import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatErrorResponse, formatSuccessResponse, logger } from '../config.js';
import { generateInstagramCaption } from '../scheduler/ai-caption.js';
import { SchedulerDb } from '../scheduler/db.js';
import { parseScheduledTime, verifyMediaReachability } from '../scheduler/queue.js';
import {
  CancelScheduledPostResult,
  CreateDraftResult,
  ListScheduledPostsResult,
  SchedulePostResult,
} from '../types.js';

function countHashtags(caption?: string): number {
  if (!caption) return 0;
  const matches = caption.match(/#[a-zA-Z0-9_]+/g);
  return matches ? matches.length : 0;
}

export function registerSchedulingTools(server: McpServer): void {
  const db = SchedulerDb.getInstance();

  // ==========================================
  // Tool 1: generate_caption
  // ==========================================
  const generateCaptionHandler = async (args: {
    topic: string;
    tone?: 'engaging' | 'professional' | 'casual' | 'storytelling' | 'humorous' | 'inspirational' | 'educational' | 'promotional';
    target_audience?: string;
    include_hashtags?: boolean;
    max_hashtags?: number;
    call_to_action?: string;
    media_type?: 'IMAGE' | 'REEL' | 'CAROUSEL';
  }) => {
    logger.info(`Generating AI caption draft for topic: "${args.topic}" (tone: ${args.tone || 'engaging'})...`);

    try {
      const result = await generateInstagramCaption({
        topic: args.topic,
        tone: args.tone,
        targetAudience: args.target_audience,
        includeHashtags: args.include_hashtags,
        maxHashtags: args.max_hashtags,
        callToAction: args.call_to_action,
        mediaType: args.media_type,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatSuccessResponse(result), null, 2),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'AI_CAPTION_FAILED',
                `Failed to generate caption: ${msg}`,
                { topic: args.topic },
                'Check network connectivity or refine your topic prompt.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }
  };

  server.registerTool(
    'generate_caption',
    {
      description:
        'Generate AI-assisted Instagram captions and strategic hashtags. Output remains a draft until reviewed and explicitly saved or scheduled.',
      inputSchema: {
        topic: z.string().min(1).describe('The topic, core idea, product, or theme of the post.'),
        tone: z
          .enum([
            'engaging',
            'professional',
            'casual',
            'storytelling',
            'humorous',
            'inspirational',
            'educational',
            'promotional',
          ])
          .optional()
          .default('engaging')
          .describe('Desired tone of voice for the caption.'),
        target_audience: z.string().optional().describe('Target audience or niche for tailored copy.'),
        include_hashtags: z.boolean().optional().default(true).describe('Whether to generate hashtags (up to 30).'),
        max_hashtags: z.number().int().min(1).max(30).optional().default(10).describe('Target number of hashtags.'),
        call_to_action: z.string().optional().describe('Custom call-to-action line (e.g. "Save for later").'),
        media_type: z.enum(['IMAGE', 'REEL', 'CAROUSEL']).optional().default('IMAGE').describe('Format of the post.'),
      },
    },
    generateCaptionHandler
  );
  server.registerTool(
    'instagram_generate_caption',
    {
      description: 'Alias for generate_caption.',
      inputSchema: {
        topic: z.string().min(1).describe('The topic, core idea, product, or theme of the post.'),
        tone: z
          .enum([
            'engaging',
            'professional',
            'casual',
            'storytelling',
            'humorous',
            'inspirational',
            'educational',
            'promotional',
          ])
          .optional()
          .default('engaging'),
        target_audience: z.string().optional(),
        include_hashtags: z.boolean().optional().default(true),
        max_hashtags: z.number().int().min(1).max(30).optional().default(10),
        call_to_action: z.string().optional(),
        media_type: z.enum(['IMAGE', 'REEL', 'CAROUSEL']).optional().default('IMAGE'),
      },
    },
    generateCaptionHandler
  );

  // ==========================================
  // Tool 2: create_post_draft
  // ==========================================
  const createDraftHandler = async (args: {
    caption: string;
    media_type?: 'IMAGE' | 'REEL' | 'CAROUSEL';
    media_urls?: string[];
    media_url?: string;
    title?: string;
    cover_url?: string;
    share_to_feed?: boolean;
  }) => {
    logger.info('Creating persistent post draft...');

    // Resolve media URLs
    const mediaUrls = args.media_urls || (args.media_url ? [args.media_url] : []);
    if (mediaUrls.length === 0) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'MISSING_MEDIA_URL',
                'At least one media URL must be provided (either media_urls or media_url).',
                null,
                'Provide a valid image or video URL for the draft.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    const hashtagCount = countHashtags(args.caption);
    if (hashtagCount > 30) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'HASHTAG_LIMIT_EXCEEDED',
                `Caption contains ${hashtagCount} hashtags. Meta allows a maximum of 30 hashtags per post.`,
                { hashtagCount, maxAllowed: 30 },
                'Reduce the number of hashtags to 30 or fewer.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    try {
      const draft = db.createDraft({
        title: args.title,
        caption: args.caption,
        mediaType: args.media_type || 'IMAGE',
        mediaUrls,
        coverUrl: args.cover_url,
        shareToFeed: args.share_to_feed !== false,
      });

      const responseData: CreateDraftResult = {
        draftId: draft.id,
        status: 'DRAFT',
        draft,
        characterCount: draft.caption.length,
        hashtagCount,
        message: `Post draft '${draft.id}' successfully created and saved persistently. Use schedule_post to schedule publication.`,
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatSuccessResponse(responseData), null, 2),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse('DRAFT_CREATION_FAILED', `Failed to create draft: ${msg}`),
              null,
              2
            ),
          },
        ],
      };
    }
  };

  server.registerTool(
    'create_post_draft',
    {
      description:
        'Store a proposed caption, media URL(s), and publishing details persistently as a draft.',
      inputSchema: {
        caption: z.string().min(1).max(2200).describe('Caption text (max 2200 characters, max 30 hashtags).'),
        media_type: z.enum(['IMAGE', 'REEL', 'CAROUSEL']).optional().default('IMAGE'),
        media_urls: z.array(z.string().url()).optional().describe('Array of publicly accessible media URLs.'),
        media_url: z.string().url().optional().describe('Single media URL (alternative to media_urls).'),
        title: z.string().optional().describe('Internal reference title for this draft.'),
        cover_url: z.string().url().optional().describe('Cover image URL (for Reels).'),
        share_to_feed: z.boolean().optional().default(true).describe('Share Reel to Instagram Feed.'),
      },
    },
    createDraftHandler
  );
  server.registerTool(
    'instagram_create_draft',
    {
      description: 'Alias for create_post_draft.',
      inputSchema: {
        caption: z.string().min(1).max(2200),
        media_type: z.enum(['IMAGE', 'REEL', 'CAROUSEL']).optional().default('IMAGE'),
        media_urls: z.array(z.string().url()).optional(),
        media_url: z.string().url().optional(),
        title: z.string().optional(),
        cover_url: z.string().url().optional(),
        share_to_feed: z.boolean().optional().default(true),
      },
    },
    createDraftHandler
  );

  // ==========================================
  // Tool 3: schedule_post
  // ==========================================
  const schedulePostHandler = async (args: {
    draft_id?: string;
    caption?: string;
    media_type?: 'IMAGE' | 'REEL' | 'CAROUSEL';
    media_urls?: string[];
    media_url?: string;
    cover_url?: string;
    share_to_feed?: boolean;
    scheduled_time: string;
    timezone?: string;
    idempotency_key?: string;
    confirm_schedule?: boolean;
  }) => {
    logger.info(`Validating post scheduling request for time: "${args.scheduled_time}"...`);

    // 1. Resolve draft if draft_id is provided
    let caption = args.caption;
    let mediaType = args.media_type || 'IMAGE';
    let mediaUrls = args.media_urls || (args.media_url ? [args.media_url] : []);
    let coverUrl = args.cover_url;
    let shareToFeed = args.share_to_feed !== false;

    if (args.draft_id) {
      const draft = db.getDraft(args.draft_id);
      if (!draft) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                formatErrorResponse(
                  'DRAFT_NOT_FOUND',
                  `Draft with ID '${args.draft_id}' does not exist in the database.`,
                  { draftId: args.draft_id },
                  'Verify the draft ID or create a new draft with create_post_draft.'
                ),
                null,
                2
              ),
            },
          ],
        };
      }
      caption = caption || draft.caption;
      mediaType = draft.mediaType;
      mediaUrls = mediaUrls.length > 0 ? mediaUrls : draft.mediaUrls;
      coverUrl = coverUrl || draft.coverUrl;
      shareToFeed = draft.shareToFeed !== false;
    }

    if (!caption) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'MISSING_CAPTION',
                'A caption must be provided directly or referenced via a valid draft_id.',
                null,
                'Provide a caption string.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    if (mediaUrls.length === 0) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'MISSING_MEDIA_URL',
                'At least one media URL is required to schedule a post.',
                null,
                'Provide a media_url or media_urls array.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    // 2. Validate time and timezone
    const timeCheck = parseScheduledTime(args.scheduled_time, args.timezone || 'UTC');
    if (!timeCheck.isValid || !timeCheck.utcIso) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'INVALID_SCHEDULED_TIME',
                timeCheck.error || 'Invalid scheduled time provided.',
                { scheduled_time: args.scheduled_time, timezone: args.timezone },
                'Provide a future time in ISO 8601 format (e.g. "2026-10-25T15:00:00Z").'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    // 3. Validate hashtags
    const hashtagCount = countHashtags(caption);
    if (hashtagCount > 30) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'HASHTAG_LIMIT_EXCEEDED',
                `Caption contains ${hashtagCount} hashtags. Meta allows a maximum of 30 hashtags per post.`,
                { hashtagCount, maxAllowed: 30 }
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    // 4. Verify media reachability
    for (const url of mediaUrls) {
      const check = await verifyMediaReachability(url);
      if (!check.isReachable) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                formatErrorResponse(
                  'MEDIA_UNREACHABLE',
                  `Media URL check failed: ${check.error}`,
                  { url },
                  'Ensure media is hosted on a public HTTPS server accessible by Meta.'
                ),
                null,
                2
              ),
            },
          ],
        };
      }
    }

    // 5. Enforce explicit confirmation
    if (args.confirm_schedule !== true) {
      logger.info('Scheduling pre-flight passed; awaiting explicit confirmation from user.');
      const dryRun: SchedulePostResult = {
        jobId: '[PENDING_CONFIRMATION]',
        status: 'CONFIRMATION_REQUIRED',
        scheduled: false,
        scheduledTimeUtc: timeCheck.utcIso,
        scheduledTimeLocal: timeCheck.localDisplay,
        timezone: args.timezone || 'UTC',
        postPreview: {
          mediaType,
          mediaUrls,
          caption,
          captionLength: caption.length,
          hashtagCount,
        },
        message:
          'Pre-flight validation passed. Explicit confirmation is required before scheduling this post in the queue.',
        actionRequired:
          'To confirm and add this job to the persistent scheduler queue, call schedule_post again with confirm_schedule: true.',
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatSuccessResponse(dryRun), null, 2),
          },
        ],
      };
    }

    // 6. Confirmed: Schedule persistently in SQLite
    const job = db.scheduleJob({
      draftId: args.draft_id,
      mediaType,
      mediaUrls,
      caption,
      coverUrl,
      shareToFeed,
      scheduledTimeUtc: timeCheck.utcIso,
      timezone: args.timezone || 'UTC',
      idempotencyKey: args.idempotency_key,
    });

    const result: SchedulePostResult = {
      jobId: job.id,
      status: 'SCHEDULED',
      scheduled: true,
      scheduledTimeUtc: job.scheduledTimeUtc,
      scheduledTimeLocal: timeCheck.localDisplay,
      timezone: job.timezone,
      postPreview: {
        mediaType,
        mediaUrls,
        caption,
        captionLength: caption.length,
        hashtagCount,
      },
      idempotencyKey: job.idempotencyKey,
      message: `Post successfully scheduled with Job ID '${job.id}'. It will automatically be dispatched to Instagram at ${timeCheck.localDisplay} (${job.scheduledTimeUtc}).`,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(formatSuccessResponse(result), null, 2),
        },
      ],
    };
  };

  server.registerTool(
    'schedule_post',
    {
      description:
        'Schedule a draft or direct post for automated future publishing. Enforces persistent SQLite storage, time-zone conversion, and confirmation.',
      inputSchema: {
        draft_id: z.string().optional().describe('ID of an existing draft (from create_post_draft).'),
        caption: z.string().max(2200).optional().describe('Caption text (if draft_id is not supplied).'),
        media_type: z.enum(['IMAGE', 'REEL', 'CAROUSEL']).optional().default('IMAGE'),
        media_urls: z.array(z.string().url()).optional().describe('Media URLs (if draft_id is not supplied).'),
        media_url: z.string().url().optional().describe('Single media URL.'),
        cover_url: z.string().url().optional().describe('Cover image URL (for Reels).'),
        share_to_feed: z.boolean().optional().default(true),
        scheduled_time: z
          .string()
          .describe('Future date and time in ISO 8601 or standard datetime string (e.g. "2026-10-25T15:00:00Z").'),
        timezone: z.string().optional().default('UTC').describe('Timezone e.g. "UTC", "Asia/Kolkata", "America/New_York".'),
        idempotency_key: z.string().optional().describe('Unique key to guarantee idempotent scheduling.'),
        confirm_schedule: z
          .boolean()
          .optional()
          .describe('Explicit user confirmation. Must be true to queue. If false or omitted, runs pre-flight validation only.'),
      },
    },
    schedulePostHandler
  );
  server.registerTool(
    'instagram_schedule_post',
    {
      description: 'Alias for schedule_post.',
      inputSchema: {
        draft_id: z.string().optional(),
        caption: z.string().max(2200).optional(),
        media_type: z.enum(['IMAGE', 'REEL', 'CAROUSEL']).optional().default('IMAGE'),
        media_urls: z.array(z.string().url()).optional(),
        media_url: z.string().url().optional(),
        cover_url: z.string().url().optional(),
        share_to_feed: z.boolean().optional().default(true),
        scheduled_time: z.string(),
        timezone: z.string().optional().default('UTC'),
        idempotency_key: z.string().optional(),
        confirm_schedule: z.boolean().optional(),
      },
    },
    schedulePostHandler
  );

  // ==========================================
  // Tool 4: list_scheduled_posts
  // ==========================================
  const listScheduledHandler = async (args: {
    status?: 'SCHEDULED' | 'PROCESSING' | 'PUBLISHED' | 'FAILED' | 'CANCELLED' | 'ALL';
    limit?: number;
  }) => {
    const filter = args.status || 'SCHEDULED';
    const limit = args.limit ?? 20;

    logger.info(`Listing scheduled posts (filter: ${filter}, limit: ${limit})...`);
    const jobs = db.listScheduledJobs(filter, limit);

    const result: ListScheduledPostsResult = {
      total: jobs.length,
      jobs,
      filter,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(formatSuccessResponse(result), null, 2),
        },
      ],
    };
  };

  server.registerTool(
    'list_scheduled_posts',
    {
      description:
        'Inspect upcoming, completed, or failed scheduled posts from the persistent database.',
      inputSchema: {
        status: z
          .enum(['SCHEDULED', 'PROCESSING', 'PUBLISHED', 'FAILED', 'CANCELLED', 'ALL'])
          .optional()
          .default('SCHEDULED')
          .describe('Filter by post status.'),
        limit: z.number().int().min(1).max(50).optional().default(20),
      },
    },
    listScheduledHandler
  );
  server.registerTool(
    'instagram_list_scheduled',
    {
      description: 'Alias for list_scheduled_posts.',
      inputSchema: {
        status: z
          .enum(['SCHEDULED', 'PROCESSING', 'PUBLISHED', 'FAILED', 'CANCELLED', 'ALL'])
          .optional()
          .default('SCHEDULED'),
        limit: z.number().int().min(1).max(50).optional().default(20),
      },
    },
    listScheduledHandler
  );

  // ==========================================
  // Tool 5: cancel_scheduled_post
  // ==========================================
  const cancelScheduledHandler = async (args: { job_id: string; reason?: string }) => {
    logger.info(`Cancelling scheduled post with ID: "${args.job_id}"...`);

    const result = db.cancelJob(args.job_id, args.reason);

    if (!result.success) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'CANCEL_FAILED',
                result.message,
                { jobId: args.job_id },
                'Verify the job ID using list_scheduled_posts.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    const payload: CancelScheduledPostResult = {
      jobId: args.job_id,
      status: 'CANCELLED',
      cancelled: true,
      message: result.message,
      cancelledAt: result.cancelledAt,
      reason: args.reason,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(formatSuccessResponse(payload), null, 2),
        },
      ],
    };
  };

  server.registerTool(
    'cancel_scheduled_post',
    {
      description: 'Cancel a pending scheduled post action.',
      inputSchema: {
        job_id: z.string().min(1).describe('The unique ID of the scheduled job to cancel.'),
        reason: z.string().optional().describe('Optional reason for cancellation.'),
      },
    },
    cancelScheduledHandler
  );
  server.registerTool(
    'instagram_cancel_scheduled',
    {
      description: 'Alias for cancel_scheduled_post.',
      inputSchema: {
        job_id: z.string().min(1),
        reason: z.string().optional(),
      },
    },
    cancelScheduledHandler
  );
}
