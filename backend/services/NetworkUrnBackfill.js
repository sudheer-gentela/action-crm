// services/NetworkUrnBackfill.js
//
// Marries the durable LinkedIn member URN onto roster rows (Design & Execution
// Tracker §G-P2, D8). A CSV export carries no URN — only a profile URL (slug) —
// but the extension-captured `prospects` rows often DO have `member_urn`. This
// pass copies that URN onto matching `linkedin_connections` rows (matched by
// slug), so champion/prospect resolution and future cross-source matching can
// use the stable URN.
//
// CRITICAL — we backfill the member_urn COLUMN ONLY, never the identity_key.
// Identity keys for CSV-sourced rows are `slug:<slug>` because every CSV
// re-import recomputes the key from the slug (CSV has no URN). If we "upgraded"
// the key to `urn:<urn>`, the next CSV import would recompute `slug:` , fail to
// match the urn-keyed row, and insert a DUPLICATE. So the slug key stays as the
// CSV re-match anchor; the URN rides alongside as a column for resolution.
//
// Idempotent (only touches rows where member_urn IS NULL). Safe to re-run.
// `executor` is any { query } — a transaction client (owner-scoped, called from
// POST /snapshot) or the pool/db helper (org-wide, for an optional cron).

'use strict';

async function backfillUrns(executor, { orgId, ownerId = null } = {}) {
  if (!orgId) return { updated: 0 };
  const params = [orgId];
  let ownerClause = '';
  if (ownerId != null) { params.push(ownerId); ownerClause = ' AND lc.owner_id = $2'; }

  const res = await executor.query(
    `UPDATE linkedin_connections lc
        SET member_urn = p.member_urn, updated_at = now()
       FROM prospects p
      WHERE lc.org_id = $1${ownerClause}
        AND lc.member_urn IS NULL
        AND lc.linkedin_url IS NOT NULL
        AND p.org_id = lc.org_id
        AND p.member_urn IS NOT NULL
        AND p.deleted_at IS NULL
        AND lower(substring(p.linkedin_url from '/in/([^/?#]+)'))
            = lower(substring(lc.linkedin_url from '/in/([^/?#]+)'))`,
    params
  );
  const updated = res.rowCount || 0;
  if (updated > 0) {
    console.log(`🔗 NetworkUrnBackfill: matched URNs onto ${updated} connection(s) (org=${orgId}${ownerId != null ? ` owner=${ownerId}` : ''})`);
  }
  return { updated };
}

module.exports = { backfillUrns };
