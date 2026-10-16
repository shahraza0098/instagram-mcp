import { config, getTokenHint, logger } from './config.js';
import {
  CarouselItem,
  ContainerStatusResult,
  ConversationsResult,
  InstagramAccount,
  InstagramComment,
  InstagramConversation,
  InstagramMessageItem,
  MediaCommentsResult,
  MediaContainerResult,
  MessagesResult,
  PublishingLimit,
  ReelPublishOptions,
  TokenDiagnostic,
} from './types.js';

/**
 * Standardized error class for Meta / Instagram API responses.
 */
export class InstagramApiError extends Error {
  public readonly status: number;
  public readonly code?: number;
  public readonly subcode?: number;
  public readonly fbtraceId?: string;
  public readonly remediation?: string;

  constructor(
    message: string,
    status = 500,
    details?: { code?: number; subcode?: number; fbtraceId?: string; remediation?: string }
  ) {
    super(message);
    this.name = 'InstagramApiError';
    this.status = status;
    this.code = details?.code;
    this.subcode = details?.subcode;
    this.fbtraceId = details?.fbtraceId;
    this.remediation = details?.remediation;
  }
}

/**
 * Meta Graph API Error payload contract.
 */
interface MetaApiErrorPayload {
  error?: {
    message: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

/**
 * Helper to produce human-friendly remediation guidance based on Meta error codes.
 */
function getErrorRemediation(code?: number, subcode?: number, message?: string): string {
  if (code === 190) {
    if (subcode === 463) {
      return 'The access token has expired. Obtain a new token via the OAuth login flow or refresh an existing long-lived token.';
    }
    if (subcode === 467 || subcode === 460) {
      return 'The access token is invalid or the session has been revoked. Re-authenticate via the OAuth authorization URL.';
    }
    return 'Authentication failed. Please verify your INSTAGRAM_ACCESS_TOKEN in .env or re-authenticate.';
  }

  if (code === 10 || code === 200) {
    return 'Permission denied. Ensure the app has been granted the required permission (e.g. instagram_business_basic, instagram_business_content_publish, instagram_business_manage_messages) in the Meta App Dashboard.';
  }

  if (subcode === 2534014) {
    return 'Recipient user not found. The user does not exist or has never initiated a direct message to this Instagram account.';
  }

  if (subcode === 2534037) {
    return '24-hour messaging window expired or message access disabled. Direct messages can only be sent within 24 hours of the user\'s last message, and "Allow access to messages" must be enabled in the Instagram mobile app settings under Privacy > Messages.';
  }

  if (subcode === 2534017) {
    return 'Recipient cannot be reached. The user may have disabled messages from business accounts or blocked the account.';
  }

  if (code === 100) {
    if (subcode === 33) {
      return 'The account is not a Professional account. Convert the Instagram account to a Creator or Business account in Instagram Mobile App Settings > Account Type and Tools.';
    }
    if (message?.toLowerCase().includes('field')) {
      return 'One or more requested fields are not supported or not permitted for this account type. Try querying standard basic fields (id, username, account_type).';
    }
    return 'Invalid parameter supplied to the Graph API.';
  }

  return 'Check the Meta Developer App status (Development vs Live mode) and verify that the Instagram account is added as a Tester/Developer in the App Roles.';
}

/**
 * Mask any potential token in raw error messages.
 */
function sanitizeErrorMessage(msg?: string): string {
  if (!msg) return 'Unknown Instagram API error occurred.';
  return msg.replace(/[a-zA-Z0-9_-]{35,}/g, '[MASKED_TOKEN]');
}

/**
 * Client for Meta Instagram Graph API (Instagram API with Instagram Login).
 * 
 * Target hosts:
 * - Graph queries & mutations: https://graph.instagram.com/{version}
 */
export class InstagramApiClient {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = `https://graph.instagram.com/${config.apiVersion}`;
  }

  /**
   * Internal HTTP request dispatcher with error normalization and credential protection.
   */
  public async request<T>(
    endpoint: string,
    options: {
      method?: 'GET' | 'POST' | 'DELETE';
      params?: Record<string, string>;
      body?: Record<string, unknown> | URLSearchParams;
      token?: string;
    } = {}
  ): Promise<T> {
    const token = options.token || config.accessToken;
    if (!token) {
      throw new InstagramApiError(
        'Missing Instagram Access Token. Set INSTAGRAM_ACCESS_TOKEN in .env or pass a valid token.',
        401,
        {
          code: 190,
          remediation: 'Configure INSTAGRAM_ACCESS_TOKEN in .env or execute the OAuth login flow.',
        }
      );
    }

    const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    const url = new URL(`${this.baseUrl}/${cleanEndpoint}`);

    // Append access token and query params
    url.searchParams.set('access_token', token);
    if (options.params) {
      for (const [key, val] of Object.entries(options.params)) {
        if (val !== undefined && val !== null) {
          url.searchParams.set(key, val);
        }
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    let fetchBody: string | undefined;
    if (options.body) {
      if (options.body instanceof URLSearchParams) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        fetchBody = options.body.toString();
      } else {
        headers['Content-Type'] = 'application/json';
        fetchBody = JSON.stringify(options.body);
      }
    }

    try {
      const response = await fetch(url.toString(), {
        method: options.method || 'GET',
        headers,
        body: fetchBody,
      });

      const data = (await response.json()) as T & MetaApiErrorPayload;

      if (!response.ok || (data as MetaApiErrorPayload)?.error) {
        const errorData = (data as MetaApiErrorPayload).error;
        const code = errorData?.code;
        const subcode = errorData?.error_subcode;
        const rawMessage = errorData?.message || `HTTP ${response.status} ${response.statusText}`;
        const sanitizedMsg = sanitizeErrorMessage(rawMessage);
        const remediation = getErrorRemediation(code, subcode, rawMessage);

        logger.error(`Instagram API call failed [${response.status}]: ${sanitizedMsg} (code: ${code}, subcode: ${subcode})`);

        throw new InstagramApiError(sanitizedMsg, response.status, {
          code,
          subcode,
          fbtraceId: errorData?.fbtrace_id,
          remediation,
        });
      }

      return data as T;
    } catch (err) {
      if (err instanceof InstagramApiError) {
        throw err;
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      throw new InstagramApiError(`Network or request failure: ${sanitizeErrorMessage(rawMessage)}`, 500);
    }
  }

  /**
   * Fetches basic profile and account information for the authenticated account or a specified ID.
   */
  public async getAccount(
    userId = 'me',
    customFields?: string[],
    tokenOverride?: string
  ): Promise<InstagramAccount> {
    const fields = customFields && customFields.length > 0
      ? customFields.join(',')
      : 'id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count';

    interface RawAccountResponse {
      id: string;
      username: string;
      name?: string;
      account_type?: string;
      profile_picture_url?: string;
      followers_count?: number;
      follows_count?: number;
      media_count?: number;
    }

    const raw = await this.request<RawAccountResponse>(userId, {
      method: 'GET',
      params: { fields },
      token: tokenOverride,
    });

    const isProfessional = raw.account_type === 'BUSINESS' || raw.account_type === 'MEDIA_CREATOR';

    return {
      id: raw.id,
      username: raw.username,
      name: raw.name,
      account_type: raw.account_type || 'UNKNOWN',
      is_professional: isProfessional,
      profile_picture_url: raw.profile_picture_url,
      followers_count: raw.followers_count,
      follows_count: raw.follows_count,
      media_count: raw.media_count,
      diagnostics: {
        is_live_verified: true,
        token_hint: getTokenHint(tokenOverride || config.accessToken),
      },
    };
  }

  /**
   * Diagnostic method to inspect token validity against the live Meta Graph API.
   * Never throws; always returns a structured TokenDiagnostic object.
   */
  public async diagnoseToken(token?: string): Promise<TokenDiagnostic> {
    const candidateToken = token || config.accessToken;

    if (!candidateToken) {
      return {
        isValid: false,
        status: 'missing',
        remediation: 'No token found. Set INSTAGRAM_ACCESS_TOKEN in .env or initiate OAuth login.',
      };
    }

    const tokenHint = getTokenHint(candidateToken);

    try {
      const account = await this.getAccount('me', ['id', 'username', 'account_type'], candidateToken);
      return {
        isValid: true,
        status: 'active',
        tokenHint,
        accountId: account.id,
        username: account.username,
        accountType: account.account_type,
        isProfessional: account.is_professional,
      };
    } catch (err) {
      if (err instanceof InstagramApiError) {
        let status: TokenDiagnostic['status'] = 'invalid';
        if (err.subcode === 463) {
          status = 'expired';
        }
        return {
          isValid: false,
          status,
          tokenHint,
          errorCode: err.code,
          errorSubcode: err.subcode,
          errorMessage: err.message,
          remediation: err.remediation,
        };
      }

      return {
        isValid: false,
        status: 'unknown',
        tokenHint,
        errorMessage: err instanceof Error ? err.message : String(err),
        remediation: 'Check network connectivity to https://graph.instagram.com.',
      };
    }
  }

  /**
   * Retrieves the current content publishing rate limits and quota usage for the account.
   */
  public async getContentPublishingLimit(userId = 'me'): Promise<PublishingLimit> {
    interface LimitResponse {
      data: Array<{
        quota_usage: number;
        config: {
          quota_total: number;
          quota_duration: number;
        };
      }>;
    }

    const raw = await this.request<LimitResponse>(`${userId}/content_publishing_limit`, {
      method: 'GET',
      params: { fields: 'quota_usage,config' },
    });

    const item = raw.data?.[0];
    const quotaUsage = item?.quota_usage ?? 0;
    const quotaTotal = item?.config?.quota_total ?? 100;
    const quotaDuration = item?.config?.quota_duration ?? 86400;

    return {
      quotaUsage,
      quotaTotal,
      quotaDuration,
      quotaRemaining: Math.max(0, quotaTotal - quotaUsage),
    };
  }

  /**
   * Creates an Instagram media container for a single image post.
   */
  public async createImageContainer(
    imageUrl: string,
    caption?: string,
    userId = 'me'
  ): Promise<MediaContainerResult> {
    const params: Record<string, string> = {
      image_url: imageUrl,
    };
    if (caption && caption.trim().length > 0) {
      params.caption = caption.trim();
    }

    const result = await this.request<MediaContainerResult>(`${userId}/media`, {
      method: 'POST',
      params,
    });

    return result;
  }

  /**
   * Checks the status of a media container.
   */
  public async getContainerStatus(containerId: string): Promise<ContainerStatusResult> {
    interface RawStatusResponse {
      status_code?: string;
      status?: string;
    }

    const raw = await this.request<RawStatusResponse>(containerId, {
      method: 'GET',
      params: { fields: 'status_code,status' },
    });

    return {
      statusCode: (raw.status_code || 'FINISHED') as ContainerStatusResult['statusCode'],
      status: raw.status,
    };
  }

  /**
   * Polls container status until it transitions to FINISHED or fails.
   */
  public async waitForContainerReady(
    containerId: string,
    maxWaitMs = 30000,
    pollIntervalMs = 2000
  ): Promise<ContainerStatusResult> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const status = await this.getContainerStatus(containerId);
      logger.info(`Container ${containerId} status: ${status.statusCode}`);

      if (status.statusCode === 'FINISHED') {
        return status;
      }

      if (status.statusCode === 'ERROR') {
        throw new InstagramApiError(
          `Media container processing failed for container ID: ${containerId}`,
          400,
          {
            remediation:
              'Ensure the image URL is publicly accessible, in JPG or PNG format, under 8MB, and has an aspect ratio between 4:5 and 1.91:1.',
          }
        );
      }

      if (status.statusCode === 'EXPIRED') {
        throw new InstagramApiError(
          `Media container has expired for container ID: ${containerId}`,
          400,
          {
            remediation: 'Media containers must be published within 24 hours of creation. Please re-create the container.',
          }
        );
      }

      // Wait before polling again
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new InstagramApiError(
      `Timed out waiting for media container ${containerId} to finish processing after ${maxWaitMs / 1000}s`,
      504,
      {
        remediation: 'The image may be taking longer than expected to process or Meta servers are experiencing elevated latency.',
      }
    );
  }

  /**
   * Publishes a ready media container to the live Instagram feed.
   */
  public async publishContainer(containerId: string, userId = 'me'): Promise<{ id: string }> {
    return this.request<{ id: string }>(`${userId}/media_publish`, {
      method: 'POST',
      params: { creation_id: containerId },
    });
  }

  /**
   * Creates an Instagram media container for a Reel (video post).
   */
  public async createReelContainer(
    options: ReelPublishOptions,
    userId = 'me'
  ): Promise<MediaContainerResult> {
    const params: Record<string, string> = {
      media_type: 'REELS',
      video_url: options.videoUrl,
      share_to_feed: options.shareToFeed !== false ? 'true' : 'false',
    };

    if (options.caption && options.caption.trim().length > 0) {
      params.caption = options.caption.trim();
    }
    if (options.coverUrl && options.coverUrl.trim().length > 0) {
      params.cover_url = options.coverUrl.trim();
    }
    if (options.thumbOffset !== undefined && options.thumbOffset >= 0) {
      params.thumb_offset = options.thumbOffset.toString();
    }

    return this.request<MediaContainerResult>(`${userId}/media`, {
      method: 'POST',
      params,
    });
  }

  /**
   * Creates an individual item container for a carousel post.
   */
  public async createCarouselItemContainer(
    item: CarouselItem,
    userId = 'me'
  ): Promise<MediaContainerResult> {
    const params: Record<string, string> = {
      is_carousel_item: 'true',
    };

    if (item.mediaType === 'VIDEO') {
      params.media_type = 'VIDEO';
      params.video_url = item.url;
    } else {
      params.image_url = item.url;
    }

    return this.request<MediaContainerResult>(`${userId}/media`, {
      method: 'POST',
      params,
    });
  }

  /**
   * Creates the parent carousel container linking 2 to 10 child containers.
   */
  public async createCarouselContainer(
    childIds: string[],
    caption?: string,
    userId = 'me'
  ): Promise<MediaContainerResult> {
    const params: Record<string, string> = {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
    };

    if (caption && caption.trim().length > 0) {
      params.caption = caption.trim();
    }

    return this.request<MediaContainerResult>(`${userId}/media`, {
      method: 'POST',
      params,
    });
  }

  /**
   * Retrieves comments on a specific Instagram media post with optional pagination and nested replies.
   */
  public async getMediaComments(
    mediaId: string,
    options: {
      limit?: number;
      after?: string;
      before?: string;
      includeReplies?: boolean;
    } = {}
  ): Promise<MediaCommentsResult> {
    const limit = options.limit ? Math.min(Math.max(1, options.limit), 50) : 25;
    const includeReplies = options.includeReplies !== false;

    const fields = includeReplies
      ? 'id,text,timestamp,username,like_count,hidden,replies{id,text,timestamp,username,like_count,hidden}'
      : 'id,text,timestamp,username,like_count,hidden';

    const params: Record<string, string> = {
      fields,
      limit: limit.toString(),
    };

    if (options.after) params.after = options.after;
    if (options.before) params.before = options.before;

    interface RawCommentItem {
      id: string;
      text: string;
      timestamp: string;
      username?: string;
      like_count?: number;
      hidden?: boolean;
      replies?: {
        data?: Array<{
          id: string;
          text: string;
          timestamp: string;
          username?: string;
          like_count?: number;
          hidden?: boolean;
        }>;
      };
    }

    interface RawCommentsResponse {
      data?: RawCommentItem[];
      paging?: {
        cursors?: {
          before?: string;
          after?: string;
        };
        next?: string;
        previous?: string;
      };
    }

    const raw = await this.request<RawCommentsResponse>(`${mediaId}/comments`, {
      method: 'GET',
      params,
    });

    const comments: InstagramComment[] = (raw.data || []).map((item) => ({
      id: item.id,
      text: item.text,
      timestamp: item.timestamp,
      username: item.username,
      like_count: item.like_count,
      hidden: item.hidden,
      replies: item.replies?.data?.map((reply) => ({
        id: reply.id,
        text: reply.text,
        timestamp: reply.timestamp,
        username: reply.username,
        like_count: reply.like_count,
        hidden: reply.hidden,
      })),
    }));

    return {
      mediaId,
      totalRetrieved: comments.length,
      comments,
      pagination: raw.paging?.cursors
        ? {
            before: raw.paging.cursors.before,
            after: raw.paging.cursors.after,
            hasNextPage: Boolean(raw.paging.next),
            hasPreviousPage: Boolean(raw.paging.previous),
          }
        : undefined,
    };
  }

  /**
   * Retrieves individual comment metadata for verification or audit.
   */
  public async getCommentDetails(commentId: string): Promise<InstagramComment> {
    interface RawCommentDetail {
      id: string;
      text: string;
      timestamp: string;
      username?: string;
      like_count?: number;
      hidden?: boolean;
    }

    const raw = await this.request<RawCommentDetail>(commentId, {
      method: 'GET',
      params: { fields: 'id,text,timestamp,username,like_count,hidden' },
    });

    return {
      id: raw.id,
      text: raw.text,
      timestamp: raw.timestamp,
      username: raw.username,
      like_count: raw.like_count,
      hidden: raw.hidden,
    };
  }

  /**
   * Replies to an existing comment on Instagram.
   */
  public async replyToComment(commentId: string, message: string): Promise<{ id: string }> {
    return this.request<{ id: string }>(`${commentId}/replies`, {
      method: 'POST',
      params: { message: message.trim() },
    });
  }

  /**
   * Hides or unhides an Instagram comment from public view.
   */
  public async hideComment(commentId: string, hide = true): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(commentId, {
      method: 'POST',
      params: { hide: hide ? 'true' : 'false' },
    });
  }

  /**
   * Retrieves active Instagram Direct Message conversations.
   */
  public async getConversations(
    userId = 'me',
    limit = 25,
    after?: string,
    before?: string
  ): Promise<ConversationsResult> {
    const cleanLimit = Math.min(Math.max(1, limit), 50);
    const params: Record<string, string> = {
      platform: 'instagram',
      fields: 'id,updated_time,participants',
      limit: cleanLimit.toString(),
    };
    if (after) params.after = after;
    if (before) params.before = before;

    interface RawConversationsResponse {
      data?: Array<{
        id: string;
        updated_time: string;
        participants?: {
          data?: Array<{
            id: string;
            username?: string;
          }>;
        };
      }>;
      paging?: {
        cursors?: {
          before?: string;
          after?: string;
        };
        next?: string;
      };
    }

    const raw = await this.request<RawConversationsResponse>(`${userId}/conversations`, {
      method: 'GET',
      params,
    });

    const conversations: InstagramConversation[] = (raw.data || []).map((item) => ({
      id: item.id,
      updated_time: item.updated_time,
      participants: item.participants?.data,
    }));

    return {
      totalRetrieved: conversations.length,
      conversations,
      pagination: raw.paging?.cursors
        ? {
            before: raw.paging.cursors.before,
            after: raw.paging.cursors.after,
            hasNextPage: Boolean(raw.paging.next),
          }
        : undefined,
    };
  }

  /**
   * Retrieves messages in a specific conversation thread.
   */
  public async getConversationMessages(
    conversationId: string,
    limit = 25,
    after?: string,
    before?: string
  ): Promise<MessagesResult> {
    const cleanLimit = Math.min(Math.max(1, limit), 50);
    const params: Record<string, string> = {
      fields: 'id,created_time,from,to,message',
      limit: cleanLimit.toString(),
    };
    if (after) params.after = after;
    if (before) params.before = before;

    interface RawMessagesResponse {
      data?: Array<{
        id: string;
        created_time: string;
        from: { id: string; username?: string };
        to?: { data?: Array<{ id: string; username?: string }> };
        message?: string;
      }>;
      paging?: {
        cursors?: {
          before?: string;
          after?: string;
        };
        next?: string;
      };
    }

    const raw = await this.request<RawMessagesResponse>(`${conversationId}/messages`, {
      method: 'GET',
      params,
    });

    const messages: InstagramMessageItem[] = (raw.data || []).map((item) => ({
      id: item.id,
      created_time: item.created_time,
      from: item.from,
      to: item.to?.data,
      message: item.message,
    }));

    return {
      conversationId,
      totalRetrieved: messages.length,
      messages,
      pagination: raw.paging?.cursors
        ? {
            before: raw.paging.cursors.before,
            after: raw.paging.cursors.after,
            hasNextPage: Boolean(raw.paging.next),
          }
        : undefined,
    };
  }

  /**
   * Sends a direct text message to an Instagram user (within the 24-hour messaging window).
   */
  public async sendDirectMessage(
    recipientId: string,
    text: string,
    userId = 'me'
  ): Promise<{ recipientId: string; messageId: string }> {
    interface SendMsgResponse {
      recipient_id?: string;
      message_id?: string;
    }

    const result = await this.request<SendMsgResponse>(`${userId}/messages`, {
      method: 'POST',
      body: {
        recipient: { id: recipientId },
        message: { text: text.trim() },
      },
    });

    return {
      recipientId: result.recipient_id || recipientId,
      messageId: result.message_id || 'unknown',
    };
  }
}

export const instagramApi = new InstagramApiClient();
