/**
 * cleanupNdrReplies.js
 *
 * Repairs the damage done by the missing NDR gate in
 * routes/prospecting-inbox.routes.js (fixed alongside this script).
 *
 * Before the fix, an "Undeliverable: ..." message from postmaster@<domain>
 * was matched to a prospect (usually via the loose Strategy-3 domain match),
 * stored in `emails` as direction='received', logged as an 'email_received'
 * activity, and used to advance that prospect outreach → engaged. Everything
 * downstream that counts replies — the CRM inbox, the campaign detail panel,
 * and (since the reply-attribution fix) team reporting — reads that `emails`
 * row. So bounces have been inflating reply counts and pushing dead addresses
 * forward in the funnel.
 *
 * This script finds those rows and undoes each consequence.
 *
 * USAGE
 *   node scripts/cleanupNdrReplies.js                    # DRY RUN, all orgs
 *   node scripts/cleanupNdrReplies.js 7                  # DRY RUN, org 7
 *   node scripts/cleanupNdrReplies.js 7 --reprocess      # DRY RUN + show what
 *                                                        #   BounceDetection would record
 *   node scripts/cleanupNdrReplies.js 7 --apply          # COMMIT
 *   node scripts/cleanupNdrReplies.js 7 --apply --reprocess
 *
 * DRY RUN IS THE DEFAULT. Every mutation runs inside a transaction which is
 * ROLLED BACK unless --apply is passed, so the dry run exercises the real SQL
 * (including constraint violations) rather than a simulation of it.
 *
 * WHAT IT DOES, per NDR email found:
 *   1. (--reprocess) Feeds it to BounceDetectionService.processPotentialNdr,
 *      which extracts the TRUE failed recipient from the body and writes the
 *      email_delivery_events + 'bounce_received' activity that should have
 *      existed all along. Idempotent (ON CONFLICT DO NOTHING). Note the true
 *      failed recipient is often a DIFFERENT prospect from the one the NDR was
 *      wrongly attached to — that is the whole point of parsing the body.
 *   2. Soft-deletes the emails row (deleted_at = now()). We soft-delete rather
 *      than hard-delete: the raw NDR is evidence, and every read path now
 *      filters deleted_at IS NULL.
 *   3. Deletes the 'email_received' activity it produced.
 *   4. Reverts the prospect engaged → outreach IF AND ONLY IF the stage change
 *      was triggered by this reply AND no genuine inbound email survives for
 *      that prospect. A prospect who bounced once and genuinely replied later
 *      stays engaged.
 *   5. Clears last_response_at and resets the prospecting_actions.outcome
 *      'replied' flag for prospects with no surviving genuine reply.
 *
 * WHAT IT DOES NOT DO
 *   - It never touches sequence_enrollments. If a hard bounce should have
 *     auto-stopped an enrollment, --reprocess handles that through the normal
 *     BounceDetectionService path (config-gated by
 *     organizations.settings.bounce_handling.auto_stop_on_hard_bounce).
 *   - It does not rebuild prospecting_metric_daily. Run
 *     scripts/backfillMetricDaily.js afterwards if you use the WBR grid.
 *
 * KNOWN IMPRECISION (read before --apply)
 *   Step 4 sets stage_changed_at = now() on reverted prospects. The original
 *   value is not recoverable — it was overwritten when the bounce advanced the
 *   stage. MetricSnapshotService derives qualified/converted from
 *   stage_changed_at, but only for those two stage types; 'outreach' is
 *   neither, so no snapshot measure is corrupted by this. Said plainly: the
 *   revert is correct on `stage`, approximate on `stage_changed_at`.
 */

const db = require('../config/database');
const BounceDetectionService = require('../services/BounceDetectionService');

const args        = process.argv.slice(2);
const APPLY       = args.includes('--apply');
const REPROCESS   = args.includes('--reprocess');
const positional  = args.filter((a) => !a.startsWith('--'));
const orgArg      = positional[0] ? parseInt(positional[0], 10) : null;

if (positional[0] && !Number.isInteger(orgArg)) {
  console.error(`Invalid org id: ${positional[0]}`);
  process.exit(1);
}

async function orgIds() {
  if (orgArg) return [orgArg];
  const r = await db.query(
    `SELECT DISTINCT o.id
       FROM organizations o
      WHERE o.status = 'active'
        AND EXISTS (SELECT 1 FROM emails e WHERE e.org_id = o.id)
      ORDER BY o.id ASC`
  );
  return r.rows.map((x) => x.id);
}

/**
 * Candidate rows: inbound prospect emails still visible to the app.
 * We classify in JS with the same predicate the live gate uses, rather than
 * re-implementing NDR_SUBJECT_REGEX in SQL and letting the two drift.
 */
