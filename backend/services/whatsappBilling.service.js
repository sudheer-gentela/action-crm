// ─────────────────────────────────────────────────────────────────────────────
// whatsappBilling.service.js
//
// Usage rollups and per-org billing configuration on top of the Stage-2 cost
// ledger (whatsapp_message_costs) and whatsapp_billing_config.
//
//   billing_mode:
//     customer_direct — the org's own WABA/card pays Meta; we only TRACK usage.
//     provider_rebill — GoWarm's account pays Meta; we rebill (meta_cost × markup).
// ─────────────────────────────────────────────────────────────────────────────
const { pool } = require('../config/database');

// Default a period to the current calendar month if not supplied.
function period(from, to) {
  const now = new Date();
  const f = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1);
  const t = to   ? new Date(to)   : new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { from: f.toISOString(), to: t.toISOString() };
}

async function getConfig(orgId) {
  const { rows: [cfg] } = await pool.query(
    `SELECT org_id, billing_mode, markup_pct, currency, platform_fee, updated_at
       FROM whatsapp_billing_config WHERE org_id = $1`, [orgId]);
  return cfg || { org_id: orgId, billing_mode: 'customer_direct', markup_pct: 0, currency: 'INR', platform_fee: 0 };
}

/**
 * Upsert billing config. `allowFull` (superadmin) permits markup/fee changes;
 * an org admin may only choose their billing_mode + currency.
 */
async function setConfig(orgId, patch, userId, allowFull) {
  const cur = await getConfig(orgId);
  const billing_mode = ['customer_direct', 'provider_rebill'].includes(patch.billing_mode)
    ? patch.billing_mode : cur.billing_mode;
  const currency   = patch.currency || cur.currency;
  const markup_pct  = allowFull && patch.markup_pct  != null ? Number(patch.markup_pct)  : cur.markup_pct;
  const platform_fee = allowFull && patch.platform_fee != null ? Number(patch.platform_fee) : cur.platform_fee;

  const { rows: [saved] } = await pool.query(
    `INSERT INTO whatsapp_billing_config (org_id, billing_mode, markup_pct, currency, platform_fee, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (org_id) DO UPDATE SET
       billing_mode = EXCLUDED.billing_mode, markup_pct = EXCLUDED.markup_pct,
       currency = EXCLUDED.currency, platform_fee = EXCLUDED.platform_fee,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`,
    [orgId, billing_mode, markup_pct, currency, platform_fee, userId]);
  return { config: saved };
}

// Per-org usage rollup for a period, broken down by category and audience.
async function orgUsage(orgId, from, to) {
  const p = period(from, to);
  const { rows } = await pool.query(
    `SELECT category, audience,
            count(*)::int                                  AS messages,
            sum(CASE WHEN billable THEN 1 ELSE 0 END)::int AS billable_messages,
            coalesce(sum(meta_cost_amount),0)              AS meta_cost,
            coalesce(sum(billed_amount),0)                 AS billed,
            max(meta_cost_currency)                        AS currency
       FROM whatsapp_message_costs
      WHERE org_id = $1 AND created_at >= $2 AND created_at < $3
      GROUP BY category, audience
      ORDER BY category, audience`,
    [orgId, p.from, p.to]);

  const totals = rows.reduce((a, r) => ({
    messages: a.messages + r.messages,
    billable_messages: a.billable_messages + r.billable_messages,
    meta_cost: a.meta_cost + Number(r.meta_cost),
    billed: a.billed + Number(r.billed),
  }), { messages: 0, billable_messages: 0, meta_cost: 0, billed: 0 });

  return { period: p, config: await getConfig(orgId), byCategory: rows, totals };
}

// Cross-org rollup for GoWarm (superadmin): usage, cost, billed, and margin.
async function superadminUsage(from, to) {
  const p = period(from, to);
  const { rows } = await pool.query(
    `SELECT c.org_id, o.name AS org_name,
            coalesce(cfg.billing_mode,'customer_direct') AS billing_mode,
            coalesce(cfg.markup_pct,0)                   AS markup_pct,
            count(*)::int                                AS messages,
            coalesce(sum(c.meta_cost_amount),0)          AS meta_cost,
            coalesce(sum(c.billed_amount),0)             AS billed,
            max(c.meta_cost_currency)                    AS currency
       FROM whatsapp_message_costs c
       JOIN organizations o ON o.id = c.org_id
       LEFT JOIN whatsapp_billing_config cfg ON cfg.org_id = c.org_id
      WHERE c.created_at >= $1 AND c.created_at < $2
      GROUP BY c.org_id, o.name, cfg.billing_mode, cfg.markup_pct
      ORDER BY billed DESC, meta_cost DESC`,
    [p.from, p.to]);

  const orgs = rows.map(r => ({
    ...r,
    margin: Number(r.billed) - Number(r.meta_cost),   // meaningful only for provider_rebill
  }));
  const totals = orgs.reduce((a, r) => ({
    messages: a.messages + r.messages,
    meta_cost: a.meta_cost + Number(r.meta_cost),
    billed: a.billed + Number(r.billed),
    margin: a.margin + r.margin,
  }), { messages: 0, meta_cost: 0, billed: 0, margin: 0 });

  return { period: p, orgs, totals };
}

module.exports = { getConfig, setConfig, orgUsage, superadminUsage };
