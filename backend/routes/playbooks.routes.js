// ─────────────────────────────────────────────────────────────────────────────
// playbooks.routes.js  —  Multi-playbook CRUD + per-stage guidance
// Mount in server.js: app.use('/api/playbooks', require('./routes/playbooks.routes'));
//
// KEY CHANGE: stage guidance endpoints now use stage KEY (e.g. "qualified", "demo")
// as the identifier, not stage_type. The key is validated against pipeline_stages for
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
// All types now use pipeline_stages — keyed by pipeline name.
// Sales legacy types map to pipeline='sales', others use type key directly.
const SALES_LEGACY_TYPES = ['sales', 'custom', 'market', 'product'];

async function validateStageKey(orgId, stageKey, playbookType, playbookId) {
  if (!stageKey || !stageKey.trim()) return false;

  const pipeline = SALES_LEGACY_TYPES.includes(playbookType) ? 'sales'
    : playbookType === 'prospecting' ? 'prospecting'
    : playbookType; // clm, service, handover_s2i, or any custom type

  // If no stages seeded yet for this pipeline, accept any non-empty key
  const stageCount = await db.query(
    `SELECT COUNT(*) FROM pipeline_stages WHERE org_id = $1 AND pipeline = $2`,
    [orgId, pipeline]
  );
  if (parseInt(stageCount.rows[0].count) === 0) return true;

  const result = await db.query(
    `SELECT key FROM pipeline_stages WHERE org_id = $1 AND pipeline = $2 AND key = $3 LIMIT 1`,
    [orgId, pipeline, stageKey]
  );
  return result.rows.length > 0;
}

// ── Helper: build default stage_guidance from salesPlaybook.js ───────────────
// Fetches the org's active stage keys and maps them to salesPlaybook defaults.
// Called on new playbook creation and the seed-guidance endpoint.

async function buildDefaultGuidance(orgId) {
  const stagesResult = await db.query(
    `SELECT key FROM pipeline_stages WHERE org_id = $1 AND pipeline = 'sales' AND is_active = TRUE AND is_terminal = FALSE ORDER BY sort_order ASC`,
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

// ── Helper: build default stage_guidance for prospecting playbooks ─────────
// Uses prospect lifecycle stages instead of deal stages.

function buildDefaultProspectingGuidance() {
  return {
    target: {
      goal: 'Verify ICP fit and gather basic company intel',
      key_actions: ['research_company', 'research_contact'],
      success_criteria: ['Company research completed', 'ICP score above threshold'],
      timeline: '1-2 days',
    },
    researched: {
      goal: 'Prepare personalised outreach based on research findings',
      key_actions: ['craft_outreach', 'identify_pain_points'],
      success_criteria: ['Personalised message drafted', 'Value prop mapped to pain points'],
      timeline: '1 day',
    },
    contacted: {
      goal: 'Execute multi-touch outreach sequence and get a response',
      key_actions: ['send_email', 'send_linkedin', 'follow_up', 'make_call'],
      success_criteria: ['Response received', 'Meeting booked', 'Or sequence exhausted'],
      timeline: '2-3 weeks',
      cadence: { touches: 8, span_days: 21 },
    },
    engaged: {
      goal: 'Deepen conversation and qualify the opportunity',
      key_actions: ['discovery_call', 'qualify', 'share_resources'],
      success_criteria: ['Budget confirmed', 'Decision timeline identified', 'Champion identified'],
      timeline: '1-2 weeks',
    },
    qualified: {
      goal: 'Convert to a deal with a clear next step',
      key_actions: ['schedule_demo', 'intro_to_ae', 'convert'],
      success_criteria: ['Deal created in pipeline', 'Meeting scheduled with decision maker'],
      timeline: '1 week',
    },
  };
}

// ── GET / — list all playbooks for org ───────────────────────────────────────
// Supports ?type=prospecting to filter by type
router.get('/', async (req, res) => {
  try {
    const { type } = req.query;
    let query = `SELECT id, name, type, description, is_default, created_at, updated_at
       FROM playbooks
       WHERE org_id = $1`;
    const params = [req.orgId];

    if (type) {
      query += ` AND type = $2`;
      params.push(type);
    }

    query += ` ORDER BY is_default DESC, name ASC`;

    const result = await db.query(query, params);
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

    // Validate type against org's configured playbook types
    const orgTypesResult = await db.query(
      `SELECT settings->'playbook_types' AS types FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const orgTypes = orgTypesResult.rows[0]?.types;
    // System types are always valid regardless of org settings
    const SYSTEM_TYPE_KEYS = ['sales', 'market', 'product', 'custom', 'prospecting', 'clm', 'handover_s2i', 'service'];
    if (!SYSTEM_TYPE_KEYS.includes(type)) {
      const customKeys = Array.isArray(orgTypes) ? orgTypes.map(t => t.key) : [];
      if (!customKeys.includes(type)) {
        return res.status(400).json({ error: { message: `type must be one of: ${[...SYSTEM_TYPE_KEYS, ...customKeys].join(', ')}` } });
      }
    }

    if (is_default) {
      // Clear defaults only within the same type — each type has its own default
      await db.query(
        `UPDATE playbooks SET is_default = FALSE WHERE org_id = $1 AND type = $2 AND is_default = TRUE`,
        [req.orgId, type]
      );
    }

    // Auto-populate stage_guidance from defaults when none provided.
    // Only sales-type playbooks get deal stage defaults — everything else starts empty.
    let resolvedGuidance;
    if (Object.keys(stage_guidance).length > 0) {
      resolvedGuidance = stage_guidance;
    } else if (type === 'prospecting') {
      resolvedGuidance = buildDefaultProspectingGuidance();
    } else if (type === 'sales' || type === 'custom' || type === 'market' || type === 'product') {
      resolvedGuidance = await buildDefaultGuidance(req.orgId);
    } else {
      resolvedGuidance = {}; // all other types start with empty guidance, admin fills via UI
    }

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

    if (type) {
      const orgTypesResult = await db.query(
        `SELECT settings->'playbook_types' AS types FROM organizations WHERE id = $1`,
        [req.orgId]
      );
      const orgTypes = orgTypesResult.rows[0]?.types;
      const validKeys = Array.isArray(orgTypes) && orgTypes.length > 0
        ? orgTypes.map(t => t.key)
        : ['sales', 'market', 'product', 'custom', 'prospecting', 'clm', 'handover_s2i'];
      if (!validKeys.includes(type) && type !== 'custom' && type !== 'clm' && type !== 'handover_s2i') {
        return res.status(400).json({ error: { message: `type must be one of: ${validKeys.join(', ')}` } });
      }
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

    // Fetch playbook type so validateStageKey can apply the right validation strategy
    const pbRow = await db.query(
      'SELECT type FROM playbooks WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );
    if (pbRow.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }
    const playbookType = pbRow.rows[0].type;

    const keyExists = await validateStageKey(req.orgId, stageKey, playbookType, parseInt(req.params.id));
    if (!keyExists) {
      return res.status(400).json({
        error: { message: `Stage key "${stageKey}" does not exist in your organisation's stages` },
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
// Scoped by type: setting a prospecting default won't clear the sales default.
router.post('/:id/set-default', adminOnly, async (req, res) => {
  try {
    const existing = await db.query(
      'SELECT id, type FROM playbooks WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }

    const pbType = existing.rows[0].type;

    await db.query('BEGIN');
    // Clear defaults only within the same type — each type has its own default
    await db.query(
      `UPDATE playbooks SET is_default = FALSE WHERE org_id = $1 AND type = $2`,
      [req.orgId, pbType]
    );
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
