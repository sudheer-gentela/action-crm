/**
 * NdrCleanupService.js
 *
 * Finds NDR ("undeliverable") messages that were wrongly ingested as prospect
 * replies, and undoes every consequence.
 *
 * WHY THIS EXISTS
 *
 * `jobs/syncScheduler.js` has always routed mailer-daemon/postmaster mail to
 * BounceDetectionService before Gate 1 could store it. But that job only
 * iterates users with `users.gmail_connected` / outlook connected. Sequence
 * mail goes out from `prospecting_sender_accounts` — a separate OAuth store —
 * so NDRs land in a mailbox only `routes/prospecting-inbox.routes.js` reads,
 * and that path had no gate. Result: bounces were saved as
 * `emails.direction='received'`, logged as 'email_received' activities, and
 * used to advance prospects outreach → engaged. In production this left
 * `email_delivery_events` completely empty while phantom replies inflated
 * every reply metric.
 *
 * Gate 0 in prospecting-inbox.routes.js stops new ones. This service repairs
 * the ones already stored.
 *
 * ONE IMPLEMENTATION, TWO CALLERS
 *
 * `scripts/cleanupNdrReplies.js` (CLI) and `routes/ndr-cleanup.routes.js`
 * (Org Admin UI) both call execute(). The logic lives here so a fix to one
 * can never leave the other behind.
 *
 * DRY RUN IS THE DEFAULT. execute({ apply: false }) runs every mutation inside
 * a transaction and ROLLBACKs. That exercises the real SQL — constraint
 * violations included — rather than simulating it. Nothing is committed unless
 * apply === true.
 *
 * WHAT IT DOES, per NDR email found:
 *   1. (reprocess) Feeds it to BounceDetectionService.processPotentialNdr,
 *      which extracts the TRUE failed recipient from the body and writes the
 *      email_delivery_events + 'bounce_received' activity that should have
 *      existed. Idempotent (ON CONFLICT DO NOTHING). The true failed recipient
 *      is often a DIFFERENT prospect from the one the NDR was attached to —
 *      the old code matched on sending domain, which picks an arbitrary
 *      colleague of the person who actually bounced.
 *   2. Soft-deletes the emails row. Not a hard delete: the raw NDR is
 *      evidence, and every read path now filters deleted_at IS NULL.
 *   3. Deletes the 'email_received' activity it produced.
 *   4. Reverts the prospect engaged → outreach IF AND ONLY IF the stage change
 *      was triggered by a reply AND no genuine inbound email survives. A
 *      prospect who bounced once and genuinely replied later stays engaged.
 *   5. Clears last_response_at and resets prospecting_actions.outcome='replied'
 *      for prospects with no surviving genuine reply.
 *
 * WHAT IT DOES NOT DO
 *   - Never touches sequence_enrollments directly. Hard-bounce auto-stop is
 *     handled inside BounceDetectionService (config-gated by
 *     organizations.settings.bounce_handling.auto_stop_on_hard_bounce), and
 *     only when reprocess is on.
 *   - Does not rebuild prospecting_metric_daily. Run
 *     scripts/backfillMetricDaily.js afterwards if you use the WBR grid.
 *
 * KNOWN IMPRECISION (surfaced in the UI, not buried)
 *   Step 4 sets stage_changed_at = now() on reverted prospects. The original
 *   value is unrecoverable — the bounce overwrote it. MetricSnapshotService
 *   derives qualified/converted from stage_changed_at, but 'outreach' is
 *   neither, so no snapshot measure is corrupted. The revert is exact on
 *   `stage`, approximate on `stage_changed_at`.
 */

const db = require('../config/database');
const BounceDetectionService = require('./BounceDetectionService');

/**
 * Candidate rows: inbound prospect emails still visible to the app.
 * Classified in JS with the same predicate the live Gate 0 uses, rather than
 * re-implementing NDR_SUBJECT_REGEX in SQL and letting the two drift.
 */
async function findNdrEmails(client, orgId) {
  const { rows } = await client.query(
    `SELECT e.id, e.external_id, e.prospect_id, e.user_id, e.subject,
            e.from_address, e.body, e.sent_at, e.provider,
            p.email        AS prospect_email,
            p.stage        AS prospect_stage,
            p.first_name, p.last_name
       FROM emails e
       JOIN prospects p ON p.id = e.prospect_id AND p.org_id = e.org_id
      WHERE e.org_id      = $1
        AND e.direction   IN ('received', 'inbound')
        AND e.deleted_at  IS NULL
        AND e.prospect_id IS NOT NULL
      ORDER BY e.sent_at DESC`,
    [orgId]
  );

  return rows.filter((r) => {
    const from = String(r.from_address || '').toLowerCase();
    // Mirror Gate 0 exactly: an NDR never originates from the prospect's own
    // mailbox unless that mailbox is a role account.
    const exact = from && from === String(r.prospect_email || '').toLowerCase();
    const role = BounceDetectionService.isRoleSender(from);
    const ndr = BounceDetectionService.isLikelyNdr(from, r.subject);
    return ndr && (role || !exact);
  });
}

