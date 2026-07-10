#!/usr/bin/env node
/**
 * scripts/backfillDeliveryEvents.js
 *
 * ONE-OFF RECOVERY. Rebuilds `email_delivery_events` from NDRs that
 * NdrCleanupService has already soft-deleted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * NdrCleanupService does two things in one transaction:
 *
 *   1. (optional, ?reprocess=1) feeds each NDR to
 *      BounceDetectionService.processPotentialNdr → writes email_delivery_events
 *   2. (always, on apply) soft-deletes the NDR: `UPDATE emails SET deleted_at`
 *
 * Step 2 ran. Step 1 did not. And `findNdrEmails` — the only thing that knows
 * how to locate an NDR — filters `e.deleted_at IS NULL`. So the evidence is
 * quarantined and the tool designed to read it can no longer see it. Re-running
 * the cleanup with ?reprocess=1 now finds zero NDRs and writes zero events, and
 * Team reporting shows `Bounced —` forever.
 *
 * This script is the way back in. It reads NDR-shaped emails REGARDLESS of
 * deleted_at, and feeds them through the same parser the live path uses.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES *NOT* DO
 *
 * It does not touch `emails.deleted_at`, prospect stages, `last_response_at`,
 * or the `email_received` activities. NdrCleanupService already did all of that
 * correctly. This script only recovers the delivery telemetry that step 1 would
 * have produced. Running it does not "un-clean" anything.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IDEMPOTENCY
 *
 * `email_delivery_events` is unique on (org_id, ndr_external_id,
 * failed_recipient) WHERE ndr_external_id IS NOT NULL. processPotentialNdr
 * returns `{duplicate:true}` and exits before touching activities or enrollments
 * when the insert conflicts, so a second run is a no-op.
 *
 * NDRs with a NULL external_id have no conflict target and WOULD duplicate on a
 * re-run. They are counted and skipped; see `noExternalId` in the report.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * detected_at IS BACKDATED, DELIBERATELY
 *
 * processPotentialNdr lets `detected_at` default to now(). For a live NDR that
 * is exactly right. For a bounce that arrived in May, stamping it "today" is a
 * lie with two consequences:
 *
 *   * the drill panel says a three-month-old bounce happened "2h ago"
 *   * `deliveryTelemetry.since` = today, so BounceEventsQuery's coverage note
 *     fires on every window ("bounce capture began today"), which is useless
 *
 * After each successful insert we set detected_at to the NDR's own sent_at.
 * `since` then reports the oldest bounce we actually hold, and a window opening
 * before it is honestly flagged as uncovered.
 *
 * Note this does NOT move any reporting number: BounceEventsQuery windows on the
 * SEND's fired_at, never on detected_at. Only labels and coverage change.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SIDE EFFECT WORTH READING BEFORE YOU PASS --apply
 *
 * processPotentialNdr stops enrollments on a hard bounce
 * (status='stopped', stop_reason='hard_bounce') when the org has
 * settings.bounce_handling.auto_stop_on_hard_bounce enabled — the default.
 * Backfilling months-old bounces will therefore stop any enrollment that is
 * STILL ACTIVE against a dead address. That is the correct outcome, and it is a
 * write to sequence_enrollments that a "reporting backfill" does not obviously
 * imply. The dry run reports the count before you commit. Use --no-stop to
 * suppress it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 *
 *   node scripts/backfillDeliveryEvents.js --org 12              # dry run
 *   node scripts/backfillDeliveryEvents.js --org 12 --apply
 *   node scripts/backfillDeliveryEvents.js --org 12 --apply --no-stop
 *   node scripts/backfillDeliveryEvents.js --all-orgs            # dry run, every org
 *
 * A dry run opens a transaction, does the full work, and ROLLBACKs. The numbers
 * it prints are what an --apply would produce.
 */

const { pool } = require('../config/database');
const BounceDetectionService = require('../services/BounceDetectionService');

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const APPLY    = has('--apply');
const NO_STOP  = has('--no-stop');
const ALL_ORGS = has('--all-orgs');
const ORG_ID   = val('--org') ? parseInt(val('--org'), 10) : null;

if (!ALL_ORGS && !Number.isInteger(ORG_ID)) {
  console.error('Usage: node scripts/backfillDeliveryEvents.js --org <id> [--apply] [--no-stop]');
  console.error('   or: node scripts/backfillDeliveryEvents.js --all-orgs [--apply]');
  process.exit(1);
}

