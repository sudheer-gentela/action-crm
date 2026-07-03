/**
 * services/SignalActionSurfacer.js
 *
 * DROP-IN LOCATION: backend/services/SignalActionSurfacer.js
 *
 * Surfaces signal-prioritized prospects to the rep's queue — Phase 5. Uses the
 * SAME upsert-and-resolve contract as ProspectDiagnosticsEngine, against
 * prospecting_actions, so signals ride the existing action queue with no new
 * surface (design §6: "surfaced via the existing action pattern, ordered by
 * priority; never writes prospect stage").
 *
 * Isolation from diagnostics: signal rows use source='signal' (diagnostics use
 * 'auto_generated'). Each engine resolves ONLY its own source, so they never
 * clear each other's rows.
 *
 * Keying: source_rule = 'signal:<campaignId>'. A prospect belongs to one
 * campaign, so this is a stable per-prospect key that upserts in place as
 * priority/why-now change, and resolves cleanly when the prospect stops
 * qualifying. Uses uq_pactions_prospect_source_rule (prospect_id, source_rule).
 *
 * The verdict comes from CampaignSignalEngine.evaluateProspect:
 *   - qualifies=false  → resolve any existing signal action (disqualified /
 *     dropped from the pool). Never a hard delete; auto_completed=true, exactly
 *     like diagnostics resolve-stale.
 *   - qualifies=true   → upsert a 'signal' action carrying priority + why-now +
 *     the active trigger + any Work-time confirmations in metadata.
 *
 * A prospect that qualifies purely on unknown filters (no active trigger yet)
 * is still surfaced — at low priority — because the confirmations ARE the work
 * ("confirm these on the page"). That's the design's "blank source allowed /
 * every qualifier becomes a Work-time confirmation" path made concrete.
 *
 * Never reads or writes prospect.stage.
 */

const { pool } = require('../config/database');
const CampaignSignalEngine = require('./CampaignSignalEngine');

const SOURCE = 'signal';

const DUE_OFFSET_BY_PRIORITY = { high: 1, medium: 3, low: 7 };

function sourceRuleFor(campaignId) {
  return `signal:${campaignId}`;
}

function buildTitle(verdict) {
  if (verdict.activeTrigger) {
    return verdict.activeTrigger.label || 'Signal trigger active';
  }
  if (verdict.confirmations.length) {
    return 'Confirm targeting on the page';
  }
  return 'Prioritized by campaign signals';
}

function buildDescription(verdict) {
  if (verdict.whyNow) return verdict.whyNow;
  if (verdict.confirmations.length) {
    const labels = verdict.confirmations.map((c) => c.label).slice(0, 3).join(', ');
    return `Confirm on the page: ${labels}${verdict.confirmations.length > 3 ? '…' : ''}`;
  }
  return null;
}

/**
 * Evaluate one prospect for one campaign and reconcile its signal action.
 *
 * @param {object} opts
 * @param {number}  opts.orgId
 * @param {object}  opts.campaign   - campaign row (with prospecting_config_override)
 * @param {object}  opts.prospect   - prospect row ({ id, account_id, owner_id, title? })
 * @param {number} [opts.systemUserId] - assignee for the surfaced action; defaults to prospect.owner_id
 * @param {Date}   [opts.now]
 * @param {object} [opts.client]
 * @returns {Promise<{ upserted: number, resolved: number, verdict: object }>}
 */
