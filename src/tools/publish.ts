import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatErrorResponse, formatSuccessResponse, logger } from '../config.js';
import { instagramApi, InstagramApiError } from '../instagram-api.js';

/**
 * Counts the number of hashtags in a caption string.
 */
function countHashtags(caption?: string): number {
  if (!caption) return 0;
  const matches = caption.match(/#[a-zA-Z0-9_]+/g);
  return matches ? matches.length : 0;
}

/**
 * Validates that a media URL is well-formed, uses HTTP/HTTPS, and does not target localhost/private IPs.
 */
function validateMediaUrlSyntax(rawUrl: string): { isValid: boolean; error?: string } {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { isValid: false, error: 'Media URL must use http: or https: protocol.' };
    }

    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname.startsWith('127.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('169.254.') || // Cloud metadata & link-local (AWS/DigitalOcean/GCP)
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.localhost') ||
      hostname === 'metadata.google.internal' ||
      hostname === 'instance-data'
    ) {
      return {
        isValid: false,
        error: `Address '${hostname}' is a private, loopback, or cloud-internal endpoint. Media must be hosted on a publicly accessible Internet URL.`,
      };
    }

    return { isValid: true };
  } catch {
    return { isValid: false, error: 'Malformed media URL provided.' };
  }
}

/**
 * Verifies live reachability of a media URL over the network.
 * Satisfies Requirement 6: Do not assume a media URL is accessible just because it starts with HTTPS.
 */
async function verifyMediaUrlReachability(
  rawUrl: string,
  mediaKind: 'IMAGE' | 'VIDEO'
): Promise<{ isReachable: boolean; error?: string; contentType?: string }> {
  const syntaxCheck = validateMediaUrlSyntax(rawUrl);
  if (!syntaxCheck.isValid) {
    return { isReachable: false, error: syntaxCheck.error };
  }

  try {
    let response: Response;
    try {
      response = await fetch(rawUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(6000),
      });

      // Some CDNs reject HEAD with 405 Method Not Allowed; fall back to GET range
      if (response.status === 405) {
        response = await fetch(rawUrl, {
          headers: { Range: 'bytes=0-10' },
          signal: AbortSignal.timeout(6000),
        });
      }
    } catch {
      // Fallback to GET range if HEAD throws
      response = await fetch(rawUrl, {
        headers: { Range: 'bytes=0-10' },
        signal: AbortSignal.timeout(6000),
      });
    }

    if (!response.ok && response.status !== 206) {
      return {
        isReachable: false,
        error: `Media server returned HTTP status ${response.status} (${response.statusText}). Ensure the URL is public and not behind authentication.`,
      };
    }

    const contentType = response.headers.get('content-type')?.toLowerCase();
    return { isReachable: true, contentType };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isReachable: false,
      error: `Unable to reach media host: ${msg}. Check domain name and public accessibility.`,
    };
  }
}

/**
 * Registers content publishing tools for Instagram Graph API.
 */
