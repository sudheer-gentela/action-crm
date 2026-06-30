// services/NetworkJobChangePlayService.js
//
// P1 routing for network job-change events (Design & Execution Tracker §G-P1).
// FIRST play (D4): champion-left CHURN risk.
//
// For each unclassified company_change event, resolve the moved person to a
// CHAMPION contact at a CUSTOMER account (account_type='customer', D12). If
// matched, it's a champion-leaving-a-customer signal:
//   • stamp the event: is_from_customer_account=true, from_account_id
//   • mint a churn-risk action on the OLD account (re-multithread)
// If not matched, mark the event is_from_customer_account=false so it isn't
// re-evaluated (idempotent re-runs).
//
// PERSON-CENTRIC by design (matches the coverage rule in §C): we link the
// connection to a known contact via contacts.linkedin_url (slug), the canonical
// contact_identities resolver, or prospect conversion — NOT by matching the
// company name string (the CSV has no domain, D3). A pure network connection
// with no contact linkage at the customer simply won't fire — accepted for v1.
//
// The churn play lands in the `actions` table (account-level), mirroring
// ActionPersister's column conventions (source='auto_generated', source_rule,
// status 'yet_to_start'). There is no (account_id, source_rule) unique index,
// so dedup is app-level (INSERT … WHERE NOT EXISTS) — no new index on the
// populated actions table.
//
// NOT here (next slice): pursue-champion play at the NEW company + auto-promote
// to prospect (D2). That needs the prospect-promotion path + config.

'use strict';

const { slugFromUrl } = require('./NetworkConnectionIngestService');

// D11 default champion vocabulary — maps to real contacts.role_type CHECK values
// (champion/decision_maker/economic_buyer) + deal_contacts is_primary/role.
// Could move to org config later.
const CHAMPION_ROLES = new Set(['champion', 'decision_maker', 'economic_buyer']);

const CHURN_SOURCE_RULE = 'champion_left';

// ── Pure predicate (exported for unit tests; no DB) ───────────────────────────
// A contact is a "champion" if their role_type qualifies, OR any of their
// deal_contacts links for the account is primary / a champion role.
function isChampionRole(roleType, dealContactRows = []) {
  if (roleType && CHAMPION_ROLES.has(String(roleType).toLowerCase())) return true;
  for (const dc of dealContactRows) {
    if (dc.is_primary) return true;
    if (dc.role && CHAMPION_ROLES.has(String(dc.role).toLowerCase())) return true;
  }
  return false;
}

// ── Resolve a moved connection → champion contact at a customer account ────────
// @returns { matched:false } | { matched:true, accountId, accountName, accountOwnerId, contactId, roleType, via }
async function findChampionContext(client, { orgId, connection }) {
  const slug = slugFromUrl(connection.linkedin_url || connection.linkedinUrl);
  const idValues = [connection.member_urn || connection.memberUrn,
                    connection.linkedin_url || connection.linkedinUrl]
                    .filter(Boolean).map((v) => String(v).toLowerCase());
  const prospectId = connection.prospect_id || connection.prospectId || null;

  // Candidate contacts at CUSTOMER accounts, via three linkage paths.
  const res = await client.query(
    `WITH cand AS (
        -- (a) direct slug match on contacts.linkedin_url
        SELECT c.id, c.account_id, c.role_type
          FROM contacts c
         WHERE c.org_id = $1 AND c.deleted_at IS NULL
           AND $2::text IS NOT NULL
           AND lower(substring(c.linkedin_url from '/in/([^/?#]+)')) = $2
        UNION
        -- (b) canonical identity resolver (match by value or by slug-in-value)
        SELECT c.id, c.account_id, c.role_type
          FROM contact_identities ci
          JOIN contacts c ON c.id = ci.canonical_contact_id
                         AND c.org_id = ci.org_id AND c.deleted_at IS NULL
         WHERE ci.org_id = $1 AND ci.status = 'confirmed'
           AND ( lower(ci.identity_value) = ANY($3::text[])
              OR ($2::text IS NOT NULL
                  AND lower(substring(ci.identity_value from '/in/([^/?#]+)')) = $2) )
        UNION
        -- (c) prospect this connection was promoted from, later converted to a contact
        SELECT c.id, c.account_id, c.role_type
          FROM contacts c
         WHERE c.org_id = $1 AND c.deleted_at IS NULL
           AND $4::int IS NOT NULL AND c.converted_from_prospect_id = $4
     )
     SELECT cand.id AS contact_id, cand.account_id, cand.role_type,
            a.name AS account_name, a.owner_id AS account_owner_id
       FROM cand
       JOIN accounts a ON a.id = cand.account_id AND a.org_id = $1 AND a.deleted_at IS NULL
      WHERE a.account_type = 'customer'
      LIMIT 5`,
    [orgId, slug, idValues, prospectId]
  );
  if (!res.rows.length) return { matched: false };

  for (const cand of res.rows) {
    // deal_contacts links for this contact on deals at this account
    const dc = await client.query(
      `SELECT dc.role, dc.is_primary
         FROM deal_contacts dc
         JOIN deals d ON d.id = dc.deal_id AND d.deleted_at IS NULL AND d.account_id = $2
        WHERE dc.contact_id = $1`,
      [cand.contact_id, cand.account_id]
    );
    if (isChampionRole(cand.role_type, dc.rows)) {
      return {
        matched: true,
        accountId: cand.account_id,
        accountName: cand.account_name,
        accountOwnerId: cand.account_owner_id,
        contactId: cand.contact_id,
        roleType: cand.role_type,
        via: 'role',
      };
    }
  }
  return { matched: false };
}

