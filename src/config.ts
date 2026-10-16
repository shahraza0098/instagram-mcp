import dotenv from 'dotenv';
import { McpErrorResponse, McpSuccessResponse, ServerHealth } from './types.js';

// Load environment variables from .env
dotenv.config();

const SERVER_NAME = 'instagram-mcp';
const SERVER_VERSION = '1.0.0';
const DEFAULT_API_VERSION = 'v21.0';

/**
 * Validates and normalizes Meta Graph API version string.
 * Replaces placeholder 'vXX.X' with a supported production version (v21.0).
 */
function resolveApiVersion(rawVersion?: string): string {
  if (!rawVersion || rawVersion.trim() === '' || rawVersion === 'vXX.X') {
    return DEFAULT_API_VERSION;
  }
  return rawVersion.startsWith('v') ? rawVersion : `v${rawVersion}`;
}

/**
 * Returns a safe, non-sensitive hint about the token type (e.g., 'IGAA' for Instagram User Token)
 * without exposing the secret itself.
 */
export function getTokenHint(token?: string): string | undefined {
  if (!token || token.length < 4) return undefined;
  return `${token.substring(0, 4)}... (length: ${token.length})`;
}

/**
 * Safely masks secrets for diagnostic display.
 */
export function maskSecret(secret?: string): string {
  if (!secret) return '[NOT CONFIGURED]';
  if (secret.length <= 8) return '********';
  return `${secret.substring(0, 4)}...${secret.substring(secret.length - 4)}`;
}

export interface AppConfig {
  appId?: string;
  appSecret?: string;
  userId?: string;
  accessToken?: string;
  apiVersion: string;
  port: number;
  webhookVerifyToken?: string;
  redirectUri?: string;
  databasePath: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
}

export const config: AppConfig = {
  appId: process.env.META_APP_ID?.trim(),
  appSecret: process.env.META_APP_SECRET?.trim(),
  userId: process.env.INSTAGRAM_USER_ID?.trim(),
  accessToken: process.env.INSTAGRAM_ACCESS_TOKEN?.trim(),
  apiVersion: resolveApiVersion(process.env.META_API_VERSION),
  port: parseInt(process.env.PORT || '3000', 10),
  webhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN?.trim(),
  redirectUri: process.env.INSTAGRAM_REDIRECT_URI?.trim(),
  databasePath: process.env.DATABASE_PATH?.trim() || './data/scheduler.db',
  openaiApiKey: process.env.OPENAI_API_KEY?.trim(),
  geminiApiKey: process.env.GEMINI_API_KEY?.trim(),
};

/**
 * Centralized safe logger that writes ONLY to process.stderr.
 * This guarantees stdout remains dedicated to JSON-RPC over stdio.
 */
export const logger = {
  info: (message: string, ...args: unknown[]) => {
    console.error(`[INFO] [${new Date().toISOString()}] ${message}`, ...args);
  },
  warn: (message: string, ...args: unknown[]) => {
    console.error(`[WARN] [${new Date().toISOString()}] ${message}`, ...args);
  },
  error: (message: string, ...args: unknown[]) => {
    console.error(`[ERROR] [${new Date().toISOString()}] ${message}`, ...args);
  },
  debug: (message: string, ...args: unknown[]) => {
    if (process.env.DEBUG) {
      console.error(`[DEBUG] [${new Date().toISOString()}] ${message}`, ...args);
    }
  },
};

/**
 * Builds a sanitized diagnostic health snapshot of the server and its environment.
 * Never leaks access tokens, passwords, or secrets.
 */
export function getHealthSnapshot(): ServerHealth {
  const hasAppId = Boolean(config.appId);
  const hasAppSecret = Boolean(config.appSecret);
  const hasUserId = Boolean(config.userId);
  const hasAccessToken = Boolean(config.accessToken);
  const hasWebhookVerifyToken = Boolean(config.webhookVerifyToken);
  const hasRedirectUri = Boolean(config.redirectUri);

  const diagnostics: string[] = [];

  if (!hasAccessToken) {
    diagnostics.push('Missing INSTAGRAM_ACCESS_TOKEN in environment');
  }
  if (!hasUserId) {
    diagnostics.push('Missing INSTAGRAM_USER_ID in environment');
  }
  if (!hasAppId) {
    diagnostics.push('Missing META_APP_ID in environment');
  }
  if (!hasAppSecret) {
    diagnostics.push('Missing META_APP_SECRET in environment');
  }
  if (process.env.META_API_VERSION === 'vXX.X') {
    diagnostics.push(`META_API_VERSION had placeholder 'vXX.X'; auto-resolved to '${config.apiVersion}'`);
  }
  if (!hasWebhookVerifyToken) {
    diagnostics.push('WEBHOOK_VERIFY_TOKEN not set (webhooks will require this in Phase 4)');
  }
  if (!hasRedirectUri) {
    diagnostics.push('INSTAGRAM_REDIRECT_URI not set (OAuth callback flow requires this)');
  }

  let status: ServerHealth['status'] = 'healthy';
  if (!hasAccessToken || !hasUserId) {
    status = 'unconfigured';
  } else if (!hasAppId || !hasAppSecret) {
    status = 'degraded';
  }

  return {
    status,
    server: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      transport: 'stdio',
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
    },
    environment: {
      hasAppId,
      hasAppSecret,
      hasUserId,
      hasAccessToken,
      tokenTypeHint: getTokenHint(config.accessToken),
      apiVersion: config.apiVersion,
      hasWebhookVerifyToken,
      hasRedirectUri,
      port: config.port,
    },
    features: {
      healthCheck: true,
      accountRead: true, // Implemented in Phase 2
      publishing: true,  // Implemented in Phase 3 & 4
      comments: true,    // Implemented in Phase 5
      messaging: true,   // Implemented in Phase 6
      scheduling: true,  // Implemented in Phase 7
      insights: false,   // Planned for future
      oauth: true,       // Foundation implemented in Phase 2
      webhooks: true,    // Implemented in Phase 6
    },
    diagnostics,
  };
}

/**
 * Standardized success response envelope.
 */
export function formatSuccessResponse<T>(data: T): McpSuccessResponse<T> {
  return {
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      server: SERVER_NAME,
      version: SERVER_VERSION,
    },
  };
}

/**
 * Standardized error response envelope with sanitized output.
 */
export function formatErrorResponse(
  code: string,
  message: string,
  details?: unknown,
  remediation?: string
): McpErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      details,
      remediation,
    },
    meta: {
      timestamp: new Date().toISOString(),
      server: SERVER_NAME,
      version: SERVER_VERSION,
    },
  };
}
