// ============================================================================
// services/CampaignSweeps.js
//
// Slice 2 — nightly SLA sweeps for campaigns.
//
// Two sweeps, mirroring the pattern in SequenceStepFirer.syncOverdueDrafts:
//
//   syncOverdueActivations()
//     For each active campaign, find prospects in 'research' stage older
//     than activationSlaDays with no active enrollment in the campaign's
//     default sequence. Insert one rolled-up prospecting_action per
//     (campaign, campaign_owner) pair so the campaign owner gets nagged in
//     the Actions inbox.
//
//   syncOverdueResearch()
//     Same idea, but 'target'-stage prospects older than researchSlaDays —
//     reminds whoever has the researcher hat on that the queue is backing
//     up.
//
// Both are idempotent: NOT EXISTS guard prevents duplicate actions when
// the previous one is still pending. Rolled up by (campaignId, type) so a
// campaign with 200 stale prospects generates ONE action, not 200.
//
// Configuration (read from org_integrations.config for prospecting_email):
//   activationSlaDays  default 7
//   researchSlaDays    default 14
//
// Wired in server.js — runs daily 09:00 UTC alongside the other sweeps.
// ============================================================================

const { pool } = require('../config/database');

const DEFAULT_ACTIVATION_SLA_DAYS = 7;
const DEFAULT_RESEARCH_SLA_DAYS   = 14;

// ─────────────────────────────────────────────────────────────────────────────
// Helper — load per-org SLA windows. Returns a map keyed by org_id.
// ─────────────────────────────────────────────────────────────────────────────
async function loadOrgSlaConfig() {
  const r = await pool.query(
    `SELECT org_id, config FROM org_integrations
      WHERE integration_type = 'prospecting_email'`
  );
  const byOrg = {};
  for (const row of r.rows) {
    const cfg = row.config || {};
    byOrg[row.org_id] = {
      activationSlaDays: parseInt(cfg.activationSlaDays, 10) || DEFAULT_ACTIVATION_SLA_DAYS,
      researchSlaDays:   parseInt(cfg.researchSlaDays, 10)   || DEFAULT_RESEARCH_SLA_DAYS,
    };
  }
  return byOrg;
}

// ─────────────────────────────────────────────────────────────────────────────
// syncOverdueActivations
//
// For every active campaign with a default sequence, count how many of its
// prospects are stuck in 'research' stage past the activation SLA. If >0 and
// no open action already exists, create a single rolled-up action assigned
// to the campaign owner (falls back to created_by if owner_id is null).
//
// Action shape:
//   action_type = 'campaign_activation_overdue'
//   priority    = 'high'
//   source      = 'sla_sweep'
//   metadata    = { campaignId, campaignName, stuckCount, oldestStageChangedAt, slaDays }
// ─────────────────────────────────────────────────────────────────────────────
async function syncOverdueActivations() {
  const slaByOrg = await loadOrgSlaConfig();
  let inserted = 0;
  let scanned  = 0;

  // We iterate per-org because the SLA window can vary. For each, run a
  // single set-based INSERT that handles all of that org's campaigns.
  for (const [orgId, sla] of Object.entries(slaByOrg)) {
    const days = sla.activationSlaDays;

    // Find candidate campaigns and how many stuck prospects each has.
    // The HAVING clause filters down to campaigns that actually have a
    // backlog past SLA.
    const candidateRes = await pool.query(
      `SELECT c.id              AS campaign_id,
              c.name            AS campaign_name,
              COALESCE(c.owner_id, c.created_by) AS assignee_id,
              COUNT(p.id)::int                  AS stuck_count,
              MIN(p.stage_changed_at)           AS oldest_change_at
         FROM prospecting_campaigns c
         JOIN prospects p
           ON p.campaign_id = c.id
          AND p.org_id      = c.org_id
          AND p.stage       = 'research'
          AND p.deleted_at IS NULL
          AND p.stage_changed_at < NOW() - ($2::int * INTERVAL '1 day')
        WHERE c.org_id  = $1
          AND c.status  = 'active'
          AND c.default_sequence_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM sequence_enrollments se
             WHERE se.prospect_id = p.id
               AND se.sequence_id = c.default_sequence_id
               AND se.status IN ('active', 'paused')
          )
     GROUP BY c.id, c.name, c.owner_id, c.created_by
       HAVING COUNT(p.id) > 0`,
      [orgId, days]
    );

    scanned += candidateRes.rows.length;

    for (const row of candidateRes.rows) {
      if (!row.assignee_id) continue;   // no owner to assign to — skip

      // Idempotency: only insert if there's no open action for this campaign
      // of this type. metadata->>'campaignId' is the match key.
      const insertRes = await pool.query(
        `INSERT INTO prospecting_actions
           (org_id, user_id, prospect_id, title, description,
            action_type, channel, status, priority, due_date, source, metadata)
         SELECT $1, $2, NULL,
                $3::text,
                $4::text,
                'campaign_activation_overdue',
                NULL,
                'pending',
                'high',
                NOW(),
                'sla_sweep',
                jsonb_build_object(
                  'campaignId',           $5::int,
                  'campaignName',         $6::text,
                  'stuckCount',           $7::int,
                  'oldestStageChangedAt', $8::timestamptz,
                  'slaDays',              $9::int
                )
         WHERE NOT EXISTS (
           SELECT 1 FROM prospecting_actions pa
            WHERE pa.org_id      = $1
              AND pa.action_type = 'campaign_activation_overdue'
              AND (pa.metadata->>'campaignId')::int = $5
              AND pa.status IN ('pending', 'in_progress', 'snoozed')
         )
         RETURNING id`,
        [
          parseInt(orgId, 10),
          row.assignee_id,
          `${row.stuck_count} prospect${row.stuck_count === 1 ? '' : 's'} waiting to be activated in "${row.campaign_name}"`,
          `Oldest entered research stage ${formatRelativeDays(row.oldest_change_at)}. Activation pace is below SLA (${days}d). Open the campaign and click "Activate next 25".`,
          row.campaign_id,
          row.campaign_name,
          row.stuck_count,
          row.oldest_change_at,
          days,
        ]
      );
      if (insertRes.rowCount > 0) inserted += insertRes.rowCount;
    }
  }

  if (inserted > 0) {
    console.log(`📍 CampaignSweeps.syncOverdueActivations: ${scanned} campaigns over SLA, ${inserted} new actions`);
  }
  return { scanned, inserted };
}