/**
 * Every NDR-shaped inbound email for an org, cleaned or not.
 *
 * Mirrors NdrCleanupService.findNdrEmails exactly — same JOIN, same direction
 * filter, same isLikelyNdr/isRoleSender predicate — with ONE difference: no
 * `deleted_at IS NULL`. If the classifier there changes, change it here too.
 */
async function findAllNdrEmails(client, orgId) {
  const { rows } = await client.query(
    `SELECT e.id, e.external_id, e.prospect_id, e.user_id, e.subject,
            e.from_address, e.body, e.sent_at, e.provider, e.deleted_at,
            p.email AS prospect_email
       FROM emails e
       JOIN prospects p ON p.id = e.prospect_id AND p.org_id = e.org_id
      WHERE e.org_id      = $1
        AND e.direction   IN ('received', 'inbound')
        AND e.prospect_id IS NOT NULL
      ORDER BY e.sent_at ASC`,
    [orgId]
  );

  // Byte-for-byte the predicate in NdrCleanupService.findNdrEmails. If that one
  // changes, change this one. A looser filter here would feed genuine replies to
  // the bounce parser; a tighter one would leave real bounces unrecovered.
  return rows.filter((r) => {
    const from  = String(r.from_address || '').toLowerCase();
    const exact = from && from === String(r.prospect_email || '').toLowerCase();
    const role  = BounceDetectionService.isRoleSender(from);
    const ndr   = BounceDetectionService.isLikelyNdr(from, r.subject);
    return ndr && (role || !exact);
  });
}

async function backfillOrg(client, orgId, log) {
  const ndrs = await findAllNdrEmails(client, orgId);

  const stats = {
    orgId,
    found: ndrs.length,
    cleaned: ndrs.filter((n) => n.deleted_at).length,
    live: ndrs.filter((n) => !n.deleted_at).length,
    noExternalId: 0,
    unparseable: 0,
    written: 0,
    duplicate: 0,
    linked: 0,
    unlinked: 0,
    hard: 0,
    soft: 0,
    block: 0,
    enrollmentsStopped: 0,
    backdated: 0,
  };

  if (ndrs.length === 0) {
    log(`org=${orgId} — no NDR-shaped emails found.`);
    return stats;
  }

  log(`org=${orgId} — ${ndrs.length} NDR(s) (${stats.cleaned} cleaned, ${stats.live} live)`);

  for (const n of ndrs) {
    // No conflict target → a re-run would duplicate. Skip rather than corrupt.
    if (!n.external_id) {
      stats.noExternalId++;
      log(`  email#${n.id}: skipped — no external_id, cannot dedupe on re-run`);
      continue;
    }

    let res;
    try {
      res = await BounceDetectionService.processPotentialNdr(client, {
        orgId,
        userId: n.user_id,
        email: {
          externalId:  n.external_id,
          fromAddress: n.from_address,
          subject:     n.subject,
          body:        n.body,
          // The whole point. Without it matchToStepLog anchors on now(), finds
          // no send within 14 days of *today* for a months-old bounce, and
          // writes step_log_id = NULL — which BounceEventsQuery discards.
          sentAt:      n.sent_at,
        },
        provider: n.provider,
      });
    } catch (err) {
      log(`  email#${n.id}: ERROR ${err.message}`);
      continue;
    }

    if (!res.processed) {
      stats.unparseable++;
      log(`  email#${n.id}: NDR-shaped but no extractable recipient — skipped`);
      continue;
    }

    if (res.duplicate) {
      stats.duplicate++;
      continue;
    }

    stats.written++;
    if (res.eventType === 'hard_bounce') stats.hard++;
    else if (res.eventType === 'soft_bounce') stats.soft++;
    else if (res.eventType === 'block') stats.block++;

    if (res.stepLogId) stats.linked++; else stats.unlinked++;
    if (res.enrollmentStopped) stats.enrollmentsStopped++;

    // Backdate. See the header — this moves no reporting number, only labels
    // and `deliveryTelemetry.since`.
    if (n.sent_at) {
      const upd = await client.query(
        `UPDATE email_delivery_events
            SET detected_at = ($4::timestamp AT TIME ZONE 'UTC')
          WHERE org_id           = $1
            AND ndr_external_id  = $2
            AND failed_recipient = $3`,
        [orgId, n.external_id, res.failedRecipient, n.sent_at]
      );
      stats.backdated += upd.rowCount;
    }

    log(
      `  email#${n.id}: ${res.eventType} → ${res.failedRecipient || 'unparsed'}` +
      ` step_log=${res.stepLogId || 'UNLINKED'}` +
      (res.enrollmentStopped ? ' — enrollment stopped' : '')
    );
  }

  return stats;
}

