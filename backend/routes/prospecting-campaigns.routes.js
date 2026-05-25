// ─────────────────────────────────────────────────────────────────────────────
// prospecting-campaigns.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// A "campaign" is a project that runs while you prospect for a particular
// solution. It groups prospects, points at a target prospecting playbook, and
// carries an optional default sequence used by "enroll all".
//
// Endpoints:
//   GET    /api/prospecting-campaigns                  list (with live counts)
//   POST   /api/prospecting-campaigns                  create
//   GET    /api/prospecting-campaigns/:id              one campaign + funnel
//   PUT    /api/prospecting-campaigns/:id              update
//   DELETE /api/prospecting-campaigns/:id              archive (soft) / delete
//   POST   /api/prospecting-campaigns/:id/prospects    assign prospects to it
//   DELETE /api/prospecting-campaigns/:id/prospects    un-assign prospects
//   POST   /api/prospecting-campaigns/:id/enroll-all   enroll members in seq
//
// All queries are org-scoped via req.orgId (set by orgContext). Never trust
// org_id from the request body.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');
const {
  sanitizeCampaignConfig,
  sanitizeOrgConfig,
  emptyCampaignConfig,
  emptyOrgConfig,
} = require('../config/prospectingConfigSchema');
// Slice 3: per-prospect personalisation now goes through the dispatcher,
// which walks all sequence steps and calls the right per-channel skill
// (outreach-email / outreach-linkedin) with the right step_intent. Replaces
// Slice 2's inline mapping of the retired outreach-personalization skill.
const PersonalizationDispatcher = require('../services/PersonalizationDispatcher');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

const VALID_STATUS = ['active', 'paused', 'completed', 'archived'];

// Stage order used for funnel display. Kept in sync with prospects.routes.js
// VALID_STAGES; terminal stages (disqualified/nurture) are reported separately.
const FUNNEL_STAGES = ['target', 'research', 'outreach', 'engaged', 'discovery_call', 'qualified_sal'];

// ─────────────────────────────────────────────────────────────────────────────
// Helper: load one campaign scoped to the org, or null.
// ─────────────────────────────────────────────────────────────────────────────
async function loadCampaign(orgId, id) {
  const { rows } = await pool.query(
    `SELECT c.*,
            pb.name AS playbook_name,
            sq.name AS default_sequence_name,
            u.first_name AS owner_first_name,
            u.last_name  AS owner_last_name
       FROM prospecting_campaigns c
       LEFT JOIN playbooks  pb ON pb.id = c.playbook_id
       LEFT JOIN sequences  sq ON sq.id = c.default_sequence_id
       LEFT JOIN users      u  ON u.id  = c.owner_id
      WHERE c.id = $1 AND c.org_id = $2`,
    [id, orgId]
  );
  return rows[0] || null;
}

// ── GET / — list campaigns with live prospect counts ─────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;

    const params = [req.orgId];
    let statusFilter = `AND c.status <> 'archived'`;   // hide archived by default
    if (status) {
      params.push(status);
      statusFilter = `AND c.status = $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT c.*,
              pb.name AS playbook_name,
              sq.name AS default_sequence_name,
              u.first_name AS owner_first_name,
              u.last_name  AS owner_last_name,
              COUNT(p.id) FILTER (WHERE p.deleted_at IS NULL)                                    AS prospect_count,
              COUNT(p.id) FILTER (WHERE p.deleted_at IS NULL AND p.stage = 'qualified_sal')       AS qualified_count,
              COUNT(p.id) FILTER (WHERE p.deleted_at IS NULL AND p.stage NOT IN
                    ('qualified_sal','disqualified','nurture'))                                  AS active_count
         FROM prospecting_campaigns c
         LEFT JOIN playbooks pb ON pb.id = c.playbook_id
         LEFT JOIN sequences sq ON sq.id = c.default_sequence_id
         LEFT JOIN users     u  ON u.id  = c.owner_id
         LEFT JOIN prospects p  ON p.campaign_id = c.id AND p.org_id = c.org_id
        WHERE c.org_id = $1 ${statusFilter}
     GROUP BY c.id, pb.name, sq.name, u.first_name, u.last_name
     ORDER BY c.created_at DESC`,
      params
    );

    res.json({ campaigns: rows });
  } catch (err) {
    console.error('campaigns GET /', err);
    res.status(500).json({ error: { message: 'Failed to load campaigns' } });
  }
});

