import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatErrorResponse, formatSuccessResponse, logger } from '../config.js';
import { instagramApi, InstagramApiError } from '../instagram-api.js';

/**
 * Registers read-only account and token diagnostic tools.
 */
export function registerAccountTools(server: McpServer): void {
  const accountInputSchema = {
    user_id: z
      .string()
      .optional()
      .describe('The Instagram user ID or "me" for authenticated account. Defaults to "me".'),
    fields: z
      .array(z.string())
      .optional()
      .describe(
        'Optional list of fields to request (e.g. id, username, name, account_type, profile_picture_url, followers_count, follows_count, media_count).'
      ),
  };

  const handleAccountRequest = async (args: { user_id?: string; fields?: string[] }) => {
    try {
      const targetUserId = args.user_id?.trim() || 'me';
      logger.info(`Fetching Instagram account details for target: ${targetUserId}`);

      const account = await instagramApi.getAccount(targetUserId, args.fields);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatSuccessResponse(account), null, 2),
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
                  `INSTAGRAM_API_ERROR_${err.code || err.status}`,
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
                'ACCOUNT_LOOKUP_FAILED',
                `Failed to retrieve Instagram account: ${rawMsg}`,
                undefined,
                'Verify network connection and ensure your INSTAGRAM_ACCESS_TOKEN is valid.'
              ),
              null,
              2
            ),
          },
        ],
      };
    }
  };

  // Primary tool: get_instagram_account
  server.registerTool(
    'get_instagram_account',
    {
      description:
        'Retrieve verified profile information and professional status for the authenticated Instagram account (or specified user ID).',
      inputSchema: accountInputSchema,
    },
    async (args) => handleAccountRequest(args)
  );

  // Alias tool: instagram_get_account (standard naming alignment)
  server.registerTool(
    'instagram_get_account',
    {
      description:
        'Alias for get_instagram_account: Retrieve verified profile information for the authenticated Instagram account.',
      inputSchema: accountInputSchema,
    },
    async (args) => handleAccountRequest(args)
  );

  // Diagnostic tool: instagram_verify_token
  server.registerTool(
    'instagram_verify_token',
    {
      description:
        'Verify validity, active status, expiration, and account professional status of the Instagram access token without revealing it.',
      inputSchema: {
        custom_token: z
          .string()
          .optional()
          .describe('Optional custom token to probe. If omitted, validates the currently configured INSTAGRAM_ACCESS_TOKEN.'),
      },
    },
    async (args) => {
      logger.info('Diagnosing Instagram access token validity against live Meta Graph API...');
      const diagnostic = await instagramApi.diagnoseToken(args.custom_token);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatSuccessResponse(diagnostic), null, 2),
          },
        ],
      };
    }
  );
}
