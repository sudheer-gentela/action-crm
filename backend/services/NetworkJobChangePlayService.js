// services/NetworkJobChangePlayService.js
//
// P1 routing for network job-change events (Design & Execution Tracker §G-P1).
// Champion-left → BOTH plays (design §F):
//   (a) CHURN risk on the OLD customer account  (actions table)
//   (b) PURSUE champion at the NEW company       (promote → prospect + prospecting_action)
//
// Flow per unclassified company_change event:
//   1. Resolve the moved person to a CHAMPION contact at a CUSTOMER account
//      (account_type='customer', D12) — person-centric (slug / contact_identities
//      / prospect-conversion), NOT company-string matching (CSV has no domain).
//   2. If matched: stamp event (is_from_customer_account, from_account_id) and
//      mint the churn-risk action on the old account.
//   3. If auto-promote is ON (D2, default ON via NetworkJobChangeConfig): promote
//      the connection to a prospect at the NEW company (URN-first dedup, mirrors
//      POST /prospects), mint the pursue-champion action, stamp
//      promoted_prospect_id.
//   4. If not matched: mark is_from_customer_account=false (idempotent re-runs).
//
// Dedup: churn action is app-level (no account source_rule index); pursue action
// uses the existing uq_pactions_prospect_source_rule via ON CONFLICT DO NOTHING.

'use strict';

const { slugFromUrl } = require('./NetworkConnectionIngestService');
const Config = require('./NetworkJobChangeConfig');

const CHAMPION_ROLES   = new Set(['champion', 'decision_maker', 'economic_buyer']); // D11
const CHURN_SOURCE_RULE   = 'champion_left';
const PURSUE_SOURCE_RULE  = 'pursue_champion';
const INBOUND_SOURCE_RULE = 'inbound_target';
const PROSPECT_SOURCE      = 'network_job_change';

// ── Pure predicate (exported for unit tests; no DB) ───────────────────────────
function isChampionRole(roleType, dealContactRows = []) {
  if (roleType && CHAMPION_ROLES.has(String(roleType).toLowerCase())) return true;
  for (const dc of dealContactRows) {
    if (dc.is_primary) return true;
    if (dc.role && CHAMPION_ROLES.has(String(dc.role).toLowerCase())) return true;
  }
  return false;
}

