// =============================================================================
// workflow.superAdmin.routes.js
// =============================================================================
// Platform-scoped workflow + rule CRUD for super admins.
//
// Mount in server.js (alongside existing superAdmin.routes.js):
//   app.use('/api/super', require('./routes/workflow.superAdmin.routes'));
//
// All routes inherit: authenticateToken + requireSuperAdmin
// (applied via router.use at top of file — same pattern as superAdmin.routes.js)
// =============================================================================

const express           = require('express');
const router            = express.Router();
const { pool }          = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { requireSuperAdmin } = require('../middleware/superAdmin.middleware');

router.use(authenticateToken, requireSuperAdmin);

// ─────────────────────────────────────────────────────────────────────────────
// WORKFLOWS
// ─────────────────────────────────────────────────────────────────────────────

// GET /super/workflows — list all platform-scoped workflows
router.get('/workflows', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT w.*,
              u.first_name AS created_by_first,
              u.last_name  AS created_by_last,
              COUNT(ws.id)::int AS step_count
       FROM workflows w
       LEFT JOIN users u  ON w.created_by = u.id
       LEFT JOIN workflow_steps ws ON ws.workflow_id = w.id
       WHERE w.scope = 'platform' AND w.org_id IS NULL
       GROUP BY w.id, u.first_name, u.last_name
       ORDER BY w.created_at DESC`
    );
    res.json({ workflows: result.rows });
  } catch (err) {
    console.error('GET /super/workflows error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// POST /super/workflows — create platform workflow
router.post('/workflows', async (req, res) => {
  try {
    const { entity, trigger, name, description, is_active = true } = req.body;
    if (!entity || !trigger || !name) {
      return res.status(400).json({ error: { message: 'entity, trigger, and name are required' } });
    }
    const result = await pool.query(
      `INSERT INTO workflows (org_id, scope, entity, trigger, name, description, is_active, is_locked, created_by)
       VALUES (NULL, 'platform', $1, $2, $3, $4, $5, TRUE, $6)
       RETURNING *`,
      [entity, trigger, name, description || null, is_active, req.user.userId]
    );
    res.status(201).json({ workflow: result.rows[0] });
  } catch (err) {
    console.error('POST /super/workflows error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// PATCH /super/workflows/:id
router.patch('/workflows/:id', async (req, res) => {
  try {
    const { name, description, entity, trigger, is_active } = req.body;
    const result = await pool.query(
      `UPDATE workflows
       SET name        = COALESCE($1, name),
           description = COALESCE($2, description),
           entity      = COALESCE($3, entity),
           trigger     = COALESCE($4, trigger),
           is_active   = COALESCE($5, is_active),
           updated_at  = NOW()
       WHERE id = $6 AND scope = 'platform' AND org_id IS NULL
       RETURNING *`,
      [name, description, entity, trigger, is_active, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Workflow not found' } });
    }
    res.json({ workflow: result.rows[0] });
  } catch (err) {
    console.error('PATCH /super/workflows/:id error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// DELETE /super/workflows/:id
router.delete('/workflows/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM workflows WHERE id = $1 AND scope = 'platform' AND org_id IS NULL RETURNING id`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Workflow not found' } });
    }
    res.json({ deleted: true, id: Number(req.params.id) });
  } catch (err) {
    console.error('DELETE /super/workflows/:id error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WORKFLOW STEPS
// ─────────────────────────────────────────────────────────────────────────────

// GET /super/workflows/:id/steps
router.get('/workflows/:id/steps', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ws.*
       FROM workflow_steps ws
       JOIN workflows w ON ws.workflow_id = w.id
       WHERE ws.workflow_id = $1 AND w.scope = 'platform' AND w.org_id IS NULL
       ORDER BY ws.sort_order ASC`,
      [req.params.id]
    );
    res.json({ steps: result.rows });
  } catch (err) {
    console.error('GET /super/workflows/:id/steps error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// POST /super/workflows/:id/steps
router.post('/workflows/:id/steps', async (req, res) => {
  try {
    const { step_type, name, sort_order = 0, on_pass, on_fail, exec_mode = 'sync', depends_on = [] } = req.body;
    if (!step_type || !name) {
      return res.status(400).json({ error: { message: 'step_type and name are required' } });
    }
    // Verify workflow belongs to platform scope
    const wf = await pool.query(
      `SELECT id FROM workflows WHERE id = $1 AND scope = 'platform' AND org_id IS NULL`,
      [req.params.id]
    );
    if (wf.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Workflow not found' } });
    }
    const result = await pool.query(
      `INSERT INTO workflow_steps (workflow_id, step_type, name, sort_order, on_pass, on_fail, exec_mode, depends_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.params.id, step_type, name, sort_order, on_pass || null, on_fail || null, exec_mode, depends_on]
    );
    res.status(201).json({ step: result.rows[0] });
  } catch (err) {
    console.error('POST /super/workflows/:id/steps error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// PATCH /super/workflows/:id/steps/:stepId
router.patch('/workflows/:id/steps/:stepId', async (req, res) => {
  try {
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
    console.error('PATCH /super/workflows/:id/steps/:stepId error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// DELETE /super/workflows/:id/steps/:stepId
router.delete('/workflows/:id/steps/:stepId', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM workflow_steps WHERE id = $1 AND workflow_id = $2 RETURNING id`,
      [req.params.stepId, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Step not found' } });
    }
    res.json({ deleted: true, id: Number(req.params.stepId) });
  } catch (err) {
    console.error('DELETE /super/workflows/:id/steps/:stepId error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STANDALONE RULES
// ─────────────────────────────────────────────────────────────────────────────

// GET /super/rules — list all standalone platform rules
router.get('/rules', async (req, res) => {
  try {
    const { entity, trigger } = req.query;
    const params = [];
    let where = `WHERE wr.step_id IS NULL AND wr.org_id IS NULL`;
    if (entity)  { params.push(entity);  where += ` AND wr.entity = $${params.length}`; }
    if (trigger) { params.push(trigger); where += ` AND wr.trigger = $${params.length}`; }

    const result = await pool.query(
      `SELECT wr.*, u.first_name AS created_by_first, u.last_name AS created_by_last
       FROM workflow_rules wr
       LEFT JOIN users u ON wr.created_by = u.id
       ${where}
       ORDER BY wr.sort_order ASC, wr.created_at DESC`,
      params
    );
    res.json({ rules: result.rows });
  } catch (err) {
    console.error('GET /super/rules error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// POST /super/rules — create standalone platform rule
router.post('/rules', async (req, res) => {
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
       VALUES (NULL, NULL, $1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9, $10)
       RETURNING *`,
      [entity, rule_type, name, severity, trigger,
       JSON.stringify(conditions), JSON.stringify(action),
       is_active, sort_order, req.user.userId]
    );
    res.status(201).json({ rule: result.rows[0] });
  } catch (err) {
    console.error('POST /super/rules error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// PATCH /super/rules/:id
router.patch('/rules/:id', async (req, res) => {
  try {
    const {
      name, severity, trigger, entity, rule_type,
      conditions, action, is_active, is_locked, sort_order,
    } = req.body;

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
           is_locked  = COALESCE($9, is_locked),
           sort_order = COALESCE($10, sort_order),
           updated_at = NOW()
       WHERE id = $11 AND org_id IS NULL AND step_id IS NULL
       RETURNING *`,
      [name, severity, trigger, entity, rule_type,
       conditions ? JSON.stringify(conditions) : null,
       action ? JSON.stringify(action) : null,
       is_active, is_locked, sort_order, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Rule not found' } });
    }
    res.json({ rule: result.rows[0] });
  } catch (err) {
    console.error('PATCH /super/rules/:id error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// DELETE /super/rules/:id
router.delete('/rules/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM workflow_rules WHERE id = $1 AND org_id IS NULL AND step_id IS NULL RETURNING id`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Rule not found' } });
    }
    res.json({ deleted: true, id: Number(req.params.id) });
  } catch (err) {
    console.error('DELETE /super/rules/:id error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION HISTORY
// ─────────────────────────────────────────────────────────────────────────────

// GET /super/executions — execution history across all orgs
router.get('/executions', async (req, res) => {
  try {
    const { org_id, entity_type, status, limit = 50, offset = 0 } = req.query;
    const params = [];
    const conditions = [];

    if (org_id) {
      params.push(org_id);
      conditions.push(`w.org_id = $${params.length}`);
    }
    if (entity_type) {
      params.push(entity_type);
      conditions.push(`we.entity_type = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`we.status = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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
       ${whereClause}
       ORDER BY we.started_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ executions: result.rows });
  } catch (err) {
    console.error('GET /super/executions error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
