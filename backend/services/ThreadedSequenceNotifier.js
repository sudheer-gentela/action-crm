// ─────────────────────────────────────────────────────────────────────────────
// services/ThreadedSequenceNotifier.js  (2026_71)
//
// Owner-facing alerts when a THREADED / pinned enrollment can't send because its
// pinned mailbox is blocked (revoked token or deactivated) and the sequence is in
// 'defer' failover mode. Two entry points:
//
//   notifyBlocked() — fired ONCE at the moment an enrollment is paused (the
//                     firer's pauseThreadBlocked guards the transition, so this
//                     is not re-fired on subsequent ticks).
//   notifyDigest()  — fired by the daily job (threadedSequenceDigest.js) with a
//                     per-owner roll-up of everything still blocked, until the
//                     owner resolves it.
//
// Both carry the SAME three resolution options in metadata so the UI can render
// consistent actions on either the immediate alert or the digest:
//   • fix_sender     — reconnect / refresh the pinned mailbox, then resume.
//   • switch_sender  — move to a different sender from the SAME user; the thread
//                      is carried on the recipient side (subject + References)
//                      even though the server-side thread resets.
//   • stop_sequence  — stop the enrollment(s).
//
// Thin wrapper over notificationService.createNotification (the in-app row is the
// source of truth; it also fans out to Slack). Kept separate so the broadly-used
// notificationService needs no edits.
// ─────────────────────────────────────────────────────────────────────────────

const notificationService = require('./notificationService');

const TYPE_BLOCKED = 'thread_sender_blocked';
const TYPE_DIGEST  = 'thread_sender_blocked_digest';

const RESOLUTION_OPTIONS = [
  { key: 'fix_sender',    label: 'Reconnect the sending mailbox' },
  { key: 'switch_sender', label: 'Switch to a different sender (from the same user)' },
  { key: 'stop_sequence', label: 'Stop the sequence' },
];

/**
 * Immediate, one-shot alert when an enrollment is paused by the defer path.
 * `client` is accepted for signature symmetry with the firer; the in-app write
 * runs on the notificationService pool (best-effort, same as all notifications).
 */
async function notifyBlocked(client, { orgId, userId, enrollmentId, seqId, seqName, stepOrder, senderId, reason }) {
  const title = `Threaded sequence paused: "${seqName || 'sequence'}"`;
  const body =
    `Step ${stepOrder ?? '?'} of "${seqName || 'sequence'}" couldn't send because the pinned ` +
    `mailbox is unavailable (${reason || 'sender blocked'}). The enrollment is paused to keep the ` +
    `thread intact. Resolve it by reconnecting the mailbox, switching to another sender from the ` +
    `same user (the thread is carried on the recipient side), or stopping the sequence.`;

  return notificationService.createNotification(
    orgId, userId, TYPE_BLOCKED, title, body,
    'sequence_enrollment', enrollmentId,
    {
      seqId: seqId || null,
      stepOrder: stepOrder ?? null,
      senderId: senderId || null,
      reason: reason || null,
      resolutionOptions: RESOLUTION_OPTIONS,
    }
  );
}

/**
 * Daily roll-up for one owner. `blocked` is an array of
 * { enrollmentId, seqId, seqName, senderId, prospectId, blockedAt }.
 * One digest notification per owner per run.
 */
async function notifyDigest(client, { orgId, userId, blocked }) {
  const n = blocked.length;
  if (!n) return null;

  const seqNames = [...new Set(blocked.map(b => b.seqName).filter(Boolean))];
  const title = `${n} threaded sequence enrollment${n === 1 ? '' : 's'} still paused`;
  const body =
    `${n} enrollment${n === 1 ? '' : 's'} across ${seqNames.length || 1} sequence` +
    `${seqNames.length === 1 ? '' : 's'}${seqNames.length ? ` (${seqNames.slice(0, 3).join(', ')}${seqNames.length > 3 ? '…' : ''})` : ''}` +
    ` are paused because their pinned mailbox is still unavailable. Reconnect the mailbox, switch to ` +
    `another sender from the same user, or stop the affected sequences.`;

  return notificationService.createNotification(
    orgId, userId, TYPE_DIGEST, title, body,
    'sequence_enrollment', blocked[0].enrollmentId,
    {
      count: n,
      enrollmentIds: blocked.map(b => b.enrollmentId),
      sequences: seqNames,
      resolutionOptions: RESOLUTION_OPTIONS,
    }
  );
}

module.exports = {
  notifyBlocked,
  notifyDigest,
  TYPE_BLOCKED,
  TYPE_DIGEST,
  RESOLUTION_OPTIONS,
};
