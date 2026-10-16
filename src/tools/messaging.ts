import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatErrorResponse, formatSuccessResponse, logger } from '../config.js';
import { instagramApi, InstagramApiError } from '../instagram-api.js';
import { InstagramWebhookHandler } from '../webhooks.js';

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
 * Registers direct messaging and webhook management tools for Instagram Graph API.
 */
export function registerMessagingTools(server: McpServer): void {
  // ==========================================
  // Tool 1: get_conversations
  // ==========================================
  const getConversationsHandler = async (args: { limit?: number; after?: string; before?: string }) => {
    const { limit = 25, after, before } = args;

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
                'Provide a valid cursor string from a previous get_conversations response.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    try {
      logger.info(`Fetching Instagram conversations (limit: ${limit})`);
      const result = await instagramApi.getConversations('me', limit, after, before);

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
                  `CONVERSATIONS_QUERY_FAILED_${err.code || err.status}`,
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
                'CONVERSATIONS_RETRIEVAL_ERROR',
                `Failed to retrieve conversations: ${rawMsg}`,
                undefined,
                'Ensure your token has instagram_business_manage_messages and "Allow access to messages" is enabled in Instagram mobile app settings.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }
  };

  const getConversationsSchema = {
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Number of conversation threads to return per page (1 to 50, default: 25).'),
    after: z.string().optional().describe('Pagination cursor for the next page of conversations.'),
    before: z.string().optional().describe('Pagination cursor for the previous page of conversations.'),
  };

  server.registerTool(
    'get_conversations',
    {
      description: 'List active direct message conversation threads for the authenticated Instagram account.',
      inputSchema: getConversationsSchema,
    },
    getConversationsHandler
  );

  // Alias
  server.registerTool(
    'instagram_get_conversations',
    {
      description: 'Alias for get_conversations: List active direct message conversation threads.',
      inputSchema: getConversationsSchema,
    },
    getConversationsHandler
  );

  // ==========================================
  // Tool 2: get_conversation_messages
  // ==========================================
  const getMessagesHandler = async (args: {
    conversationId: string;
    limit?: number;
    after?: string;
    before?: string;
  }) => {
    const { conversationId, limit = 25, after, before } = args;

    if (!isValidMetaId(conversationId)) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'INVALID_CONVERSATION_ID',
                `Invalid conversation ID format '${conversationId}'. Meta IDs must be 10-25 digits.`,
                { conversationId },
                'Provide a valid conversation ID from get_conversations.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

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
                'Provide a valid cursor string from a previous response.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    try {
      logger.info(`Fetching messages for conversation ID: ${conversationId} (limit: ${limit})`);
      const result = await instagramApi.getConversationMessages(conversationId, limit, after, before);

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
                  `MESSAGES_QUERY_FAILED_${err.code || err.status}`,
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
                'MESSAGES_RETRIEVAL_ERROR',
                `Failed to retrieve conversation messages: ${rawMsg}`,
                undefined,
                'Verify that the conversation ID exists and is accessible.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }
  };

  const getMessagesSchema = {
    conversationId: z.string().describe('The Instagram Conversation ID (e.g. from get_conversations).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Number of messages to return per page (1 to 50, default: 25).'),
    after: z.string().optional().describe('Pagination cursor for the next page of messages.'),
    before: z.string().optional().describe('Pagination cursor for the previous page of messages.'),
  };

  server.registerTool(
    'get_conversation_messages',
    {
      description: 'Retrieve message history and participants within a specific Instagram conversation thread.',
      inputSchema: getMessagesSchema,
    },
    getMessagesHandler
  );

  // Alias
  server.registerTool(
    'instagram_get_messages',
    {
      description: 'Alias for get_conversation_messages: Retrieve message history within a conversation.',
      inputSchema: getMessagesSchema,
    },
    getMessagesHandler
  );

  // ==========================================
  // Tool 3: send_direct_message
  // ==========================================
  const sendMessageHandler = async (args: {
    recipientId: string;
    text: string;
    confirm_send?: boolean;
  }) => {
    const { recipientId, text, confirm_send } = args;

    // 1. Validate recipient ID format
    if (!isValidMetaId(recipientId)) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'INVALID_RECIPIENT_ID',
                `Invalid recipient ID format '${recipientId}'. Meta IGSIDs must be 10-25 digits.`,
                { recipientId },
                'Provide an Instagram-Scoped ID (IGSID) of a user who has previously messaged your account.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    // 2. Validate message text
    const cleanText = text.trim();
    if (cleanText.length === 0 || cleanText.length > 1000) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              formatErrorResponse(
                'INVALID_MESSAGE_TEXT',
                `Direct message text must be between 1 and 1,000 characters. Length: ${cleanText.length}.`,
                { textLength: cleanText.length, maxAllowed: 1000 },
                'Ensure the message text is non-empty and does not exceed 1,000 characters.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    // 3. Server-enforced confirmation check
    if (confirm_send !== true) {
      logger.info(`Message pre-flight passed for recipient ID: ${recipientId}; awaiting explicit confirmation.`);
      const dryRunResponse = {
        status: 'CONFIRMATION_REQUIRED',
        sent: false,
        message:
          'Pre-flight validation passed. User confirmation is strictly required before sending a direct message.',
        preview: {
          recipientId,
          text: cleanText,
          characterCount: cleanText.length,
        },
        policy_notice:
          'Meta messaging policy requires that messages are sent only within 24 hours of the user\'s last interaction. Unsolicited outbound DMs are prohibited.',
        action_required:
          'To send this direct message live to Instagram, call send_direct_message again with confirm_send set to true.',
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

    // 4. User confirmed - Execute dispatch
    try {
      logger.info(`[AUDIT] Dispatching direct message to recipient: ${recipientId}`);
      const result = await instagramApi.sendDirectMessage(recipientId, cleanText);
      const timestamp = new Date().toISOString();

      logger.info(`[AUDIT] Message successfully sent! Message ID: ${result.messageId} to recipient: ${recipientId}`);

      const responsePayload = {
        success: true,
        status: 'SENT',
        sent: true,
        message_id: result.messageId,
        recipient_id: result.recipientId,
        message: 'Direct message was successfully sent to the Instagram user.',
        audit_trail: {
          action: 'DIRECT_MESSAGE_SENT',
          recipientId: result.recipientId,
          messageId: result.messageId,
          characterCount: cleanText.length,
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
                  `SEND_MESSAGE_FAILED_${err.code || err.status}`,
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
                'SEND_MESSAGE_EXECUTION_ERROR',
                `Failed to send direct message: ${rawMsg}`,
                undefined,
                'Verify that the recipient has messaged you within the last 24 hours.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }
  };

  const sendMessageSchema = {
    recipientId: z
      .string()
      .describe('The Instagram-Scoped ID (IGSID) of the recipient user (from incoming webhooks or conversation history).'),
    text: z.string().min(1).max(1000).describe('The message text to send (1 to 1,000 characters).'),
    confirm_send: z
      .boolean()
      .optional()
      .describe(
        'Explicit user approval to send this direct message on Instagram. Must be set to true to execute. If false or omitted, performs pre-flight validation only.'
      ),
  };

  server.registerTool(
    'send_direct_message',
    {
      description:
        'Send a direct message reply to an Instagram user within the 24-hour messaging window. Requires explicit confirmation (confirm_send: true) before sending.',
      inputSchema: sendMessageSchema,
    },
    sendMessageHandler
  );

  // Alias
  server.registerTool(
    'instagram_send_message',
    {
      description: 'Alias for send_direct_message: Send a direct message reply to an Instagram user.',
      inputSchema: sendMessageSchema,
    },
    sendMessageHandler
  );

  // ==========================================
  // Tool 4: get_webhook_status
  // ==========================================
  server.registerTool(
    'get_webhook_status',
    {
      description:
        'Inspect the status of the local Meta Webhook listener, incoming event queue, deduplication metrics, and configuration instructions.',
      inputSchema: {},
    },
    async () => {
      logger.info('Retrieving Meta webhook listener status and metrics...');
      const status = InstagramWebhookHandler.getStatus();

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatSuccessResponse(status), null, 2),
          },
        ],
      };
    }
  );

  // Alias
  server.registerTool(
    'instagram_webhook_status',
    {
      description: 'Alias for get_webhook_status: Check webhook listener status and recent incoming events.',
      inputSchema: {},
    },
    async () => {
      const status = InstagramWebhookHandler.getStatus();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatSuccessResponse(status), null, 2),
          },
        ],
      };
    }
  );
}