// ── Mint the churn-risk action (app-level dedup) ──────────────────────────────
async function upsertChurnAction(client, { orgId, assigneeId, ctx, connection, event }) {
  const sourceId = `${CHURN_SOURCE_RULE}:${connection.connection_id || connection.id}:${ctx.accountId}`;
  const who = connection.full_name || 'A champion';
  const left = event.from_company || ctx.accountName || 'a customer account';
  const title = `Churn risk: ${who} left ${left}`;
  const description =
    `${who}${ctx.roleType ? ` (${ctx.roleType})` : ''} at ${ctx.accountName || 'this customer'} `
    + `appears to have moved to ${event.to_company || 'a new company'}. `
    + `Re-multithread the account — confirm coverage and identify a new internal sponsor.`;
  const suggested = `Reach another stakeholder at ${ctx.accountName || 'the account'} to re-establish a sponsor.`;

  const ins = await client.query(
    `INSERT INTO actions (
        org_id, user_id, account_id, contact_id,
        type, action_type, title, description,
        priority, due_date, next_step, is_internal,
        source, source_rule, source_module, source_id,
        suggested_action, status, created_at, updated_at
     )
     SELECT $1, $2, $3, $4,
            'churn_risk', 'churn_risk', $5, $6,
            'high', NOW(), 'email', false,
            'auto_generated', $7, 'prospecting', $8,
            $9, 'yet_to_start', NOW(), NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM actions
         WHERE org_id = $1 AND account_id = $3
           AND source_rule = $7 AND source_id = $8
           AND completed = false
      )
     RETURNING id`,
    [orgId, assigneeId, ctx.accountId, ctx.contactId,
     title, description, CHURN_SOURCE_RULE, sourceId, suggested]
  );
  return ins.rows[0] ? ins.rows[0].id : null; // null = dedup hit (already open)
}

// ── Orchestrator: classify + route champion-left for a snapshot's events ───────
// Idempotent: only touches company_change events not yet classified
// (is_from_customer_account IS NULL). Called from POST /snapshot after the diff.
async function routeChampionLeftForSnapshot(client, { orgId, ownerId }) {
  const evRes = await client.query(
    `SELECT e.id AS event_id, e.connection_id, e.from_company, e.to_company,
            c.member_urn, c.linkedin_url, c.prospect_id, c.full_name, c.owner_id
       FROM connection_job_events e
       JOIN linkedin_connections c ON c.id = e.connection_id AND c.org_id = e.org_id
      WHERE e.org_id = $1 AND e.owner_id = $2
        AND e.event_type = 'company_change'
        AND e.is_from_customer_account IS NULL`,
    [orgId, ownerId]
  );

  let evaluated = 0, championLeft = 0, actionsCreated = 0;

  for (const row of evRes.rows) {
    evaluated++;
    const connection = {
      connection_id: row.connection_id,
      member_urn: row.member_urn,
      linkedin_url: row.linkedin_url,
      prospect_id: row.prospect_id,
      full_name: row.full_name,
      owner_id: row.owner_id,
    };
    const event = { from_company: row.from_company, to_company: row.to_company };

    const ctx = await findChampionContext(client, { orgId, connection });

    if (!ctx.matched) {
      await client.query(
        `UPDATE connection_job_events
            SET is_from_customer_account = false
          WHERE id = $1 AND org_id = $2`,
        [row.event_id, orgId]
      );
      continue;
    }

    championLeft++;
    await client.query(
      `UPDATE connection_job_events
          SET is_from_customer_account = true, from_account_id = $3
        WHERE id = $1 AND org_id = $2`,
      [row.event_id, orgId, ctx.accountId]
    );

    const assigneeId = ctx.accountOwnerId || ownerId; // account owner, else the rep who knows them
    const actionId = await upsertChurnAction(client, { orgId, assigneeId, ctx, connection, event });
    if (actionId) actionsCreated++;
  }

  if (evaluated) {
    console.log(
      `🛟 ChampionLeft org=${orgId} owner=${ownerId} evaluated=${evaluated} ` +
      `championLeft=${championLeft} churnActions=${actionsCreated}`
    );
  }
  return { evaluated, championLeft, actionsCreated };
}

module.exports = {
  routeChampionLeftForSnapshot,
  findChampionContext,
  upsertChurnAction,
  isChampionRole,       // exported for unit tests
  CHAMPION_ROLES,
  CHURN_SOURCE_RULE,
};
