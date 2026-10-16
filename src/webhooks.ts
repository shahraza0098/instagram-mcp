import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import { config, logger } from './config.js';
import { WebhookIncomingMessage, WebhookStatusResult } from './types.js';

interface RawWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: Array<{
      sender?: { id?: string };
      recipient?: { id?: string };
      timestamp?: number;
      message?: {
        mid?: string;
        text?: string;
      };
    }>;
  }>;
}

/**
 * Webhooks Verification & Event Handler for Meta Instagram Webhooks.
 *
 * Implements:
 * - GET /webhooks handshake verification with hub.challenge
 * - POST /webhooks HMAC-SHA256 signature verification (X-Hub-Signature-256)
 * - Event deduplication and in-memory event buffering
 */
export class InstagramWebhookHandler {
  private static seenMessageIds = new Map<string, number>(); // ID -> timestamp
  private static recentMessages: WebhookIncomingMessage[] = [];
  private static totalReceived = 0;
  private static deduplicatedCount = 0;
  private static lastReceivedAt?: string;

  /**
   * Maximum number of messages kept in recent event buffer.
   */
  private static readonly MAX_EVENT_BUFFER = 100;
  /**
   * Deduplication cache TTL (24 hours in ms).
   */
  private static readonly DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

  /**
   * Verifies the subscription handshake challenge from Meta.
   */
  public static verifyHandshake(
    mode?: string,
    token?: string,
    challenge?: string
  ): { isValid: boolean; challenge?: string } {
    const configuredToken = config.webhookVerifyToken;
    if (!configuredToken) {
      logger.warn('Webhook verification failed: WEBHOOK_VERIFY_TOKEN is not configured in .env');
      return { isValid: false };
    }

    if (mode === 'subscribe' && token === configuredToken && challenge) {
      logger.info('Meta webhook verification handshake succeeded');
      return { isValid: true, challenge };
    }

    logger.warn('Meta webhook verification handshake rejected: mode or token mismatch');
    return { isValid: false };
  }