async function surfaceForProspect({ orgId, campaign, prospect, systemUserId, now, client }) {
  const db = client || pool;
  const sourceRule = sourceRuleFor(campaign.id);

  const verdict = await CampaignSignalEngine.evaluateProspect({ orgId, campaign, prospect, now, client });

  // Disqualified → resolve any existing signal action for this prospect+rule.
  if (!verdict.qualifies) {
    const resolved = await _resolve(db, prospect.id, orgId, sourceRule);
    return { upserted: 0, resolved, verdict };
  }

  const assignee = systemUserId != null ? systemUserId : (prospect.owner_id ?? null);
  const due = new Date(now instanceof Date ? now.getTime() : Date.now());
  due.setDate(due.getDate() + (DUE_OFFSET_BY_PRIORITY[verdict.priority] || 7));

  const metadata = {
    campaign_id: campaign.id,
    priority_score: verdict.priorityScore,
    active_trigger: verdict.activeTrigger,
    why_now: verdict.whyNow,
    confirmations: verdict.confirmations,
    // full evaluation trace for the Work panel (P7) + debugging
    filters: verdict.filterResults,
    prioritizers: verdict.prioritizerResults,
  };

  const res = await db.query(
    `INSERT INTO prospecting_actions (
       org_id, user_id, prospect_id,
       title, description,
       action_type, channel,
       priority, due_date,
       source, source_rule,
       suggested_action,
       metadata, status
     ) VALUES (
       $1, $2, $3,
       $4, $5,
       'signal', 'general',
       $6, $7,
       'signal', $8,
       $9,
       $10, 'pending'
     )
     ON CONFLICT (prospect_id, source_rule)
     WHERE prospect_id IS NOT NULL AND source_rule IS NOT NULL
     DO UPDATE SET
       title       = EXCLUDED.title,
       description  = EXCLUDED.description,
       priority     = EXCLUDED.priority,
       due_date     = EXCLUDED.due_date,
       metadata     = EXCLUDED.metadata,
       user_id      = EXCLUDED.user_id,
       updated_at   = NOW()
     -- Preserve created_at + status so a snoozed / in_progress row stays put.
     RETURNING id, (xmax = 0) AS inserted`,
    [
      orgId, assignee, prospect.id,
      buildTitle(verdict), buildDescription(verdict),
      verdict.priority, due,
      sourceRule,
      verdict.whyNow || null,
      JSON.stringify(metadata),
    ]
  );

  return { upserted: res.rows[0] ? 1 : 0, resolved: 0, verdict };
}

/**
 * Resolve (auto-complete) a prospect's signal action for a campaign — used when
 * a prospect no longer qualifies, or a campaign/targeting is removed. Mirrors
 * ProspectDiagnosticsEngine._resolveStale, scoped to source='signal'.
 */
async function _resolve(db, prospectId, orgId, sourceRule) {
  try {
    const result = await db.query(
      `UPDATE prospecting_actions
          SET status         = 'completed',
              auto_completed = true,
              completed_at   = NOW(),
              updated_at     = NOW()
        WHERE prospect_id = $1
          AND org_id      = $2
          AND source      = '${SOURCE}'
          AND source_rule = $3
          AND status      = 'pending'`,
      [prospectId, orgId, sourceRule]
    );
    return result.rowCount || 0;
  } catch (err) {
    console.error(`[SignalActionSurfacer] resolve failed for prospect ${prospectId}:`, err.message);
    return 0;
  }
}

/**
 * Sweep every member of a campaign: evaluate + reconcile each prospect's signal
 * action. This is the batch entry point used by the nightly re-eval and by the
 * on-demand "refresh this campaign's queue" path.
 *
 * @returns {Promise<{ processed, upserted, resolved, qualified, errors }>}
 */
async function surfaceForCampaign({ orgId, campaign, systemUserId, now, client }) {
  const db = client || pool;
  const { rows: prospects } = await db.query(
    `SELECT id, account_id, owner_id, title
       FROM prospects
      WHERE org_id = $1 AND campaign_id = $2`,
    [orgId, campaign.id]
  );

  let upserted = 0, resolved = 0, qualified = 0, errors = 0;
  for (const prospect of prospects) {
    try {
      const r = await surfaceForProspect({ orgId, campaign, prospect, systemUserId, now, client });
      upserted += r.upserted;
      resolved += r.resolved;
      if (r.verdict.qualifies) qualified += 1;
    } catch (err) {
      errors += 1;
      console.error(`[SignalActionSurfacer] prospect ${prospect.id} in campaign ${campaign.id}:`, err.message);
    }
  }
  return { processed: prospects.length, upserted, resolved, qualified, errors };
}

/**
 * Org-wide nightly re-eval (design §6: "re-evaluated nightly + on fresh
 * capture; resolve-stale updates the queue"). Walks every active campaign that
 * has a targeting block, sweeping each. Freshness is applied inside the engine
 * (signals past TTL read as unknown → confirmations, not drops), so aging is
 * automatic — no separate expiry job.
 *
 * @returns {Promise<{ campaigns, processed, upserted, resolved, errors }>}
 */
