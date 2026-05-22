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
const { orgContext }    = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');

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

module.exports = router;
