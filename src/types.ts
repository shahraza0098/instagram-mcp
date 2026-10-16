/**
 * Common types and structured response contracts for Instagram MCP Server.
 */

export interface McpSuccessResponse<T = unknown> {
  success: true;
  data: T;
  meta: {
    timestamp: string;
    server: string;
    version: string;
  };
}

export interface McpErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    remediation?: string;
  };
  meta: {
    timestamp: string;
    server: string;
    version: string;
  };
}

export interface ServerHealth {
  status: 'healthy' | 'degraded' | 'unconfigured';
  server: {
    name: string;
    version: string;
    transport: 'stdio';
    nodeVersion: string;
    uptimeSeconds: number;
  };
  environment: {
    hasAppId: boolean;
    hasAppSecret: boolean;
    hasUserId: boolean;
    hasAccessToken: boolean;
    tokenTypeHint?: string;
    apiVersion: string;
    hasWebhookVerifyToken: boolean;
    hasRedirectUri: boolean;
    port: number;
  };
  features: {
    healthCheck: boolean;
    accountRead: boolean;
    publishing: boolean;
    comments: boolean;
    messaging: boolean;
    scheduling: boolean;
    insights: boolean;
    oauth: boolean;
    webhooks: boolean;
  };
  diagnostics: string[];
}

export interface InstagramAccount {
  id: string;
  username: string;
  name?: string;
  account_type: 'BUSINESS' | 'MEDIA_CREATOR' | 'PERSONAL' | string;
  is_professional: boolean;
  profile_picture_url?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  diagnostics?: {
    is_live_verified: boolean;
    token_hint?: string;
  };
}

export interface TokenDiagnostic {
  isValid: boolean;
  status: 'active' | 'expired' | 'invalid' | 'missing' | 'unknown';
  tokenHint?: string;
  accountId?: string;
  username?: string;
  accountType?: string;
  isProfessional?: boolean;
  errorCode?: number;
  errorSubcode?: number;
  errorMessage?: string;
  remediation?: string;
}

export interface OAuthTokenResult {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  user_id?: string | number;
}

export interface PublishingLimit {
  quotaUsage: number;
  quotaTotal: number;
  quotaDuration: number;
  quotaRemaining: number;
}

export interface MediaContainerResult {
  id: string;
}

export interface ContainerStatusResult {
  statusCode: 'FINISHED' | 'IN_PROGRESS' | 'ERROR' | 'EXPIRED' | string;
  status?: string;
}

export interface PublishImageResult {
  published: boolean;
  status: 'PUBLISHED' | 'CONFIRMATION_REQUIRED' | 'CONTAINER_CREATED';
  mediaId?: string;
  containerId?: string;
  message: string;
  postPreview?: {
    imageUrl: string;
    caption?: string;
    captionLength: number;
    hashtagCount: number;
  };
  publishingQuota?: PublishingLimit;
  actionRequired?: string;
}

export interface ReelPublishOptions {
  videoUrl: string;
  caption?: string;
  coverUrl?: string;
  shareToFeed?: boolean;
  thumbOffset?: number;
}

export interface CarouselItem {
  url: string;
  mediaType: 'IMAGE' | 'VIDEO';
}

export interface PublishReelResult {
  published: boolean;
  status: 'PUBLISHED' | 'CONFIRMATION_REQUIRED';
  mediaId?: string;
  containerId?: string;
  message: string;
  postPreview?: {
    videoUrl: string;
    caption?: string;
    coverUrl?: string;
    shareToFeed: boolean;
    captionLength: number;
    hashtagCount: number;
  };
  publishingQuota?: PublishingLimit;
  actionRequired?: string;
}

export interface PublishCarouselResult {
  published: boolean;
  status: 'PUBLISHED' | 'CONFIRMATION_REQUIRED';
  mediaId?: string;
  containerId?: string;
  childContainerIds?: string[];
  message: string;
  postPreview?: {
    itemCount: number;
    items: CarouselItem[];
    caption?: string;
    captionLength: number;
    hashtagCount: number;
  };
  publishingQuota?: PublishingLimit;
  actionRequired?: string;
}

export interface InstagramCommentReply {
  id: string;
  text: string;
  timestamp: string;
  username?: string;
  like_count?: number;
  hidden?: boolean;
}

export interface InstagramComment {
  id: string;
  text: string;
  timestamp: string;
  username?: string;
  like_count?: number;
  hidden?: boolean;
  replies?: InstagramCommentReply[];
}

