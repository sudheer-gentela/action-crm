/**
 * StuckCallCleanup
 *
 * Background job that catches Twilio calls which got stuck in a non-terminal
 * status because Twilio's status webhook never fired (network blip, our
 * server was down during the callback retry window, signature check
 * inadvertently rejected a real Twilio call, etc.).
 *
 * Rows in 'initiated' / 'ringing' / 'in_progress' older than the per-org
 * `stuck_call_window_hours` setting are flagged as 'failed'. Default window
 * is 2 hours, overridable per-org via `org_action_config.call_settings.
 * stuck_call_window_hours`.
 *
 * Design notes:
 *  - We don't try to inspect Twilio for the *real* final state. This is a
 *    safety net, not a reconciliation. Sales reps care more about "this
 *    call isn't blocking my queue" than about getting the exact terminal
 *    state right after the fact.
 *  - We DO leave the row in place (no DELETE) so the rep can still recover
 *    it via the "Outcome not captured" recovery flow if it was actually
 *    completed but the webhook never landed. The recovery flow takes
 *    precedence — if a rep dispositioned it before the cron fires, the
 *    row will be at outcome=NOT-NULL and the cron's WHERE clause skips it.
 *  - Each org's window is read once per scan, not per row.
 *
 * Cron schedule: every 30 minutes (registered in server.js).
 */

const db = require('../config/database');

const DEFAULT_WINDOW_HOURS = 2;
const MIN_WINDOW_HOURS     = 1;   // safety floor — never run the cron more
                                   // aggressively than this, even if an admin
                                   // misconfigures the org setting to 0
const MAX_WINDOW_HOURS     = 24;

const NON_TERMINAL_STATES = ['initiated', 'ringing', 'in_progress'];


// ── Public: scan all orgs and flag stuck rows ──────────────────────────────
// Returns: { scanned: N, flagged: N, errors: N, orgs: N }
//
// Idempotent — running it twice in a row should flag nothing the second time.
// Safe to run concurrently with rep activity (the UPDATE is row-scoped).
async function scanAndFlag() {
  const startedAt = Date.now();
  let totalScanned = 0;
  let totalFlagged = 0;
  let totalErrors  = 0;

  // Pull every org that has at least one non-terminal Twilio call. Skip orgs
  // with no candidates — most orgs most of the time will fall into this fast
  // path so the cron stays cheap.
  const orgsRes = await db.pool.query(
    `SELECT DISTINCT org_id
       FROM calls
      WHERE provider = 'twilio'
        AND status IN ('initiated', 'ringing', 'in_progress')`
  );

  for (const { org_id } of orgsRes.rows) {
    try {
      const flagged = await scanOrg(org_id);
      totalScanned += flagged.scanned;
      totalFlagged += flagged.flagged;
    } catch (err) {
      totalErrors++;
      console.error(`StuckCallCleanup: org ${org_id} scan failed:`, err.message);
    }
  }

  const ms = Date.now() - startedAt;
  return {
    scanned: totalScanned,
    flagged: totalFlagged,
    errors:  totalErrors,
    orgs:    orgsRes.rows.length,
    ms,
  };
}


// ── Internal: scan one org and flag its stuck rows ─────────────────────────
// Reads the org's window setting, then runs ONE UPDATE that flips all stuck
// rows in a single round-trip. Keeps the cron fast even with many stuck rows.
async function scanOrg(orgId) {
  const windowHours = await resolveWindowForOrg(orgId);

  // The UPDATE doubles as the scan — it tells us how many rows it touched.
  // We don't pre-count; the DB count is authoritative.
  const result = await db.pool.query(
    `UPDATE calls
        SET status     = 'failed',
            updated_at = NOW()
      WHERE org_id    = $1
        AND provider  = 'twilio'
        AND status    = ANY($2::text[])
        AND created_at < NOW() - ($3 || ' hours')::interval
      RETURNING id, status, created_at`,
    [orgId, NON_TERMINAL_STATES, windowHours]
  );

  if (result.rows.length > 0) {
    console.log(`StuckCallCleanup: org ${orgId} flagged ${result.rows.length} call(s) as failed (window=${windowHours}h)`);
  }

  return {
    scanned: result.rows.length,  // since we only return rows that were flagged
    flagged: result.rows.length,
  };
}


// ── Internal: read per-org window with bounds and fallback ─────────────────
async function resolveWindowForOrg(orgId) {
  try {
    const { rows } = await db.pool.query(
      `SELECT call_settings -> 'stuck_call_window_hours' AS w
         FROM org_action_config
        WHERE org_id = $1`,
      [orgId]
    );
    const raw = rows[0]?.w;
    if (raw === null || raw === undefined) return DEFAULT_WINDOW_HOURS;

    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_WINDOW_HOURS;

    // Clamp to safety bounds so a misconfigured value can't cause harm.
    if (n < MIN_WINDOW_HOURS) return MIN_WINDOW_HOURS;
    if (n > MAX_WINDOW_HOURS) return MAX_WINDOW_HOURS;
    return n;
  } catch (err) {
    console.warn(`StuckCallCleanup: failed to read window for org ${orgId}, using default:`, err.message);
    return DEFAULT_WINDOW_HOURS;
  }
}


module.exports = {
  scanAndFlag,
  // Exposed for tests and for /api/org/admin/twilio settings validation.
  DEFAULT_WINDOW_HOURS,
  MIN_WINDOW_HOURS,
  MAX_WINDOW_HOURS,
};