// ─────────────────────────────────────────────────────────────────────────────
// syncOverdueResearch
//
// Same shape, but 'target'-stage prospects older than researchSlaDays.
// Tells the researcher/owner the queue is backing up.
// ─────────────────────────────────────────────────────────────────────────────
async function syncOverdueResearch() {
  const slaByOrg = await loadOrgSlaConfig();
  let inserted = 0;
  let scanned  = 0;

  for (const [orgId, sla] of Object.entries(slaByOrg)) {
    const days = sla.researchSlaDays;

    const candidateRes = await pool.query(
      `SELECT c.id              AS campaign_id,
              c.name            AS campaign_name,
              COALESCE(c.owner_id, c.created_by) AS assignee_id,
              COUNT(p.id)::int                  AS stuck_count,
              MIN(p.created_at)                 AS oldest_created_at
         FROM prospecting_campaigns c
         JOIN prospects p
           ON p.campaign_id = c.id
          AND p.org_id      = c.org_id
          AND p.stage       = 'target'
          AND p.deleted_at IS NULL
          AND p.created_at  < NOW() - ($2::int * INTERVAL '1 day')
        WHERE c.org_id  = $1
          AND c.status  = 'active'
     GROUP BY c.id, c.name, c.owner_id, c.created_by
       HAVING COUNT(p.id) > 0`,
      [orgId, days]
    );

    scanned += candidateRes.rows.length;

    for (const row of candidateRes.rows) {
      if (!row.assignee_id) continue;

      const insertRes = await pool.query(
        `INSERT INTO prospecting_actions
           (org_id, user_id, prospect_id, title, description,
            action_type, channel, status, priority, due_date, source, metadata)
         SELECT $1, $2, NULL,
                $3::text,
                $4::text,
                'campaign_research_overdue',
                NULL,
                'pending',
                'medium',
                NOW(),
                'sla_sweep',
                jsonb_build_object(
                  'campaignId',     $5::int,
                  'campaignName',   $6::text,
                  'stuckCount',     $7::int,
                  'oldestCreatedAt',$8::timestamptz,
                  'slaDays',        $9::int
                )
         WHERE NOT EXISTS (
           SELECT 1 FROM prospecting_actions pa
            WHERE pa.org_id      = $1
              AND pa.action_type = 'campaign_research_overdue'
              AND (pa.metadata->>'campaignId')::int = $5
              AND pa.status IN ('pending', 'in_progress', 'snoozed')
         )
         RETURNING id`,
        [
          parseInt(orgId, 10),
          row.assignee_id,
          `${row.stuck_count} prospect${row.stuck_count === 1 ? '' : 's'} waiting for research in "${row.campaign_name}"`,
          `Oldest imported ${formatRelativeDays(row.oldest_created_at)}. Research throughput is below SLA (${days}d). Open the Research Queue for this campaign.`,
          row.campaign_id,
          row.campaign_name,
          row.stuck_count,
          row.oldest_created_at,
          days,
        ]
      );
      if (insertRes.rowCount > 0) inserted += insertRes.rowCount;
    }
  }

  if (inserted > 0) {
    console.log(`📍 CampaignSweeps.syncOverdueResearch: ${scanned} campaigns over SLA, ${inserted} new actions`);
  }
  return { scanned, inserted };
}

// Pretty "N days ago" for descriptions. Static — no i18n hookup here.
function formatRelativeDays(ts) {
  if (!ts) return 'a while ago';
  const days = Math.floor((Date.now() - new Date(ts).getTime()) / (1000 * 60 * 60 * 24));
  if (days <= 0)  return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

module.exports = {
  syncOverdueActivations,
  syncOverdueResearch,
  // Exported for unit tests:
  loadOrgSlaConfig,
  formatRelativeDays,
  DEFAULT_ACTIVATION_SLA_DAYS,
  DEFAULT_RESEARCH_SLA_DAYS,
};