// ── POST / — create a campaign ───────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    name, description, solution,
    playbook_id, default_sequence_id,
    goal_qualified, start_date, end_date,
    status = 'active',
  } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: { message: 'name is required' } });
  }
  if (!VALID_STATUS.includes(status)) {
    return res.status(400).json({ error: { message: `status must be one of: ${VALID_STATUS.join(', ')}` } });
  }

  try {
    // Validate playbook belongs to this org and is a prospecting playbook.
    if (playbook_id) {
      const pb = await pool.query(
        `SELECT id, type FROM playbooks WHERE id = $1 AND org_id = $2`,
        [playbook_id, req.orgId]
      );
      if (!pb.rows.length) {
        return res.status(400).json({ error: { message: 'Playbook not found in this org' } });
      }
      if (pb.rows[0].type !== 'prospecting') {
        return res.status(400).json({ error: { message: 'Campaign playbook must be a prospecting playbook' } });
      }
    }

    // Validate sequence belongs to this org.
    if (default_sequence_id) {
      const sq = await pool.query(
        `SELECT id FROM sequences WHERE id = $1 AND org_id = $2`,
        [default_sequence_id, req.orgId]
      );
      if (!sq.rows.length) {
        return res.status(400).json({ error: { message: 'Sequence not found in this org' } });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO prospecting_campaigns
             (org_id, name, description, solution, playbook_id, default_sequence_id,
              goal_qualified, start_date, end_date, status, owner_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       RETURNING *`,
      [
        req.orgId, name.trim(), description || null, solution || null,
        playbook_id || null, default_sequence_id || null,
        goal_qualified || null, start_date || null, end_date || null,
        status, req.user.userId,
      ]
    );

    const campaign = await loadCampaign(req.orgId, rows[0].id);
    res.status(201).json({ campaign });
  } catch (err) {
    console.error('campaigns POST /', err);
    res.status(500).json({ error: { message: 'Failed to create campaign' } });
  }
});

// ── GET /:id — one campaign + funnel + multi-channel outreach metrics ────────
//
// Outreach metrics now span three channels:
//   - email     (emails table, direction sent vs received/inbound)
//   - linkedin  (prospecting_activities, activity_type='linkedin_event',
//                direction derived from metadata->>'event')
//   - call      (calls table, direction outbound vs inbound — supports both
//                rep voicemails left AND prospect callback voicemails)
//
// All three roll up into byChannel + totals. The `?channel=` query param
// filters byChannel to only the requested slice (still returns funnel +
// totals unfiltered — see SPRINT_PROGRESS.md design note: funnel-by-channel
// is semantically odd because a prospect is in stage X regardless of which
// channel touched them).
//
// Also returns bySource: counts of prospects in this campaign grouped by
// where they were added from (manual / csv_import / extension / linkedin /
// referral / event / inbound). This powers the Sources mini-card on the UI.
router.get('/:id', async (req, res) => {
  try {
    const campaign = await loadCampaign(req.orgId, req.params.id);
    if (!campaign) return res.status(404).json({ error: { message: 'Campaign not found' } });

    const channelFilter = req.query.channel;  // 'email' | 'linkedin' | 'call' | undefined
    const VALID_CHANNEL_FILTERS = new Set(['email', 'linkedin', 'call']);
    if (channelFilter && !VALID_CHANNEL_FILTERS.has(channelFilter)) {
      return res.status(400).json({
        error: { message: `channel must be one of: ${[...VALID_CHANNEL_FILTERS].join(', ')}` },
      });
    }

    // Funnel: prospect count per stage within this campaign.
    const stageRes = await pool.query(
      `SELECT stage, COUNT(*)::int AS count
         FROM prospects
        WHERE org_id = $1 AND campaign_id = $2 AND deleted_at IS NULL
     GROUP BY stage`,
      [req.orgId, req.params.id]
    );
    const stageMap = {};
    stageRes.rows.forEach(r => { stageMap[r.stage] = r.count; });

    const funnel = FUNNEL_STAGES.map(s => ({ stage: s, count: stageMap[s] || 0 }));
    const terminal = {
      disqualified: stageMap['disqualified'] || 0,
      nurture:      stageMap['nurture']      || 0,
    };
    const totalProspects = Object.values(stageMap).reduce((a, b) => a + b, 0);
    const qualified      = stageMap['qualified_sal'] || 0;

    // Outreach + responses this week, unioned across channels. Week starts
    // on the most recent Sunday in server time (matches the old behaviour).
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    // The CTE produces one row per touch with (channel, direction). We then
    // aggregate by channel.
    //
    // LinkedIn direction derivation: metadata->>'event' tells us what kind
    // of LinkedIn action it was. Outbound events count as outreach; the
    // single inbound event 'reply_received' counts as a response. Events
    // that are neither (e.g. 'connection_accepted', 'profile_viewed',
    // 'meeting_booked') are excluded — they're status milestones, not
    // outreach/response. We also count 'sequence_step_sent' as an outbound
    // touch on whatever channel the sequence step was for (almost always
    // email; linkedin sequence steps are also valid).
    //
    // Calls: direction column on the table already distinguishes outbound
    // (rep dialing, including voicemails left) from inbound (prospect
    // calling back, including voicemails left for the rep).
    const outreachRes = await pool.query(
      `WITH outreach AS (
         -- Email touches
         SELECT 'email'::text  AS channel,
                CASE
                  WHEN e.direction = 'sent'                     THEN 'outreach'
                  WHEN e.direction IN ('received','inbound')    THEN 'response'
                  ELSE NULL
                END AS kind
           FROM emails e
           JOIN prospects p ON p.id = e.prospect_id
          WHERE e.org_id     = $1
            AND p.campaign_id = $2
            AND e.sent_at    >= $3

         UNION ALL

         -- LinkedIn touches from prospecting_activities (extension or rep)
         SELECT 'linkedin'::text AS channel,
                CASE
                  WHEN pa.metadata->>'event' IN (
                    'connection_request_sent', 'message_sent',
                    'inmail_sent',              'voice_note_sent'
                  ) THEN 'outreach'
                  WHEN pa.metadata->>'event' = 'reply_received' THEN 'response'
                  ELSE NULL
                END AS kind
           FROM prospecting_activities pa
           JOIN prospects p ON p.id = pa.prospect_id
          WHERE pa.org_id      = $1
            AND p.campaign_id  = $2
            AND pa.activity_type = 'linkedin_event'
            AND pa.created_at  >= $3

         UNION ALL

         -- Sequence step sends — attributed to the step's channel
         SELECT
           CASE
             WHEN pa.metadata->>'channel' IN ('email','linkedin','call')
               THEN pa.metadata->>'channel'
             ELSE 'email'  -- default for legacy rows without channel meta
           END::text AS channel,
           'outreach'::text AS kind
           FROM prospecting_activities pa
           JOIN prospects p ON p.id = pa.prospect_id
          WHERE pa.org_id      = $1
            AND p.campaign_id  = $2
            AND pa.activity_type = 'sequence_step_sent'
            AND pa.created_at  >= $3

         UNION ALL

         -- Calls (both directions)
         SELECT 'call'::text AS channel,
                CASE
                  WHEN c.direction = 'outbound' THEN 'outreach'
                  WHEN c.direction = 'inbound'  THEN 'response'
                  ELSE NULL
                END AS kind
           FROM calls c
           JOIN prospects p ON p.id = c.prospect_id
          WHERE c.org_id      = $1
            AND p.campaign_id = $2
            AND c.occurred_at >= $3
       )
       SELECT channel,
              COUNT(*) FILTER (WHERE kind = 'outreach')::int AS outreach,
              COUNT(*) FILTER (WHERE kind = 'response')::int AS responses
         FROM outreach
        WHERE kind IS NOT NULL
     GROUP BY channel`,
      [req.orgId, req.params.id, weekStart]
    );

    // Build byChannel with explicit zeros for any missing channel so the
    // UI doesn't have to defensively handle absent keys.
    const byChannel = {
      email:    { outreach: 0, responses: 0 },
      linkedin: { outreach: 0, responses: 0 },
      call:     { outreach: 0, responses: 0 },
    };
    for (const row of outreachRes.rows) {
      if (byChannel[row.channel]) {
        byChannel[row.channel] = {
          outreach:  row.outreach  || 0,
          responses: row.responses || 0,
        };
      }
    }

    // Totals across all channels — kept on the response for the cards that
    // show "Outreach this week" without a channel split (and for the
    // backward-compat fields we still emit below).
    const outreachThisWeek  = byChannel.email.outreach  + byChannel.linkedin.outreach  + byChannel.call.outreach;
    const responsesThisWeek = byChannel.email.responses + byChannel.linkedin.responses + byChannel.call.responses;

    // Apply channel filter to byChannel if requested. We keep the totals
    // computed over ALL channels, since totals are an unconditional rollup
    // for the campaign — filtering totals would just confuse the UI.
    const byChannelOut = channelFilter
      ? { [channelFilter]: byChannel[channelFilter] }
      : byChannel;

    // Prospects by source — counts of how each prospect in this campaign
    // was added. Source is set at create time and never changes.
    const sourceRes = await pool.query(
      `SELECT COALESCE(source, 'unknown') AS source,
              COUNT(*)::int AS count
         FROM prospects
        WHERE org_id = $1
          AND campaign_id = $2
          AND deleted_at IS NULL
     GROUP BY COALESCE(source, 'unknown')`,
      [req.orgId, req.params.id]
    );
    const bySource = {};
    sourceRes.rows.forEach(r => { bySource[r.source] = r.count; });

    // Active enrollments for this campaign's prospects.
    const enrollRes = await pool.query(
      `SELECT COUNT(*)::int AS active_enrollments
         FROM sequence_enrollments se
         JOIN prospects p ON p.id = se.prospect_id
        WHERE se.org_id = $1 AND p.campaign_id = $2 AND se.status = 'active'`,
      [req.orgId, req.params.id]
    );

    res.json({
      campaign,
      funnel,
      terminal,
      metrics: {
        totalProspects,
        qualified,
        goalQualified:       campaign.goal_qualified || null,
        // Back-compat — older frontend code reads these flat fields.
        outreachThisWeek,
        responsesThisWeek,
        activeEnrollments:   enrollRes.rows[0]?.active_enrollments || 0,
        // New, channel-aware shape.
        byChannel:           byChannelOut,
        bySource,
      },
    });
  } catch (err) {
    console.error('campaigns GET /:id', err);
    res.status(500).json({ error: { message: 'Failed to load campaign' } });
  }
});

// ── PUT /:id — update a campaign ─────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const existing = await loadCampaign(req.orgId, req.params.id);
    if (!existing) return res.status(404).json({ error: { message: 'Campaign not found' } });

    const {
      name, description, solution,
      playbook_id, default_sequence_id,
      goal_qualified, start_date, end_date, status,
    } = req.body;

    if (status !== undefined && !VALID_STATUS.includes(status)) {
      return res.status(400).json({ error: { message: `status must be one of: ${VALID_STATUS.join(', ')}` } });
    }
    if (playbook_id) {
      const pb = await pool.query(
        `SELECT id, type FROM playbooks WHERE id = $1 AND org_id = $2`,
        [playbook_id, req.orgId]
      );
      if (!pb.rows.length || pb.rows[0].type !== 'prospecting') {
        return res.status(400).json({ error: { message: 'Invalid prospecting playbook' } });
      }
    }
    if (default_sequence_id) {
      const sq = await pool.query(
        `SELECT id FROM sequences WHERE id = $1 AND org_id = $2`,
        [default_sequence_id, req.orgId]
      );
      if (!sq.rows.length) {
        return res.status(400).json({ error: { message: 'Invalid sequence' } });
      }
    }

    // Build a COALESCE-style partial update: only provided fields change.
    const { rows } = await pool.query(
      `UPDATE prospecting_campaigns SET
         name                = COALESCE($3, name),
         description         = $4,
         solution            = $5,
         playbook_id         = $6,
         default_sequence_id = $7,
         goal_qualified      = $8,
         start_date          = $9,
         end_date            = $10,
         status              = COALESCE($11, status)
       WHERE id = $1 AND org_id = $2
       RETURNING id`,
      [
        req.params.id, req.orgId,
        name !== undefined ? (name && name.trim()) : null,
        description !== undefined ? description : existing.description,
        solution    !== undefined ? solution    : existing.solution,
        playbook_id !== undefined ? (playbook_id || null) : existing.playbook_id,
        default_sequence_id !== undefined ? (default_sequence_id || null) : existing.default_sequence_id,
        goal_qualified !== undefined ? (goal_qualified || null) : existing.goal_qualified,
        start_date !== undefined ? (start_date || null) : existing.start_date,
        end_date   !== undefined ? (end_date   || null) : existing.end_date,
        status !== undefined ? status : null,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'Campaign not found' } });

    const campaign = await loadCampaign(req.orgId, req.params.id);
    res.json({ campaign });
  } catch (err) {
    console.error('campaigns PUT /:id', err);
    res.status(500).json({ error: { message: 'Failed to update campaign' } });
  }
});

// ── DELETE /:id — archive (default) or hard-delete (?hard=true) ───────────────
// Archive keeps the campaign + un-assigns nothing (members stay linked).
// Hard delete relies on the FK ON DELETE SET NULL to un-assign prospects.
router.delete('/:id', async (req, res) => {
  try {
    const existing = await loadCampaign(req.orgId, req.params.id);
    if (!existing) return res.status(404).json({ error: { message: 'Campaign not found' } });

    if (req.query.hard === 'true') {
      await pool.query(
        `DELETE FROM prospecting_campaigns WHERE id = $1 AND org_id = $2`,
        [req.params.id, req.orgId]
      );
      return res.json({ ok: true, deleted: true });
    }

    await pool.query(
      `UPDATE prospecting_campaigns SET status = 'archived'
        WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    res.json({ ok: true, archived: true });
  } catch (err) {
    console.error('campaigns DELETE /:id', err);
    res.status(500).json({ error: { message: 'Failed to delete campaign' } });
  }
});

// ── POST /:id/prospects — assign prospects to this campaign ───────────────────
// body: { prospectIds: [int] }
router.post('/:id/prospects', async (req, res) => {
  const { prospectIds } = req.body;
  if (!Array.isArray(prospectIds) || prospectIds.length === 0) {
    return res.status(400).json({ error: { message: 'prospectIds[] is required' } });
  }
  try {
    const campaign = await loadCampaign(req.orgId, req.params.id);
    if (!campaign) return res.status(404).json({ error: { message: 'Campaign not found' } });

    // Only re-assign prospects that actually belong to this org.
    const { rows } = await pool.query(
      `UPDATE prospects
          SET campaign_id = $1
        WHERE org_id = $2
          AND id = ANY($3::int[])
          AND deleted_at IS NULL
       RETURNING id`,
      [req.params.id, req.orgId, prospectIds]
    );
    res.json({ ok: true, assigned: rows.length, prospectIds: rows.map(r => r.id) });
  } catch (err) {
    console.error('campaigns POST /:id/prospects', err);
    res.status(500).json({ error: { message: 'Failed to assign prospects' } });
  }
});

// ── DELETE /:id/prospects — un-assign prospects from this campaign ────────────
// body: { prospectIds: [int] }
router.delete('/:id/prospects', async (req, res) => {
  const { prospectIds } = req.body;
  if (!Array.isArray(prospectIds) || prospectIds.length === 0) {
    return res.status(400).json({ error: { message: 'prospectIds[] is required' } });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE prospects
          SET campaign_id = NULL
        WHERE org_id = $1
          AND campaign_id = $2
          AND id = ANY($3::int[])
       RETURNING id`,
      [req.orgId, req.params.id, prospectIds]
    );
    res.json({ ok: true, removed: rows.length });
  } catch (err) {
    console.error('campaigns DELETE /:id/prospects', err);
    res.status(500).json({ error: { message: 'Failed to remove prospects' } });
  }
});

// ── POST /:id/enroll-all — enroll campaign members into a sequence ───────────
// body: { sequenceId?, onlyStage?, skipEnrolled = true }
//   sequenceId  — defaults to the campaign's default_sequence_id
//   onlyStage   — optional: enroll only members in this stage
//   skipEnrolled — skip prospects already in an ACTIVE enrollment of that seq
//
// This thin wrapper resolves the member list, then inserts enrollments using
// the exact same logic as POST /api/sequences/enroll (kept in sync with it).
router.post('/:id/enroll-all', async (req, res) => {
  const { sequenceId: bodySeqId, onlyStage, skipEnrolled = true } = req.body;

  const client = await pool.connect();
  try {
    const campaign = await loadCampaign(req.orgId, req.params.id);
    if (!campaign) return res.status(404).json({ error: { message: 'Campaign not found' } });

    const sequenceId = bodySeqId || campaign.default_sequence_id;
    if (!sequenceId) {
      return res.status(400).json({
        error: { message: 'No sequence specified and campaign has no default sequence' },
      });
    }

    // Validate sequence is active and in-org.
    const seqRes = await client.query(
      `SELECT * FROM sequences WHERE id = $1 AND org_id = $2 AND status = 'active'`,
      [sequenceId, req.orgId]
    );
    if (!seqRes.rows.length) {
      return res.status(404).json({ error: { message: 'Active sequence not found' } });
    }
    const sequenceName = seqRes.rows[0].name;

    // First step delay → next_step_due.
    const firstStepRes = await client.query(
      `SELECT delay_days FROM sequence_steps
        WHERE sequence_id = $1 ORDER BY step_order LIMIT 1`,
      [sequenceId]
    );
    const firstDelayDays = firstStepRes.rows[0]?.delay_days ?? 0;

    // Resolve member list.
    const memberParams = [req.orgId, req.params.id];
    let stageFilter = '';
    if (onlyStage) {
      memberParams.push(onlyStage);
      stageFilter = `AND stage = $${memberParams.length}`;
    }
    const memberRes = await client.query(
      `SELECT id FROM prospects
        WHERE org_id = $1 AND campaign_id = $2 AND deleted_at IS NULL ${stageFilter}`,
      memberParams
    );
    const memberIds = memberRes.rows.map(r => r.id);
    if (memberIds.length === 0) {
      return res.json({ enrolled: 0, skipped: [], message: 'No matching prospects in campaign' });
    }

    // Pre-fetch active enrollments for this sequence to skip duplicates.
    let alreadyEnrolled = new Set();
    if (skipEnrolled) {
      const enrRes = await client.query(
        `SELECT prospect_id FROM sequence_enrollments
          WHERE sequence_id = $1 AND org_id = $2 AND status = 'active'
            AND prospect_id = ANY($3::int[])`,
        [sequenceId, req.orgId, memberIds]
      );
      alreadyEnrolled = new Set(enrRes.rows.map(r => r.prospect_id));
    }

    const nextDue = new Date();
    nextDue.setDate(nextDue.getDate() + firstDelayDays);

    await client.query('BEGIN');
    const enrolled = [];
    const skipped  = [];

    for (const prospectId of memberIds) {
      if (skipEnrolled && alreadyEnrolled.has(prospectId)) {
        skipped.push({ prospectId, reason: 'already enrolled' });
        continue;
      }
      try {
        const er = await client.query(
          `INSERT INTO sequence_enrollments
                 (org_id, sequence_id, prospect_id, enrolled_by, next_step_due, personalised_steps)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (sequence_id, prospect_id) DO NOTHING
           RETURNING id`,
          [req.orgId, sequenceId, prospectId, req.user.userId, nextDue, JSON.stringify({})]
        );
        if (er.rows.length) {
          enrolled.push(prospectId);
          // Mirror the activity write done by /api/sequences/enroll.
          try {
            await client.query(
              `INSERT INTO prospecting_activities
                     (prospect_id, user_id, activity_type, description, metadata)
               VALUES ($1, $2, 'sequence_enrolled', $3, $4)`,
              [
                prospectId, req.user.userId,
                `Enrolled in sequence "${sequenceName}" via campaign "${campaign.name}"`,
                JSON.stringify({
                  sequenceId, sequenceName,
                  enrollmentId: er.rows[0].id,
                  campaignId: campaign.id, campaignName: campaign.name,
                }),
              ]
            );
          } catch (actErr) {
            console.warn('enroll-all: activity log failed for prospect', prospectId, actErr.message);
          }
        } else {
          skipped.push({ prospectId, reason: 'already enrolled' });
        }
      } catch (err) {
        skipped.push({ prospectId, reason: err.message });
      }
    }

    await client.query('COMMIT');
    res.json({ enrolled: enrolled.length, skipped, sequenceId, sequenceName });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    console.error('campaigns POST /:id/enroll-all', err);
    res.status(500).json({ error: { message: 'Enroll-all failed' } });
  } finally {
    client.release();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /:id/sequence-health
// Sprint 4 (Group C). Campaign-scoped sequence health — same shape as
// /api/sequences/health but restricted to enrollments whose prospects are
// in this campaign.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/:id/sequence-health', async (req, res) => {
  try {
    const campaign = await loadCampaign(req.orgId, req.params.id);
    if (!campaign) return res.status(404).json({ error: { message: 'Campaign not found' } });

    const day  = `'24 hours'::interval`;
    const week = `'7 days'::interval`;

    // Per-sequence aggregates scoped to this campaign's enrollments.
    // We list only sequences that actually have at least one campaign
    // enrollment — different from the global /health endpoint which lists
    // every active sequence in the org.
    const aggRes = await pool.query(
      `SELECT
         s.id    AS sequence_id,
         s.name  AS sequence_name,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${day}  AND ssl.status = 'draft')::int                              AS drafts_24h,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${day}  AND ssl.status IN ('sent','completed'))::int                AS sent_24h,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${day}  AND ssl.status = 'replied')::int                            AS replied_24h,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${day}  AND ssl.status = 'failed')::int                             AS failed_24h,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${week} AND ssl.status = 'draft')::int                              AS drafts_7d,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${week} AND ssl.status IN ('sent','completed'))::int                AS sent_7d,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${week} AND ssl.status = 'replied')::int                            AS replied_7d,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${week} AND ssl.status = 'failed')::int                             AS failed_7d,
         MAX(ssl.fired_at) AS last_fired_at
       FROM sequences s
       JOIN sequence_enrollments se ON se.sequence_id = s.id
       JOIN prospects p             ON p.id = se.prospect_id
       LEFT JOIN sequence_step_logs ssl ON ssl.enrollment_id = se.id
      WHERE s.org_id      = $1
        AND p.campaign_id = $2
      GROUP BY s.id, s.name
      ORDER BY s.id ASC`,
      [req.orgId, req.params.id]
    );

    // Top errors per sequence within this campaign.
    const errRes = await pool.query(
      `SELECT se.sequence_id,
              ssl.error_message,
              COUNT(*)::int AS count
         FROM sequence_step_logs ssl
         JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
         JOIN prospects p             ON p.id = se.prospect_id
        WHERE ssl.org_id    = $1
          AND p.campaign_id = $2
          AND ssl.status    = 'failed'
          AND ssl.fired_at >= NOW() - ${week}
          AND ssl.error_message IS NOT NULL
     GROUP BY se.sequence_id, ssl.error_message
     ORDER BY se.sequence_id, count DESC`,
      [req.orgId, req.params.id]
    );
    const errorsBySeq = {};
    for (const row of errRes.rows) {
      if (!errorsBySeq[row.sequence_id]) errorsBySeq[row.sequence_id] = [];
      if (errorsBySeq[row.sequence_id].length < 3) {
        errorsBySeq[row.sequence_id].push({ message: row.error_message, count: row.count });
      }
    }

    // Stalled enrollments per sequence within this campaign.
    const stalledRes = await pool.query(
      `SELECT se.sequence_id,
              COUNT(*)::int AS stalled
         FROM sequence_enrollments se
         JOIN prospects p ON p.id = se.prospect_id
         LEFT JOIN LATERAL (
           SELECT MAX(fired_at) AS last_fired
             FROM sequence_step_logs
            WHERE enrollment_id = se.id
         ) ssl ON true
        WHERE se.org_id     = $1
          AND p.campaign_id = $2
          AND se.status     = 'active'
          AND COALESCE(ssl.last_fired, se.enrolled_at) < NOW() - ${week}
     GROUP BY se.sequence_id`,
      [req.orgId, req.params.id]
    );
    const stalledBySeq = {};
    for (const row of stalledRes.rows) stalledBySeq[row.sequence_id] = row.stalled;

    const health = aggRes.rows.map(r => ({
      sequenceId:   r.sequence_id,
      sequenceName: r.sequence_name,
      last24h: {
        drafts:  r.drafts_24h,
        sent:    r.sent_24h,
        replied: r.replied_24h,
        failed:  r.failed_24h,
      },
      last7d: {
        drafts:  r.drafts_7d,
        sent:    r.sent_7d,
        replied: r.replied_7d,
        failed:  r.failed_7d,
      },
      lastFiredAt:        r.last_fired_at,
      topErrors:          errorsBySeq[r.sequence_id] || [],
      stalledEnrollments: stalledBySeq[r.sequence_id] || 0,
    }));

    res.json({ campaignId: parseInt(req.params.id, 10), health });
  } catch (err) {
    console.error('campaign sequence-health error:', err);
    res.status(500).json({ error: { message: 'Failed to load sequence health' } });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN-LEVEL PROSPECTING_CONFIG OVERRIDE (Slice 1)
// ─────────────────────────────────────────────────────────────────────────────
// A campaign can override the org's prospecting_config for specific fields
// (value_props, target_personas, etc.). The override is stored as a JSONB
// blob on prospecting_campaigns.prospecting_config_override.
//
// Resolution semantics (enforced in services/SkillContextService.js
// buildOrgContext):
//   - Non-empty arrays on the campaign REPLACE the org array
//   - Empty arrays mean "inherit from org" — to explicitly clear a field
//     campaign-wide, DELETE the entire override (column → NULL)
//   - Guardrails (banned_phrasings / required_disclaimers) UNION across layers
//
// Endpoints:
//   GET    /:id/config   → { override, resolved, org_baseline }
//   PUT    /:id/config   → write/replace the override JSONB
//   DELETE /:id/config   → clear the override (column → NULL)
//
// Owner/admin only — matches the gating on routes/prospecting-config.routes.js
// (org-level config). Campaign-level config is a config-write privilege.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Campaign config access guard.
//
// Original rule: only owner/admin can read/write a campaign's prospecting_config_override.
// That's too restrictive — campaigns are owned by individual reps, and the rep
// running a campaign needs to author its pain narrative, value props, and hook
// preferences without bothering an admin.
//
// New rule: ANY of these grants access to /:id/config (GET/PUT/DELETE):
//   1. Org-level owner or admin (broad authority)
//   2. The campaign's owner_id matches the requesting user (rep authority)
//   3. The campaign's created_by matches the requesting user (creator authority,
//      for the case where owner_id is unset and the creator should retain edit
//      rights as a fallback)
//
// Returns 403 if none match, 404 if the campaign doesn't exist in the org.
// Sets req.userRole, req.campaignOwnerId, req.isCampaignOwner for downstream use.
async function campaignConfigGuard(req, res, next) {
  try {
    // 1) Org role check — fastest, gates the whole thing if user is admin/owner.
    const roleRes = await pool.query(
      `SELECT role FROM org_users
        WHERE user_id = $1 AND org_id = $2 AND is_active = TRUE`,
      [req.userId, req.orgId]
    );
    if (roleRes.rows.length === 0) {
      return res.status(403).json({ error: { message: 'Access denied — not a member of this org' } });
    }
    const userRole = roleRes.rows[0].role;
    req.userRole = userRole;

    // 2) Owner/admin: grant immediately, skip the campaign lookup.
    if (userRole === 'owner' || userRole === 'admin') {
      req.isCampaignOwner = true;   // for UI semantics, even though it's role-based
      return next();
    }

    // 3) Otherwise look up the campaign and check owner_id / created_by.
    const cRes = await pool.query(
      `SELECT id, owner_id, created_by
         FROM prospecting_campaigns
        WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (cRes.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Campaign not found' } });
    }
    const camp = cRes.rows[0];
    req.campaignOwnerId = camp.owner_id || camp.created_by;
    if (camp.owner_id === req.userId || camp.created_by === req.userId) {
      req.isCampaignOwner = true;
      return next();
    }

    // 4) Neither role nor ownership match — refuse.
    return res.status(403).json({ error: {
      message: 'Only owners/admins or this campaign\'s owner can edit its outreach config.',
    } });
  } catch (err) {
    console.error('campaignConfigGuard error:', err);
    return res.status(500).json({ error: { message: 'Permission check failed' } });
  }
}