export interface CommentPagination {
  before?: string;
  after?: string;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface MediaCommentsResult {
  mediaId: string;
  totalRetrieved: number;
  comments: InstagramComment[];
  pagination?: CommentPagination;
}

export interface ReplyCommentResult {
  success: boolean;
  status: 'REPLIED' | 'CONFIRMATION_REQUIRED';
  replyId?: string;
  commentId: string;
  message: string;
  timestamp: string;
  actionRequired?: string;
  auditTrail?: {
    action: string;
    targetCommentId: string;
    replyLength: number;
    timestamp: string;
  };
}

export interface HideCommentResult {
  success: boolean;
  status: 'MODERATED' | 'CONFIRMATION_REQUIRED';
  commentId: string;
  hidden: boolean;
  message: string;
  timestamp: string;
  actionRequired?: string;
  auditTrail?: {
    action: string;
    targetCommentId: string;
    hidden: boolean;
    timestamp: string;
  };
}

export interface ConversationParticipant {
  id: string;
  username?: string;
}

export interface InstagramConversation {
  id: string;
  updated_time: string;
  participants?: ConversationParticipant[];
}

export interface ConversationsResult {
  totalRetrieved: number;
  conversations: InstagramConversation[];
  pagination?: {
    before?: string;
    after?: string;
    hasNextPage: boolean;
  };
}

export interface InstagramMessageItem {
  id: string;
  created_time: string;
  from: {
    id: string;
    username?: string;
  };
  to?: Array<{
    id: string;
    username?: string;
  }>;
  message?: string;
}

export interface MessagesResult {
  conversationId: string;
  totalRetrieved: number;
  messages: InstagramMessageItem[];
  pagination?: {
    before?: string;
    after?: string;
    hasNextPage: boolean;
  };
}

export interface SendMessageResult {
  success: boolean;
  status: 'SENT' | 'CONFIRMATION_REQUIRED';
  messageId?: string;
  recipientId: string;
  text: string;
  timestamp: string;
  actionRequired?: string;
  auditTrail?: {
    action: string;
    recipientId: string;
    messageId?: string;
    timestamp: string;
  };
}

export interface WebhookIncomingMessage {
  mid: string;
  senderId: string;
  recipientId: string;
  timestamp: number;
  text?: string;
  receivedAt: string;
}

export interface WebhookStatusResult {
  isConfigured: boolean;
  hasVerifyToken: boolean;
  hasAppSecret: boolean;
  endpointUrl: string;
  totalReceived: number;
  deduplicatedCount: number;
  lastReceivedAt?: string;
  recentEvents: WebhookIncomingMessage[];
  operationalNotes: string[];
}

export interface GeneratedCaptionResult {
  caption: string;
  hashtags: string[];
  fullText: string;
  characterCount: number;
  hashtagCount: number;
  tone: string;
  provider: string;
  isDraft: true;
  status: 'AI_DRAFT';
  recommendedNextStep: string;
}

export interface PostDraft {
  id: string;
  title?: string;
  caption: string;
  mediaType: 'IMAGE' | 'REEL' | 'CAROUSEL';
  mediaUrls: string[];
  coverUrl?: string;
  shareToFeed?: boolean;
  createdAt: string;
  updatedAt: string;
  status: 'DRAFT' | 'SCHEDULED' | 'ARCHIVED';
  metadata?: Record<string, unknown>;
}

export interface CreateDraftResult {
  draftId: string;
  status: 'DRAFT';
  draft: PostDraft;
  characterCount: number;
  hashtagCount: number;
  message: string;
}

export interface ScheduledPostJob {
  id: string;
  draftId?: string;
  mediaType: 'IMAGE' | 'REEL' | 'CAROUSEL';
  mediaUrls: string[];
  caption: string;
  coverUrl?: string;
  shareToFeed?: boolean;
  scheduledTimeUtc: string;
  scheduledTimeLocal?: string;
  timezone: string;
  status: 'SCHEDULED' | 'PROCESSING' | 'PUBLISHED' | 'FAILED' | 'CANCELLED';
  attempts: number;
  maxRetries: number;
  nextRetryAt?: string;
  publishedMediaId?: string;
  errorCode?: string;
  errorMessage?: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
  cancellationReason?: string;
}

export interface SchedulePostResult {
  jobId: string;
  status: 'SCHEDULED' | 'CONFIRMATION_REQUIRED';
  scheduled: boolean;
  scheduledTimeUtc?: string;
  scheduledTimeLocal?: string;
  timezone?: string;
  postPreview?: {
    mediaType: 'IMAGE' | 'REEL' | 'CAROUSEL';
    mediaUrls: string[];
    caption: string;
    captionLength: number;
    hashtagCount: number;
  };
  idempotencyKey?: string;
  message: string;
  actionRequired?: string;
}

export interface CancelScheduledPostResult {
  jobId: string;
  status: 'CANCELLED';
  cancelled: boolean;
  message: string;
  cancelledAt: string;
  reason?: string;
}

export interface ListScheduledPostsResult {
  total: number;
  jobs: ScheduledPostJob[];
  filter: string;
}

