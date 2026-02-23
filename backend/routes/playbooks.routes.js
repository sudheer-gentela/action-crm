// ─────────────────────────────────────────────────────────────────────────────
// playbooks.routes.js  —  Multi-playbook CRUD + per-stage guidance
// Mount in server.js: app.use('/api/playbooks', require('./routes/playbooks.routes'));
//
// KEY CHANGE: stage guidance endpoints now use stage KEY (e.g. "qualified", "demo")
// as the identifier, not stage_type. The key is validated against deal_stages for
// the org, so any key the org has defined is valid.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken           = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const PlaybookService             = require('../services/playbook.service');
const SALES_PLAYBOOK              = require('../config/salesPlaybook');

router.use(authenticateToken, orgContext);

const adminOnly = requireRole('owner', 'admin');

// ── Helper: validate a stage key belongs to this org ─────────────────────────
async function validateStageKey(orgId, stageKey) {
  const result = await db.query(
    `SELECT key FROM deal_stages WHERE org_id = $1 AND key = $2`,
    [orgId, stageKey]
  );
  return result.rows.length > 0;
}

// ── Helper: build default stage_guidance from salesPlaybook.js ───────────────
// Fetches the org's active stage keys and maps them to salesPlaybook defaults.
// Called on new playbook creation and the seed-guidance endpoint.

async function buildDefaultGuidance(orgId) {
  const stagesResult = await db.query(
    `SELECT key FROM deal_stages WHERE org_id = $1 AND is_active = TRUE AND is_terminal = FALSE ORDER BY sort_order ASC`,
    [orgId]
  );
  const guidance = {};
  for (const { key } of stagesResult.rows) {
    if (SALES_PLAYBOOK.deal_stages?.[key]) {
      guidance[key] = SALES_PLAYBOOK.deal_stages[key];
    }
  }
  return guidance;
}

