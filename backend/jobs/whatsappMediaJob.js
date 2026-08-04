// ─────────────────────────────────────────────────────────────────────────────
// jobs/whatsappMediaJob.js
//
// Fetches inbound WhatsApp attachments from Meta and stores them in the
// customer's own Drive or OneDrive.
//
// TWO PATHS, ON PURPOSE:
//   • enqueue()  — called from webhook ingest. Runs within seconds, which is
//                  what makes the download URL (minutes) irrelevant.
//   • runSweep() — a cron backstop for anything the queue dropped: a Redis
//                  outage, a deploy mid-flight, or a project that had no
//                  storage configured when the message arrived. Ordered by how
//                  close Meta is to dropping the media.
//
//   The sweep is not belt-and-braces. Meta keeps media about 30 days and the
//   number is on the Cloud API, so it has no app inbox — an attachment nobody
//   fetches is unreachable by anyone, permanently. A queue that silently loses
//   a job loses a file.
//
// Wiring (one line each, in the server.js cron/worker block):
//     require('./jobs/whatsappMediaJob');                       // processor
//     require('./jobs/whatsappMediaJob').startScheduler();      // sweep
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const Queue = require('bull');
const cron  = require('node-cron');

const media = require('../services/whatsappMedia.service');

const SCHEDULE   = process.env.WHATSAPP_MEDIA_CRON || '*/15 * * * *';
const BATCH_SIZE = parseInt(process.env.WHATSAPP_MEDIA_BATCH || '50', 10);

const mediaQueue = new Queue('whatsapp-media', process.env.REDIS_URL, {
  defaultJobOptions: {
    // Five attempts over roughly ten minutes. Generous because the cost of
    // giving up is a permanently lost file, and bounded because a genuinely
    // dead credential will not recover no matter how long we try — that case
    // is marked 'skipped' by the service and never reaches a retry.
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 200,
    removeOnFail:     100,
  },
});

mediaQueue.process(async (job) => {
  const { orgId, messageId } = job.data;
  const result = await media.captureMessage(orgId, messageId);

  // Throwing is what tells Bull to retry, so ONLY genuinely retryable outcomes
  // throw. 'skipped' and 'expired' are final answers — retrying them burns the
  // attempt budget on something that cannot change, and buries the queue.
  if (result.status === 'failed' && result.retryable) {
    throw new Error(result.reason || 'media capture failed');
  }
  return result;
});

mediaQueue.on('failed', (job, err) => {
  console.warn(`[whatsapp-media] message ${job.data?.messageId} attempt ${job.attemptsMade} failed: ${err.message}`);
});

/**
 * Queue one attachment. Never throws: a queueing failure must not roll back the
 * webhook, or Meta retries the whole delivery and the message is ingested
 * twice. The sweep will pick it up.
 */
async function enqueue(orgId, messageId) {
  const jobId = `wa-media-${messageId}`;
  try {
    // A fixed jobId stops the same attachment being processed twice when the
    // ingest enqueue and the sweep overlap. But Bull KEEPS finished jobs
    // (removeOnComplete: 200), and add() with an existing jobId is a silent
    // no-op — so once a message had been through once, every later retry was
    // quietly discarded.
    //
    // That is not academic: the first run of a message whose project had no
    // attachment folder completes as 'skipped', which is a SUCCESS as far as
    // Bull is concerned. Configure the folder afterwards and the retry could
    // never run, with no error anywhere. Sweep says "sweeping 1", nothing
    // happens, nothing is logged.
    //
    // So: clear a finished job before re-adding, and leave a live one alone.
    const existing = await mediaQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (['waiting', 'active', 'delayed'].includes(state)) return true;  // already coming
      await existing.remove();
    }
    await mediaQueue.add({ orgId, messageId }, { jobId });
    return true;
  } catch (err) {
    console.warn(`[whatsapp-media] could not enqueue message ${messageId}: ${err.message} — the sweep will retry`);
    return false;
  }
}

/**
 * Reap what the source has already dropped, then queue whatever is still
 * recoverable. Reaping first keeps expired media out of the batch.
 *
 * TWO TRANSPORTS, ONE SWEEP
 *   Cloud API rows go through Bull as they always have. SESSION rows are not
 *   fetchable from this process at all — the key is in the worker's copy of
 *   the message and the CDN is not Graph — so captureMessage() puts them back
 *   into 'pending' and the worker collects them on its next heartbeat. That is
 *   a cheap UPDATE, so it is fine for it to go through the same queue, and
 *   routing it here rather than branching keeps one code path for "this
 *   attachment is overdue".
 */
async function runSweep() {
  try {
    const { expired } = await media.reapExpired();
    if (expired) console.log(`[whatsapp-media] ${expired} attachment(s) passed their retention window and are unrecoverable`);

    const due = await media.listRecoverable(BATCH_SIZE);
    if (!due.length) return;

    const session = due.filter(m => m.media_source === 'session').length;
    console.log(`[whatsapp-media] sweeping ${due.length} attachment(s)${session ? ` (${session} via the session worker)` : ''}`);
    for (const m of due) await enqueue(m.org_id, m.id);
  } catch (err) {
    console.error('[whatsapp-media] sweep failed:', err.message);
  }
}

function startScheduler() {
  cron.schedule(SCHEDULE, runSweep);
  console.log(`📎 WhatsApp media capture scheduler started (cron: ${SCHEDULE})`);
}

module.exports = { mediaQueue, enqueue, runSweep, startScheduler };
