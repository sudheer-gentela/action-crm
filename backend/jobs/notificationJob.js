// jobs/notificationJob.js
//
// Bull queue for action notification processing.
// Follows the exact same pattern as emailProcessor.js.
//
// Job types:
//   type='immediate'    — process a single overdue action's immediate alert
//   type='daily_digest' — process a daily digest for a single user

const Queue = require('bull');
const notificationService = require('../services/notificationService');

// ── Queue setup ───────────────────────────────────────────────────────────────
const notificationQueue = new Queue('team-notifications', process.env.REDIS_URL, {
  defaultJobOptions: {
    attempts:         3,
    backoff:          { type: 'exponential', delay: 2000 },
    removeOnComplete: 200,
    removeOnFail:     100,
  },
});

// ── Job processor ─────────────────────────────────────────────────────────────
notificationQueue.process(async (job) => {
  const { type, orgId, actionId, userId, overdueActions } = job.data;

  console.log(`[notifications] Processing job ${job.id}: type=${type} org=${orgId}`);

  if (type === 'immediate') {
    // Single action immediate alert
    job.progress(20);
    const result = await notificationService.processImmediateNotification(orgId, actionId);
    job.progress(100);
    return result;

  } else if (type === 'daily_digest') {
    // Daily digest for a single user's overdue actions
    job.progress(20);
    const result = await notificationService.processDailyDigest(orgId, userId, overdueActions);
    job.progress(100);
    return result;

  } else {
    console.warn(`[notifications] Unknown job type: ${type}`);
    return { skipped: true, reason: 'unknown_type' };
  }
});

// ── Event listeners ───────────────────────────────────────────────────────────
notificationQueue.on('completed', (job, result) => {
  if (result?.skipped) {
    console.log(`[notifications] Job ${job.id} skipped: ${result.reason}`);
  } else if (job.data.type === 'immediate') {
    console.log(`[notifications] Job ${job.id} (immediate): action ${result?.actionId}, ${result?.recipientCount} notifications`);
  } else if (job.data.type === 'daily_digest') {
    console.log(`[notifications] Job ${job.id} (digest): user ${result?.userId}, ${result?.overdueCount} overdue, ${result?.recipientCount} notifications`);
  }
});

notificationQueue.on('failed', (job, err) => {
  console.error(`[notifications] Job ${job.id} (${job.data.type}) failed:`, err.message);
});

notificationQueue.on('stalled', (job) => {
  console.warn(`[notifications] Job ${job.id} stalled`);
});

notificationQueue.on('active', (job) => {
  console.log(`[notifications] Job ${job.id} (${job.data.type}) started`);
});

module.exports = { notificationQueue };
