import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, logger } from '../config.js';
import { PostDraft, ScheduledPostJob } from '../types.js';

export class SchedulerDb {
  private static instance: SchedulerDb | null = null;
  private db: DatabaseSync;

  private constructor(customPath?: string) {
    const dbPath = customPath || config.databasePath;
    const resolvedPath = path.resolve(process.cwd(), dbPath);
    const dir = path.dirname(resolvedPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(resolvedPath);
    this.initPragmas();
    this.initTables();
  }

  public static getInstance(customPath?: string): SchedulerDb {
    if (!SchedulerDb.instance) {
      SchedulerDb.instance = new SchedulerDb(customPath);
    }
    return SchedulerDb.instance;
  }

  /**
   * For testing or isolated databases.
   */
  public static createIsolatedInstance(pathOrMemory: string): SchedulerDb {
    return new SchedulerDb(pathOrMemory);
  }

  private initPragmas(): void {
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec('PRAGMA foreign_keys = ON;');
    } catch (err) {
      logger.warn('Failed to set SQLite PRAGMAs (non-fatal):', err instanceof Error ? err.message : String(err));
    }
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS post_drafts (
        id TEXT PRIMARY KEY,
        title TEXT,
        caption TEXT NOT NULL,
        media_type TEXT NOT NULL,
        media_urls TEXT NOT NULL,
        cover_url TEXT,
        share_to_feed INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS scheduled_posts (
        id TEXT PRIMARY KEY,
        draft_id TEXT,
        media_type TEXT NOT NULL,
        media_urls TEXT NOT NULL,
        caption TEXT NOT NULL,
        cover_url TEXT,
        share_to_feed INTEGER DEFAULT 1,
        scheduled_time_utc TEXT NOT NULL,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'SCHEDULED',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        next_retry_at TEXT,
        published_media_id TEXT,
        error_code TEXT,
        error_message TEXT,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_attempt_at TEXT,
        cancellation_reason TEXT,
        FOREIGN KEY (draft_id) REFERENCES post_drafts(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status_time 
        ON scheduled_posts(status, scheduled_time_utc);

      CREATE INDEX IF NOT EXISTS idx_scheduled_posts_idempotency 
        ON scheduled_posts(idempotency_key);

      CREATE TABLE IF NOT EXISTS publishing_audit_logs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_logs_job_id 
        ON publishing_audit_logs(job_id);
    `);
  }

  // ==========================================
  // Post Draft Operations
  // ==========================================

  public createDraft(data: {
    title?: string;
    caption: string;
    mediaType: 'IMAGE' | 'REEL' | 'CAROUSEL';
    mediaUrls: string[];
    coverUrl?: string;
    shareToFeed?: boolean;
    metadata?: Record<string, unknown>;
  }): PostDraft {
    const id = `draft_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO post_drafts (
        id, title, caption, media_type, media_urls, cover_url, share_to_feed,
        created_at, updated_at, status, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)
    `);

    stmt.run(
      id,
      data.title || null,
      data.caption,
      data.mediaType,
      JSON.stringify(data.mediaUrls),
      data.coverUrl || null,
      data.shareToFeed !== false ? 1 : 0,
      now,
      now,
      data.metadata ? JSON.stringify(data.metadata) : null
    );

    return {
      id,
      title: data.title,
      caption: data.caption,
      mediaType: data.mediaType,
      mediaUrls: data.mediaUrls,
      coverUrl: data.coverUrl,
      shareToFeed: data.shareToFeed !== false,
      createdAt: now,
      updatedAt: now,
      status: 'DRAFT',
      metadata: data.metadata,
    };
  }

  public getDraft(id: string): PostDraft | null {
    const stmt = this.db.prepare('SELECT * FROM post_drafts WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    return this.mapDraftRow(row);
  }

  public listDrafts(limit = 20): PostDraft[] {
    const stmt = this.db.prepare('SELECT * FROM post_drafts ORDER BY created_at DESC LIMIT ?');
    const rows = stmt.all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapDraftRow(r));
  }

  public updateDraftStatus(id: string, status: PostDraft['status']): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE post_drafts SET status = ?, updated_at = ? WHERE id = ?');
    stmt.run(status, now, id);
  }

  private mapDraftRow(row: Record<string, unknown>): PostDraft {
    return {
      id: String(row.id),
      title: row.title ? String(row.title) : undefined,
      caption: String(row.caption),
      mediaType: row.media_type as 'IMAGE' | 'REEL' | 'CAROUSEL',
      mediaUrls: JSON.parse(String(row.media_urls || '[]')),
      coverUrl: row.cover_url ? String(row.cover_url) : undefined,
      shareToFeed: Number(row.share_to_feed) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      status: row.status as PostDraft['status'],
      metadata: row.metadata ? JSON.parse(String(row.metadata)) : undefined,
    };
  }

  // ==========================================
  // Scheduled Posts Operations
  // ==========================================

  public scheduleJob(data: {
    draftId?: string;
    mediaType: 'IMAGE' | 'REEL' | 'CAROUSEL';
    mediaUrls: string[];
    caption: string;
    coverUrl?: string;
    shareToFeed?: boolean;
    scheduledTimeUtc: string;
    timezone: string;
    idempotencyKey?: string;
    maxRetries?: number;
  }): ScheduledPostJob {
    const id = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const idempotencyKey =
      data.idempotencyKey ||
      `idem_${crypto.createHash('sha256').update(`${data.caption}_${data.scheduledTimeUtc}_${data.mediaUrls.join(',')}`).digest('hex').substring(0, 24)}`;

    // Check if an existing job has the exact idempotency key
    const existing = this.getJobByIdempotencyKey(idempotencyKey);
    if (existing) {
      logger.info(`Idempotent request detected. Returning existing job: ${existing.id}`);
      return existing;
    }

    const stmt = this.db.prepare(`
      INSERT INTO scheduled_posts (
        id, draft_id, media_type, media_urls, caption, cover_url, share_to_feed,
        scheduled_time_utc, timezone, status, attempts, max_retries,
        idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', 0, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.draftId || null,
      data.mediaType,
      JSON.stringify(data.mediaUrls),
      data.caption,
      data.coverUrl || null,
      data.shareToFeed !== false ? 1 : 0,
      data.scheduledTimeUtc,
      data.timezone,
      data.maxRetries ?? 3,
      idempotencyKey,
      now,
      now
    );

    if (data.draftId) {
      this.updateDraftStatus(data.draftId, 'SCHEDULED');
    }

    this.logAudit(id, 'SCHEDULED', {
      scheduledTimeUtc: data.scheduledTimeUtc,
      timezone: data.timezone,
      idempotencyKey,
    });

    return {
      id,
      draftId: data.draftId,
      mediaType: data.mediaType,
      mediaUrls: data.mediaUrls,
      caption: data.caption,
      coverUrl: data.coverUrl,
      shareToFeed: data.shareToFeed !== false,
      scheduledTimeUtc: data.scheduledTimeUtc,
      timezone: data.timezone,
      status: 'SCHEDULED',
      attempts: 0,
      maxRetries: data.maxRetries ?? 3,
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
    };
  }

  public getJob(id: string): ScheduledPostJob | null {
    const stmt = this.db.prepare('SELECT * FROM scheduled_posts WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapJobRow(row);
  }

  public getJobByIdempotencyKey(key: string): ScheduledPostJob | null {
    const stmt = this.db.prepare('SELECT * FROM scheduled_posts WHERE idempotency_key = ?');
    const row = stmt.get(key) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapJobRow(row);
  }

  public listScheduledJobs(filter = 'SCHEDULED', limit = 20): ScheduledPostJob[] {
    let query = 'SELECT * FROM scheduled_posts';
    const params: (string | number)[] = [];

    if (filter && filter.toUpperCase() !== 'ALL') {
      query += ' WHERE status = ?';
      params.push(filter.toUpperCase());
    }

    query += ' ORDER BY scheduled_time_utc ASC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapJobRow(r));
  }

  public cancelJob(id: string, reason?: string): { success: boolean; message: string; cancelledAt: string } {
    const job = this.getJob(id);
    if (!job) {
      return { success: false, message: `Scheduled post with ID '${id}' not found.`, cancelledAt: new Date().toISOString() };
    }

    if (job.status === 'PUBLISHED') {
      return { success: false, message: `Cannot cancel post '${id}' because it has already been published to Instagram (Media ID: ${job.publishedMediaId}).`, cancelledAt: new Date().toISOString() };
    }

    if (job.status === 'CANCELLED') {
      return { success: true, message: `Post '${id}' is already cancelled.`, cancelledAt: job.updatedAt };
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE scheduled_posts
      SET status = 'CANCELLED', cancellation_reason = ?, updated_at = ?
      WHERE id = ? AND status != 'PUBLISHED'
    `);
    stmt.run(reason || 'User requested cancellation', now, id);

    this.logAudit(id, 'CANCELLED', { reason, cancelledAt: now });

    return {
      success: true,
      message: `Scheduled post '${id}' successfully cancelled.`,
      cancelledAt: now,
    };
  }

  public getDueJobs(nowIso: string): ScheduledPostJob[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_posts
      WHERE (
        (status = 'SCHEDULED' AND scheduled_time_utc <= ?)
        OR
        (status = 'RETRY_PENDING' AND next_retry_at <= ?)
      )
      ORDER BY scheduled_time_utc ASC
      LIMIT 10
    `);

    const rows = stmt.all(nowIso, nowIso) as Record<string, unknown>[];
    return rows.map((r) => this.mapJobRow(r));
  }

  /**
   * Atomically claims a job for processing to guarantee idempotency across workers.
   */
  public claimJobForProcessing(id: string): boolean {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE scheduled_posts
      SET status = 'PROCESSING',
          attempts = attempts + 1,
          last_attempt_at = ?,
          updated_at = ?
      WHERE id = ? AND status IN ('SCHEDULED', 'RETRY_PENDING')
    `);

    const info = stmt.run(now, now, id);
    const claimed = Number(info.changes) > 0;
    if (claimed) {
      this.logAudit(id, 'ATTEMPT_STARTED', { attemptAt: now });
    }
    return claimed;
  }

  public markJobPublished(id: string, publishedMediaId: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE scheduled_posts
      SET status = 'PUBLISHED',
          published_media_id = ?,
          updated_at = ?
      WHERE id = ?
    `);
    stmt.run(publishedMediaId, now, id);

    this.logAudit(id, 'PUBLISHED', { publishedMediaId, timestamp: now });
  }

  public markJobFailed(
    id: string,
    errorCode: string,
    errorMessage: string,
    canRetry: boolean,
    nextRetryAt?: string
  ): void {
    const now = new Date().toISOString();
    const nextStatus = canRetry ? 'RETRY_PENDING' : 'FAILED';

    const stmt = this.db.prepare(`
      UPDATE scheduled_posts
      SET status = ?,
          error_code = ?,
          error_message = ?,
          next_retry_at = ?,
          updated_at = ?
      WHERE id = ?
    `);

    stmt.run(nextStatus, errorCode, errorMessage, nextRetryAt || null, now, id);

    this.logAudit(id, canRetry ? 'RETRY_SCHEDULED' : 'FAILED_FINAL', {
      errorCode,
      errorMessage,
      canRetry,
      nextRetryAt,
      timestamp: now,
    });
  }

  public logAudit(jobId: string, action: string, details?: unknown): void {
    try {
      const id = `audit_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const now = new Date().toISOString();
      const stmt = this.db.prepare(`
        INSERT INTO publishing_audit_logs (id, job_id, action, details, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(id, jobId, action, details ? JSON.stringify(details) : null, now);
    } catch (err) {
      logger.warn('Failed to record audit log entry:', err instanceof Error ? err.message : String(err));
    }
  }

  public getAuditLogs(jobId: string): Array<{ id: string; action: string; details?: unknown; createdAt: string }> {
    const stmt = this.db.prepare('SELECT * FROM publishing_audit_logs WHERE job_id = ? ORDER BY created_at ASC');
    const rows = stmt.all(jobId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      action: String(r.action),
      details: r.details ? JSON.parse(String(r.details)) : undefined,
      createdAt: String(r.created_at),
    }));
  }

  /**
   * Prunes old audit logs beyond retention threshold to keep the SQLite database compact.
   */
  public pruneAuditLogs(retentionDays = 30): number {
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const stmt = this.db.prepare('DELETE FROM publishing_audit_logs WHERE created_at < ?');
    const info = stmt.run(cutoffDate);
    return Number(info.changes);
  }

  /**
   * Prunes completed or cancelled jobs older than retention window.
   */
  public pruneCompletedJobs(retentionDays = 90): number {
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const stmt = this.db.prepare("DELETE FROM scheduled_posts WHERE status IN ('PUBLISHED', 'CANCELLED') AND updated_at < ?");
    const info = stmt.run(cutoffDate);
    return Number(info.changes);
  }

  private mapJobRow(row: Record<string, unknown>): ScheduledPostJob {
    return {
      id: String(row.id),
      draftId: row.draft_id ? String(row.draft_id) : undefined,
      mediaType: row.media_type as 'IMAGE' | 'REEL' | 'CAROUSEL',
      mediaUrls: JSON.parse(String(row.media_urls || '[]')),
      caption: String(row.caption),
      coverUrl: row.cover_url ? String(row.cover_url) : undefined,
      shareToFeed: Number(row.share_to_feed) === 1,
      scheduledTimeUtc: String(row.scheduled_time_utc),
      timezone: String(row.timezone || 'UTC'),
      status: row.status as ScheduledPostJob['status'],
      attempts: Number(row.attempts || 0),
      maxRetries: Number(row.max_retries || 3),
      nextRetryAt: row.next_retry_at ? String(row.next_retry_at) : undefined,
      publishedMediaId: row.published_media_id ? String(row.published_media_id) : undefined,
      errorCode: row.error_code ? String(row.error_code) : undefined,
      errorMessage: row.error_message ? String(row.error_message) : undefined,
      idempotencyKey: String(row.idempotency_key),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : undefined,
      cancellationReason: row.cancellation_reason ? String(row.cancellation_reason) : undefined,
    };
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // Ignored on close
    }
  }
}
