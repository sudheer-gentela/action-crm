/**
 * services/enrichment/creditLog.js
 *
 * Thin wrapper around the enrichment_credit_log table. Writes one ledger
 * row per provider call (success or failure), and exposes helpers for the
 * OrgAdmin usage tile + SuperAdmin cross-org view.
 *
 * The cap-enforcement check (capCheck) is read-only — it does NOT debit
 * credits. The orchestrator (services/enrichment/index.js) calls capCheck
 * BEFORE making the provider call and writeLog AFTER.
 *
 * Why one row per call (rather than aggregating in app code):
 *   - Lets ops audit which exact call ran out of credits
 *   - Per-call status field captures error vs not_found vs ambiguous —
 *     useful for tuning the chain (e.g. CoreSignal returns mostly
 *     not_found → switch primary to Apollo)
 *   - Simpler reconciliation against provider dashboards
 */

const db = require('../../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// Write one ledger row. Always returns — failures are logged and swallowed
// so a credit-log write never breaks the surrounding enrichment call.
//
// args:
//   { orgId, provider, purpose='enrichment', operation, creditsUsed,
//     prospectId?, accountId?, status='ok', metadata? }
// ─────────────────────────────────────────────────────────────────────────────
async function writeLog({
  orgId, provider, purpose = 'enrichment', operation,
  creditsUsed = 1, prospectId = null, accountId = null,
  status = 'ok', metadata = null,
}) {
  try {
    await db.query(
      `INSERT INTO enrichment_credit_log
         (org_id, provider, purpose, operation, credits_used,
          prospect_id, account_id, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        orgId, provider, purpose, operation, creditsUsed,
        prospectId, accountId, status,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
  } catch (err) {
    // Non-fatal — surfacing this as a warning rather than throwing, since
    // a missed credit-log row is worth catching in ops but should never
    // block a working enrichment call.
    console.warn('[enrichment/creditLog] writeLog failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sum credits used by an org in a given month (default: current month).
// Optionally filtered by provider.
//
// Returns a number. 0 if no rows.
// ─────────────────────────────────────────────────────────────────────────────
async function monthlyUsage(orgId, { provider = null, month = null } = {}) {
  // month: 'YYYY-MM' string, or null for current month.
  let monthFilter;
  let params;
  if (month) {
    // Use date_trunc to clamp to month boundaries for safety.
    monthFilter = `occurred_at >= date_trunc('month', $2::date)
                   AND occurred_at < date_trunc('month', $2::date) + INTERVAL '1 month'`;
    params = [orgId, `${month}-01`];
  } else {
    monthFilter = `occurred_at >= date_trunc('month', NOW())`;
    params = [orgId];
  }

  let providerFilter = '';
  if (provider) {
    params.push(provider);
    providerFilter = ` AND provider = $${params.length}`;
  }

  const { rows } = await db.query(
    `SELECT COALESCE(SUM(credits_used), 0)::int AS total
       FROM enrichment_credit_log
      WHERE org_id = $1
        AND ${monthFilter}
        ${providerFilter}`,
    params
  );
  return rows[0]?.total || 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-provider breakdown for an org in a month. Returns:
//   [{ provider, credits, calls, errors }]
// ─────────────────────────────────────────────────────────────────────────────
async function monthlyBreakdown(orgId, { month = null } = {}) {
  let monthFilter;
  let params;
  if (month) {
    monthFilter = `occurred_at >= date_trunc('month', $2::date)
                   AND occurred_at < date_trunc('month', $2::date) + INTERVAL '1 month'`;
    params = [orgId, `${month}-01`];
  } else {
    monthFilter = `occurred_at >= date_trunc('month', NOW())`;
    params = [orgId];
  }

  const { rows } = await db.query(
    `SELECT provider,
            SUM(credits_used)::int                                    AS credits,
            COUNT(*)::int                                             AS calls,
            COUNT(*) FILTER (WHERE status NOT IN ('ok','not_found'))::int AS errors
       FROM enrichment_credit_log
      WHERE org_id = $1
        AND ${monthFilter}
   GROUP BY provider
   ORDER BY credits DESC`,
    params
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// SuperAdmin cross-org breakdown for a month. Returns:
//   [{ org_id, org_name, provider, credits, calls }]
// ─────────────────────────────────────────────────────────────────────────────
async function crossOrgBreakdown({ month = null } = {}) {
  let monthFilter;
  let params = [];
  if (month) {
    monthFilter = `occurred_at >= date_trunc('month', $1::date)
                   AND occurred_at < date_trunc('month', $1::date) + INTERVAL '1 month'`;
    params = [`${month}-01`];
  } else {
    monthFilter = `occurred_at >= date_trunc('month', NOW())`;
  }

  const { rows } = await db.query(
    `SELECT l.org_id,
            o.name AS org_name,
            l.provider,
            SUM(l.credits_used)::int AS credits,
            COUNT(*)::int            AS calls
       FROM enrichment_credit_log l
       JOIN organizations o ON o.id = l.org_id
      WHERE ${monthFilter}
   GROUP BY l.org_id, o.name, l.provider
   ORDER BY credits DESC`,
    params
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check whether an org is within its monthly cap. Returns:
//   { withinCap: true,  used, cap }                             — proceed
//   { withinCap: false, used, cap, reason: 'monthly_cap_exceeded' } — block
//
// cap = null means no cap (unlimited).
// Caller passes the cap value resolved from org_action_config.enrichment.
// ─────────────────────────────────────────────────────────────────────────────
async function capCheck(orgId, cap) {
  if (cap == null || cap <= 0) {
    return { withinCap: true, used: 0, cap: null };
  }
  const used = await monthlyUsage(orgId);
  if (used >= cap) {
    return { withinCap: false, used, cap, reason: 'monthly_cap_exceeded' };
  }
  return { withinCap: true, used, cap };
}

// ─────────────────────────────────────────────────────────────────────────────
// Has the 90% threshold been crossed THIS month and we haven't yet notified
// the org admins? Used by the orchestrator to fire a one-time-per-month
// warning when usage crosses 90% of cap.
//
// We use a small lookup against notifications table for idempotency:
// a notification of type 'enrichment_cap_warning' with metadata->>'month'
// matching the current month is considered "already sent".
// ─────────────────────────────────────────────────────────────────────────────
async function shouldFireCapWarning(orgId, cap) {
  if (cap == null || cap <= 0) return false;
  const used = await monthlyUsage(orgId);
  if (used < Math.floor(cap * 0.9)) return false;

  const currentMonth = new Date().toISOString().slice(0, 7);  // 'YYYY-MM'
  const { rows } = await db.query(
    `SELECT 1
       FROM notifications
      WHERE org_id = $1
        AND type = 'enrichment_cap_warning'
        AND metadata->>'month' = $2
      LIMIT 1`,
    [orgId, currentMonth]
  );
  return rows.length === 0;
}

module.exports = {
  writeLog,
  monthlyUsage,
  monthlyBreakdown,
  crossOrgBreakdown,
  capCheck,
  shouldFireCapWarning,
};
