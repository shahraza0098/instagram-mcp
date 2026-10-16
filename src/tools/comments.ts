import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatErrorResponse, formatSuccessResponse, logger } from '../config.js';
import { instagramApi, InstagramApiError } from '../instagram-api.js';

/**
 * Validates Meta Graph API numeric ID format (10 to 25 digits).
 */
function isValidMetaId(id?: string): boolean {
  if (!id) return false;
  return /^\d{10,25}$/.test(id.trim());
}

/**
 * Validates pagination cursor strings (alphanumeric/base64 up to 500 characters).
 */
function isValidCursor(cursor?: string): boolean {
  if (!cursor) return true;
  return /^[a-zA-Z0-9_\-=]{1,500}$/.test(cursor.trim());
}

/**
 * Registers comment management tools for Instagram Graph API.
 */
export function registerCommentsTools(server: McpServer): void {
  // ==========================================
  // Tool 1: get_media_comments
  // ==========================================
  const getCommentsHandler = async (args: {
    mediaId: string;
    limit?: number;
    after?: string;
    before?: string;
    includeReplies?: boolean;
  }) => {
    const { mediaId, limit = 25, after, before, includeReplies = true } = args;

    // 1. Validate Media ID
    if (!isValidMetaId(mediaId)) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'INVALID_MEDIA_ID',
                `Invalid media ID format '${mediaId}'. Meta media IDs must be 10-25 digits.`,
                { mediaId },
                'Provide a valid Instagram Media ID (e.g. from get_instagram_account or recent media listings).'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    // 2. Validate pagination cursors
    if (!isValidCursor(after) || !isValidCursor(before)) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'INVALID_PAGINATION_CURSOR',
                'Invalid pagination cursor format provided.',
                { after, before },
                'Provide a valid cursor string obtained from a previous get_media_comments response.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    try {
      logger.info(`Fetching comments for media ID: ${mediaId} (limit: ${limit})`);
      const result = await instagramApi.getMediaComments(mediaId, {
        limit,
        after,
        before,
        includeReplies,
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
      if (err instanceof InstagramApiError) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                formatErrorResponse(
                  `COMMENTS_QUERY_FAILED_${err.code || err.status}`,
                  err.message,
                  {
                    status: err.status,
                    code: err.code,
                    subcode: err.subcode,
                    fbtraceId: err.fbtraceId,
                  },
                  err.remediation
                ),
                null,
                2
              ),
            },
          ],
        };
      }

      const rawMsg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'COMMENTS_RETRIEVAL_ERROR',
                `Failed to retrieve comments: ${rawMsg}`,
                undefined,
                'Verify that the media ID exists and your access token has instagram_business_manage_comments permission.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }
  };

  const getCommentsSchema = {
    mediaId: z.string().describe('The Instagram Media ID to retrieve comments for (e.g. "18092345872634440").'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Number of top-level comments to return per page (1 to 50, default: 25).'),
    after: z.string().optional().describe('Pagination cursor for the next page of comments.'),
    before: z.string().optional().describe('Pagination cursor for the previous page of comments.'),
    includeReplies: z
      .boolean()
      .optional()
      .describe('Whether to fetch nested reply comments under each top-level comment (default: true).'),
  };

  server.registerTool(
    'get_media_comments',
    {
      description:
        'Retrieve comments and nested replies for an Instagram media post with pagination and like counts.',
      inputSchema: getCommentsSchema,
    },
    getCommentsHandler
  );

  // Alias
  server.registerTool(
    'instagram_get_comments',
    {
      description: 'Alias for get_media_comments: Retrieve comments for a media post.',
      inputSchema: getCommentsSchema,
    },
    getCommentsHandler
  );

  // ==========================================
  // Tool 2: reply_to_comment
  // ==========================================
  const replyCommentHandler = async (args: {
    commentId: string;
    message: string;
    confirm_reply?: boolean;
  }) => {
    const { commentId, message, confirm_reply } = args;

    // 1. Validate Comment ID format
    if (!isValidMetaId(commentId)) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'INVALID_COMMENT_ID',
                `Invalid comment ID format '${commentId}'. Meta comment IDs must be 10-25 digits.`,
                { commentId },
                'Provide a valid Instagram Comment ID obtained from get_media_comments.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    // 2. Validate reply message text
    const cleanMessage = message.trim();
    if (cleanMessage.length === 0 || cleanMessage.length > 1000) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'INVALID_REPLY_MESSAGE',
                `Reply message must be between 1 and 1,000 characters. Length: ${cleanMessage.length}.`,
                { messageLength: cleanMessage.length, maxAllowed: 1000 },
                'Ensure the reply text is not empty and does not exceed 1,000 characters.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    // 3. Server-enforced confirmation check
    if (confirm_reply !== true) {
      logger.info(`Reply pre-flight validation passed for comment ID: ${commentId}; awaiting explicit confirmation.`);
      const dryRunResponse = {
        status: 'CONFIRMATION_REQUIRED',
        replied: false,
        message:
          'Pre-flight validation passed. User confirmation is strictly required before posting this reply to Instagram live.',
        preview: {
          targetCommentId: commentId,
          replyText: cleanMessage,
          characterCount: cleanMessage.length,
        },
        action_required:
          'To post this reply live to Instagram, call reply_to_comment again with confirm_reply set to true.',
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatSuccessResponse(dryRunResponse), null, 2),
          },
        ],
      };
    }

    // 4. User confirmed - Execute reply
    try {
      logger.info(`[AUDIT] Posting reply to Instagram comment ID: ${commentId}`);
      const result = await instagramApi.replyToComment(commentId, cleanMessage);
      const timestamp = new Date().toISOString();

      logger.info(`[AUDIT] Reply successfully posted! Reply ID: ${result.id} for parent comment: ${commentId}`);

      const responsePayload = {
        success: true,
        status: 'REPLIED',
        replied: true,
        reply_id: result.id,
        target_comment_id: commentId,
        message: 'Reply was successfully posted to the Instagram comment.',
        audit_trail: {
          action: 'REPLY_POSTED',
          targetCommentId: commentId,
          replyId: result.id,
          characterCount: cleanMessage.length,
          timestamp,
        },
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatSuccessResponse(responsePayload), null, 2),
          },
        ],
      };
    } catch (err) {
      if (err instanceof InstagramApiError) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                formatErrorResponse(
                  `REPLY_FAILED_${err.code || err.status}`,
                  err.message,
                  {
                    status: err.status,
                    code: err.code,
                    subcode: err.subcode,
                    fbtraceId: err.fbtraceId,
                  },
                  err.remediation
                ),
                null,
                2
              ),
            },
          ],
        };
      }

      const rawMsg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'REPLY_EXECUTION_ERROR',
                `Failed to post reply: ${rawMsg}`,
                undefined,
                'Verify that the comment exists and your access token has instagram_business_manage_comments permission.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }
  };

  const replyCommentSchema = {
    commentId: z.string().describe('The Instagram Comment ID to reply to (e.g. "17858843269216389").'),
    message: z.string().min(1).max(1000).describe('The reply text message (1 to 1,000 characters).'),
    confirm_reply: z
      .boolean()
      .optional()
      .describe(
        'Explicit user approval to post this reply live on Instagram. Must be set to true to execute. If false or omitted, performs pre-flight validation only.'
      ),
  };

  server.registerTool(
    'reply_to_comment',
    {
      description:
        'Reply to an existing comment on an Instagram post. Requires explicit confirmation (confirm_reply: true) before posting.',
      inputSchema: replyCommentSchema,
    },
    replyCommentHandler
  );

  // Alias
  server.registerTool(
    'instagram_reply_comment',
    {
      description: 'Alias for reply_to_comment: Reply to an existing comment on Instagram.',
      inputSchema: replyCommentSchema,
    },
    replyCommentHandler
  );

  // ==========================================
  // Tool 3: hide_comment
  // ==========================================
  const hideCommentHandler = async (args: {
    commentId: string;
    hide?: boolean;
    confirm_hide?: boolean;
  }) => {
    const { commentId, hide = true, confirm_hide } = args;

    // 1. Validate Comment ID format
    if (!isValidMetaId(commentId)) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'INVALID_COMMENT_ID',
                `Invalid comment ID format '${commentId}'. Meta comment IDs must be 10-25 digits.`,
                { commentId },
                'Provide a valid Instagram Comment ID.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    const actionName = hide ? 'HIDE' : 'UNHIDE';

    // 2. Server-enforced confirmation check
    if (confirm_hide !== true) {
      logger.info(`Moderation pre-flight passed for comment ID: ${commentId} (${actionName}); awaiting confirmation.`);
      const dryRunResponse = {
        status: 'CONFIRMATION_REQUIRED',
        moderated: false,
        message: `Pre-flight validation passed. User confirmation is strictly required before ${hide ? 'hiding' : 'unhiding'} this comment on Instagram.`,
        preview: {
          targetCommentId: commentId,
          requestedAction: actionName,
        },
        action_required: `To execute this moderation action on Instagram, call hide_comment again with confirm_hide set to true.`,
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatSuccessResponse(dryRunResponse), null, 2),
          },
        ],
      };
    }

    // 3. User confirmed - Execute moderation
    try {
      logger.info(`[AUDIT] Executing ${actionName} on Instagram comment ID: ${commentId}`);
      const result = await instagramApi.hideComment(commentId, hide);
      const timestamp = new Date().toISOString();

      logger.info(`[AUDIT] Comment ${commentId} successfully ${hide ? 'hidden' : 'unhidden'}!`);

      const responsePayload = {
        success: result.success,
        status: 'MODERATED',
        comment_id: commentId,
        hidden: hide,
        message: `Comment was successfully ${hide ? 'hidden from' : 'made visible to'} public view on Instagram.`,
        audit_trail: {
          action: hide ? 'COMMENT_HIDDEN' : 'COMMENT_UNHIDDEN',
          targetCommentId: commentId,
          hidden: hide,
          timestamp,
        },
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatSuccessResponse(responsePayload), null, 2),
          },
        ],
      };
    } catch (err) {
      if (err instanceof InstagramApiError) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                formatErrorResponse(
                  `MODERATION_FAILED_${err.code || err.status}`,
                  err.message,
                  {
                    status: err.status,
                    code: err.code,
                    subcode: err.subcode,
                    fbtraceId: err.fbtraceId,
                  },
                  err.remediation
                ),
                null,
                2
              ),
            },
          ],
        };
      }

      const rawMsg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'MODERATION_EXECUTION_ERROR',
                `Failed to moderate comment: ${rawMsg}`,
                undefined,
                'Verify that the comment exists and your access token has instagram_business_manage_comments permission.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }
  };

  const hideCommentSchema = {
    commentId: z.string().describe('The Instagram Comment ID to moderate (e.g. "17858843269216389").'),
    hide: z
      .boolean()
      .optional()
      .describe('True to hide the comment from public view, false to unhide it (default: true).'),
    confirm_hide: z
      .boolean()
      .optional()
      .describe(
        'Explicit user approval to moderate this comment live on Instagram. Must be set to true to execute. If false or omitted, performs pre-flight validation only.'
      ),
  };

  server.registerTool(
    'hide_comment',
    {
      description:
        'Hide or unhide an Instagram comment from public view. Requires explicit confirmation (confirm_hide: true) before moderating.',
      inputSchema: hideCommentSchema,
    },
    hideCommentHandler
  );

  // Alias
  server.registerTool(
    'instagram_hide_comment',
    {
      description: 'Alias for hide_comment: Hide or unhide a comment on Instagram.',
      inputSchema: hideCommentSchema,
    },
    hideCommentHandler
  );
}
