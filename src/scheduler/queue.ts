import { config, logger } from '../config.js';
import { instagramApi, InstagramApiError } from '../instagram-api.js';
import { ScheduledPostJob } from '../types.js';
import { SchedulerDb } from './db.js';

/**
 * Validates that a media URL is well-formed, uses HTTP/HTTPS, and is not a private IP.
 */
function validateMediaUrlSyntax(rawUrl: string): { isValid: boolean; error?: string } {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { isValid: false, error: 'Media URL must use http: or https: protocol.' };
    }

    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname.startsWith('127.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('169.254.') || // Cloud metadata & link-local (AWS/DigitalOcean/GCP)
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.localhost') ||
      hostname === 'metadata.google.internal' ||
      hostname === 'instance-data'
    ) {
      return {
        isValid: false,
        error: `Address '${hostname}' is a private, loopback, or cloud-internal endpoint. Media must be hosted on a publicly accessible Internet URL.`,
      };
    }

    return { isValid: true };
  } catch {
    return { isValid: false, error: 'Malformed media URL provided.' };
  }
}

/**
 * Verifies live reachability of media over network before publishing.
 */
export async function verifyMediaReachability(
  url: string
): Promise<{ isReachable: boolean; error?: string }> {
  const syntax = validateMediaUrlSyntax(url);
  if (!syntax.isValid) return { isReachable: false, error: syntax.error };

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(6000),
      });
      if (response.status === 405) {
        response = await fetch(url, {
          headers: { Range: 'bytes=0-10' },
          signal: AbortSignal.timeout(6000),
        });
      }
    } catch {
      response = await fetch(url, {
        headers: { Range: 'bytes=0-10' },
        signal: AbortSignal.timeout(6000),
      });
    }

    if (!response.ok && response.status !== 206) {
      return {
        isReachable: false,
        error: `Media server returned HTTP status ${response.status} (${response.statusText}).`,
      };
    }

    return { isReachable: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isReachable: false, error: `Unable to reach media URL: ${msg}` };
  }
}

/**
 * Parses and converts arbitrary time inputs into canonical UTC ISO format and localized display string.
 */