/** Does this prospect still have a genuine (non-NDR, non-deleted) reply? */
async function hasGenuineReply(client, orgId, prospectId, excludeEmailIds) {
  const { rows } = await client.query(
    `SELECT e.from_address, e.subject
       FROM emails e
      WHERE e.org_id      = $1
        AND e.prospect_id = $2
        AND e.direction   IN ('received', 'inbound')
        AND e.deleted_at  IS NULL
        AND NOT (e.id = ANY($3::int[]))`,
    [orgId, prospectId, excludeEmailIds]
  );
  return rows.some(
    (r) =>
      !BounceDetectionService.isLikelyNdr(r.from_address, r.subject) &&
      !BounceDetectionService.isRoleSender(r.from_address)
  );
}

/**
 * Preview or perform the cleanup for one org.
 *
 * @param {object} opts
 *   orgId     {number}  required
 *   reprocess {boolean} feed each NDR to BounceDetectionService (writes
 *                       email_delivery_events + bounce_received activity)
 *   apply     {boolean} COMMIT. When false (default) everything ROLLBACKs.
 *   onLog     {function} optional line logger (the CLI passes console.log)
 *
 * @returns {Promise<object>} {
 *   orgId, apply, reprocess,
 *   stats: { ndrEmails, reprocessed, activitiesDeleted, stagesReverted, actionsReset },
 *   emails:    [ { emailId, prospectId, prospectName, prospectEmail, prospectStage,
 *                  fromAddress, subject, sentAt, parsed } ],
 *   prospects: [ { prospectId, prospectEmail, outcome, detail } ],
 * }
 */
