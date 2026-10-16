import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import { config, getTokenHint, logger, maskSecret } from './config.js';
import { OAuthTokenResult } from './types.js';

/**
 * Service for managing Instagram Login OAuth 2.0 flow.
 * Target hosts:
 * - Authorization: https://www.instagram.com/oauth/authorize
 * - Short-lived Token Exchange: https://api.instagram.com/oauth/access_token
 * - Long-lived Token Exchange/Refresh: https://graph.instagram.com
 */
export class InstagramOAuthService {
  /**
   * Generates the authorization URL for Instagram Login.
   * Only requests 'instagram_business_basic' in Phase 2 to avoid unnecessary permissions.
   */
  public static getAuthorizationUrl(customRedirectUri?: string, state?: string): string {
    const redirectUri = customRedirectUri || config.redirectUri || `http://localhost:${config.port}/oauth/callback`;
    const appId = config.appId;

    if (!appId) {
      throw new Error('META_APP_ID is not configured in .env');
    }

    const params = new URLSearchParams({
      enable_fb_login: '0',
      force_authentication: '1',
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'instagram_business_basic',
    });

    if (state) {
      params.set('state', state);
    }

    return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchanges an authorization code for a short-lived access token.
   * Meta sends code with an optional trailing '#_', which must be stripped.
   */
  public static async exchangeCodeForToken(code: string, customRedirectUri?: string): Promise<OAuthTokenResult> {
    const cleanCode = code.replace(/#_$/, '');
    const redirectUri = customRedirectUri || config.redirectUri || `http://localhost:${config.port}/oauth/callback`;
    const appId = config.appId;
    const appSecret = config.appSecret;

    if (!appId || !appSecret) {
      throw new Error('META_APP_ID and META_APP_SECRET must be configured in .env');
    }

    const body = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code: cleanCode,
    });

    const response = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    const data = await response.json();

    if (!response.ok || data.error_type || data.error_message) {
      const errorMsg = data.error_message || data.error?.message || `HTTP ${response.status}`;
      logger.error(`OAuth code exchange failed: ${errorMsg}`);
      throw new Error(`Instagram OAuth exchange failed: ${errorMsg}`);
    }

    return {
      access_token: data.access_token,
      user_id: data.user_id,
    };
  }

  /**
   * Exchanges a short-lived access token for a 60-day long-lived access token.
   */
  public static async exchangeForLongLivedToken(shortLivedToken: string): Promise<OAuthTokenResult> {
    const appSecret = config.appSecret;
    if (!appSecret) {
      throw new Error('META_APP_SECRET is not configured in .env');
    }

    const url = new URL('https://graph.instagram.com/access_token');
    url.searchParams.set('grant_type', 'ig_exchange_token');
    url.searchParams.set('client_secret', appSecret);
    url.searchParams.set('access_token', shortLivedToken);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      const errorMsg = data.error?.message || `HTTP ${response.status}`;
      logger.error(`Long-lived token exchange failed: ${errorMsg}`);
      throw new Error(`Long-lived token exchange failed: ${errorMsg}`);
    }