function report(s) {
  const pctLinked = s.written > 0 ? ((s.linked / s.written) * 100).toFixed(1) : '0.0';
  console.log(`
── org ${s.orgId} ─────────────────────────────────────────
  NDRs found            ${s.found}  (${s.cleaned} cleaned · ${s.live} live)
  skipped, no ext id    ${s.noExternalId}
  skipped, unparseable  ${s.unparseable}
  already present       ${s.duplicate}
  events written        ${s.written}
    hard_bounce         ${s.hard}
    soft_bounce         ${s.soft}
    block               ${s.block}
  linked to a send      ${s.linked}  (${pctLinked}%)   ← only these reach Bounced
  UNLINKED              ${s.unlinked}                   ← invisible to reporting
  detected_at backdated ${s.backdated}
  enrollments stopped   ${s.enrollmentsStopped}
`);

  if (s.unlinked > 0) {
    console.log(
      `  NOTE: ${s.unlinked} event(s) have no step_log_id. BounceEventsQuery\n` +
      `  INNER JOINs on step_log_id so bounced ⊆ sent and delivered cannot go\n` +
      `  negative — these will NOT appear in Bounced or Deliv %. Usual causes:\n` +
      `  the send is older than MATCH_WINDOW_DAYS (14) before the NDR, or the\n` +
      `  failed recipient does not match any prospect's email.\n`
    );
  }
  if (s.noExternalId > 0) {
    console.log(
      `  NOTE: ${s.noExternalId} NDR(s) have no external_id and were skipped —\n` +
      `  the unique index that makes this script idempotent is partial on\n` +
      `  (ndr_external_id IS NOT NULL). Inserting them would duplicate on a\n` +
      `  re-run. They are lost to reporting unless deduped by hand.\n`
    );
  }
}

(async () => {
  const client = await pool.connect();
  const quiet = ALL_ORGS && !process.env.VERBOSE;
  const log = (m) => { if (!quiet) console.log(m); };

  try {
    await client.query('BEGIN');

    const orgIds = ALL_ORGS
      ? (await client.query('SELECT id FROM organizations ORDER BY id')).rows.map((r) => r.id)
      : [ORG_ID];

    // ── --no-stop ────────────────────────────────────────────────────────
    // Enrollment stopping is config-gated inside BounceDetectionService and
    // read per-org from organizations.settings. There is no override argument,
    // so the only way to suppress it is to flip the setting for the duration of
    // this transaction.
    //
    // The naive version — set false, then set true at the end — silently ENABLES
    // auto-stop on any org that had deliberately turned it off. Snapshot the
    // whole `settings` jsonb per org and restore it byte-for-byte instead.
    //
    // (A concurrent write to organizations.settings during this run would be
    // clobbered by the restore. This is a one-off maintenance script; run it
    // when nobody is editing org settings.)
    let settingsSnapshot = [];
    if (NO_STOP) {
      settingsSnapshot = (await client.query(
        `SELECT id, settings FROM organizations WHERE id = ANY($1::int[]) FOR UPDATE`,
        [orgIds]
      )).rows;
      await client.query(
        `UPDATE organizations
            SET settings = jsonb_set(
                  COALESCE(settings, '{}'::jsonb),
                  '{bounce_handling,auto_stop_on_hard_bounce}',
                  'false'::jsonb, true)
          WHERE id = ANY($1::int[])`,
        [orgIds]
      );
      console.log('--no-stop: auto_stop_on_hard_bounce suppressed for this run');
    }

    const all = [];
    for (const id of orgIds) all.push(await backfillOrg(client, id, log));

    if (NO_STOP) {
      for (const row of settingsSnapshot) {
        await client.query(
          `UPDATE organizations SET settings = $2 WHERE id = $1`,
          [row.id, row.settings]
        );
      }
      console.log('--no-stop: original org settings restored');
    }

    for (const s of all) if (s.found > 0) report(s);

    if (APPLY) {
      await client.query('COMMIT');
      console.log('COMMITTED.');
      console.log('Next: node scripts/backfillMetricDaily.js   (so the WBR grid agrees)');
    } else {
      await client.query('ROLLBACK');
      console.log('DRY RUN — rolled back. Re-run with --apply to commit.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('FAILED, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