async function execute({ orgId, reprocess = false, apply = false, onLog = () => {} }) {
  if (!Number.isInteger(orgId)) throw new Error('orgId must be an integer');

  const client = await db.pool.connect();
  const stats = {
    ndrEmails: 0,
    reprocessed: 0,
    activitiesDeleted: 0,
    stagesReverted: 0,
    actionsReset: 0,
  };
  const emailsOut = [];
  const prospectsOut = [];

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${parseInt(orgId, 10)}'`);

    const ndrs = await findNdrEmails(client, orgId);
    stats.ndrEmails = ndrs.length;

    if (ndrs.length === 0) {
      await client.query('ROLLBACK');
      onLog(`org=${orgId} — no NDR-shaped replies found. Clean.`);
      return { orgId, apply, reprocess, stats, emails: [], prospects: [] };
    }

    onLog(`org=${orgId} — ${ndrs.length} NDR(s) stored as replies`);

    const ndrIds = ndrs.map((n) => n.id);

    // ── 1. Reprocess through the real parser ─────────────────────────────
    for (const n of ndrs) {
      let parsed = null;
      if (reprocess) {
        const res = await BounceDetectionService.processPotentialNdr(client, {
          orgId,
          userId: n.user_id,
          email: {
            externalId: n.external_id,
            fromAddress: n.from_address,
            subject: n.subject,
            body: n.body,
          },
          provider: n.provider,
        });
        if (res.processed) {
          stats.reprocessed++;
          parsed = {
            eventType: res.eventType,
            failedRecipient: res.failedRecipient || null,
            trueProspectId: res.prospectId || null,
            stepLogId: res.stepLogId || null,
            enrollmentStopped: !!res.enrollmentStopped,
            duplicate: !!res.duplicate,
          };
          onLog(
            `  email#${n.id}: ${res.eventType} → true recipient ` +
              `${res.failedRecipient || 'unparsed'} (prospect ${res.prospectId || 'unmatched'})` +
              (res.enrollmentStopped ? ' — enrollment stopped' : '')
          );
        } else {
          onLog(`  email#${n.id}: unparseable, no delivery event written`);
        }
      }

      emailsOut.push({
        emailId: n.id,
        prospectId: n.prospect_id,
        prospectName: [n.first_name, n.last_name].filter(Boolean).join(' ').trim() || null,
        prospectEmail: n.prospect_email,
        prospectStage: n.prospect_stage,
        fromAddress: n.from_address,
        subject: n.subject,
        sentAt: n.sent_at,
        parsed,
      });
    }

    // ── 2. Soft-delete the NDR emails ────────────────────────────────────
    await client.query(
      `UPDATE emails SET deleted_at = now()
        WHERE org_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL`,
      [orgId, ndrIds]
    );

    // ── 3. Remove the 'email_received' activities they produced ──────────
    // Link is metadata->>'emailExternalId' (what the inbox sync writes).
    // Fall back to the description string for rows written before that field
    // existed, bounded to the same prospect.
    const extIds = ndrs.map((n) => n.external_id).filter(Boolean);
    const delAct = await client.query(
      `DELETE FROM prospecting_activities a
        WHERE a.org_id = $1
          AND a.activity_type = 'email_received'
          AND a.prospect_id = ANY($2::int[])
          AND (
            (a.metadata ->> 'emailExternalId') = ANY($3::text[])
            OR a.description = ANY($4::text[])
          )
        RETURNING a.id`,
      [
        orgId,
        ndrs.map((n) => n.prospect_id),
        extIds.length ? extIds : [''],
        ndrs.map((n) => `Reply received: ${n.subject}`),
      ]
    );
    stats.activitiesDeleted = delAct.rowCount || 0;

    // ── 4 & 5. Revert stage / counters where no genuine reply survives ───
    const byProspect = new Map();
    for (const n of ndrs) if (!byProspect.has(n.prospect_id)) byProspect.set(n.prospect_id, n);

    for (const [prospectId, n] of byProspect) {
      const genuine = await hasGenuineReply(client, orgId, prospectId, ndrIds);
      if (genuine) {
        prospectsOut.push({
          prospectId,
          prospectEmail: n.prospect_email,
          outcome: 'kept',
          detail: 'A genuine reply also exists — stage left alone.',
        });
        continue;
      }

      const trig = await client.query(
        `SELECT id FROM prospecting_activities
          WHERE org_id = $1 AND prospect_id = $2
            AND activity_type = 'stage_change'
            AND metadata ->> 'trigger'  = 'reply_received'
            AND metadata ->> 'toStage'  = 'engaged'
          LIMIT 1`,
        [orgId, prospectId]
      );

      if (trig.rows.length === 0) {
        prospectsOut.push({
          prospectId,
          prospectEmail: n.prospect_email,
          outcome: 'kept',
          detail: 'No reply-triggered stage change — stage left alone.',
        });
      } else {
        const rev = await client.query(
          `UPDATE prospects
              SET stage            = 'outreach',
                  stage_changed_at = now(),
                  last_response_at = NULL,
                  updated_at       = now()
            WHERE org_id = $1 AND id = $2 AND stage = 'engaged'
            RETURNING id`,
          [orgId, prospectId]
        );
        if (rev.rowCount) {
          stats.stagesReverted++;
          await client.query(
            `INSERT INTO prospecting_activities
               (org_id, prospect_id, user_id, activity_type, description, metadata)
             VALUES ($1, $2, $3, 'stage_change', $4, $5)`,
            [
              orgId,
              prospectId,
              n.user_id,
              'Stage reverted: engaged → outreach (bounce was mis-read as a reply)',
              JSON.stringify({
                fromStage: 'engaged',
                toStage: 'outreach',
                trigger: 'ndr_cleanup',
                source: 'NdrCleanupService',
                ndrEmailId: n.id,
                ndrSubject: n.subject,
              }),
            ]
          );
          prospectsOut.push({
            prospectId,
            prospectEmail: n.prospect_email,
            outcome: 'reverted',
            detail: 'engaged → outreach',
          });
          onLog(`  prospect#${prospectId}: engaged → outreach`);
        } else {
          prospectsOut.push({
            prospectId,
            prospectEmail: n.prospect_email,
            outcome: 'kept',
            detail: 'Not currently in engaged — nothing to revert.',
          });
        }
      }

      const act = await client.query(
        `UPDATE prospecting_actions
            SET outcome = NULL, updated_at = now()
          WHERE org_id = $1 AND prospect_id = $2
            AND channel = 'email' AND outcome = 'replied'
          RETURNING id`,
        [orgId, prospectId]
      );
      stats.actionsReset += act.rowCount || 0;
    }

    if (apply) {
      await client.query('COMMIT');
      onLog(`org=${orgId} COMMITTED`);
    } else {
      await client.query('ROLLBACK');
      onLog(`org=${orgId} DRY RUN — rolled back, nothing changed`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return { orgId, apply, reprocess, stats, emails: emailsOut, prospects: prospectsOut };
}

/** Orgs that have at least one email row — the CLI's "all orgs" mode. */
async function orgsWithEmail() {
  const r = await db.query(
    `SELECT DISTINCT o.id
       FROM organizations o
      WHERE o.status = 'active'
        AND EXISTS (SELECT 1 FROM emails e WHERE e.org_id = o.id)
      ORDER BY o.id ASC`
  );
  return r.rows.map((x) => x.id);
}

module.exports = { execute, orgsWithEmail, findNdrEmails, hasGenuineReply };
