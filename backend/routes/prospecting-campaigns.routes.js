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

// ── GET /:id — one campaign + funnel breakdown ───────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const campaign = await loadCampaign(req.orgId, req.params.id);
    if (!campaign) return res.status(404).json({ error: { message: 'Campaign not found' } });

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

    // Outreach + replies this week, scoped to this campaign's prospects.
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const emailRes = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE e.direction = 'sent')                       AS outreach_this_week,
         COUNT(*) FILTER (WHERE e.direction IN ('received','inbound'))       AS responses_this_week
         FROM emails e
         JOIN prospects p ON p.id = e.prospect_id
        WHERE e.org_id = $1
          AND p.campaign_id = $2
          AND e.sent_at >= $3`,
      [req.orgId, req.params.id, weekStart]
    );

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
        outreachThisWeek:    parseInt(emailRes.rows[0]?.outreach_this_week  || 0, 10),
        responsesThisWeek:   parseInt(emailRes.rows[0]?.responses_this_week || 0, 10),
        activeEnrollments:   enrollRes.rows[0]?.active_enrollments || 0,
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

module.exports = router;
