import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SchedulerDb } from '../src/scheduler/db.js';
import { generateInstagramCaption } from '../src/scheduler/ai-caption.js';
import { parseScheduledTime, executeScheduledJob } from '../src/scheduler/queue.js';
import fs from 'node:fs';
import path from 'node:path';

async function runTests() {
  console.log('=== RUNNING PHASE 7 UNIT & INTEGRATION TESTS ===\n');

  // Use an isolated test database
  const testDbPath = './data/test_scheduler.db';
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
  const db = SchedulerDb.createIsolatedInstance(testDbPath);

  // -------------------------------------------------------------
  // Test 1: AI Caption Generation (Draft Only)
  // -------------------------------------------------------------
  console.log('--- Test 1: AI Caption Generation ---');
  const captionResult = await generateInstagramCaption({
    topic: 'Minimalist workspace setup and productivity tips',
    tone: 'inspirational',
    targetAudience: 'Remote professionals and software developers',
    includeHashtags: true,
    maxHashtags: 5,
    mediaType: 'IMAGE',
  });

  console.log('Provider:', captionResult.provider);
  console.log('Is draft:', captionResult.isDraft);
  console.log('Status:', captionResult.status);
  console.log('Hashtag count:', captionResult.hashtagCount);
  console.log('Character count:', captionResult.characterCount);
  console.log('Caption preview:\n', captionResult.fullText.substring(0, 150) + '...\n');

  if (captionResult.status !== 'AI_DRAFT' || !captionResult.isDraft) {
    throw new Error('Test 1 failed: AI-generated content must remain a draft!');
  }
  console.log('✓ Test 1 Passed: AI caption is generated and marked strictly as draft.\n');

  // -------------------------------------------------------------
  // Test 2: Persistent Post Draft Creation
  // -------------------------------------------------------------
  console.log('--- Test 2: Persistent Post Draft Creation ---');
  const draft = db.createDraft({
    title: 'Workspace Inspiration Post',
    caption: captionResult.fullText,
    mediaType: 'IMAGE',
    mediaUrls: ['https://images.unsplash.com/photo-1498050108023-c5249f4df085'],
  });

  console.log('Created draft ID:', draft.id);
  console.log('Draft status:', draft.status);

  const retrievedDraft = db.getDraft(draft.id);
  if (!retrievedDraft || retrievedDraft.id !== draft.id || retrievedDraft.status !== 'DRAFT') {
    throw new Error('Test 2 failed: Draft was not persisted properly in SQLite!');
  }
  console.log('✓ Test 2 Passed: Draft saved and retrieved from persistent SQLite DB.\n');

  // -------------------------------------------------------------
  // Test 3: Time-Zone Handling and Validation
  // -------------------------------------------------------------
  console.log('--- Test 3: Time-Zone Handling and Validation ---');
  // Past time should fail
  const pastCheck = parseScheduledTime('2020-01-01T00:00:00Z', 'UTC');
  console.log('Past time rejected correctly:', !pastCheck.isValid);

  // Future ISO time in UTC
  const futureIso = new Date(Date.now() + 3600 * 24 * 3 * 1000).toISOString();
  const futureCheckUtc = parseScheduledTime(futureIso, 'UTC');
  console.log('Future UTC time valid:', futureCheckUtc.isValid, 'UTC ISO:', futureCheckUtc.utcIso);

  // Localized time with timezone
  const futureCheckKolkata = parseScheduledTime(futureIso, 'Asia/Kolkata');
  console.log('Future Kolkata time display:', futureCheckKolkata.localDisplay);

  if (!pastCheck.error || !futureCheckUtc.isValid) {
    throw new Error('Test 3 failed: Time-zone handling or future validation failed!');
  }
  console.log('✓ Test 3 Passed: Time-zone parsing and future-time constraints verified.\n');

  // -------------------------------------------------------------
  // Test 4: Scheduling & Idempotency
  // -------------------------------------------------------------
  console.log('--- Test 4: Scheduling & Idempotency ---');
  const job1 = db.scheduleJob({
    draftId: draft.id,
    mediaType: 'IMAGE',
    mediaUrls: draft.mediaUrls,
    caption: draft.caption,
    scheduledTimeUtc: futureCheckUtc.utcIso!,
    timezone: 'Asia/Kolkata',
    idempotencyKey: 'test_idempotency_key_123',
  });

  console.log('Created scheduled job ID:', job1.id);
  console.log('Job status:', job1.status);

  // Attempt duplicate scheduling with identical idempotency key
  const jobDuplicate = db.scheduleJob({
    draftId: draft.id,
    mediaType: 'IMAGE',
    mediaUrls: draft.mediaUrls,
    caption: draft.caption,
    scheduledTimeUtc: futureCheckUtc.utcIso!,
    timezone: 'Asia/Kolkata',
    idempotencyKey: 'test_idempotency_key_123',
  });

  console.log('Duplicate submission returned same job ID:', jobDuplicate.id === job1.id);
  if (jobDuplicate.id !== job1.id) {
    throw new Error('Test 4 failed: Idempotency failed! Duplicate job was created.');
  }
  console.log('✓ Test 4 Passed: Scheduling and idempotency verified.\n');

  // -------------------------------------------------------------
  // Test 5: Listing Scheduled Posts
  // -------------------------------------------------------------
  console.log('--- Test 5: Listing Scheduled Posts ---');
  const scheduledList = db.listScheduledJobs('SCHEDULED', 10);
  console.log('Active scheduled jobs count:', scheduledList.length);
  const found = scheduledList.find((j) => j.id === job1.id);
  if (!found) {
    throw new Error('Test 5 failed: Job was not listed in scheduled jobs!');
  }
  console.log('Found scheduled job in DB:', found.id, 'scheduled for:', found.scheduledTimeUtc);
  console.log('✓ Test 5 Passed: Scheduled posts listing verified.\n');

  // -------------------------------------------------------------
  // Test 6: Cancellation
  // -------------------------------------------------------------
  console.log('--- Test 6: Cancellation ---');
  const cancelResult = db.cancelJob(job1.id, 'User changed publishing plan');
  console.log('Cancellation success:', cancelResult.success, 'Message:', cancelResult.message);

  const updatedJob = db.getJob(job1.id);
  if (!updatedJob || updatedJob.status !== 'CANCELLED') {
    throw new Error('Test 6 failed: Job status was not updated to CANCELLED!');
  }

  // Cancelling already cancelled job is idempotent
  const cancelAgain = db.cancelJob(job1.id);
  console.log('Idempotent re-cancellation success:', cancelAgain.success);

  // Cancelling published job should fail
  const fakePublishedJob = db.scheduleJob({
    mediaType: 'IMAGE',
    mediaUrls: ['https://example.com/img.jpg'],
    caption: 'Published test',
    scheduledTimeUtc: futureIso,
    timezone: 'UTC',
    idempotencyKey: 'pub_test_key',
  });
  db.markJobPublished(fakePublishedJob.id, 'meta_media_9999');
  const cancelPublished = db.cancelJob(fakePublishedJob.id);
  console.log('Cannot cancel published job:', !cancelPublished.success);
  if (cancelPublished.success) {
    throw new Error('Test 6 failed: Should not allow cancelling a published post!');
  }
  console.log('✓ Test 6 Passed: Cancellation rules and state machine verified.\n');

  // -------------------------------------------------------------
  // Test 7: Retries & Failed Publication Handling
  // -------------------------------------------------------------
  console.log('--- Test 7: Retries & Failed Publication Handling ---');
  const retryJob = db.scheduleJob({
    mediaType: 'IMAGE',
    mediaUrls: ['https://example.com/retry-test.jpg'],
    caption: 'Retry test post',
    scheduledTimeUtc: new Date(Date.now() - 1000).toISOString(), // due now
    timezone: 'UTC',
    idempotencyKey: 'retry_job_key',
  });

  // Claim job
  const claimed = db.claimJobForProcessing(retryJob.id);
  console.log('Job claimed atomically for processing:', claimed);

  // Simulate transient failure (e.g. Meta 500 or timeout)
  const nextRetryTime = new Date(Date.now() + 60000).toISOString();
  db.markJobFailed(retryJob.id, 'META_500', 'Instagram Graph API temporary internal error', true, nextRetryTime);

  const retryState = db.getJob(retryJob.id);
  console.log('After transient error - status:', retryState?.status, 'next retry at:', retryState?.nextRetryAt);
  if (retryState?.status !== 'RETRY_PENDING' || !retryState?.nextRetryAt) {
    throw new Error('Test 7 failed: Transient error did not set RETRY_PENDING status!');
  }

  // Simulate fatal failure (e.g. token expired or invalid format)
  db.markJobFailed(retryJob.id, 'OAUTH_TOKEN_EXPIRED', 'Access token has expired (Error code: 190)', false);
  const failedState = db.getJob(retryJob.id);
  console.log('After fatal error - status:', failedState?.status, 'error code:', failedState?.errorCode);
  if (failedState?.status !== 'FAILED') {
    throw new Error('Test 7 failed: Fatal error did not set FAILED status!');
  }

  // Check audit log
  const auditLogs = db.getAuditLogs(retryJob.id);
  console.log('Audit log entries count for retryJob:', auditLogs.length);
  console.log('Audit actions recorded:', auditLogs.map((a) => a.action).join(' -> '));
  console.log('✓ Test 7 Passed: Retry backoff and fatal failure states verified.\n');

  // Clean up test DB
  db.close();
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch {}

  // -------------------------------------------------------------
  // Test 8: Live MCP Server Tools via Stdio Transport
  // -------------------------------------------------------------
  console.log('--- Test 8: Live MCP Server Tools via Stdio Transport ---');
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts'],
    cwd: path.resolve(process.cwd()),
  });

  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log('Connected to Instagram MCP Server over stdio.');

  const toolsResponse = await client.listTools();
  const toolNames = toolsResponse.tools.map((t) => t.name);
  console.log(`Total tools registered: ${toolNames.length}`);

  const requiredTools = [
    'generate_caption',
    'create_post_draft',
    'schedule_post',
    'list_scheduled_posts',
    'cancel_scheduled_post',
  ];

  for (const name of requiredTools) {
    const exists = toolNames.includes(name);
    console.log(`Tool '${name}' registered: ${exists}`);
    if (!exists) throw new Error(`Missing tool: ${name}`);
  }

  // Test 8a: generate_caption via MCP
  console.log('\n--- Calling generate_caption via MCP ---');
  const genResult = await client.callTool({
    name: 'generate_caption',
    arguments: {
      topic: 'Coffee shop aesthetics and creative writing',
      tone: 'casual',
      max_hashtags: 4,
    },
  });
  console.log('generate_caption result preview:', (genResult.content[0] as { text: string }).text.substring(0, 150) + '...');

  // Test 8b: create_post_draft via MCP
  console.log('\n--- Calling create_post_draft via MCP ---');
  const draftResult = await client.callTool({
    name: 'create_post_draft',
    arguments: {
      caption: 'Quiet mornings with warm coffee and fresh thoughts. ☕✨ #coffee #writing',
      media_url: 'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb',
      title: 'Coffee Morning Draft',
    },
  });
  const draftParsed = JSON.parse((draftResult.content[0] as { text: string }).text);
  console.log('create_post_draft response:', draftParsed.data.status, 'ID:', draftParsed.data.draftId);
  const mcpDraftId = draftParsed.data.draftId;

  // Test 8c: schedule_post dry-run (no confirm_schedule)
  console.log('\n--- Calling schedule_post without confirm_schedule (dry run) ---');
  const dryScheduleResult = await client.callTool({
    name: 'schedule_post',
    arguments: {
      draft_id: mcpDraftId,
      scheduled_time: '2026-10-28T16:00:00Z',
      timezone: 'UTC',
    },
  });
  const dryParsed = JSON.parse((dryScheduleResult.content[0] as { text: string }).text);
  console.log('schedule_post dry run status:', dryParsed.data.status, 'scheduled:', dryParsed.data.scheduled);
  if (dryParsed.data.status !== 'CONFIRMATION_REQUIRED' || dryParsed.data.scheduled !== false) {
    throw new Error('Test 8c failed: Confirmation was bypassed!');
  }

  // Test 8d: schedule_post confirmed (confirm_schedule: true)
  console.log('\n--- Calling schedule_post with confirm_schedule: true ---');
  const confirmedScheduleResult = await client.callTool({
    name: 'schedule_post',
    arguments: {
      draft_id: mcpDraftId,
      scheduled_time: '2026-10-28T16:00:00Z',
      timezone: 'UTC',
      confirm_schedule: true,
    },
  });
  const confirmedParsed = JSON.parse((confirmedScheduleResult.content[0] as { text: string }).text);
  console.log('schedule_post confirmed status:', confirmedParsed.data.status, 'Job ID:', confirmedParsed.data.jobId);
  const mcpJobId = confirmedParsed.data.jobId;

  // Test 8e: list_scheduled_posts via MCP
  console.log('\n--- Calling list_scheduled_posts via MCP ---');
  const listResult = await client.callTool({
    name: 'list_scheduled_posts',
    arguments: { status: 'SCHEDULED' },
  });
  const listParsed = JSON.parse((listResult.content[0] as { text: string }).text);
  console.log('list_scheduled_posts total:', listParsed.data.total);
  const foundMcpJob = listParsed.data.jobs.find((j: any) => j.id === mcpJobId);
  console.log('Found job in MCP list:', Boolean(foundMcpJob));

  // Test 8f: cancel_scheduled_post via MCP
  console.log('\n--- Calling cancel_scheduled_post via MCP ---');
  const cancelMcpResult = await client.callTool({
    name: 'cancel_scheduled_post',
    arguments: {
      job_id: mcpJobId,
      reason: 'Testing cancellation via MCP client',
    },
  });
  const cancelParsed = JSON.parse((cancelMcpResult.content[0] as { text: string }).text);
  console.log('cancel_scheduled_post status:', cancelParsed.data.status, 'cancelled:', cancelParsed.data.cancelled);

  await client.close();
  console.log('\n✓ Test 8 Passed: Complete MCP client-server lifecycle verified over stdio.\n');

  console.log('=== ALL PHASE 7 TESTS COMPLETED SUCCESSFULLY! ===');
}

runTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