  /**
   * Verifies the cryptographic HMAC-SHA256 signature from Meta.
   */
  public static verifySignature(rawPayload?: string | Buffer, signatureHeader?: string): boolean {
    const appSecret = config.appSecret;
    if (!appSecret || !signatureHeader || !rawPayload) return false;

    const parts = signatureHeader.split('=');
    if (parts.length !== 2 || parts[0] !== 'sha256' || !parts[1]) return false;

    const signature = parts[1];
    const expectedSignature = crypto
      .createHmac('sha256', appSecret)
      .update(rawPayload)
      .digest('hex');

    try {
      const sigBuf = Buffer.from(signature, 'hex');
      const expectedBuf = Buffer.from(expectedSignature, 'hex');
      if (sigBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  }

  /**
   * Cleans up expired deduplication entries older than 24 hours.
   */
  private static purgeOldSeenIds(): void {
    const now = Date.now();
    for (const [id, timestamp] of this.seenMessageIds.entries()) {
      if (now - timestamp > this.DEDUP_TTL_MS) {
        this.seenMessageIds.delete(id);
      }
    }
  }

  /**
   * Processes, validates, and deduplicates an incoming webhook payload.
   */
  public static processPayload(payload: RawWebhookPayload): {
    success: boolean;
    receivedCount: number;
    duplicateCount: number;
    error?: string;
  } {
    if (!payload || typeof payload !== 'object') {
      return { success: false, receivedCount: 0, duplicateCount: 0, error: 'Empty or invalid JSON payload' };
    }

    if (payload.object !== 'instagram') {
      return {
        success: false,
        receivedCount: 0,
        duplicateCount: 0,
        error: `Expected webhook object 'instagram', received '${payload.object || 'unknown'}'`,
      };
    }

    this.purgeOldSeenIds();
    let newItemsCount = 0;
    let duplicateItemsCount = 0;
    const nowIso = new Date().toISOString();

    for (const entry of payload.entry || []) {
      for (const msgItem of entry.messaging || []) {
        const mid = msgItem.message?.mid || `${msgItem.sender?.id}_${msgItem.timestamp}`;
        this.totalReceived++;

        if (this.seenMessageIds.has(mid)) {
          this.deduplicatedCount++;
          duplicateItemsCount++;
          logger.info(`Deduplicated incoming webhook event: ${mid}`);
          continue;
        }

        this.seenMessageIds.set(mid, Date.now());
        newItemsCount++;
        this.lastReceivedAt = nowIso;

        const incoming: WebhookIncomingMessage = {
          mid,
          senderId: msgItem.sender?.id || 'unknown',
          recipientId: msgItem.recipient?.id || 'unknown',
          timestamp: msgItem.timestamp || Date.now(),
          text: msgItem.message?.text,
          receivedAt: nowIso,
        };

        this.recentMessages.unshift(incoming);
        if (this.recentMessages.length > this.MAX_EVENT_BUFFER) {
          this.recentMessages.pop();
        }

        logger.info(`[WEBHOOK EVENT] Incoming message from ${incoming.senderId}: "${incoming.text || '[Media/Attachment]'}" (MID: ${mid})`);
      }
    }

    return {
      success: true,
      receivedCount: newItemsCount,
      duplicateCount: duplicateItemsCount,
    };
  }

  /**
   * Returns current webhook status, metrics, and recent message queue.
   */
  public static getStatus(): WebhookStatusResult {
    const hasVerifyToken = Boolean(config.webhookVerifyToken);
    const hasAppSecret = Boolean(config.appSecret);
    const isConfigured = hasVerifyToken && hasAppSecret;
    const endpointUrl = `http://localhost:${config.port}/webhooks`;

    const operationalNotes: string[] = [];
    if (!hasVerifyToken) {
      operationalNotes.push('WEBHOOK_VERIFY_TOKEN is missing in .env. Generate a secure random token and configure it in Meta App Dashboard > Webhooks.');
    }
    if (!hasAppSecret) {
      operationalNotes.push('META_APP_SECRET is missing in .env. Required for X-Hub-Signature-256 payload verification.');
    }
    operationalNotes.push('Meta webhooks require a publicly accessible HTTPS URL. Use an HTTPS reverse proxy (e.g. ngrok, Cloudflare Tunnel) to forward requests to this local port.');
    operationalNotes.push('In Meta Developer App > Webhooks > Instagram, subscribe to the "messages" and "messaging_postbacks" fields.');

    return {
      isConfigured,
      hasVerifyToken,
      hasAppSecret,
      endpointUrl,
      totalReceived: this.totalReceived,
      deduplicatedCount: this.deduplicatedCount,
      lastReceivedAt: this.lastReceivedAt,
      recentEvents: this.recentMessages.slice(0, 10),
      operationalNotes,
    };
  }

  /**
   * Express router handling GET (verification) and POST (event delivery).
   */
  public static createRouter(): Router {
    const router = Router();

    // GET /webhooks - Meta Webhook Verification Handshake
    router.get('/', (req: Request, res: Response) => {
      const mode = req.query['hub.mode'] as string | undefined;
      const token = req.query['hub.verify_token'] as string | undefined;
      const challenge = req.query['hub.challenge'] as string | undefined;

      const verification = InstagramWebhookHandler.verifyHandshake(mode, token, challenge);
      if (verification.isValid && verification.challenge) {
        res.status(200).send(verification.challenge);
      } else {
        res.status(403).send('Forbidden: Webhook verification failed.');
      }
    });

    // POST /webhooks - Meta Event Dispatch
    router.post('/', (req: Request, res: Response) => {
      const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody || JSON.stringify(req.body);

      // Verify cryptographic HMAC-SHA256 signature
      const isSignatureValid = InstagramWebhookHandler.verifySignature(rawBody, signatureHeader);
      if (!isSignatureValid) {
        logger.warn('Incoming webhook rejected: invalid or missing X-Hub-Signature-256 signature');
        res.status(401).send('Unauthorized: Invalid signature.');
        return;
      }

      // Process and deduplicate payload
      const result = InstagramWebhookHandler.processPayload(req.body);
      if (!result.success) {
        logger.warn(`Malformed webhook payload: ${result.error}`);
        res.status(400).send(`Bad Request: ${result.error}`);
        return;
      }

      // Always return 200 OK to acknowledge receipt
      res.status(200).send('EVENT_RECEIVED');
    });

    return router;
  }
}
