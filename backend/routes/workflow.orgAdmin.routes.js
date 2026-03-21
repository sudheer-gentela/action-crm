// =============================================================================
// workflow.orgAdmin.routes.js
// =============================================================================
// Org-scoped workflow + rule CRUD for org owners and admins.
//
// Mount in server.js (alongside existing orgAdmin.routes.js):
//   app.use('/api/org/admin', require('./routes/workflow.orgAdmin.routes'));
//
// Auth pattern mirrors orgAdmin.routes.js exactly:
//   router.use(authenticateToken, orgContext)
//   const adminOnly = requireRole('owner', 'admin')
// =============================================================================

const express           = require('express');
const router            = express.Router();
const { pool }          = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');

router.use(authenticateToken, orgContext);
const adminOnly = requireRole('owner', 'admin');

// ─────────────────────────────────────────────────────────────────────────────
// WORKFLOWS
// ─────────────────────────────────────────────────────────────────────────────

// GET /org/admin/workflows — list org workflows + inherited platform workflows
router.get('/workflows', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT w.*,
              u.first_name AS created_by_first,
              u.last_name  AS created_by_last,
              COUNT(ws.id)::int AS step_count
       FROM workflows w
       LEFT JOIN users u ON w.created_by = u.id
       LEFT JOIN workflow_steps ws ON ws.workflow_id = w.id
       WHERE w.org_id = $1 OR (w.scope = 'platform' AND w.org_id IS NULL)
       GROUP BY w.id, u.first_name, u.last_name
       ORDER BY
         CASE WHEN w.scope = 'platform' THEN 0 ELSE 1 END,
         w.created_at DESC`,
      [req.orgId]
    );
    res.json({ workflows: result.rows });
  } catch (err) {
    console.error('GET /org/admin/workflows error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// POST /org/admin/workflows — create org-scoped workflow
router.post('/workflows', adminOnly, async (req, res) => {
  try {
    const { entity, trigger, name, description, is_active = true } = req.body;
    if (!entity || !trigger || !name) {
      return res.status(400).json({ error: { message: 'entity, trigger, and name are required' } });
    }
    const result = await pool.query(
      `INSERT INTO workflows (org_id, scope, entity, trigger, name, description, is_active, is_locked, created_by)
       VALUES ($1, 'org', $2, $3, $4, $5, $6, FALSE, $7)
       RETURNING *`,
      [req.orgId, entity, trigger, name, description || null, is_active, req.user.userId]
    );
    res.status(201).json({ workflow: result.rows[0] });
  } catch (err) {
    console.error('POST /org/admin/workflows error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// PATCH /org/admin/workflows/:id — org workflows only, locked=false only
router.patch('/workflows/:id', adminOnly, async (req, res) => {
  try {
    // Fetch to confirm ownership and check lock
    const existing = await pool.query(
      `SELECT id, is_locked FROM workflows WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Workflow not found' } });
    }
    if (existing.rows[0].is_locked) {
      return res.status(403).json({
        error: { message: 'This workflow is managed by the platform and cannot be modified' },
      });
    }

    const { name, description, entity, trigger, is_active } = req.body;
    const result = await pool.query(
      `UPDATE workflows
       SET name        = COALESCE($1, name),
           description = COALESCE($2, description),
           entity      = COALESCE($3, entity),
           trigger     = COALESCE($4, trigger),
           is_active   = COALESCE($5, is_active),
           updated_at  = NOW()
       WHERE id = $6 AND org_id = $7
       RETURNING *`,
      [name, description, entity, trigger, is_active, req.params.id, req.orgId]
    );
    res.json({ workflow: result.rows[0] });
  } catch (err) {
    console.error('PATCH /org/admin/workflows/:id error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// DELETE /org/admin/workflows/:id — org workflows only, locked=false only
router.delete('/workflows/:id', adminOnly, async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT id, is_locked FROM workflows WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Workflow not found' } });
    }
    if (existing.rows[0].is_locked) {
      return res.status(403).json({
        error: { message: 'This workflow is managed by the platform and cannot be modified' },
      });
    }
    await pool.query(`DELETE FROM workflows WHERE id = $1 AND org_id = $2`, [req.params.id, req.orgId]);
    res.json({ deleted: true, id: Number(req.params.id) });
  } catch (err) {
    console.error('DELETE /org/admin/workflows/:id error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WORKFLOW STEPS (org workflows only)
// ─────────────────────────────────────────────────────────────────────────────

// GET /org/admin/workflows/:id/steps
router.get('/workflows/:id/steps', adminOnly, async (req, res) => {
  try {
    // Allow viewing steps for platform workflows too (read-only context)
    const result = await pool.query(
      `SELECT ws.*
       FROM workflow_steps ws
       JOIN workflows w ON ws.workflow_id = w.id
       WHERE ws.workflow_id = $1
         AND (w.org_id = $2 OR (w.scope = 'platform' AND w.org_id IS NULL))
       ORDER BY ws.sort_order ASC`,
      [req.params.id, req.orgId]
    );
    res.json({ steps: result.rows });
  } catch (err) {
    console.error('GET /org/admin/workflows/:id/steps error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// POST /org/admin/workflows/:id/steps — org-owned workflows only
router.post('/workflows/:id/steps', adminOnly, async (req, res) => {
  try {
    const wf = await pool.query(
      `SELECT id, is_locked FROM workflows WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (wf.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Workflow not found' } });
    }
    if (wf.rows[0].is_locked) {
      return res.status(403).json({
        error: { message: 'This workflow is managed by the platform and cannot be modified' },
      });
    }

    const { step_type, name, sort_order = 0, on_pass, on_fail, exec_mode = 'sync', depends_on = [] } = req.body;
    if (!step_type || !name) {
      return res.status(400).json({ error: { message: 'step_type and name are required' } });
    }

    const result = await pool.query(
      `INSERT INTO workflow_steps (workflow_id, step_type, name, sort_order, on_pass, on_fail, exec_mode, depends_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.params.id, step_type, name, sort_order, on_pass || null, on_fail || null, exec_mode, depends_on]
    );
    res.status(201).json({ step: result.rows[0] });
  } catch (err) {
    console.error('POST /org/admin/workflows/:id/steps error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// PATCH /org/admin/workflows/:id/steps/:stepId
router.patch('/workflows/:id/steps/:stepId', adminOnly, async (req, res) => {
  try {
    // Confirm workflow belongs to this org and is not locked
    const wf = await pool.query(
      `SELECT id, is_locked FROM workflows WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (wf.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Workflow not found' } });
    }
    if (wf.rows[0].is_locked) {
      return res.status(403).json({
        error: { message: 'This workflow is managed by the platform and cannot be modified' },
      });
    }

    const { name, sort_order, on_pass, on_fail, exec_mode, depends_on, step_type } = req.body;
    const result = await pool.query(
      `UPDATE workflow_steps
       SET name       = COALESCE($1, name),
           sort_order = COALESCE($2, sort_order),
           on_pass    = COALESCE($3, on_pass),
           on_fail    = COALESCE($4, on_fail),
           exec_mode  = COALESCE($5, exec_mode),
           depends_on = COALESCE($6, depends_on),
           step_type  = COALESCE($7, step_type)
       WHERE id = $8 AND workflow_id = $9
       RETURNING *`,
      [name, sort_order, on_pass, on_fail, exec_mode, depends_on, step_type,
       req.params.stepId, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Step not found' } });
    }
    res.json({ step: result.rows[0] });
  } catch (err) {
    console.error('PATCH /org/admin/workflows/:id/steps/:stepId error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// DELETE /org/admin/workflows/:id/steps/:stepId
router.delete('/workflows/:id/steps/:stepId', adminOnly, async (req, res) => {
  try {
    const wf = await pool.query(
      `SELECT id, is_locked FROM workflows WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (wf.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Workflow not found' } });
    }
    if (wf.rows[0].is_locked) {
      return res.status(403).json({
        error: { message: 'This workflow is managed by the platform and cannot be modified' },
      });
    }

    const result = await pool.query(
      `DELETE FROM workflow_steps WHERE id = $1 AND workflow_id = $2 RETURNING id`,
      [req.params.stepId, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Step not found' } });
    }
    res.json({ deleted: true, id: Number(req.params.stepId) });
  } catch (err) {
    console.error('DELETE /org/admin/workflows/:id/steps/:stepId error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STANDALONE RULES
// ─────────────────────────────────────────────────────────────────────────────

// GET /org/admin/rules — org rules + inherited platform rules
router.get('/rules', adminOnly, async (req, res) => {
  try {
    const { entity, trigger } = req.query;
    const params = [req.orgId];
    let extraWhere = '';
    if (entity)  { params.push(entity);  extraWhere += ` AND wr.entity = $${params.length}`; }
    if (trigger) { params.push(trigger); extraWhere += ` AND wr.trigger = $${params.length}`; }

    const result = await pool.query(
      `SELECT wr.*, u.first_name AS created_by_first, u.last_name AS created_by_last
       FROM workflow_rules wr
       LEFT JOIN users u ON wr.created_by = u.id
       WHERE wr.step_id IS NULL
         AND (wr.org_id = $1 OR wr.org_id IS NULL)
         ${extraWhere}
       ORDER BY
         CASE WHEN wr.org_id IS NULL THEN 0 ELSE 1 END,
         wr.sort_order ASC, wr.created_at DESC`,
      params
    );
    res.json({ rules: result.rows });
  } catch (err) {
    console.error('GET /org/admin/rules error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// POST /org/admin/rules — create standalone org rule
router.post('/rules', adminOnly, async (req, res) => {
  try {
    const {
      entity, rule_type, name, severity = 'block', trigger,
      conditions = {}, action = {}, is_active = true, sort_order = 0,
    } = req.body;

    if (!entity || !rule_type || !name || !trigger) {
      return res.status(400).json({
        error: { message: 'entity, rule_type, name, and trigger are required' },
      });
    }

    const result = await pool.query(
      `INSERT INTO workflow_rules
         (step_id, org_id, entity, rule_type, name, severity, trigger,
          conditions, action, is_active, is_locked, sort_order, created_by)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, $10, $11)
       RETURNING *`,
      [req.orgId, entity, rule_type, name, severity, trigger,
       JSON.stringify(conditions), JSON.stringify(action),
       is_active, sort_order, req.user.userId]
    );
    res.status(201).json({ rule: result.rows[0] });
  } catch (err) {
    console.error('POST /org/admin/rules error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// PATCH /org/admin/rules/:id — locked=false only
router.patch('/rules/:id', adminOnly, async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT id, is_locked FROM workflow_rules WHERE id = $1 AND org_id = $2 AND step_id IS NULL`,
      [req.params.id, req.orgId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Rule not found' } });
    }
    if (existing.rows[0].is_locked) {
      return res.status(403).json({
        error: { message: 'This rule is managed by the platform and cannot be modified' },
      });
    }

    const { name, severity, trigger, entity, rule_type, conditions, action, is_active, sort_order } = req.body;
    const result = await pool.query(
      `UPDATE workflow_rules
       SET name       = COALESCE($1, name),
           severity   = COALESCE($2, severity),
           trigger    = COALESCE($3, trigger),
           entity     = COALESCE($4, entity),
           rule_type  = COALESCE($5, rule_type),
           conditions = COALESCE($6, conditions),
           action     = COALESCE($7, action),
           is_active  = COALESCE($8, is_active),
           sort_order = COALESCE($9, sort_order),
           updated_at = NOW()
       WHERE id = $10 AND org_id = $11 AND step_id IS NULL
       RETURNING *`,
      [name, severity, trigger, entity, rule_type,
       conditions ? JSON.stringify(conditions) : null,
       action ? JSON.stringify(action) : null,
       is_active, sort_order, req.params.id, req.orgId]
    );
    res.json({ rule: result.rows[0] });
  } catch (err) {
    console.error('PATCH /org/admin/rules/:id error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// DELETE /org/admin/rules/:id — locked=false only
router.delete('/rules/:id', adminOnly, async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT id, is_locked FROM workflow_rules WHERE id = $1 AND org_id = $2 AND step_id IS NULL`,
      [req.params.id, req.orgId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Rule not found' } });
    }
    if (existing.rows[0].is_locked) {
      return res.status(403).json({
        error: { message: 'This rule is managed by the platform and cannot be modified' },
      });
    }
    await pool.query(`DELETE FROM workflow_rules WHERE id = $1 AND org_id = $2`, [req.params.id, req.orgId]);
    res.json({ deleted: true, id: Number(req.params.id) });
  } catch (err) {
    console.error('DELETE /org/admin/rules/:id error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION HISTORY + VIOLATIONS (own org only)
// ─────────────────────────────────────────────────────────────────────────────

// GET /org/admin/executions
router.get('/executions', adminOnly, async (req, res) => {
  try {
    const { entity_type, status, limit = 50, offset = 0 } = req.query;
    const params = [req.orgId];
    const conditions = [`w.org_id = $1 OR (w.scope = 'platform' AND w.org_id IS NULL)`];

    if (entity_type) { params.push(entity_type); conditions.push(`we.entity_type = $${params.length}`); }
    if (status)      { params.push(status);       conditions.push(`we.status = $${params.length}`); }

    params.push(Number(limit));
    params.push(Number(offset));

    const result = await pool.query(
      `SELECT we.*,
              w.name       AS workflow_name,
              w.entity     AS workflow_entity,
              w.scope      AS workflow_scope,
              u.first_name AS triggered_by_first,
              u.last_name  AS triggered_by_last
       FROM workflow_executions we
       JOIN workflows w ON we.workflow_id = w.id
       LEFT JOIN users u ON we.triggered_by = u.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY we.started_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ executions: result.rows });
  } catch (err) {
    console.error('GET /org/admin/executions error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// GET /org/admin/violations — open violations for this org's entities
router.get('/violations', adminOnly, async (req, res) => {
  try {
    const { entity_type, limit = 100, offset = 0 } = req.query;
    const params = [req.orgId];
    let entityFilter = '';
    if (entity_type) {
      params.push(entity_type);
      entityFilter = `AND rv.entity_type = $${params.length}`;
    }

    params.push(Number(limit));
    params.push(Number(offset));

    const result = await pool.query(
      `SELECT rv.*,
              wr.name        AS rule_name,
              wr.severity    AS rule_severity,
              wr.rule_type,
              wr.entity      AS rule_entity
       FROM rule_violations rv
       JOIN workflow_rules wr ON rv.rule_id = wr.id
       WHERE rv.resolved_at IS NULL
         AND (wr.org_id = $1 OR wr.org_id IS NULL)
         ${entityFilter}
       ORDER BY rv.detected_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ violations: result.rows });
  } catch (err) {
    console.error('GET /org/admin/violations error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