    return {
      access_token: data.access_token,
      token_type: data.token_type,
      expires_in: data.expires_in,
    };
  }

  /**
   * Refreshes an active long-lived token before it expires (must be at least 24 hours old).
   */
  public static async refreshLongLivedToken(token?: string): Promise<OAuthTokenResult> {
    const activeToken = token || config.accessToken;
    if (!activeToken) {
      throw new Error('No token available to refresh. Configure INSTAGRAM_ACCESS_TOKEN in .env');
    }

    const url = new URL('https://graph.instagram.com/refresh_access_token');
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', activeToken);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      const errorMsg = data.error?.message || `HTTP ${response.status}`;
      logger.error(`Token refresh failed: ${errorMsg}`);
      throw new Error(`Token refresh failed: ${errorMsg}`);
    }

    return {
      access_token: data.access_token,
      token_type: data.token_type,
      expires_in: data.expires_in,
    };
  }

  private static validStates = new Map<string, number>();

  /**
   * Express router exposing /oauth/login, /oauth/callback, and /oauth/refresh.
   */
  public static createRouter(): Router {
    const router = Router();

    // GET /oauth/login - Redirects to Meta Instagram authorization dialog with CSRF state
    router.get('/login', (_req: Request, res: Response) => {
      try {
        // Generate cryptographically random state to protect against CSRF
        const state = crypto.randomBytes(24).toString('hex');
        InstagramOAuthService.validStates.set(state, Date.now() + 10 * 60 * 1000); // 10 min TTL

        // Purge expired states
        const now = Date.now();
        for (const [st, exp] of InstagramOAuthService.validStates.entries()) {
          if (now > exp) InstagramOAuthService.validStates.delete(st);
        }

        const authUrl = InstagramOAuthService.getAuthorizationUrl(undefined, state);
        logger.info('Redirecting user to Instagram authorization dialog with secure state');
        res.redirect(authUrl);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        res.status(500).send(`<h3>OAuth Configuration Error</h3><p>${errorMsg}</p>`);
      }
    });

    // GET /oauth/callback - Handles redirect callback from Meta
    router.get('/callback', async (req: Request, res: Response) => {
      const code = req.query.code as string | undefined;
      const state = req.query.state as string | undefined;
      const error = req.query.error as string | undefined;
      const errorReason = req.query.error_reason as string | undefined;
      const errorDescription = req.query.error_description as string | undefined;

      if (error) {
        logger.warn(`Instagram authorization declined: ${error} - ${errorDescription}`);
        res.status(400).send(`
          <!DOCTYPE html>
          <html>
            <body style="font-family: sans-serif; padding: 2rem;">
              <h2 style="color: #c00;">Authorization Denied by User</h2>
              <p>Reason: ${errorReason || error}</p>
              <p>Details: ${errorDescription || 'None provided'}</p>
              <a href="/oauth/login">Try Again</a>
            </body>
          </html>
        `);
        return;
      }

      // Verify OAuth CSRF state parameter
      if (!state || !InstagramOAuthService.validStates.has(state)) {
        logger.warn('OAuth callback rejected: Missing or unrecognized state parameter (potential CSRF).');
        res.status(403).send(`
          <!DOCTYPE html>
          <html>
            <body style="font-family: sans-serif; padding: 2rem;">
              <h2 style="color: #c00;">Security Error (CSRF Protection)</h2>
              <p>Invalid or expired state parameter. Please restart the login flow.</p>
              <a href="/oauth/login">Restart OAuth Login</a>
            </body>
          </html>
        `);
        return;
      }

      const expiry = InstagramOAuthService.validStates.get(state) || 0;
      InstagramOAuthService.validStates.delete(state); // Single-use consumption
      if (Date.now() > expiry) {
        logger.warn('OAuth callback rejected: State parameter has expired.');
        res.status(403).send('<h3>Expired State</h3><p>OAuth state has expired. Please try logging in again.</p>');
        return;
      }

      if (!code) {
        res.status(400).send('<h3>Invalid Request</h3><p>Missing authorization code from Instagram.</p>');
        return;
      }

      try {
        logger.info('Exchanging OAuth authorization code for short-lived token...');
        const shortLived = await InstagramOAuthService.exchangeCodeForToken(code);

        logger.info('Upgrading short-lived token to 60-day long-lived token...');
        const longLived = await InstagramOAuthService.exchangeForLongLivedToken(shortLived.access_token);

        const tokenHint = getTokenHint(longLived.access_token);
        const masked = maskSecret(longLived.access_token);
        const days = longLived.expires_in ? Math.floor(longLived.expires_in / 86400) : 60;

        // Safely update running server config in memory
        config.accessToken = longLived.access_token;
        config.userId = String(shortLived.user_id);

        logger.info(`OAuth token exchange succeeded for User ID: ${shortLived.user_id}`);

        res.send(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <title>Instagram Auth Success</title>
            </head>
            <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 2rem; max-width: 600px; margin: auto; line-height: 1.5;">
              <h2 style="color: #0b8043;">✓ Instagram Authentication Succeeded</h2>
              <p>Your Instagram account has been authorized and loaded into server memory.</p>
              <ul style="background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 1.5rem 2rem;">
                <li><strong>Instagram Account ID:</strong> ${shortLived.user_id}</li>
                <li><strong>Token Type:</strong> Long-lived (~${days} days validity)</li>
                <li><strong>Token Hint:</strong> <code>${tokenHint}</code></li>
                <li><strong>Masked Preview:</strong> <code>${masked}</code></li>
              </ul>
              <div style="background: #eef2ff; border: 1px solid #c7d2fe; padding: 1.25rem; border-radius: 8px; margin-top: 1.5rem;">
                <p style="margin-top: 0;"><strong>Active Session:</strong> The active token is now running in server memory.</p>
                <small style="color: #4b5563;">For persistent storage across cold restarts on your production server, verify your server's secure environment file.</small>
              </div>
            </body>
          </html>
        `);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(`OAuth callback handling failed: ${errorMsg}`);
        res.status(500).send(`
          <!DOCTYPE html>
          <html>
            <body style="font-family: sans-serif; padding: 2rem;">
              <h2 style="color: #c00;">Token Exchange Failed</h2>
              <p>${errorMsg}</p>
              <a href="/oauth/login">Restart OAuth Flow</a>
            </body>
          </html>
        `);
      }
    });

    // GET /oauth/refresh - Refreshes the currently active long-lived token
    router.get('/refresh', async (req: Request, res: Response) => {
      // Access control: Require admin key if configured, or restrict to loopback/local
      const adminKey = process.env.ADMIN_API_KEY?.trim();
      const clientKey = req.headers['x-admin-key'] || req.query.admin_key;
      const remoteIp = req.socket.remoteAddress || '';
      const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';

      if (adminKey && clientKey !== adminKey) {
        logger.warn(`Unauthorized attempt to refresh token from IP: ${remoteIp}`);
        res.status(401).json({ success: false, error: 'Unauthorized: Invalid x-admin-key' });
        return;
      }

      if (!adminKey && !isLoopback) {
        logger.warn(`Remote token refresh attempt blocked without ADMIN_API_KEY from IP: ${remoteIp}`);
        res.status(403).json({ success: false, error: 'Forbidden: Configure ADMIN_API_KEY to allow remote token refresh.' });
        return;
      }

      try {
        logger.info('Refreshing active Instagram long-lived token...');
        const refreshed = await InstagramOAuthService.refreshLongLivedToken();
        const days = refreshed.expires_in ? Math.floor(refreshed.expires_in / 86400) : 60;
        config.accessToken = refreshed.access_token;
        logger.info('Token refresh succeeded and updated in server memory.');
        res.json({
          success: true,
          message: `Token refreshed successfully. Valid for ~${days} days.`,
          token_hint: getTokenHint(refreshed.access_token),
          expires_in: refreshed.expires_in,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ success: false, error: errorMsg });
      }
    });

    return router;
  }
}