async function findNdrEmails(client, orgId) {
  const { rows } = await client.query(
    `SELECT e.id, e.external_id, e.prospect_id, e.user_id, e.subject,
            e.from_address, e.body, e.sent_at, e.provider,
            p.email  AS prospect_email,
            p.stage  AS prospect_stage
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
    // Mirror the live gate exactly: an NDR never originates from the
    // prospect's own mailbox unless that mailbox is a role account.
    const exact = from && from === String(r.prospect_email || '').toLowerCase();
    const role  = BounceDetectionService.isRoleSender(from);
    const ndr   = BounceDetectionService.isLikelyNdr(from, r.subject);
    return ndr && (role || !exact);
  });
}

/** Does this prospect still have a genuine (non-NDR, non-deleted) reply? */
async function hasGenuineReply(client, orgId, prospectId, excludeEmailIds) {
  const { rows } = await client.query(
    `SELECT e.id, e.from_address, e.subject
       FROM emails e
      WHERE e.org_id      = $1
        AND e.prospect_id = $2
        AND e.direction   IN ('received', 'inbound')
        AND e.deleted_at  IS NULL
        AND NOT (e.id = ANY($3::int[]))`,
    [orgId, prospectId, excludeEmailIds]
  );
  return rows.some((r) =>
    !BounceDetectionService.isLikelyNdr(r.from_address, r.subject) &&
    !BounceDetectionService.isRoleSender(r.from_address)
  );
}

async function processOrg(orgId) {
  const client = await db.pool.connect();
  const stats = {
    ndrEmails: 0, reprocessed: 0, activitiesDeleted: 0,
    stagesReverted: 0, actionsReset: 0, prospectsTouched: new Set(),
  };

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${parseInt(orgId, 10)}'`);

    const ndrs = await findNdrEmails(client, orgId);
    stats.ndrEmails = ndrs.length;

    if (ndrs.length === 0) {
      await client.query('ROLLBACK');
      console.log(`[cleanupNdr] org=${orgId} — no NDR-shaped replies found. Clean.`);
      return stats;
    }

    console.log(`[cleanupNdr] org=${orgId} — ${ndrs.length} NDR(s) stored as replies:`);
    for (const n of ndrs) {
      console.log(
        `    email#${n.id}  from=${n.from_address}  → prospect#${n.prospect_id}` +
        ` (${n.prospect_email}, stage=${n.prospect_stage})  "${String(n.subject).slice(0, 60)}"`
      );
    }

    const ndrIds = ndrs.map((n) => n.id);

    // ── 1. Reprocess through the real parser ─────────────────────────────
    if (REPROCESS) {
      for (const n of ndrs) {
        const res = await BounceDetectionService.processPotentialNdr(client, {
          orgId,
          userId:   n.user_id,
          email:    { externalId: n.external_id, fromAddress: n.from_address,
                      subject: n.subject, body: n.body },
          provider: n.provider,
        });
        if (res.processed) {
          stats.reprocessed++;
          console.log(
            `    ↳ parsed email#${n.id}: ${res.eventType}` +
            ` → true prospect=${res.prospectId || 'unmatched'}` +
            (res.enrollmentStopped ? ' (enrollment stopped)' : '') +
            (res.duplicate ? ' [already recorded]' : '')
          );
        } else {
          console.log(`    ↳ email#${n.id}: unparseable, no delivery event written`);
        }
      }
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
    for (const n of ndrs) byProspect.set(n.prospect_id, n);

    for (const [prospectId, n] of byProspect) {
      stats.prospectsTouched.add(prospectId);

      const genuine = await hasGenuineReply(client, orgId, prospectId, ndrIds);
      if (genuine) {
        console.log(`    ↳ prospect#${prospectId}: genuine reply also exists — stage left alone`);
        continue;
      }

      // Only revert if the bounce is what advanced them.
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
        console.log(`    ↳ prospect#${prospectId}: no reply-triggered stage change — stage left alone`);
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
              orgId, prospectId, n.user_id,
              'Stage reverted: engaged → outreach (bounce was mis-read as a reply)',
              JSON.stringify({
                fromStage: 'engaged', toStage: 'outreach',
                trigger:   'ndr_cleanup',
                source:    'scripts/cleanupNdrReplies.js',
                ndrEmailId: n.id, ndrSubject: n.subject,
              }),
            ]
          );
          console.log(`    ↳ prospect#${prospectId}: engaged → outreach`);
        }
      }

      // Clear the Responses/WK flag set by the phantom reply.
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

    if (APPLY) {
      await client.query('COMMIT');
      console.log(`[cleanupNdr] org=${orgId} COMMITTED`);
    } else {
      await client.query('ROLLBACK');
      console.log(`[cleanupNdr] org=${orgId} DRY RUN — rolled back, nothing changed`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[cleanupNdr] org=${orgId} FAILED (rolled back):`, err.message);
    throw err;
  } finally {
    client.release();
  }

  return stats;
}

async function main() {
  console.log(
    `[cleanupNdr] mode=${APPLY ? 'APPLY' : 'DRY RUN'}` +
    ` reprocess=${REPROCESS ? 'yes' : 'no'}`
  );
  if (!APPLY) console.log('[cleanupNdr] No changes will be committed. Re-run with --apply.\n');

  const orgs = await orgIds();
  let failures = 0;
  const totals = { ndrEmails: 0, reprocessed: 0, activitiesDeleted: 0, stagesReverted: 0, actionsReset: 0 };

  for (const orgId of orgs) {
    try {
      const s = await processOrg(orgId);
      totals.ndrEmails         += s.ndrEmails;
      totals.reprocessed       += s.reprocessed;
      totals.activitiesDeleted += s.activitiesDeleted;
      totals.stagesReverted    += s.stagesReverted;
      totals.actionsReset      += s.actionsReset;
    } catch {
      failures++;
    }
  }

  console.log(
    `\n[cleanupNdr] ${APPLY ? 'applied' : 'would apply'} across ${orgs.length} org(s):\n` +
    `    NDR emails soft-deleted : ${totals.ndrEmails}\n` +
    `    delivery events written : ${totals.reprocessed}\n` +
    `    reply activities removed: ${totals.activitiesDeleted}\n` +
    `    stages reverted         : ${totals.stagesReverted}\n` +
    `    action outcomes reset   : ${totals.actionsReset}\n` +
    `    failures                : ${failures}`
  );
  if (!APPLY && totals.ndrEmails > 0) {
    console.log('\n[cleanupNdr] Re-run with --apply --reprocess to commit.');
  }
  await db.pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[cleanupNdr] fatal:', err);
  await db.pool.end().catch(() => {});
  process.exit(1);
});
