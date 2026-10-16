import express from 'express';
import { Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config, logger } from './config.js';
import { registerHealthTools } from './tools/health.js';
import { registerAccountTools } from './tools/account.js';
import { registerPublishTools } from './tools/publish.js';
import { registerCommentsTools } from './tools/comments.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerInsightsTools } from './tools/insights.js';
import { registerSchedulingTools } from './tools/scheduling.js';
import { InstagramOAuthService } from './oauth.js';
import { InstagramWebhookHandler } from './webhooks.js';
import { SchedulerQueue } from './scheduler/queue.js';

/**
 * Initializes and starts the Instagram Model Context Protocol (MCP) Server.
 */
async function main(): Promise<void> {
  logger.info('Initializing Instagram MCP Server (Phase 7: AI Caption & Scheduling)...');

  // Create MCP Server instance
  const server = new McpServer(
    {
      name: 'instagram-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register modular tool domains
  registerHealthTools(server);
  registerAccountTools(server);
  registerPublishTools(server);
  registerCommentsTools(server);
  registerMessagingTools(server);
  registerInsightsTools(server);
  registerSchedulingTools(server);

  // Initialize and start background persistent scheduler queue worker
  const schedulerQueue = SchedulerQueue.getInstance();
  schedulerQueue.start();

  // Start Express helper for OAuth callback & webhook events
  let httpServer: HttpServer | null = null;
  try {
    const app = express();
    app.disable('x-powered-by');

    // Security headers middleware
    app.use((_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      next();
    });

    // In-memory IP rate limiter (120 req/min per IP) to prevent abuse and DoS
    const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
    app.use((req, res, next) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const windowMs = 60 * 1000;
      const maxReqs = 120;

      const record = rateLimitMap.get(ip);
      if (!record || now > record.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
        next();
      } else if (record.count < maxReqs) {
        record.count++;
        next();
      } else {
        logger.warn(`Rate limit exceeded for IP: ${ip}`);
        res.status(429).json({ error: 'Too Many Requests', retryAfter: Math.ceil((record.resetAt - now) / 1000) });
      }
    });

    // Retain raw body buffer for HMAC-SHA256 signature verification (capped at 2MB)
    app.use(
      express.json({
        limit: '2mb',
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody?: Buffer }).rawBody = buf;
        },
      })
    );
    app.use('/oauth', InstagramOAuthService.createRouter());
    app.use('/webhooks', InstagramWebhookHandler.createRouter());

    httpServer = app.listen(config.port, () => {
      logger.info(
        `HTTP helper listening at http://localhost:${config.port} (OAuth: /oauth/login, Webhooks: /webhooks)`
      );
    });

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(`Port ${config.port} is already in use. OAuth HTTP listener disabled for this instance, but MCP stdio server remains fully operational.`);
      } else {
        logger.error('OAuth HTTP server error:', err.message);
      }
    });
  } catch (err) {
    logger.warn('Failed to start OAuth HTTP helper:', err instanceof Error ? err.message : String(err));
  }

  // Connect via StdioServerTransport
  const transport = new StdioServerTransport();

  // Process lifecycle & signal management
  const cleanup = async () => {
    logger.info('Shutting down Instagram MCP Server...');
    schedulerQueue.stop();
    if (httpServer) {
      httpServer.close();
    }
    try {
      await server.close();
    } catch (err) {
      logger.error('Error closing server:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception in MCP server process:', error.message);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection in MCP server process:', reason instanceof Error ? reason.message : String(reason));
  });

  await server.connect(transport);
  logger.info(`Instagram MCP Server is running over stdio (Meta API target: ${config.apiVersion}).`);
}

main().catch((error) => {
  logger.error('Fatal initialization failure in Instagram MCP Server:', error);
  process.exit(1);
});