const configWriteGuard = campaignConfigGuard;

// ── GET /:id/config — current override + resolved view + org baseline ────────
router.get('/:id/config', configWriteGuard, async (req, res) => {
  try {
    const campRes = await pool.query(
      `SELECT id, prospecting_config_override
         FROM prospecting_campaigns
        WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!campRes.rows.length) {
      return res.status(404).json({ error: { message: 'Campaign not found' } });
    }
    const rawOverride = campRes.rows[0].prospecting_config_override;
    // sanitizeCampaignConfig always returns the full shape (empty arrays where
    // unset) — handy for the UI which can render an editor without null guards.
    const override = sanitizeCampaignConfig(rawOverride);

    // Org baseline — same shape, returned so the UI can show "Inherits: ..." next
    // to each field.
    const orgRes = await pool.query(
      `SELECT settings FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const orgBaseline = sanitizeOrgConfig(orgRes.rows[0]?.settings?.prospecting_config);

    // Resolved view — what the skill will actually see. Mirrors buildOrgContext
    // semantics without invoking it (no user layer here — that's per-rep).
    const resolveReplace = (orgArr, campArr) =>
      (Array.isArray(campArr) && campArr.length > 0) ? campArr : (orgArr || []);

    const resolved = {
      products:                     resolveReplace(orgBaseline.products,                     override.products),
      default_value_props:          resolveReplace(orgBaseline.default_value_props,          override.default_value_props),
      default_target_personas:      resolveReplace(orgBaseline.default_target_personas,      override.default_target_personas),
      default_case_study_summaries: resolveReplace(orgBaseline.default_case_study_summaries, override.default_case_study_summaries),
      hook_preferences: {
        preferred_categories: resolveReplace(
          orgBaseline.hook_preferences?.preferred_categories,
          override.hook_preferences?.preferred_categories
        ),
      },
      guardrails: {
        banned_phrasings: [...new Set([
          ...(orgBaseline.guardrails?.banned_phrasings     || []),
          ...(override.guardrails?.banned_phrasings        || []),
        ])],
        required_disclaimers: [...new Set([
          ...(orgBaseline.guardrails?.required_disclaimers || []),
          ...(override.guardrails?.required_disclaimers    || []),
        ])],
      },
    };

    res.json({
      override,
      resolved,
      org_baseline: orgBaseline,
      has_override: rawOverride !== null && rawOverride !== undefined,
      // Slice-5-fix: tell the client whether the requesting user is allowed
      // to edit. The guard already ran; this just surfaces its result so the
      // UI doesn't need to re-derive role/ownership logic client-side.
      can_edit: true,                    // if we got this far, guard passed
      access_via: req.userRole === 'owner' || req.userRole === 'admin'
        ? 'org_role'
        : 'campaign_ownership',
    });
  } catch (err) {
    console.error('campaign GET /:id/config:', err);
    res.status(500).json({ error: { message: 'Failed to load campaign config' } });
  }
});

// ── PUT /:id/config — write/replace the override JSONB ───────────────────────
// Body: { override: { ...sanitizeCampaignConfig-shape... } }
router.put('/:id/config', configWriteGuard, async (req, res) => {
  try {
    if (!req.body || typeof req.body.override !== 'object' || req.body.override === null) {
      return res.status(400).json({ error: { message: 'override object is required' } });
    }
    const clean = sanitizeCampaignConfig(req.body.override);

    const r = await pool.query(
      `UPDATE prospecting_campaigns
          SET prospecting_config_override = $3::jsonb,
              updated_at = now()
        WHERE id = $1 AND org_id = $2
      RETURNING id, prospecting_config_override`,
      [req.params.id, req.orgId, JSON.stringify(clean)]
    );
    if (!r.rows.length) {
      return res.status(404).json({ error: { message: 'Campaign not found' } });
    }

    res.json({
      override: sanitizeCampaignConfig(r.rows[0].prospecting_config_override),
      has_override: true,
    });
  } catch (err) {
    console.error('campaign PUT /:id/config:', err);
    res.status(500).json({ error: { message: 'Failed to save campaign config' } });
  }
});

// ── DELETE /:id/config — clear the override (column → NULL) ──────────────────
// After this the campaign inherits org config entirely.
router.delete('/:id/config', configWriteGuard, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE prospecting_campaigns
          SET prospecting_config_override = NULL,
              updated_at = now()
        WHERE id = $1 AND org_id = $2
      RETURNING id`,
      [req.params.id, req.orgId]
    );
    if (!r.rows.length) {
      return res.status(404).json({ error: { message: 'Campaign not found' } });
    }
    res.json({ cleared: true, has_override: false });
  } catch (err) {
    console.error('campaign DELETE /:id/config:', err);
    res.status(500).json({ error: { message: 'Failed to clear campaign config' } });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// SLICE 2 — RESEARCHER WORKFLOW + BATCH ACTIVATION + PACING
// ─────────────────────────────────────────────────────────────────────────────

// ── Helper: load this org's effective LinkedIn activation cap ────────────────
// Org ceiling: org_integrations.config.linkedinDailyActivationCap (default 25).
// User target:  user_preferences.preferences.linkedin_daily_activation_target.
// Effective = min(userTarget || orgCap, orgCap). NULL user target → orgCap.
async function resolveActivationLimits(orgId, userId) {
  const [orgRes, userRes] = await Promise.all([
    pool.query(
      `SELECT config FROM org_integrations
        WHERE org_id = $1 AND integration_type = 'prospecting_email'`,
      [orgId]
    ),
    pool.query(
      `SELECT preferences FROM user_preferences
        WHERE user_id = $1 AND org_id = $2`,
      [userId, orgId]
    ),
  ]);
  const cfg = orgRes.rows[0]?.config || {};
  const orgCap = parseInt(cfg.linkedinDailyActivationCap, 10);
  const effectiveOrgCap = (Number.isFinite(orgCap) && orgCap > 0) ? orgCap : 25;

  const prefs = userRes.rows[0]?.preferences || {};
  const userTargetRaw = prefs.linkedin_daily_activation_target;
  const userTarget = parseInt(userTargetRaw, 10);
  const effectiveTarget = (Number.isFinite(userTarget) && userTarget > 0)
    ? Math.min(userTarget, effectiveOrgCap)
    : effectiveOrgCap;

  return {
    orgCap:    effectiveOrgCap,
    userTarget: Number.isFinite(userTarget) && userTarget > 0 ? userTarget : null,
    effective: effectiveTarget,
    activationSlaDays: parseInt(cfg.activationSlaDays, 10) || 7,
    researchSlaDays:   parseInt(cfg.researchSlaDays, 10)   || 14,
  };
}

// ── GET /:id/research-queue — paginated list of `target` prospects ──────────
// For the Research Queue UI. Returns prospects newest-first by default; the UI
// processes one at a time. Returned shape includes everything the researcher
// needs to write the signal without re-doing the AI's account research.
router.get('/:id/research-queue', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '20', 10), 50);
    const offset = parseInt(req.query.offset || '0', 10);
    const stage  = req.query.stage === 'research' ? 'research' : 'target';

    const campRes = await pool.query(
      `SELECT id FROM prospecting_campaigns WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!campRes.rows.length) {
      return res.status(404).json({ error: { message: 'Campaign not found' } });
    }

    const { rows } = await pool.query(
      `SELECT p.id, p.first_name, p.last_name, p.email, p.linkedin_url,
              p.title, p.company_name, p.company_industry,
              p.stage, p.stage_changed_at, p.research_notes, p.research_meta,
              p.created_at,
              a.research_notes AS account_research,
              a.research_meta  AS account_research_meta,
              -- LinkedIn capture status — joined on slug parsed from
              -- linkedin_url with the same regex linkedin-profiles.routes.js
              -- uses on write. last_captured_at is the most recent of any
              -- per-section capture timestamp on the row, written by the
              -- extension upsert. NULL when no row exists for the prospect's
              -- LinkedIn URL — the Research Queue UI renders the "amber"
              -- capture-missing badge in that case.
              lp.last_captured_at        AS linkedin_captured_at,
              lp.last_activity_captured_at AS linkedin_activity_captured_at
         FROM prospects p
    LEFT JOIN accounts a ON a.id = p.account_id
    LEFT JOIN linkedin_profiles lp
           ON lp.org_id = p.org_id
          AND lp.deleted_at IS NULL
          AND lp.linkedin_slug = LOWER(SUBSTRING(p.linkedin_url FROM '/in/([^/?#]+)'))
        WHERE p.org_id      = $1
          AND p.campaign_id = $2
          AND p.stage       = $3
          AND p.deleted_at IS NULL
     ORDER BY p.created_at ASC
        LIMIT $4 OFFSET $5`,
      [req.orgId, req.params.id, stage, limit, offset]
    );

    // Total for paging.
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM prospects
        WHERE org_id      = $1
          AND campaign_id = $2
          AND stage       = $3
          AND deleted_at IS NULL`,
      [req.orgId, req.params.id, stage]
    );

    res.json({
      campaignId: parseInt(req.params.id, 10),
      stage,
      total: countRes.rows[0].total,
      limit,
      offset,
      prospects: rows.map(r => ({
        id: r.id,
        firstName:   r.first_name,
        lastName:    r.last_name,
        email:       r.email,
        linkedinUrl: r.linkedin_url,
        title:       r.title,
        companyName: r.company_name,
        companyIndustry: r.company_industry,
        stage:       r.stage,
        stageChangedAt: r.stage_changed_at,
        createdAt:   r.created_at,
        researchNotes: r.research_notes,
        researchMeta:  r.research_meta,
        // Surface the account-level research so the researcher can decide
        // whether they need to type anything at all, or just hit Approve.
        accountResearch:     r.account_research,
        accountResearchMeta: r.account_research_meta,
        // LinkedIn capture status drives the badge in the Research Queue
        // UI. linkedinCapturedAt is NULL when no row exists; in that case
        // the UI shows an amber "Not captured" hint with a "Open LinkedIn"
        // CTA so the researcher can run the Chrome extension on the page.
        linkedinCapturedAt:         r.linkedin_captured_at,
        linkedinActivityCapturedAt: r.linkedin_activity_captured_at,
      })),
    });
  } catch (err) {
    console.error('research-queue error:', err);
    res.status(500).json({ error: { message: 'Failed to load research queue' } });
  }
});

// ── POST /:id/bulk-activate — batch-activate research-stage prospects ───────
// Creates fresh sequence_enrollments in 'active' status using the campaign's
// default_sequence_id. Optionally runs PersonalizationDispatcher per prospect
// before enrolling, walking every step of the sequence and calling the right
// per-channel skill (outreach-email / outreach-linkedin) with the inferred
// step_intent. Replaces Slice 2's inline single-skill mapping.
//
// Body:
//   {
//     count?:        number,                  // pick N oldest first
//     prospectIds?:  number[],                // explicit list (capped at limit)
//     runSkill?:     boolean (default true),  // call skill before enroll
//     skipPersonalisation?: boolean           // alias for runSkill=false
//   }
//
// Caps: min(userTarget, orgCap), default 25. Hard ceiling enforced server-side.
//
// Returns:
//   {
//     activated: number,
//     enrollments: [{prospectId, enrollmentId, skillStatus}],
//     skipped:   [{prospectId, reason}],
//     cap:       { orgCap, userTarget, effective, used }
//   }
router.post('/:id/bulk-activate', async (req, res) => {
  try {
    const { count, prospectIds, runSkill = true, skipPersonalisation } = req.body || {};

    // Validate campaign + ensure it has a default sequence to enroll into.
    const campRes = await pool.query(
      `SELECT id, default_sequence_id, name
         FROM prospecting_campaigns
        WHERE id = $1 AND org_id = $2 AND status IN ('active', 'paused')`,
      [req.params.id, req.orgId]
    );
    if (!campRes.rows.length) {
      return res.status(404).json({ error: { message: 'Campaign not found or archived' } });
    }
    const campaign = campRes.rows[0];
    if (!campaign.default_sequence_id) {
      return res.status(400).json({ error: {
        message: 'Campaign has no default sequence — set one before bulk-activating.',
      } });
    }

    // Compute cap.
    const limits = await resolveActivationLimits(req.orgId, req.user.userId);

    // Determine candidate set.
    let candidates;
    if (Array.isArray(prospectIds) && prospectIds.length > 0) {
      // Explicit list — validate they're all in this campaign, research stage,
      // and not already enrolled in the default sequence.
      const ids = prospectIds.map(x => parseInt(x, 10)).filter(Number.isFinite);
      const r = await pool.query(
        `SELECT p.id
           FROM prospects p
          WHERE p.org_id      = $1
            AND p.campaign_id = $2
            AND p.stage       = 'research'
            AND p.deleted_at IS NULL
            AND p.id = ANY($3::int[])
            AND NOT EXISTS (
              SELECT 1 FROM sequence_enrollments se
               WHERE se.prospect_id = p.id
                 AND se.sequence_id = $4
                 AND se.status IN ('active', 'paused')
            )`,
        [req.orgId, req.params.id, ids, campaign.default_sequence_id]
      );
      candidates = r.rows.map(row => row.id);
    } else {
      const n = Math.max(1, Math.min(parseInt(count, 10) || limits.effective, limits.effective));
      const r = await pool.query(
        `SELECT p.id
           FROM prospects p
          WHERE p.org_id      = $1
            AND p.campaign_id = $2
            AND p.stage       = 'research'
            AND p.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM sequence_enrollments se
               WHERE se.prospect_id = p.id
                 AND se.sequence_id = $3
                 AND se.status IN ('active', 'paused')
            )
       ORDER BY p.stage_changed_at ASC NULLS FIRST, p.id ASC
          LIMIT $4`,
        [req.orgId, req.params.id, campaign.default_sequence_id, n]
      );
      candidates = r.rows.map(row => row.id);
    }

    // Hard ceiling: never exceed effective cap, even if caller asks for more.
    if (candidates.length > limits.effective) {
      candidates = candidates.slice(0, limits.effective);
    }

    if (candidates.length === 0) {
      return res.json({
        activated: 0,
        enrollments: [],
        skipped: [],
        cap: { ...limits, used: 0 },
        message: 'No eligible prospects (must be in research stage and not already enrolled).',
      });
    }

    // Load sequence to compute next_step_due.
    const seqRes = await pool.query(
      `SELECT s.id, s.name,
              (SELECT delay_days FROM sequence_steps
                 WHERE sequence_id = s.id ORDER BY step_order LIMIT 1) AS first_delay
         FROM sequences s
        WHERE s.id = $1 AND s.org_id = $2 AND s.status = 'active'`,
      [campaign.default_sequence_id, req.orgId]
    );
    if (!seqRes.rows.length) {
      return res.status(400).json({ error: {
        message: 'Default sequence not found or inactive.',
      } });
    }
    const seq = seqRes.rows[0];
    const firstDelay = parseInt(seq.first_delay, 10) || 0;

    // Per-prospect processing — sequential to keep skill rate-limited and to
    // produce clean per-prospect error messages. For 25 prospects with skill
    // calls (~3-6s each per step; multiple steps per sequence) this completes
    // in a couple of minutes; the UI shows a progress count.
    //
    // Slice 3: personalisation is now delegated to PersonalizationDispatcher,
    // which walks all steps and routes each to outreach-email or
    // outreach-linkedin with the inferred step_intent. The dispatcher handles
    // any sequence shape — 3 steps or 8 steps, LinkedIn-first or email-first,
    // with breakups and tasks in any position.
    const wantSkill = runSkill !== false && skipPersonalisation !== true;
    const enrollments = [];
    const skipped     = [];

    for (const prospectId of candidates) {
      let personalisedSteps = {};
      let skillStatus       = 'not_run';
      let dispatchSummary   = null;

      // Step 1: dispatch personalisation across all sequence steps (optional).
      if (wantSkill) {
        try {
          const dispatchResult = await PersonalizationDispatcher.personaliseEnrollment({
            orgId:      req.orgId,
            userId:     req.user.userId,
            sequenceId: campaign.default_sequence_id,
            prospectId,
          });
          personalisedSteps = dispatchResult.personalisedSteps || {};
          dispatchSummary   = dispatchResult.summary;

          // Status semantics:
          //   - 'ok':      every personalisable step succeeded
          //   - 'partial': some succeeded, some errored (rep can still enroll;
          //                errored steps fall back to sequence templates)
          //   - 'failed':  zero steps personalised
          if (dispatchSummary.personalised === 0) {
            skillStatus = 'failed';
          } else if (dispatchSummary.errored > 0) {
            skillStatus = 'partial';
          } else {
            skillStatus = 'ok';
          }

          // Log per-step errors at warn level — useful for tuning intents.
          if (dispatchResult.errors && dispatchResult.errors.length > 0) {
            console.warn(
              `bulk-activate: dispatcher errors for prospect ${prospectId}:`,
              dispatchResult.errors.map(e => `step ${e.stepOrder}: ${e.reason}`).join('; ')
            );
          }
        } catch (dispatchErr) {
          // Hard failure (e.g. sequence has no steps) — non-fatal at the
          // batch level. Enrollment still proceeds with empty
          // personalised_steps; the firer will render from sequence templates.
          console.warn(`bulk-activate dispatcher failed for prospect ${prospectId}:`, dispatchErr.message);
          skillStatus = 'error';
        }
      }

      // Step 2: insert enrollment (active, next_step_due = now + firstDelay).
      try {
        const nextDue = new Date();
        nextDue.setDate(nextDue.getDate() + firstDelay);

        const er = await pool.query(
          `INSERT INTO sequence_enrollments
                       (org_id, sequence_id, prospect_id, enrolled_by,
                        next_step_due, personalised_steps, status)
                VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active')
           ON CONFLICT (sequence_id, prospect_id) DO NOTHING
           RETURNING id`,
          [req.orgId, campaign.default_sequence_id, prospectId,
           req.user.userId, nextDue, JSON.stringify(personalisedSteps)]
        );

        if (er.rows.length === 0) {
          // Race condition: someone enrolled the prospect between our
          // candidate fetch and this INSERT. Skip silently.
          skipped.push({ prospectId, reason: 'already_enrolled' });
          continue;
        }

        const enrollmentId = er.rows[0].id;

        // Move stage research → outreach. The firer would do this on first
        // step fire, but advancing now keeps the funnel honest immediately.
        await pool.query(
          `UPDATE prospects
              SET stage = 'outreach',
                  stage_changed_at = CURRENT_TIMESTAMP,
                  updated_at       = CURRENT_TIMESTAMP
            WHERE id = $1 AND org_id = $2 AND stage = 'research'`,
          [prospectId, req.orgId]
        );

        // Activity row — feeds the campaign drawer's activity feed.
        try {
          await pool.query(
            `INSERT INTO prospecting_activities
                         (org_id, prospect_id, user_id, activity_type, description, metadata)
                  VALUES ($1, $2, $3, 'activation_completed', $4, $5::jsonb)`,
            [
              req.orgId, prospectId, req.user.userId,
              `Activated in sequence "${seq.name}"`,
              JSON.stringify({
                campaignId: parseInt(req.params.id, 10),
                sequenceId: campaign.default_sequence_id,
                sequenceName: seq.name,
                enrollmentId,
                skillStatus,
                dispatchSummary,
                bulkActivate: true,
              }),
            ]
          );
        } catch (actErr) {
          console.warn('bulk-activate: activity log failed:', actErr.message);
        }

        enrollments.push({ prospectId, enrollmentId, skillStatus, dispatchSummary });
      } catch (insertErr) {
        console.error(`bulk-activate enroll failed for prospect ${prospectId}:`, insertErr);
        skipped.push({ prospectId, reason: insertErr.message });
      }
    }

    res.json({
      activated: enrollments.length,
      enrollments,
      skipped,
      cap: { ...limits, used: enrollments.length },
      campaignId: parseInt(req.params.id, 10),
      sequenceName: seq.name,
    });
  } catch (err) {
    console.error('bulk-activate error:', err);
    res.status(500).json({ error: { message: 'Bulk activation failed: ' + err.message } });
  }
});

// ── GET /:id/pacing — funnel counts + 7d activation rate + days-to-clear ────
router.get('/:id/pacing', async (req, res) => {
  try {
    const campRes = await pool.query(
      `SELECT id, name, end_date, default_sequence_id
         FROM prospecting_campaigns
        WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!campRes.rows.length) {
      return res.status(404).json({ error: { message: 'Campaign not found' } });
    }
    const campaign = campRes.rows[0];

    // Stage counts.
    const stageRes = await pool.query(
      `SELECT stage, COUNT(*)::int AS count
         FROM prospects
        WHERE org_id = $1 AND campaign_id = $2 AND deleted_at IS NULL
     GROUP BY stage`,
      [req.orgId, req.params.id]
    );
    const stageCounts = {};
    stageRes.rows.forEach(r => { stageCounts[r.stage] = r.count; });

    // 7d activation rate: count activation_completed activities in last 7 days.
    const actRes = await pool.query(
      `SELECT COUNT(*)::int AS recent_activations
         FROM prospecting_activities pa
         JOIN prospects p ON p.id = pa.prospect_id
        WHERE pa.org_id = $1
          AND p.campaign_id = $2
          AND pa.activity_type = 'activation_completed'
          AND pa.created_at >= NOW() - INTERVAL '7 days'`,
      [req.orgId, req.params.id]
    );
    const recentActivations = actRes.rows[0].recent_activations;
    const activationsPerDay = recentActivations / 7;

    const readyToActivate = stageCounts.research || 0;
    const daysToClear = activationsPerDay > 0
      ? Math.ceil(readyToActivate / activationsPerDay)
      : null;

    // Health: green if pace is sufficient to clear within end_date (or 60d
    // default), amber if it'll take 1.5x the window, red if more.
    let health = 'gray';
    if (readyToActivate === 0) {
      health = 'green';
    } else if (daysToClear === null) {
      health = 'red';   // ready to activate but no recent activity
    } else {
      const windowDays = campaign.end_date
        ? Math.max(1, Math.ceil((new Date(campaign.end_date) - new Date()) / (1000 * 60 * 60 * 24)))
        : 60;
      const ratio = daysToClear / windowDays;
      if (ratio <= 1)      health = 'green';
      else if (ratio <= 1.5) health = 'amber';
      else                  health = 'red';
    }

    res.json({
      campaignId: parseInt(req.params.id, 10),
      stages: {
        target:         stageCounts.target         || 0,
        research:       stageCounts.research       || 0,
        outreach:       stageCounts.outreach       || 0,
        engaged:        stageCounts.engaged        || 0,
        discovery_call: stageCounts.discovery_call || 0,
        qualified_sal:  stageCounts.qualified_sal  || 0,
        disqualified:   stageCounts.disqualified   || 0,
        nurture:        stageCounts.nurture        || 0,
      },
      pacing: {
        readyToActivate,
        activationsLast7d: recentActivations,
        activationsPerDay: Math.round(activationsPerDay * 10) / 10,
        daysToClear,
        health,
      },
    });
  } catch (err) {
    console.error('pacing error:', err);
    res.status(500).json({ error: { message: 'Failed to load pacing' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SLICE 4 — SENDER VISIBILITY
// ─────────────────────────────────────────────────────────────────────────────
// "Where are emails going FROM, and which LinkedIn account drives the LinkedIn
// tasks?" — exposed on the campaign drawer so reps don't have to navigate to
// Settings to find out before launching.
//
// Sender resolution logic mirrors SequenceStepFirer.resolveSender, simplified:
//   1. Per-campaign owner sender (campaign.owner_id) — primary path
//   2. Fallback: any active sender for that owner
//
// LinkedIn doesn't have a server-side account binding — it's whoever's signed
// into the Chrome extension when LinkedIn tasks fire. We surface this as a
// "you" answer with a tooltip explaining the model.
//
// Response shape:
//   {
//     email: {
//       configured: bool,
//       email: string | null,
//       provider: 'google' | 'outlook' | null,
//       display_name: string | null,
//       is_active: bool,
//       emails_sent_today: number,
//       daily_limit: number,
//       health: 'healthy' | 'warning' | 'unconfigured' | 'over_limit',
//       health_reason: string | null,
//       owner_id: number,
//       owner_name: string
//     },
//     linkedin: {
//       model: 'chrome_extension',
//       owner_id: number,
//       owner_name: string,
//       note: string
//     }
//   }

router.get('/:id/sender-summary', async (req, res) => {
  try {
    // Load campaign + owner. Sender resolution follows the campaign owner;
    // for backstop, owner_id falls back to created_by (same pattern as the
    // SLA sweeps).
    const campRes = await pool.query(
      `SELECT c.id, COALESCE(c.owner_id, c.created_by) AS resolved_owner_id,
              u.first_name, u.last_name, u.email AS owner_user_email
         FROM prospecting_campaigns c
    LEFT JOIN users u ON u.id = COALESCE(c.owner_id, c.created_by)
        WHERE c.id = $1 AND c.org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!campRes.rows.length) {
      return res.status(404).json({ error: { message: 'Campaign not found' } });
    }
    const camp = campRes.rows[0];
    const ownerId = camp.resolved_owner_id;
    const ownerName = [camp.first_name, camp.last_name].filter(Boolean).join(' ') || 'Unassigned';

    // Load ALL active senders for the owner — not just the next-to-fire. The
    // firer round-robins across active senders by emails_sent_today then
    // last_sent_at, so a campaign with multiple connected senders sends from
    // all of them. Surface that to the UI so reps don't think the campaign
    // sends from a single account.
    //
    // Sort order matches the firer's selection logic, so the FIRST row is
    // the next-to-fire sender (rep can see "[email protected] sends next").
    const sRes = await pool.query(
      `SELECT id, email, provider, display_name, is_active,
              emails_sent_today, daily_limit, last_reset_at, last_sent_at,
              created_at
         FROM prospecting_sender_accounts
        WHERE org_id = $1
          AND user_id = $2
          AND client_id IS NULL
          AND is_active = true
        ORDER BY
          (CASE WHEN last_reset_at < CURRENT_DATE THEN 0 ELSE emails_sent_today END) ASC,
          last_sent_at ASC NULLS FIRST`,
      [req.orgId, ownerId]
    );

    // Also load inactive senders for the owner — useful for the UI to show
    // "you have 1 active + 2 inactive senders, here's how to reactivate."
    const inactiveRes = await pool.query(
      `SELECT id, email, provider, display_name, is_active,
              emails_sent_today, daily_limit
         FROM prospecting_sender_accounts
        WHERE org_id = $1
          AND user_id = $2
          AND client_id IS NULL
          AND is_active = false`,
      [req.orgId, ownerId]
    );

    // Today-aware sent count — sender rows that haven't reset since yesterday
    // still carry yesterday's counter. UI should display 0 in that case.
    const todayStr = new Date().toISOString().slice(0, 10);
    function sentTodayFor(s) {
      if (!s.last_reset_at) return s.emails_sent_today || 0;
      return new Date(s.last_reset_at) < new Date(todayStr) ? 0 : (s.emails_sent_today || 0);
    }

    function computeHealth(s) {
      const sentToday = sentTodayFor(s);
      const dailyLimit = s.daily_limit || 0;
      if (!s.is_active) {
        return { health: 'warning', reason: 'Connected but inactive. Reactivate under Settings → Email senders.' };
      }
      if (dailyLimit > 0 && sentToday >= dailyLimit) {
        return { health: 'over_limit', reason: `Daily limit (${dailyLimit}) reached. Future sends queue until tomorrow.` };
      }
      if (dailyLimit > 0 && sentToday >= dailyLimit * 0.9) {
        return { health: 'warning', reason: `Near daily limit (${sentToday}/${dailyLimit}). Plan activations carefully.` };
      }
      return { health: 'healthy', reason: null };
    }

    // Build the senders[] list — active first (in firer order), then inactive.
    const senders = [
      ...sRes.rows.map(s => {
        const h = computeHealth(s);
        return {
          id: s.id,
          email: s.email,
          provider: s.provider,
          display_name: s.display_name,
          is_active: true,
          emails_sent_today: sentTodayFor(s),
          daily_limit: s.daily_limit || 0,
          health: h.health,
          health_reason: h.reason,
        };
      }),
      ...inactiveRes.rows.map(s => ({
        id: s.id,
        email: s.email,
        provider: s.provider,
        display_name: s.display_name,
        is_active: false,
        emails_sent_today: 0,
        daily_limit: s.daily_limit || 0,
        health: 'warning',
        health_reason: 'Inactive — not in round-robin rotation.',
      })),
    ];

    // Aggregate health across all ACTIVE senders. The overall rollup is the
    // worst-state among active senders, falling back to 'unconfigured' if
    // none are active.
    const activeSenders = senders.filter(s => s.is_active);

    let emailSummary;
    if (activeSenders.length === 0) {
      emailSummary = {
        configured: false,
        sender_count: 0,
        active_count: 0,
        inactive_count: senders.filter(s => !s.is_active).length,
        senders,                  // empty if no connected senders at all
        next_to_fire: null,
        health: 'unconfigured',
        health_reason: 'No active email senders connected for the campaign owner. Connect one under Settings → Email senders.',
        owner_id: ownerId,
        owner_name: ownerName,
        // Backward-compat: keep the old single-sender shape readable by the
        // pre-Slice-5 UI. Points at the first inactive sender if none active.
        email: senders[0]?.email || null,
        provider: senders[0]?.provider || null,
        display_name: senders[0]?.display_name || null,
        is_active: false,
        emails_sent_today: 0,
        daily_limit: 0,
      };
    } else {
      // Pick worst health among active senders for the rollup.
      const worstActive = activeSenders.reduce((worst, s) => {
        const rank = { healthy: 0, warning: 1, over_limit: 2 };
        return (rank[s.health] > rank[worst.health]) ? s : worst;
      }, activeSenders[0]);
      const nextToFire = activeSenders[0];   // already sorted by firer order

      emailSummary = {
        configured: true,
        sender_count: senders.length,
        active_count: activeSenders.length,
        inactive_count: senders.length - activeSenders.length,
        senders,
        next_to_fire: { id: nextToFire.id, email: nextToFire.email, provider: nextToFire.provider },
        health: worstActive.health,
        health_reason: worstActive.health_reason,
        owner_id: ownerId,
        owner_name: ownerName,
        // Backward-compat shape — pre-Slice-5 UI will still render the
        // next-to-fire sender from the top-level fields.
        email: nextToFire.email,
        provider: nextToFire.provider,
        display_name: nextToFire.display_name,
        is_active: true,
        emails_sent_today: nextToFire.emails_sent_today,
        daily_limit: nextToFire.daily_limit,
      };
    }

    // LinkedIn: no server-side account. The driving account is whoever's
    // logged in on the rep's browser when LinkedIn tasks fire. We surface
    // the rep identity + an explanatory note.
    const linkedinSummary = {
      model: 'chrome_extension',
      owner_id: ownerId,
      owner_name: ownerName,
      note: 'LinkedIn connection requests and messages are executed from the rep\'s logged-in LinkedIn account via the GoWarmCRM Chrome extension. There is no server-side LinkedIn account binding — whoever is signed in on the rep\'s browser at task execution time is the sender.',
    };

    res.json({ email: emailSummary, linkedin: linkedinSummary });
  } catch (err) {
    console.error('sender-summary error:', err);
    res.status(500).json({ error: { message: 'Failed to load sender summary' } });
  }
});

module.exports = router;
