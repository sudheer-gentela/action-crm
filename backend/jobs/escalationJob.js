// jobs/escalationJob.js
//
// Bull queue for action escalation processing.
// Follows the exact same pattern as emailProcessor.js.
//
// Job types:
//   type='immediate'    — process a single overdue action's immediate alert
//   type='daily_digest' — process a daily digest for a single user

const Queue = require('bull');
const escalationService = require('../services/escalationService');

// ── Queue setup ───────────────────────────────────────────────────────────────
const escalationQueue = new Queue('action-escalation', process.env.REDIS_URL, {
  defaultJobOptions: {
    attempts:         3,
    backoff:          { type: 'exponential', delay: 2000 },
    removeOnComplete: 200,
    removeOnFail:     100,
  },
});

// ── Job processor ─────────────────────────────────────────────────────────────
escalationQueue.process(async (job) => {
  const { type, orgId, actionId, userId, overdueActions } = job.data;

  console.log(`[escalation] Processing job ${job.id}: type=${type} org=${orgId}`);

  if (type === 'immediate') {
    // Single action immediate alert
    job.progress(20);
    const result = await escalationService.processImmediateEscalation(orgId, actionId);
    job.progress(100);
    return result;

  } else if (type === 'daily_digest') {
    // Daily digest for a single user's overdue actions
    job.progress(20);
    const result = await escalationService.processDailyDigest(orgId, userId, overdueActions);
    job.progress(100);
    return result;

  } else {
    console.warn(`[escalation] Unknown job type: ${type}`);
    return { skipped: true, reason: 'unknown_type' };
  }
});

// ── Event listeners ───────────────────────────────────────────────────────────
escalationQueue.on('completed', (job, result) => {
  if (result?.skipped) {
    console.log(`[escalation] Job ${job.id} skipped: ${result.reason}`);
  } else if (job.data.type === 'immediate') {
    console.log(`[escalation] Job ${job.id} (immediate): action ${result?.actionId}, ${result?.recipientCount} notifications`);
  } else if (job.data.type === 'daily_digest') {
    console.log(`[escalation] Job ${job.id} (digest): user ${result?.userId}, ${result?.overdueCount} overdue, ${result?.recipientCount} notifications`);
  }
});

escalationQueue.on('failed', (job, err) => {
  console.error(`[escalation] Job ${job.id} (${job.data.type}) failed:`, err.message);
});

escalationQueue.on('stalled', (job) => {
  console.warn(`[escalation] Job ${job.id} stalled`);
});

escalationQueue.on('active', (job) => {
  console.log(`[escalation] Job ${job.id} (${job.data.type}) started`);
});

module.exports = { escalationQueue };
