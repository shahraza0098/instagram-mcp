import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatSuccessResponse, getHealthSnapshot } from '../config.js';

/**
 * Registers health and diagnostic tools for the Instagram MCP server.
 */
export function registerHealthTools(server: McpServer): void {
  server.registerTool(
    'instagram_health_check',
    {
      description:
        'Check operational health, transport, and sanitized configuration status of the Instagram MCP server without exposing credentials.',
      inputSchema: {
        verbose: z.boolean().optional().describe('Whether to include extended diagnostics and feature support status'),
      },
    },
    async (args) => {
      const health = getHealthSnapshot();

      if (!args.verbose) {
        const compact = {
          status: health.status,
          server: health.server,
          isConfigured: health.environment.hasAccessToken && health.environment.hasUserId,
          apiVersion: health.environment.apiVersion,
          tokenTypeHint: health.environment.tokenTypeHint,
          diagnosticsCount: health.diagnostics.length,
        };

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(formatSuccessResponse(compact), null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatSuccessResponse(health), null, 2),
          },
        ],
      };
    }
  );
}