// ── GET / — list all playbooks for org ───────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, type, description, is_default, created_at, updated_at
       FROM playbooks
       WHERE org_id = $1
       ORDER BY is_default DESC, name ASC`,
      [req.orgId]
    );
    res.json({ playbooks: result.rows });
  } catch (err) {
    console.error('List playbooks error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── GET /default — get the org default playbook ───────────────────────────────
router.get('/default', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM playbooks WHERE org_id = $1 AND is_default = TRUE LIMIT 1`,
      [req.orgId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'No default playbook found' } });
    }
    res.json({ playbook: parsePlaybook(result.rows[0]) });
  } catch (err) {
    console.error('Get default playbook error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── GET /:id — get one playbook with full content + stage_guidance ─────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM playbooks WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }
    res.json({ playbook: parsePlaybook(result.rows[0]) });
  } catch (err) {
    console.error('Get playbook error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── POST / — create new playbook (admin only) ─────────────────────────────────
router.post('/', adminOnly, async (req, res) => {
  try {
    const {
      name, type = 'custom', description = '',
      content = {}, stage_guidance = {}, is_default = false,
    } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: { message: 'Playbook name is required' } });
    }

    const VALID_TYPES = ['market', 'product', 'custom'];
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: { message: `type must be one of: ${VALID_TYPES.join(', ')}` } });
    }

    if (is_default) {
      await db.query(
        'UPDATE playbooks SET is_default = FALSE WHERE org_id = $1 AND is_default = TRUE',
        [req.orgId]
      );
    }

    // Auto-populate stage_guidance from salesPlaybook defaults when none provided
    const resolvedGuidance = (Object.keys(stage_guidance).length > 0)
      ? stage_guidance
      : await buildDefaultGuidance(req.orgId);

    const result = await db.query(
      `INSERT INTO playbooks (org_id, name, type, description, content, stage_guidance, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.orgId, name.trim(), type, description,
       JSON.stringify(content), JSON.stringify(resolvedGuidance), is_default]
    );

    res.status(201).json({ playbook: parsePlaybook(result.rows[0]) });
  } catch (err) {
    console.error('Create playbook error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── PUT /:id — update playbook metadata + content (admin only) ────────────────
router.put('/:id', adminOnly, async (req, res) => {
  try {
    const { name, type, description, content, stage_guidance } = req.body;

    const existing = await db.query(
      'SELECT id FROM playbooks WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }

    const VALID_TYPES = ['market', 'product', 'custom'];
    if (type && !VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: { message: `type must be one of: ${VALID_TYPES.join(', ')}` } });
    }

    const result = await db.query(
      `UPDATE playbooks
       SET name           = COALESCE($1, name),
           type           = COALESCE($2, type),
           description    = COALESCE($3, description),
           content        = COALESCE($4, content),
           stage_guidance = COALESCE($5, stage_guidance),
           updated_at     = NOW()
       WHERE id = $6 AND org_id = $7
       RETURNING *`,
      [
        name?.trim()   || null,
        type           || null,
        description    ?? null,
        content        ? JSON.stringify(content)        : null,
        stage_guidance ? JSON.stringify(stage_guidance) : null,
        req.params.id,
        req.orgId,
      ]
    );

    res.json({ playbook: parsePlaybook(result.rows[0]) });
  } catch (err) {
    console.error('Update playbook error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── GET /:id/stages — get all stage guidance for a playbook ───────────────────
router.get('/:id/stages', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, stage_guidance FROM playbooks WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }

    const raw      = result.rows[0].stage_guidance;
    const guidance = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    res.json({ stage_guidance: guidance });
  } catch (err) {
    console.error('Get stage guidance error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── PUT /:id/stages/:stageKey — upsert guidance for one stage (admin only) ────
// stageKey is the deal_stages.key value (e.g. "qualified", "demo", "security_review").
// Validated against deal_stages for this org — any key the org has defined is accepted.

router.put('/:id/stages/:stageKey', adminOnly, async (req, res) => {
  try {
    const { stageKey } = req.params;

    const keyExists = await validateStageKey(req.orgId, stageKey);
    if (!keyExists) {
      return res.status(400).json({
        error: { message: `Stage key "${stageKey}" does not exist in your organisation's deal stages` },
      });
    }

    const {
      goal, next_step, timeline, key_actions,
      email_response_time, success_criteria, requires_proposal_doc,
    } = req.body;

    const guidance = {
      goal:                  goal                || null,
      next_step:             next_step           || null,
      timeline:              timeline            || null,
      key_actions:           Array.isArray(key_actions)       ? key_actions       : [],
      email_response_time:   email_response_time              || null,
      success_criteria:      Array.isArray(success_criteria)  ? success_criteria  : [],
      requires_proposal_doc: !!requires_proposal_doc,
    };

    const updated = await PlaybookService.upsertStageGuidance(
      req.params.id, req.orgId, stageKey, guidance
    );

    const raw = updated.stage_guidance;
    res.json({
      stage_guidance: typeof raw === 'string' ? JSON.parse(raw) : (raw || {}),
      message:        `Stage guidance for "${stageKey}" saved`,
    });
  } catch (err) {
    console.error('Upsert stage guidance error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── DELETE /:id/stages/:stageKey — remove guidance for one stage (admin only) ─

router.delete('/:id/stages/:stageKey', adminOnly, async (req, res) => {
  try {
    const { stageKey } = req.params;

    const result = await db.query(
      `UPDATE playbooks
       SET stage_guidance = stage_guidance - $1,
           updated_at     = NOW()
       WHERE id = $2 AND org_id = $3
       RETURNING id`,
      [stageKey, req.params.id, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }

    res.json({ message: `Stage guidance for "${stageKey}" removed` });
  } catch (err) {
    console.error('Delete stage guidance error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── POST /:id/seed-guidance — backfill stage_guidance from salesPlaybook defaults ─
// Safe to run multiple times — only fills keys that have no existing guidance.
// Use this to backfill the existing default playbook after the key→stageKey migration.

router.post('/:id/seed-guidance', adminOnly, async (req, res) => {
  try {
    const existing = await db.query(
      'SELECT id, stage_guidance FROM playbooks WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }

    const raw     = existing.rows[0].stage_guidance;
    const current = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});

    const defaults = await buildDefaultGuidance(req.orgId);

    // Merge: only fill keys that don't already have guidance
    const seeded  = {};
    const skipped = [];
    for (const [key, guidance] of Object.entries(defaults)) {
      if (!current[key] || (!current[key].goal && !current[key].key_actions?.length)) {
        seeded[key] = guidance;
      } else {
        skipped.push(key);
      }
    }

    if (Object.keys(seeded).length === 0) {
      return res.json({ message: 'All stages already have guidance — nothing to seed.', skipped });
    }

    const merged = { ...current, ...seeded };
    const result = await db.query(
      `UPDATE playbooks SET stage_guidance = $1, updated_at = NOW()
       WHERE id = $2 AND org_id = $3 RETURNING id, stage_guidance`,
      [JSON.stringify(merged), req.params.id, req.orgId]
    );

    const updatedGuidance = result.rows[0].stage_guidance;
    res.json({
      message: `Seeded guidance for ${Object.keys(seeded).length} stage(s).`,
      seeded:  Object.keys(seeded),
      skipped,
      stage_guidance: typeof updatedGuidance === 'string' ? JSON.parse(updatedGuidance) : updatedGuidance,
    });
  } catch (err) {
    console.error('Seed guidance error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── POST /:id/set-default — mark as org default (admin only) ─────────────────
router.post('/:id/set-default', adminOnly, async (req, res) => {
  try {
    const existing = await db.query(
      'SELECT id FROM playbooks WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }

    await db.query('BEGIN');
    await db.query('UPDATE playbooks SET is_default = FALSE WHERE org_id = $1', [req.orgId]);
    const result = await db.query(
      `UPDATE playbooks SET is_default = TRUE, updated_at = NOW()
       WHERE id = $1 AND org_id = $2 RETURNING *`,
      [req.params.id, req.orgId]
    );
    await db.query('COMMIT');

    res.json({ playbook: parsePlaybook(result.rows[0]) });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Set default playbook error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── DELETE /:id — delete playbook (admin only, blocks on default) ─────────────
router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const existing = await db.query(
      'SELECT id, is_default FROM playbooks WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }
    if (existing.rows[0].is_default) {
      return res.status(400).json({
        error: { message: 'Cannot delete the default playbook. Set another playbook as default first.' },
      });
    }

    await db.query('DELETE FROM playbooks WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]);
    res.json({ message: 'Playbook deleted' });
  } catch (err) {
    console.error('Delete playbook error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Helper: parse JSONB fields ────────────────────────────────────────────────
function parsePlaybook(row) {
  const parse = v => (typeof v === 'string' ? JSON.parse(v) : v) || {};
  return {
    ...row,
    content:        parse(row.content),
    stage_guidance: parse(row.stage_guidance),
  };
}

module.exports = router;