async function runNightlyReeval(orgId, { now, client } = {}) {
  const db = client || pool;
  const { rows: campaigns } = await db.query(
    `SELECT id, prospecting_config_override, solution
       FROM prospecting_campaigns
      WHERE org_id = $1
        AND status = 'active'
        AND prospecting_config_override IS NOT NULL`,
    [orgId]
  );

  let processed = 0, upserted = 0, resolved = 0, errors = 0, active = 0;
  for (const campaign of campaigns) {
    const tgt = CampaignSignalEngine.extractTargeting(campaign);
    if (tgt.filters.length === 0 && tgt.prioritizers.length === 0) continue; // no signal targeting
    active += 1;
    try {
      const r = await surfaceForCampaign({ orgId, campaign, now, client });
      processed += r.processed;
      upserted += r.upserted;
      resolved += r.resolved;
      errors += r.errors;
    } catch (err) {
      errors += 1;
      console.error(`[SignalActionSurfacer] campaign ${campaign.id} nightly sweep:`, err.message);
    }
  }

  console.log(`[SignalActionSurfacer] nightly org=${orgId} campaigns=${active} processed=${processed} upserted=${upserted} resolved=${resolved} errors=${errors}`);
  return { campaigns: active, processed, upserted, resolved, errors };
}

/**
 * On-capture hook (design §6: "re-evaluated ... on fresh capture"). When a
 * signal is written for an entity (list ingest P6, webhook P8, enrichment P9,
 * extension P10, or a rep on-page validation P7), re-evaluate just the affected
 * prospect(s) in their campaign — cheap, targeted, keeps the queue live.
 *
 * @param {object} opts
 * @param {number}  opts.orgId
 * @param {string}  opts.entityType  - 'prospect' | 'account'
 * @param {number}  opts.entityId
 * @param {object} [opts.now]
 * @param {object} [opts.client]
 */
async function reevalOnCapture({ orgId, entityType, entityId, now, client }) {
  const db = client || pool;

  // Find the affected prospects: the prospect itself, or all prospects at an
  // account when an account-level signal changed.
  let prospectRows;
  if (entityType === 'prospect') {
    ({ rows: prospectRows } = await db.query(
      `SELECT id, account_id, owner_id, title, campaign_id FROM prospects WHERE org_id = $1 AND id = $2`,
      [orgId, entityId]
    ));
  } else if (entityType === 'account') {
    ({ rows: prospectRows } = await db.query(
      `SELECT id, account_id, owner_id, title, campaign_id FROM prospects WHERE org_id = $1 AND account_id = $2`,
      [orgId, entityId]
    ));
  } else {
    return { processed: 0, upserted: 0, resolved: 0 };
  }

  // Group by campaign; skip prospects not in a campaign.
  const byCampaign = new Map();
  for (const p of prospectRows) {
    if (!p.campaign_id) continue;
    if (!byCampaign.has(p.campaign_id)) byCampaign.set(p.campaign_id, []);
    byCampaign.get(p.campaign_id).push(p);
  }

  let upserted = 0, resolved = 0, processed = 0;
  for (const [campaignId, prospects] of byCampaign) {
    const { rows: campRows } = await db.query(
      `SELECT id, prospecting_config_override, solution FROM prospecting_campaigns WHERE org_id = $1 AND id = $2`,
      [orgId, campaignId]
    );
    const campaign = campRows[0];
    if (!campaign) continue;
    const tgt = CampaignSignalEngine.extractTargeting(campaign);
    if (tgt.filters.length === 0 && tgt.prioritizers.length === 0) continue;

    for (const prospect of prospects) {
      const r = await surfaceForProspect({ orgId, campaign, prospect, now, client });
      upserted += r.upserted;
      resolved += r.resolved;
      processed += 1;
    }
  }
  return { processed, upserted, resolved };
}

module.exports = {
  surfaceForProspect,
  surfaceForCampaign,
  runNightlyReeval,
  reevalOnCapture,
  sourceRuleFor,
  SOURCE,
};