export function parseScheduledTime(
  rawTime: string,
  userTimezone = 'UTC'
): {
  isValid: boolean;
  utcIso?: string;
  localDisplay?: string;
  error?: string;
} {
  try {
    let parsedDate: Date;

    // Check if it's already an ISO timestamp with Z or timezone offset
    if (rawTime.includes('Z') || /[+-]\d{2}:\d{2}$/.test(rawTime.trim())) {
      parsedDate = new Date(rawTime);
    } else {
      // Local date string without explicit offset; interpret in specified timezone
      const cleaned = rawTime.trim().replace(' ', 'T');
      const testDate = new Date(cleaned);

      if (isNaN(testDate.getTime())) {
        return {
          isValid: false,
          error: `Invalid date format '${rawTime}'. Use standard ISO 8601 format (e.g. '2026-10-25T14:30:00Z' or '2026-10-25 14:30:00').`,
        };
      }
      parsedDate = testDate;
    }

    if (isNaN(parsedDate.getTime())) {
      return {
        isValid: false,
        error: `Could not parse date '${rawTime}'. Ensure a valid date and time are provided.`,
      };
    }

    const now = Date.now();
    const scheduledEpoch = parsedDate.getTime();

    // Must be at least 30 seconds into the future
    if (scheduledEpoch <= now + 30 * 1000) {
      return {
        isValid: false,
        error: `Scheduled time must be in the future (minimum 30 seconds ahead). Provided: ${parsedDate.toISOString()}, Current time: ${new Date(now).toISOString()}`,
      };
    }

    // Format localized display string
    let localDisplay: string;
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: userTimezone,
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      });
      localDisplay = formatter.format(parsedDate);
    } catch {
      localDisplay = `${parsedDate.toISOString()} (UTC)`;
    }

    return {
      isValid: true,
      utcIso: parsedDate.toISOString(),
      localDisplay,
    };
  } catch (err) {
    return {
      isValid: false,
      error: `Date parsing error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Executes a single scheduled post job against the Meta Instagram API.
 * Distinguishes a scheduled job from a confirmed Instagram publication.
 */
export async function executeScheduledJob(
  job: ScheduledPostJob,
  db: SchedulerDb
): Promise<{ success: boolean; publishedMediaId?: string; error?: string; isFatal?: boolean }> {
  logger.info(`[SCHEDULER] Executing scheduled post ${job.id} (Media Type: ${job.mediaType}, Attempt: ${job.attempts})...`);

  // 1. Verify credentials configured
  if (!config.accessToken || !config.userId) {
    const errorMsg = 'Instagram credentials missing (INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_USER_ID).';
    logger.error(`[SCHEDULER] Job ${job.id} failed: ${errorMsg}`);
    db.markJobFailed(job.id, 'MISSING_CREDENTIALS', errorMsg, false);
    return { success: false, error: errorMsg, isFatal: true };
  }

  // 2. Verify media URLs accessibility
  for (const url of job.mediaUrls) {
    const check = await verifyMediaReachability(url);
    if (!check.isReachable) {
      const errorMsg = `Media URL is inaccessible: ${check.error || 'Failed reachability probe.'}`;
      logger.error(`[SCHEDULER] Job ${job.id} failed: ${errorMsg}`);
      db.markJobFailed(job.id, 'MEDIA_UNREACHABLE', errorMsg, false);
      return { success: false, error: errorMsg, isFatal: true };
    }
  }

  // 3. Execute publishing based on media type
  try {
    let publishedMediaId: string;

    if (job.mediaType === 'IMAGE') {
      const imageUrl = job.mediaUrls[0];
      logger.info(`[SCHEDULER] Creating image container for job ${job.id}...`);
      const container = await instagramApi.createImageContainer(imageUrl, job.caption);

      logger.info(`[SCHEDULER] Waiting for container ${container.id} processing...`);
      await instagramApi.waitForContainerReady(container.id);

      logger.info(`[SCHEDULER] Publishing container ${container.id} to Instagram feed...`);
      const publishRes = await instagramApi.publishContainer(container.id);
      publishedMediaId = publishRes.id;
    } else if (job.mediaType === 'REEL') {
      const videoUrl = job.mediaUrls[0];
      logger.info(`[SCHEDULER] Creating Reel container for job ${job.id}...`);
      const container = await instagramApi.createReelContainer({
        videoUrl,
        caption: job.caption,
        coverUrl: job.coverUrl,
        shareToFeed: job.shareToFeed,
      });

      logger.info(`[SCHEDULER] Waiting for Reel container ${container.id} processing...`);
      await instagramApi.waitForContainerReady(container.id);

      logger.info(`[SCHEDULER] Publishing Reel container ${container.id} to Instagram feed...`);
      const publishRes = await instagramApi.publishContainer(container.id);
      publishedMediaId = publishRes.id;
    } else {
      // CAROUSEL
      logger.info(`[SCHEDULER] Creating ${job.mediaUrls.length} carousel item containers for job ${job.id}...`);
      const childIds: string[] = [];
      for (const itemUrl of job.mediaUrls) {
        const itemRes = await instagramApi.createCarouselItemContainer({
          url: itemUrl,
          mediaType: itemUrl.match(/\.(mp4|mov|webm)$/i) ? 'VIDEO' : 'IMAGE',
        });
        childIds.push(itemRes.id);
      }

      logger.info(`[SCHEDULER] Creating parent carousel container with ${childIds.length} children...`);
      const container = await instagramApi.createCarouselContainer(childIds, job.caption);

      logger.info(`[SCHEDULER] Waiting for carousel container ${container.id} processing...`);
      await instagramApi.waitForContainerReady(container.id);

      logger.info(`[SCHEDULER] Publishing carousel container ${container.id} to Instagram feed...`);
      const publishRes = await instagramApi.publishContainer(container.id);
      publishedMediaId = publishRes.id;
    }

    // Success! Update persistent database record
    logger.info(`[SCHEDULER] Job ${job.id} PUBLISHED successfully! Live Meta Media ID: ${publishedMediaId}`);
    db.markJobPublished(job.id, publishedMediaId);
    return { success: true, publishedMediaId };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    let errorCode = 'PUBLISH_FAILED';
    let isFatal = false;

    if (err instanceof InstagramApiError) {
      errorCode = `META_${err.code || err.status || 'ERR'}`;
      // Fatal errors: Auth token expired (190), permission missing (10/200), client error 400/401/403
      if (err.status === 401 || err.status === 403 || err.code === 190 || err.code === 10 || err.code === 200) {
        isFatal = true;
      }
    }

    const canRetry = !isFatal && job.attempts < job.maxRetries;
    let nextRetryAt: string | undefined;

    if (canRetry) {
      // Exponential backoff: 2^attempts * 60 seconds (min 1 min, max 1 hour)
      const delaySeconds = Math.min(3600, Math.pow(2, job.attempts) * 60);
      nextRetryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
      logger.warn(
        `[SCHEDULER] Job ${job.id} failed transiently: ${errorMsg}. Scheduled retry ${job.attempts + 1}/${job.maxRetries} at ${nextRetryAt}.`
      );
    } else {
      logger.error(
        `[SCHEDULER] Job ${job.id} failed permanently (isFatal: ${isFatal}, attempts: ${job.attempts}/${job.maxRetries}): ${errorMsg}`
      );
    }

    db.markJobFailed(job.id, errorCode, errorMsg, canRetry, nextRetryAt);
    return { success: false, error: errorMsg, isFatal };
  }
}

/**
 * Background Scheduler Queue Worker.
 * Periodically polls the SQLite database for due posts and processes them idempotently.
 */
export class SchedulerQueue {
  private static instance: SchedulerQueue | null = null;
  private db: SchedulerDb;
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private checkIntervalMs: number;

  private constructor(db?: SchedulerDb, checkIntervalMs = 30000) {
    this.db = db || SchedulerDb.getInstance();
    this.checkIntervalMs = checkIntervalMs;
  }

  public static getInstance(db?: SchedulerDb): SchedulerQueue {
    if (!SchedulerQueue.instance) {
      SchedulerQueue.instance = new SchedulerQueue(db);
    }
    return SchedulerQueue.instance;
  }

  public start(): void {
    if (this.timer) return;
    logger.info(`[SCHEDULER] Starting background job queue worker (poll interval: ${this.checkIntervalMs / 1000}s)...`);
    this.timer = setInterval(() => {
      this.processDueJobs().catch((err) => {
        logger.error('[SCHEDULER] Error in scheduler tick:', err);
      });
    }, this.checkIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[SCHEDULER] Stopped background job queue worker.');
    }
  }

  /**
   * Processes all currently due scheduled posts.
   * Atomically claims jobs using SQLite row updates to prevent duplicate execution.
   */
  public async processDueJobs(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    try {
      const nowIso = new Date().toISOString();
      const dueJobs = this.db.getDueJobs(nowIso);

      if (dueJobs.length === 0) {
        return 0;
      }

      logger.info(`[SCHEDULER] Found ${dueJobs.length} due scheduled posts to process.`);
      let processedCount = 0;

      for (const job of dueJobs) {
        // Atomically claim the job
        const claimed = this.db.claimJobForProcessing(job.id);
        if (!claimed) {
          logger.debug(`[SCHEDULER] Job ${job.id} already claimed by another process. Skipping.`);
          continue;
        }

        // Execute the job
        await executeScheduledJob(job, this.db);
        processedCount++;
      }

      return processedCount;
    } finally {
      this.isProcessing = false;
    }
  }
}