// ── Resolve moved connection → champion contact at a customer account ─────────
async function findChampionContext(client, { orgId, connection }) {
  const slug = slugFromUrl(connection.linkedin_url);
  const idValues = [connection.member_urn, connection.linkedin_url]
                    .filter(Boolean).map((v) => String(v).toLowerCase());
  const prospectId = connection.prospect_id || null;

  const res = await client.query(
    `WITH cand AS (
        SELECT c.id, c.account_id, c.role_type
          FROM contacts c
         WHERE c.org_id = $1 AND c.deleted_at IS NULL
           AND $2::text IS NOT NULL
           AND lower(substring(c.linkedin_url from '/in/([^/?#]+)')) = $2
        UNION
        SELECT c.id, c.account_id, c.role_type
          FROM contact_identities ci
          JOIN contacts c ON c.id = ci.canonical_contact_id
                         AND c.org_id = ci.org_id AND c.deleted_at IS NULL
         WHERE ci.org_id = $1 AND ci.status = 'confirmed'
           AND ( lower(ci.identity_value) = ANY($3::text[])
              OR ($2::text IS NOT NULL
                  AND lower(substring(ci.identity_value from '/in/([^/?#]+)')) = $2) )
        UNION
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
      };
    }
  }
  return { matched: false };
}

// ── (a) Churn-risk action on the OLD account (app-level dedup) ─────────────────
async function upsertChurnAction(client, { orgId, assigneeId, ctx, connection, event }) {
  const sourceId = `${CHURN_SOURCE_RULE}:${connection.connection_id}:${ctx.accountId}`;
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
  return ins.rows[0] ? ins.rows[0].id : null;
}

// ── Promote a moved connection → prospect at the NEW company (URN-first dedup) ──
// Mirrors POST /prospects: match member_urn, then slug, else insert. On match,
// the prospect MOVED, so company/title are updated to the new role (URN/URL
// COALESCE-backfilled). Links linkedin_connections.prospect_id back.
async function promoteConnectionToProspect(client, { orgId, connection, event, accountId = null }) {
  if (connection.prospect_id) {
    return { prospectId: connection.prospect_id, created: false };
  }

  const memberUrn   = connection.member_urn || null;
  const linkedinUrl = connection.linkedin_url || null;
  const slug        = slugFromUrl(linkedinUrl);
  const firstName   = connection.first_name || (connection.full_name || '').trim().split(/\s+/)[0] || 'Unknown';
  const lastName    = connection.last_name  || (connection.full_name || '').trim().split(/\s+/).slice(1).join(' ') || '';
  const newCompany  = event.to_company || connection.company_name || null;
  const newTitle    = connection.title || null;

  // URN-first → slug dedup.
  let match = null;
  if (memberUrn) {
    const r = await client.query(
      `SELECT id FROM prospects
        WHERE org_id = $1 AND member_urn = $2 AND deleted_at IS NULL
        ORDER BY id ASC LIMIT 1`,
      [orgId, memberUrn]
    );
    if (r.rows[0]) match = r.rows[0].id;
  }
  if (!match && slug) {
    const r = await client.query(
      `SELECT id FROM prospects
        WHERE org_id = $1 AND deleted_at IS NULL AND linkedin_url IS NOT NULL
          AND lower(substring(linkedin_url from '/in/([^/?#]+)')) = $2
        ORDER BY id ASC LIMIT 1`,
      [orgId, slug]
    );
    if (r.rows[0]) match = r.rows[0].id;
  }

  let prospectId, created;
  if (match) {
    // They moved → reflect the new company/title; backfill URN/URL.
    await client.query(
      `UPDATE prospects SET
         company_name = COALESCE($2, company_name),
         title        = COALESCE($3, title),
         member_urn   = COALESCE(member_urn, $4),
         linkedin_url = COALESCE(linkedin_url, $5),
         account_id   = COALESCE(account_id, $7),
         updated_at   = CURRENT_TIMESTAMP
       WHERE id = $1 AND org_id = $6`,
      [match, newCompany, newTitle, memberUrn, linkedinUrl, orgId, accountId]
    );
    prospectId = match; created = false;
  } else {
    const ins = await client.query(
      `INSERT INTO prospects (
         org_id, owner_id, created_by, first_name, last_name, email, phone, linkedin_url,
         title, linkedin_headline, location, company_name, company_domain, company_size,
         company_industry, account_id, source, playbook_id, tags, member_urn,
         stage, stage_changed_at
       ) VALUES (
         $1, $2, $2, $3, $4, NULL, NULL, $5,
         $6, NULL, NULL, $7, NULL, NULL,
         NULL, $10, $8, NULL, '[]'::jsonb, $9,
         'target', CURRENT_TIMESTAMP
       ) RETURNING id`,
      [orgId, connection.owner_id, firstName, lastName, linkedinUrl,
       newTitle, newCompany, PROSPECT_SOURCE, memberUrn, accountId]
    );
    prospectId = ins.rows[0].id; created = true;
  }

  await client.query(
    `UPDATE linkedin_connections SET prospect_id = $3, updated_at = now()
      WHERE id = $1 AND org_id = $2`,
    [connection.connection_id, orgId, prospectId]
  );

  return { prospectId, created };
}

// ── (b) Pursue-champion action on the new prospect (index-backed dedup) ────────
async function upsertPursueAction(client, { orgId, assigneeId, prospectId, connection, event }) {
  const who = connection.full_name || 'Your contact';
  const title = `Reconnect: ${who} moved to ${event.to_company || 'a new company'}`;
  const description =
    `${who} just changed companies. Congratulate them and explore whether `
    + `${event.to_company || 'their new company'} is a fit — a warm path you already have.`;

  const ins = await client.query(
    `INSERT INTO prospecting_actions
        (org_id, user_id, prospect_id, title, description, action_type, channel,
         status, priority, due_date, source, source_rule, metadata)
     VALUES ($1, $2, $3, $4, $5, 'follow_up', 'linkedin',
             'pending', 'high', NOW(), $6, $7, $8::jsonb)
     ON CONFLICT (prospect_id, source_rule)
       WHERE prospect_id IS NOT NULL AND source_rule IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [orgId, assigneeId, prospectId, title, description,
     PROSPECT_SOURCE, PURSUE_SOURCE_RULE,
     JSON.stringify({ connectionId: connection.connection_id, toCompany: event.to_company })]
  );
  return ins.rows[0] ? ins.rows[0].id : null;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
async function routeChampionLeftForSnapshot(client, { orgId, ownerId }) {
  const cfg = await Config.resolveForUser(client, { orgId, userId: ownerId });
  const autoPromote = cfg.autoPromoteOnMove;

  const evRes = await client.query(
    `SELECT e.id AS event_id, e.connection_id, e.from_company, e.to_company,
            c.member_urn, c.linkedin_url, c.prospect_id, c.full_name,
            c.first_name, c.last_name, c.title, c.company_name, c.owner_id
       FROM connection_job_events e
       JOIN linkedin_connections c ON c.id = e.connection_id AND c.org_id = e.org_id
      WHERE e.org_id = $1 AND e.owner_id = $2
        AND e.event_type = 'company_change'
        AND e.is_from_customer_account IS NULL`,
    [orgId, ownerId]
  );

  let evaluated = 0, championLeft = 0, churnActions = 0, promoted = 0, pursueActions = 0;

  for (const row of evRes.rows) {
    evaluated++;
    const connection = {
      connection_id: row.connection_id,
      member_urn: row.member_urn, linkedin_url: row.linkedin_url,
      prospect_id: row.prospect_id, full_name: row.full_name,
      first_name: row.first_name, last_name: row.last_name,
      title: row.title, company_name: row.company_name, owner_id: row.owner_id,
    };
    const event = { from_company: row.from_company, to_company: row.to_company };

    const ctx = await findChampionContext(client, { orgId, connection });

    if (!ctx.matched) {
      await client.query(
        `UPDATE connection_job_events SET is_from_customer_account = false
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

    // (a) churn risk on the old account
    const churnAssignee = ctx.accountOwnerId || ownerId;
    if (await upsertChurnAction(client, { orgId, assigneeId: churnAssignee, ctx, connection, event })) {
      churnActions++;
    }

    // (b) pursue champion at the new company (auto-promote gated, D2)
    if (autoPromote) {
      const { prospectId } = await promoteConnectionToProspect(client, { orgId, connection, event });
      if (prospectId) {
        promoted++;
        await client.query(
          `UPDATE connection_job_events SET promoted_prospect_id = $3
            WHERE id = $1 AND org_id = $2`,
          [row.event_id, orgId, prospectId]
        );
        // pursue action assigned to the rep who holds the relationship
        if (await upsertPursueAction(client, { orgId, assigneeId: ownerId, prospectId, connection, event })) {
          pursueActions++;
        }
      }
    }
  }

  if (evaluated) {
    console.log(
      `🛟 ChampionLeft org=${orgId} owner=${ownerId} evaluated=${evaluated} ` +
      `championLeft=${championLeft} churn=${churnActions} promoted=${promoted} ` +
      `pursue=${pursueActions} autoPromote=${autoPromote}`
    );
  }
  return { evaluated, championLeft, churnActions, promoted, pursueActions, autoPromote };
}

// ── Resolve a move's NEW company → a target account ───────────────────────────
// CSV gives a company NAME (no domain), so match exact-normalized name against
// accounts that are targets (account_type='target') or have an OPEN deal.
// Fuzzy/suffix-stripping matching stays DISABLED (D3) — conservative, low false
// positives. (Future: enable suffix-strip + token-set behind a flag.)
async function findTargetAccountContext(client, { orgId, event }) {
  const company = (event.to_company || '').trim();
  if (!company) return { matched: false };
  const norm = company.toLowerCase();

  const res = await client.query(
    `SELECT a.id, a.name, a.owner_id
       FROM accounts a
      WHERE a.org_id = $1 AND a.deleted_at IS NULL
        AND lower(btrim(a.name)) = $2
        AND ( a.account_type = 'target'
           OR EXISTS (
                SELECT 1 FROM deals d
                 WHERE d.account_id = a.id AND d.deleted_at IS NULL
                   AND COALESCE(d.stage_type, '') NOT IN ('won', 'lost')
              ) )
      LIMIT 1`,
    [orgId, norm]
  );
  if (!res.rows[0]) return { matched: false };
  const a = res.rows[0];
  return { matched: true, accountId: a.id, accountName: a.name, accountOwnerId: a.owner_id };
}

// ── Inbound warm-intro action on the new prospect (index-backed dedup) ─────────
async function upsertInboundAction(client, { orgId, assigneeId, prospectId, accountName, connection, event }) {
  const who = connection.full_name || 'Your connection';
  const title = `Warm intro: ${who} just joined ${accountName || event.to_company}`;
  const description =
    `${who} moved to ${accountName || event.to_company}, a target account — and you already `
    + `have a 1st-degree connection. Reach out to open a warm path / request an intro.`;

  const ins = await client.query(
    `INSERT INTO prospecting_actions
        (org_id, user_id, prospect_id, title, description, action_type, channel,
         status, priority, due_date, source, source_rule, metadata)
     VALUES ($1, $2, $3, $4, $5, 'follow_up', 'linkedin',
             'pending', 'high', NOW(), $6, $7, $8::jsonb)
     ON CONFLICT (prospect_id, source_rule)
       WHERE prospect_id IS NOT NULL AND source_rule IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [orgId, assigneeId, prospectId, title, description,
     PROSPECT_SOURCE, INBOUND_SOURCE_RULE,
     JSON.stringify({ connectionId: connection.connection_id, toCompany: event.to_company })]
  );
  return ins.rows[0] ? ins.rows[0].id : null;
}

// ── Orchestrator: inbound target-account moves ────────────────────────────────
// Independent of champion-left (a move into a target account fires regardless of
// where the person came from). Idempotent on is_into_target_account.
async function routeInboundTargetForSnapshot(client, { orgId, ownerId }) {
  const cfg = await Config.resolveForUser(client, { orgId, userId: ownerId });
  const autoPromote = cfg.autoPromoteOnMove;

  const evRes = await client.query(
    `SELECT e.id AS event_id, e.connection_id, e.from_company, e.to_company,
            c.member_urn, c.linkedin_url, c.prospect_id, c.full_name,
            c.first_name, c.last_name, c.title, c.company_name, c.owner_id
       FROM connection_job_events e
       JOIN linkedin_connections c ON c.id = e.connection_id AND c.org_id = e.org_id
      WHERE e.org_id = $1 AND e.owner_id = $2
        AND e.event_type = 'company_change'
        AND e.is_into_target_account IS NULL`,
    [orgId, ownerId]
  );

  let evaluated = 0, intoTarget = 0, promoted = 0, inboundActions = 0;

  for (const row of evRes.rows) {
    evaluated++;
    const connection = {
      connection_id: row.connection_id,
      member_urn: row.member_urn, linkedin_url: row.linkedin_url,
      prospect_id: row.prospect_id, full_name: row.full_name,
      first_name: row.first_name, last_name: row.last_name,
      title: row.title, company_name: row.company_name, owner_id: row.owner_id,
    };
    const event = { from_company: row.from_company, to_company: row.to_company };

    const ctx = await findTargetAccountContext(client, { orgId, event });

    if (!ctx.matched) {
      await client.query(
        `UPDATE connection_job_events SET is_into_target_account = false
          WHERE id = $1 AND org_id = $2`,
        [row.event_id, orgId]
      );
      continue;
    }

    intoTarget++;
    await client.query(
      `UPDATE connection_job_events
          SET is_into_target_account = true, to_account_id = $3
        WHERE id = $1 AND org_id = $2`,
      [row.event_id, orgId, ctx.accountId]
    );

    if (autoPromote) {
      const { prospectId } = await promoteConnectionToProspect(
        client, { orgId, connection, event, accountId: ctx.accountId }
      );
      if (prospectId) {
        promoted++;
        await client.query(
          `UPDATE connection_job_events SET promoted_prospect_id = COALESCE(promoted_prospect_id, $3)
            WHERE id = $1 AND org_id = $2`,
          [row.event_id, orgId, prospectId]
        );
        if (await upsertInboundAction(client, {
          orgId, assigneeId: ownerId, prospectId, accountName: ctx.accountName, connection, event,
        })) inboundActions++;
      }
    }
  }

  if (evaluated) {
    console.log(
      `🎯 InboundTarget org=${orgId} owner=${ownerId} evaluated=${evaluated} ` +
      `intoTarget=${intoTarget} promoted=${promoted} inbound=${inboundActions} autoPromote=${autoPromote}`
    );
  }
  return { evaluated, intoTarget, promoted, inboundActions };
}

module.exports = {
  routeChampionLeftForSnapshot,
  routeInboundTargetForSnapshot,
  findChampionContext,
  findTargetAccountContext,
  promoteConnectionToProspect,
  upsertChurnAction,
  upsertPursueAction,
  upsertInboundAction,
  isChampionRole,
  CHAMPION_ROLES,
  CHURN_SOURCE_RULE,
  PURSUE_SOURCE_RULE,
  INBOUND_SOURCE_RULE,
};