export function registerPublishTools(server: McpServer): void {
  // ==========================================
  // Tool 1: publish_image_post
  // ==========================================
  server.registerTool(
    'publish_image_post',
    {
      description:
        'Publish a single photo post to the authenticated Instagram feed. Requires explicit confirmation (confirm_publish: true) to prevent unintentional publishing.',
      inputSchema: {
        imageUrl: z
          .string()
          .url()
          .describe(
            'Publicly accessible HTTPS or HTTP URL of the image (JPEG or PNG, max 8MB, aspect ratio 4:5 to 1.91:1).'
          ),
        caption: z
          .string()
          .max(2200)
          .optional()
          .describe('Optional caption for the post. Maximum 2,200 characters and up to 30 hashtags.'),
        confirm_publish: z
          .boolean()
          .optional()
          .describe(
            'Explicit user approval to post live to Instagram feed. Must be set to true to trigger real publishing. If false or omitted, the tool performs pre-flight validation and rate limit checks only.'
          ),
      },
    },
    async (args) => {
      const { imageUrl, caption, confirm_publish } = args;

      // 1. Validate image URL format and public accessibility
      const urlCheck = await verifyMediaUrlReachability(imageUrl, 'IMAGE');
      if (!urlCheck.isReachable) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                formatErrorResponse(
                  'INVALID_IMAGE_URL',
                  urlCheck.error || 'Invalid or unreachable image URL provided.',
                  { imageUrl },
                  'Provide a publicly reachable HTTPS URL pointing to a valid JPG or PNG file.'
                ),
                null,
                2
              ),
            },
          ],
        };
      }

      // 2. Validate caption length and hashtag limits
      const hashtagCount = countHashtags(caption);
      if (hashtagCount > 30) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                formatErrorResponse(
                  'HASHTAG_LIMIT_EXCEEDED',
                  `Caption contains ${hashtagCount} hashtags. Meta allows a maximum of 30 hashtags per post.`,
                  { hashtagCount, maxAllowed: 30 },
                  'Reduce the number of hashtags in the caption to 30 or fewer.'
                ),
                null,
                2
              ),
            },
          ],
        };
      }

      try {
        // 3. Query current publishing quota and limits
        logger.info('Checking Instagram content publishing limits...');
        const quota = await instagramApi.getContentPublishingLimit();

        if (quota.quotaRemaining <= 0) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  formatErrorResponse(
                    'PUBLISHING_QUOTA_EXHAUSTED',
                    `Daily publishing quota exhausted (${quota.quotaUsage}/${quota.quotaTotal} used).`,
                    quota,
                    'Wait for the 24-hour quota window to reset before publishing further posts.'
                  ),
                  null,
                  2
                ),
              },
            ],
          };
        }

        // 4. Enforce User Confirmation check
        if (confirm_publish !== true) {
          logger.info('Pre-flight validation passed; awaiting explicit confirmation from user.');
          const dryRunResponse = {
            status: 'CONFIRMATION_REQUIRED',
            published: false,
            message:
              'Pre-flight validation passed successfully. User confirmation is strictly required before publishing to your live Instagram feed.',
            post_preview: {
              imageUrl,
              caption: caption || '[No caption]',
              captionLength: caption ? caption.length : 0,
              hashtagCount,
            },
            publishing_quota: quota,
            action_required:
              'To publish this post live to your Instagram feed, call publish_image_post again with confirm_publish set to true.',
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

        // 5. User confirmed - Execute the publishing flow
        logger.info(`Creating media container for image: ${imageUrl}`);
        const container = await instagramApi.createImageContainer(imageUrl, caption);
        logger.info(`Media container created with ID: ${container.id}. Waiting for processing...`);

        // Wait for container processing (polls status until FINISHED)
        await instagramApi.waitForContainerReady(container.id);

        logger.info(`Publishing media container ${container.id} to Instagram feed...`);
        const publishResult = await instagramApi.publishContainer(container.id);
        logger.info(`Post successfully published! Live Media ID: ${publishResult.id}`);

        const responsePayload = {
          status: 'PUBLISHED',
          published: true,
          media_id: publishResult.id,
          container_id: container.id,
          message: 'Image post was successfully published to your live Instagram feed.',
          post_details: {
            media_id: publishResult.id,
            caption: caption || '',
            published_at: new Date().toISOString(),
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
                    `PUBLISH_FAILED_${err.code || err.status}`,
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
                  'PUBLISH_EXECUTION_ERROR',
                  `Failed to publish image post: ${rawMsg}`,
                  undefined,
                  'Verify image URL format, hosting availability, and account status.'
                ),
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // ==========================================
  // Tool 2: publish_reel
  // ==========================================
  server.registerTool(
    'publish_reel',
    {
      description:
        'Publish an Instagram Reel (video) to your account. Requires explicit confirmation (confirm_publish: true) to prevent unintentional publishing.',
      inputSchema: {
        videoUrl: z
          .string()
          .url()
          .describe(
            'Publicly accessible HTTPS or HTTP URL of the video (MP4 or MOV, H.264/HEVC, AAC, duration 3s-15m, recommended aspect ratio 9:16, max 1GB).'
          ),
        caption: z
          .string()
          .max(2200)
          .optional()
          .describe('Optional caption for the Reel (maximum 2,200 characters and up to 30 hashtags).'),
        coverUrl: z
          .string()
          .url()
          .optional()
          .describe('Optional publicly accessible JPEG or PNG cover/thumbnail image URL for the Reel.'),
        shareToFeed: z
          .boolean()
          .optional()
          .describe('Whether to share the Reel to the main profile feed as well as the Reels tab (default: true).'),
        thumbOffset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Optional millisecond frame offset from the video to use as thumbnail (alternative to coverUrl).'),
        confirm_publish: z
          .boolean()
          .optional()
          .describe(
            'Explicit user approval to post live to Instagram Reels. Must be set to true to publish. If false or omitted, the tool performs pre-flight validation only.'
          ),
      },
    },
    async (args) => {
      const { videoUrl, caption, coverUrl, shareToFeed = true, thumbOffset, confirm_publish } = args;

      // 1. Validate video URL accessibility
      const videoCheck = await verifyMediaUrlReachability(videoUrl, 'VIDEO');
      if (!videoCheck.isReachable) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                formatErrorResponse(
                  'INVALID_VIDEO_URL',
                  videoCheck.error || 'Video URL is invalid or unreachable.',
                  { videoUrl },
                  'Provide a publicly reachable HTTPS URL pointing to a valid MP4 or MOV file.'
                ),
                null,
                2
              ),
            },
          ],
        };
      }

      // 2. Validate cover URL if provided
      if (coverUrl) {
        const coverCheck = await verifyMediaUrlReachability(coverUrl, 'IMAGE');
        if (!coverCheck.isReachable) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  formatErrorResponse(
                    'INVALID_COVER_URL',
                    coverCheck.error || 'Cover image URL is invalid or unreachable.',
                    { coverUrl },
                    'Provide a publicly reachable HTTPS URL for the cover image (JPEG or PNG).'
                  ),
                  null,
                  2
                ),
              },
            ],
          };
        }
      }

      // 3. Validate caption and hashtags
      const hashtagCount = countHashtags(caption);
      if (hashtagCount > 30) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                formatErrorResponse(
                  'HASHTAG_LIMIT_EXCEEDED',
                  `Caption contains ${hashtagCount} hashtags. Meta allows a maximum of 30 hashtags per post.`,
                  { hashtagCount, maxAllowed: 30 },
                  'Reduce the number of hashtags in the caption to 30 or fewer.'
                ),
                null,
                2
              ),
            },
          ],
        };
      }

      try {
        // 4. Check publishing rate limits
        logger.info('Checking Instagram content publishing limits for Reel...');
        const quota = await instagramApi.getContentPublishingLimit();

        if (quota.quotaRemaining <= 0) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  formatErrorResponse(
                    'PUBLISHING_QUOTA_EXHAUSTED',
                    `Daily publishing quota exhausted (${quota.quotaUsage}/${quota.quotaTotal} used).`,
                    quota,
                    'Wait for the 24-hour quota window to reset before publishing further Reels.'
                  ),
                  null,
                  2
                ),
              },
            ],
          };
        }

        // 5. Enforce User Confirmation check
        if (confirm_publish !== true) {
          logger.info('Reel pre-flight validation passed; awaiting explicit confirmation from user.');
          const dryRunResponse = {
            status: 'CONFIRMATION_REQUIRED',
            published: false,
            message:
              'Reel pre-flight validation passed successfully. User confirmation is strictly required before publishing to your live Instagram Reels feed.',
            post_preview: {
              videoUrl,
              caption: caption || '[No caption]',
              coverUrl,
              shareToFeed,
              captionLength: caption ? caption.length : 0,
              hashtagCount,
            },
            publishing_quota: quota,
            action_required:
              'To publish this Reel live to your Instagram feed, call publish_reel again with confirm_publish set to true.',
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

        // 6. User confirmed - Execute Reel creation and publishing
        logger.info(`Creating Reel container for video: ${videoUrl}`);
        const container = await instagramApi.createReelContainer({
          videoUrl,
          caption,
          coverUrl,
          shareToFeed,
          thumbOffset,
        });
        logger.info(`Reel media container created with ID: ${container.id}. Waiting for transcoding/processing...`);

        // Video transcoding takes longer; poll up to 120s with 5s interval
        await instagramApi.waitForContainerReady(container.id, 120000, 5000);

        logger.info(`Publishing Reel container ${container.id} to Instagram feed...`);
        const publishResult = await instagramApi.publishContainer(container.id);
        logger.info(`Reel successfully published! Live Media ID: ${publishResult.id}`);

        const responsePayload = {
          status: 'PUBLISHED',
          published: true,
          media_id: publishResult.id,
          container_id: container.id,
          message: 'Reel was successfully published to your live Instagram account.',
          post_details: {
            media_id: publishResult.id,
            caption: caption || '',
            share_to_feed: shareToFeed,
            published_at: new Date().toISOString(),
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
                    `REEL_PUBLISH_FAILED_${err.code || err.status}`,
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
                  'REEL_EXECUTION_ERROR',
                  `Failed to publish Reel: ${rawMsg}`,
                  undefined,
                  'Verify video URL format, codec compliance (H.264/AAC), and duration (3s-15m).'
                ),
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // ==========================================
  // Tool 3: publish_carousel
  // ==========================================
  server.registerTool(
    'publish_carousel',
    {
      description:
        'Publish a multi-item carousel post (2 to 10 images/videos) to your Instagram feed. Requires explicit confirmation (confirm_publish: true) to prevent unintentional publishing.',
      inputSchema: {
        items: z
          .array(
            z.object({
              url: z.string().url().describe('Publicly accessible URL of the image or video item.'),
              mediaType: z
                .enum(['IMAGE', 'VIDEO'])
                .optional()
                .describe('Media type of the item (IMAGE or VIDEO). Defaults to IMAGE.'),
            })
          )
          .min(2)
          .max(10)
          .describe('List of 2 to 10 media items to include in the carousel.'),
        caption: z
          .string()
          .max(2200)
          .optional()
          .describe('Optional caption for the entire carousel post (maximum 2,200 characters and up to 30 hashtags).'),
        confirm_publish: z
          .boolean()
          .optional()
          .describe(
            'Explicit user approval to publish the carousel live to Instagram. Must be set to true to publish. If false or omitted, the tool performs pre-flight validation only.'
          ),
      },
    },
    async (args) => {
      const { items, caption, confirm_publish } = args;

      // 1. Validate number of items (Meta constraint: 2 to 10 items)
      if (items.length < 2 || items.length > 10) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                formatErrorResponse(
                  'INVALID_CAROUSEL_ITEM_COUNT',
                  `Carousel must contain between 2 and 10 items. Provided: ${items.length} items.`,
                  { itemCount: items.length },
                  'Provide at least 2 and at most 10 items for a carousel post.'
                ),
                null,
                2
              ),
            },
          ],
        };
      }

      // 2. Validate reachability for each item
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const mediaKind = item.mediaType === 'VIDEO' ? 'VIDEO' : 'IMAGE';
        const reachability = await verifyMediaUrlReachability(item.url, mediaKind);

        if (!reachability.isReachable) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  formatErrorResponse(
                    'INVALID_CAROUSEL_ITEM',
                    `Carousel item #${i + 1} (${item.url}) is unreachable: ${reachability.error}`,
                    { itemIndex: i + 1, itemUrl: item.url, mediaType: mediaKind },
                    'Ensure every media item in the carousel is hosted on a publicly reachable URL.'
                  ),
                  null,
                  2
                ),
              },
            ],
          };
        }
      }

      // 3. Validate caption and hashtags
      const hashtagCount = countHashtags(caption);
      if (hashtagCount > 30) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                formatErrorResponse(
                  'HASHTAG_LIMIT_EXCEEDED',
                  `Caption contains ${hashtagCount} hashtags. Meta allows a maximum of 30 hashtags per post.`,
                  { hashtagCount, maxAllowed: 30 },
                  'Reduce the number of hashtags in the caption to 30 or fewer.'
                ),
                null,
                2
              ),
            },
          ],
        };
      }

      try {
        // 4. Check publishing rate limits
        logger.info('Checking Instagram content publishing limits for Carousel...');
        const quota = await instagramApi.getContentPublishingLimit();

        if (quota.quotaRemaining <= 0) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  formatErrorResponse(
                    'PUBLISHING_QUOTA_EXHAUSTED',
                    `Daily publishing quota exhausted (${quota.quotaUsage}/${quota.quotaTotal} used).`,
                    quota,
                    'Wait for the 24-hour quota window to reset before publishing further carousel posts.'
                  ),
                  null,
                  2
                ),
              },
            ],
          };
        }

        // 5. Enforce User Confirmation check
        if (confirm_publish !== true) {
          logger.info('Carousel pre-flight validation passed; awaiting explicit confirmation from user.');
          const dryRunResponse = {
            status: 'CONFIRMATION_REQUIRED',
            published: false,
            message:
              'Carousel pre-flight validation passed successfully. User confirmation is strictly required before publishing to your live Instagram feed.',
            post_preview: {
              itemCount: items.length,
              items: items.map((it) => ({
                url: it.url,
                mediaType: it.mediaType || 'IMAGE',
              })),
              caption: caption || '[No caption]',
              captionLength: caption ? caption.length : 0,
              hashtagCount,
            },
            publishing_quota: quota,
            action_required:
              'To publish this carousel live to your Instagram feed, call publish_carousel again with confirm_publish set to true.',
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

        // 6. User confirmed - Step A: Create child item containers
        logger.info(`Creating ${items.length} child containers for carousel...`);
        const childContainerIds: string[] = [];

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const mediaType = item.mediaType || 'IMAGE';
          logger.info(`Creating child container #${i + 1} (${mediaType})...`);

          const child = await instagramApi.createCarouselItemContainer({
            url: item.url,
            mediaType,
          });
          childContainerIds.push(child.id);

          // If the child is a video, wait for its processing before creating parent
          if (mediaType === 'VIDEO') {
            logger.info(`Waiting for video child container ${child.id} to process...`);
            await instagramApi.waitForContainerReady(child.id, 90000, 4000);
          }
        }

        // Step B: Create parent carousel container
        logger.info(`Creating parent carousel container with ${childContainerIds.length} children...`);
        const parentContainer = await instagramApi.createCarouselContainer(childContainerIds, caption);

        // Step C: Wait for parent container to be ready
        logger.info(`Waiting for parent carousel container ${parentContainer.id} status...`);
        await instagramApi.waitForContainerReady(parentContainer.id, 60000, 3000);

        // Step D: Publish carousel
        logger.info(`Publishing carousel container ${parentContainer.id} to Instagram feed...`);
        const publishResult = await instagramApi.publishContainer(parentContainer.id);
        logger.info(`Carousel successfully published! Live Media ID: ${publishResult.id}`);

        const responsePayload = {
          status: 'PUBLISHED',
          published: true,
          media_id: publishResult.id,
          container_id: parentContainer.id,
          child_container_ids: childContainerIds,
          message: 'Carousel was successfully published to your live Instagram feed.',
          post_details: {
            media_id: publishResult.id,
            item_count: items.length,
            caption: caption || '',
            published_at: new Date().toISOString(),
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
                    `CAROUSEL_PUBLISH_FAILED_${err.code || err.status}`,
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
                  'CAROUSEL_EXECUTION_ERROR',
                  `Failed to publish carousel: ${rawMsg}`,
                  undefined,
                  'Ensure all carousel media URLs are publicly accessible and comply with Instagram aspect ratio standards.'
                ),
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );
}
