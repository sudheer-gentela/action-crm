const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const ActionsGenerator        = require('../services/actionsGenerator');
const ActionConfigService     = require('../services/actionConfig.service');
const HandoverService         = require('../services/handover.service');
const DealContextBuilder      = require('../services/DealContextBuilder');
const PlaybookActionGenerator = require('../services/PlaybookActionGenerator');
const ActionWriter            = require('../services/ActionWriter');

router.use(authenticateToken);
router.use(orgContext);

// ── Helper: validate a stage key belongs to this org and is active ────────────
async function validateStage(orgId, stageKey) {
  if (!stageKey) return null;
  try {
    const result = await db.query(
      `SELECT key, stage_type, is_active, is_terminal
       FROM pipeline_stages
       WHERE org_id = $1 AND pipeline = 'sales' AND key = $2`,
      [orgId, stageKey]
    );
    if (result.rows.length === 0) {
      throw new Error(`Invalid stage: "${stageKey}" does not exist in this organisation`);
    }
    if (!result.rows[0].is_active) {
      throw new Error(`Stage "${stageKey}" is inactive and cannot be assigned to deals`);
    }
    return result.rows[0];
  } catch (err) {
    throw err;
  }
}

// Helper: resolve the default stage key for new deals (first active non-terminal)
async function resolveDefaultStage(orgId) {
  try {
    const result = await db.query(
      `SELECT key FROM pipeline_stages
       WHERE org_id = $1 AND pipeline = 'sales' AND is_active = TRUE AND is_terminal = FALSE
       ORDER BY sort_order ASC LIMIT 1`,
      [orgId]
    );
    return result.rows[0]?.key || 'qualified';
  } catch {
    return 'qualified';
  }
}

// ── GET / ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { stage, health, scope = 'mine' } = req.query;

    let query = `
      SELECT
        d.*,
        acc.name   as account_name,
        acc.domain as account_domain,
        u.first_name as owner_first_name,
        u.last_name  as owner_last_name,
        json_agg(
          json_build_object(
            'id', c.id, 'firstName', c.first_name, 'lastName', c.last_name,
            'email', c.email, 'title', c.title, 'role', dc.role
          )
        ) FILTER (WHERE c.id IS NOT NULL) as contacts
      FROM deals d
      LEFT JOIN accounts acc ON d.account_id = acc.id
      LEFT JOIN users u      ON d.owner_id   = u.id
      LEFT JOIN deal_contacts dc ON d.id = dc.deal_id
      LEFT JOIN contacts c ON dc.contact_id = c.id
      WHERE d.org_id = $1
    `;

    const params = [req.orgId];

    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      query += ` AND d.owner_id = ANY($${params.length + 1}::int[])`;
      params.push(teamIds);
    } else if (scope === 'org') {
      // no owner filter
    } else {
      query += ` AND d.owner_id = $${params.length + 1}`;
      params.push(req.user.userId);
    }

    if (stage) {
      query += ` AND d.stage = $${params.length + 1}`;
      params.push(stage);
    }
    if (health) {
      query += ` AND d.health = $${params.length + 1}`;
      params.push(health);
    }

    query += ' GROUP BY d.id, acc.id, u.id ORDER BY d.expected_close_date ASC';

    const result = await db.query(query, params);

    res.json({
      deals: result.rows.map(row => ({
        id:                  row.id,
        user_id:             row.owner_id,
        account_id:          row.account_id,
        name:                row.name,
        value:               parseFloat(row.value),
        stage:               row.stage,
        stage_type:          row.stage_type || null,
        health:              row.health,
        expected_close_date: row.expected_close_date,
        probability:         row.probability,
        notes:               row.notes,
        created_at:          row.created_at,
        updated_at:          row.updated_at,
        account: row.account_name ? {
          id:     row.account_id,
          name:   row.account_name,
          domain: row.account_domain
        } : null,
        owner:      { first_name: row.owner_first_name, last_name: row.owner_last_name },
        contacts:   row.contacts || [],
        playbook_id: row.playbook_id || null
      }))
    });
  } catch (error) {
    console.error('Get deals error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch deals' } });
  }
});

// ── GET /pipeline/summary ─────────────────────────────────────
router.get('/pipeline/summary', async (req, res) => {
  try {
    const { scope = 'mine' } = req.query;

    let ownerFilter;
    const params = [req.orgId];

    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      ownerFilter = `AND d.owner_id = ANY($${params.length + 1}::int[])`;
      params.push(teamIds);
    } else if (scope === 'org') {
      ownerFilter = '';
    } else {
      ownerFilter = `AND d.owner_id = $${params.length + 1}`;
      params.push(req.user.userId);
    }

    const result = await db.query(
      `SELECT
         d.stage,
         ds.name       AS stage_name,
         ds.sort_order AS stage_order,
         ds.stage_type,
         ds.is_terminal,
         COUNT(d.id)   AS count,
         SUM(d.value)  AS total_value
       FROM deals d
       LEFT JOIN pipeline_stages ds
         ON ds.org_id = d.org_id AND ds.pipeline = 'sales' AND ds.key = d.stage
       WHERE d.org_id   = $1
         ${ownerFilter}
         AND (ds.is_terminal = FALSE OR ds.is_terminal IS NULL)
       GROUP BY d.stage, ds.name, ds.sort_order, ds.stage_type, ds.is_terminal
       ORDER BY COALESCE(ds.sort_order, 999) ASC`,
      params
    );

    res.json({
      pipeline: result.rows.map(row => ({
        stage:      row.stage,
        stageName:  row.stage_name  || row.stage,
        stageType:  row.stage_type  || 'custom',
        sortOrder:  parseInt(row.stage_order) || 0,
        count:      parseInt(row.count),
        totalValue: parseFloat(row.total_value) || 0,
      }))
    });
  } catch (error) {
    console.error('Get pipeline summary error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch pipeline summary' } });
  }
});

// ── GET /:id ──────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const dealQuery = await db.query(
      `SELECT
         d.*,
         acc.name     as account_name,
         acc.domain   as account_domain,
         acc.industry as account_industry,
         acc.size     as account_size,
         u.first_name as owner_first_name,
         u.last_name  as owner_last_name
       FROM deals d
       LEFT JOIN accounts acc ON d.account_id = acc.id
       LEFT JOIN users u      ON d.owner_id   = u.id
       WHERE d.id = $1 AND d.org_id = $2 AND d.owner_id = $3`,
      [req.params.id, req.orgId, req.user.userId]
    );

    if (dealQuery.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal not found' } });
    }

    const deal = dealQuery.rows[0];

    const [contactsQuery, activitiesQuery] = await Promise.all([
      db.query(
        `SELECT c.*, dc.role
         FROM contacts c
         JOIN deal_contacts dc ON c.id = dc.contact_id
         WHERE dc.deal_id = $1`,
        [req.params.id]
      ),
      db.query(
        `SELECT * FROM deal_activities
         WHERE deal_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [req.params.id]
      ),
    ]);

    res.json({
      deal: {
        id:                  deal.id,
        user_id:             deal.owner_id,
        account_id:          deal.account_id,
        name:                deal.name,
        value:               parseFloat(deal.value),
        stage:               deal.stage,
        stage_type:          deal.stage_type || null,
        health:              deal.health,
        expected_close_date: deal.expected_close_date,
        probability:         deal.probability,
        notes:               deal.notes,
        created_at:          deal.created_at,
        updated_at:          deal.updated_at,
        account: deal.account_name ? {
          id:       deal.account_id,
          name:     deal.account_name,
          domain:   deal.account_domain,
          industry: deal.account_industry,
          size:     deal.account_size
        } : null,
        owner:       { first_name: deal.owner_first_name, last_name: deal.owner_last_name },
        contacts:    contactsQuery.rows,
        activities:  activitiesQuery.rows,
        playbook_id: deal.playbook_id || null
      }
    });
  } catch (error) {
    console.error('Get deal error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch deal' } });
  }
});

// ── GET /:id/playbook-guide ─────────────────────────────────
router.get('/:id/playbook-guide', async (req, res) => {
  try {
    const dealResult = await db.query(
      `SELECT d.stage, d.playbook_id, p.name AS playbook_name, p.type AS playbook_type,
              p.stage_guidance, p.content
       FROM deals d
       LEFT JOIN playbooks p ON d.playbook_id = p.id
       WHERE d.id = $1 AND d.org_id = $2`,
      [req.params.id, req.orgId]
    );

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal not found' } });
    }

    const deal = dealResult.rows[0];
    if (!deal.playbook_id) {
      return res.json({ guide: null, message: 'No playbook assigned to this deal' });
    }

    const stageKey = deal.stage;
    const stageGuidance = deal.stage_guidance?.[stageKey] || null;
    const company = deal.content?.company || null;

    res.json({
      guide: {
        playbook: {
          id:   deal.playbook_id,
          name: deal.playbook_name,
          type: deal.playbook_type,
        },
        stage: stageKey,
        guidance: stageGuidance,
        company,
      }
    });
  } catch (error) {
    console.error('Get playbook guide error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch playbook guide' } });
  }
});

// ── POST / ────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { accountId, name, value, stage, health, expectedCloseDate, probability, notes, playbookId } = req.body;

    let resolvedStage;
    if (stage) {
      await validateStage(req.orgId, stage);
      resolvedStage = stage;
    } else {
      resolvedStage = await resolveDefaultStage(req.orgId);
    }

    let resolvedPlaybookId = playbookId || null;
    if (!resolvedPlaybookId) {
      const defaultPb = await db.query(
        `SELECT id FROM playbooks WHERE org_id = $1 AND is_default = TRUE LIMIT 1`,
        [req.orgId]
      );
      resolvedPlaybookId = defaultPb.rows[0]?.id || null;
    }

    const result = await db.query(
      `INSERT INTO deals
         (org_id, account_id, owner_id, name, value, stage, health,
          expected_close_date, original_close_date, probability, notes, playbook_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11)
       RETURNING *`,
      [req.orgId, accountId, req.user.userId, name, value,
       resolvedStage, health || 'healthy',
       expectedCloseDate, probability || 50, notes, resolvedPlaybookId]
    );

    const newDeal = result.rows[0];

    await db.query(
      `INSERT INTO deal_activities (deal_id, user_id, activity_type, description)
       VALUES ($1, $2, 'deal_created', 'Deal created')`,
      [newDeal.id, req.user.userId]
    );

    ActionsGenerator.generateForDeal(newDeal.id).catch(err =>
      console.error('Error auto-generating actions for new deal:', err)
    );

    res.status(201).json({ deal: newDeal });
  } catch (error) {
    console.error('Create deal error:', error);
    if (error.message?.includes('Invalid stage') || error.message?.includes('inactive')) {
      return res.status(400).json({ error: { message: error.message } });
    }
    res.status(500).json({ error: { message: 'Failed to create deal' } });
  }
});

// ── POST /bulk ───────────────────────────────────────────────────────────────
router.post('/bulk', async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: { message: 'rows array is required' } });
    }

    const MAX_ROWS = 500;
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ error: { message: `Maximum ${MAX_ROWS} rows per import` } });
    }

    const defaultStage = await resolveDefaultStage(req.orgId);
    const defaultPbRes = await db.query(
      `SELECT id FROM playbooks WHERE org_id = $1 AND is_default = TRUE LIMIT 1`,
      [req.orgId]
    );
    const defaultPlaybookId = defaultPbRes.rows[0]?.id || null;

    const imported = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;
      try {
        if (!row.name?.trim()) {
          errors.push({ row: rowNum, message: 'Deal name is required' });
          continue;
        }
        const value = parseFloat(String(row.value || '0').replace(/[$,]/g, ''));
        if (isNaN(value)) {
          errors.push({ row: rowNum, message: `Invalid deal value: ${row.value}` });
          continue;
        }

        let resolvedStage = defaultStage;
        if (row.stage) {
          try {
            await validateStage(req.orgId, row.stage);
            resolvedStage = row.stage;
          } catch {
            // use default if validation fails
          }
        }

        const result = await db.query(
          `INSERT INTO deals
             (org_id, account_id, owner_id, name, value, stage, health,
              expected_close_date, original_close_date, probability, notes, playbook_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11)
           RETURNING *`,
          [req.orgId, row.accountId || null, req.user.userId,
           row.name.trim(), value, resolvedStage, row.health || 'healthy',
           row.expectedCloseDate || null,
           row.probability ? parseInt(row.probability) : 50,
           row.notes || null, defaultPlaybookId]
        );
        imported.push(result.rows[0]);
      } catch (err) {
        errors.push({ row: rowNum, message: err.message });
      }
    }

    console.log(`📥 Bulk deal import: ${imported.length} imported, ${errors.length} errors (org ${req.orgId})`);
    res.json({ imported: imported.length, deals: imported, errors });
  } catch (error) {
    console.error('Bulk deal import error:', error);
    res.status(500).json({ error: { message: 'Failed to bulk import deals' } });
  }
});

// ── PUT /:id ──────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { name, value, stage, health, expectedCloseDate, probability, notes, playbookId } = req.body;

    if (stage) {
      await validateStage(req.orgId, stage);
    }

    const currentDeal = await db.query(
      'SELECT stage, value, expected_close_date, close_date_push_count, original_close_date FROM deals WHERE id = $1 AND org_id = $2 AND owner_id = $3',
      [req.params.id, req.orgId, req.user.userId]
    );

    if (currentDeal.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal not found' } });
    }

    const current = currentDeal.rows[0];

    let closeDatePushIncrement = 0;
    if (expectedCloseDate && current.expected_close_date) {
      if (new Date(expectedCloseDate) > new Date(current.expected_close_date)) {
        closeDatePushIncrement = 1;
      }
    }

    const isClosingStage = async (stageKey) => {
      try {
        const r = await db.query(
          'SELECT is_terminal FROM pipeline_stages WHERE org_id = $1 AND pipeline = $2 AND key = $3',
          [req.orgId, 'sales', stageKey]
        );
        return r.rows[0]?.is_terminal === true;
      } catch {
        return ['closed_won', 'closed_lost'].includes(stageKey);
      }
    };
    const willClose = stage ? await isClosingStage(stage) : false;

    const result = await db.query(
      `UPDATE deals
       SET name                = COALESCE($1, name),
           value               = COALESCE($2, value),
           stage               = COALESCE($3, stage),
           health              = COALESCE($4, health),
           expected_close_date = COALESCE($5, expected_close_date),
           probability         = COALESCE($6, probability),
           notes               = COALESCE($7, notes),
           playbook_id         = COALESCE($12, playbook_id),
           close_date_push_count = close_date_push_count + $10,
           updated_at          = CURRENT_TIMESTAMP,
           closed_at           = CASE WHEN $13 THEN CURRENT_TIMESTAMP ELSE closed_at END
       WHERE id = $8 AND org_id = $9 AND owner_id = $11
       RETURNING *`,
      [name, value, stage, health, expectedCloseDate, probability, notes,
       req.params.id, req.orgId, closeDatePushIncrement, req.user.userId,
       playbookId || null, willClose]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal not found' } });
    }

    if (stage && stage !== current.stage) {
      await db.query(
        `INSERT INTO deal_activities (deal_id, user_id, activity_type, description)
         VALUES ($1, $2, 'stage_change', $3)`,
        [req.params.id, req.user.userId, `Stage changed from ${current.stage} to ${stage}`]
      );

      try {
        const config = await ActionConfigService.getConfig(req.user.userId, req.orgId);
        if (config.generate_on_stage_change) {
          await ActionsGenerator.generateForStageChange(req.params.id, stage, req.user.userId);
          console.log(`📘 Generated playbook actions for stage: ${stage}`);
        }
      } catch (err) {
        console.error('Error generating playbook actions on stage change:', err);
      }

      try {
        if (willClose) {
          const stageRow = await db.query(
            `SELECT stage_type FROM pipeline_stages WHERE org_id = $1 AND pipeline = 'sales' AND key = $2 LIMIT 1`,
            [req.orgId, stage]
          );
          const isWonStage =
            stageRow.rows[0]?.stage_type === 'won' ||
            stage === 'closed_won';

          if (isWonStage) {
            const { handover, created, warnings } = await HandoverService.initiate(
              parseInt(req.params.id),
              req.orgId,
              req.user.userId
            );
            if (created) {
              console.log(`🤝 Handover created for deal ${req.params.id} (handover id: ${handover.id})`);
            }
            if (warnings.length > 0) {
              console.warn('Handover initiation warnings:', warnings);
            }
          }
        }
      } catch (err) {
        console.error('Error initiating handover on won stage:', err);
      }
    }

    if (closeDatePushIncrement > 0) {
      await db.query(
        `INSERT INTO deal_activities (deal_id, user_id, activity_type, description)
         VALUES ($1, $2, 'close_date_pushed', $3)`,
        [req.params.id, req.user.userId,
         `Close date pushed from ${new Date(current.expected_close_date).toLocaleDateString()} to ${new Date(expectedCloseDate).toLocaleDateString()} (push #${(current.close_date_push_count || 0) + 1})`]
      );
    }

    if (value !== undefined && value !== null && parseFloat(value) !== parseFloat(current.value)) {
      await db.query(
        `INSERT INTO deal_value_history (deal_id, user_id, old_value, new_value)
         VALUES ($1, $2, $3, $4)`,
        [req.params.id, req.user.userId, current.value, value]
      );
    }

    ActionsGenerator.generateForDeal(req.params.id).catch(err =>
      console.error('Error auto-generating actions for updated deal:', err)
    );

    res.json({ deal: result.rows[0] });
  } catch (error) {
    console.error('Update deal error:', error);
    if (error.message?.includes('Invalid stage') || error.message?.includes('inactive')) {
      return res.status(400).json({ error: { message: error.message } });
    }
    res.status(500).json({ error: { message: 'Failed to update deal' } });
  }
});

// ── DELETE /:id ───────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM deals WHERE id = $1 AND org_id = $2 AND owner_id = $3 RETURNING id',
      [req.params.id, req.orgId, req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal not found' } });
    }
    res.json({ message: 'Deal deleted successfully' });
  } catch (error) {
    console.error('Delete deal error:', error);
    res.status(500).json({ error: { message: 'Failed to delete deal' } });
  }
});

// ── POST /:id/contacts ────────────────────────────────────────
router.post('/:id/contacts', async (req, res) => {
  try {
    const { contactId, role } = req.body;

    const check = await db.query(
      'SELECT id FROM deals WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal not found' } });
    }

    await db.query(
      'INSERT INTO deal_contacts (deal_id, contact_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [req.params.id, contactId, role || 'secondary']
    );

    await db.query(
      `INSERT INTO deal_activities (deal_id, user_id, activity_type, description)
       VALUES ($1, $2, 'contact_added', 'Contact added to deal')`,
      [req.params.id, req.user.userId]
    );

    res.status(201).json({ message: 'Contact added to deal' });
  } catch (error) {
    console.error('Add contact to deal error:', error);
    res.status(500).json({ error: { message: 'Failed to add contact' } });
  }
});

// ── PATCH /:id/signal-override ────────────────────────────────
router.patch('/:id/signal-override', async (req, res) => {
  try {
    const { signalKey, value, managerOverride } = req.body;

    const OVERRIDEABLE_SIGNALS = [
      'close_date_user_confirmed',
      'buyer_event_user_confirmed',
      'legal_engaged_user',
      'security_review_user',
      'scope_approved_user',
      'competitive_deal_user',
      'price_sensitivity_user',
      'discount_pending_user',
    ];

    if (!OVERRIDEABLE_SIGNALS.includes(signalKey)) {
      return res.status(400).json({ error: { message: `Invalid signal key: ${signalKey}` } });
    }

    const checkResult = await db.query(
      'SELECT id, signal_overrides FROM deals WHERE id = $1 AND org_id = $2 AND owner_id = $3',
      [req.params.id, req.orgId, req.user.userId]
    );
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal not found' } });
    }

    const currentOverrides = checkResult.rows[0].signal_overrides || {};
    const updatedOverrides = {
      ...currentOverrides,
      [signalKey]: {
        overridden_by:    req.user.userId,
        overridden_at:    new Date().toISOString(),
        manager_override: !!managerOverride,
      },
    };

    const result = await db.query(
      `UPDATE deals
       SET ${signalKey}       = $1,
           signal_overrides   = $2,
           updated_at         = CURRENT_TIMESTAMP
       WHERE id = $3 AND org_id = $4 AND owner_id = $5
       RETURNING id, ${signalKey} AS signal_value, signal_overrides, health, health_score`,
      [value, JSON.stringify(updatedOverrides), req.params.id, req.orgId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal not found' } });
    }

    const row = result.rows[0];
    res.json({
      dealId:          parseInt(req.params.id),
      signalKey,
      value:           row.signal_value,
      signalOverrides: row.signal_overrides,
    });
  } catch (error) {
    console.error('Signal override error:', error);
    res.status(500).json({ error: { message: 'Failed to update signal override' } });
  }
});

// ── POST /:id/generate-actions ────────────────────────────────────────────────
// Generate actions from the deal's playbook for the current (or specified) stage.
//
// Body: {
//   stageKey?:    string,              — defaults to deal's current stage
//   mode?:        'template' | 'ai',   — defaults to 'template'
//   deduplicate?: boolean,             — skip plays already actioned (default true)
// }
router.post('/:id/generate-actions', async (req, res) => {
  try {
    const dealId = parseInt(req.params.id);
    const userId = req.user.userId;
    const orgId  = req.orgId;
    const { mode = 'template', deduplicate = true } = req.body;

    // Validate deal belongs to org
    const dealRes = await db.query(
      'SELECT * FROM deals WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
      [dealId, orgId]
    );
    if (dealRes.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal not found' } });
    }
    const deal     = dealRes.rows[0];
    const stageKey = req.body.stageKey || deal.stage;

    if (!stageKey) {
      return res.status(400).json({ error: { message: 'Deal has no stage assigned' } });
    }

    // Build full context (fixes broken PlaybookService calls, loads playbook correctly)
    const context = await DealContextBuilder.build(dealId, userId, orgId);

    // Generate action rows (template or AI)
    const { actions, playbookId, playbookName, mode: effectiveMode } =
      await PlaybookActionGenerator.generate({
        entityType: 'deal',
        context,
        playbookId: context.playbookId || deal.playbook_id || null,
        stageKey,
        mode,
        orgId,
        userId,
      });

    if (actions.length === 0) {
      return res.json({
        inserted: 0, skipped: 0,
        playbookName: playbookName || null,
        mode: effectiveMode,
        message: playbookName
          ? `No plays defined for stage "${stageKey}" in "${playbookName}"`
          : 'No playbook found for this deal',
      });
    }

    // Persist to actions table
    const result = await ActionWriter.write({
      entityType:        'deal',
      entityId:          dealId,
      actions,
      playbookId,
      playbookName,
      orgId,
      userId,
      deduplicateSource: deduplicate ? 'playbook' : null,
    });

    res.json({
      inserted:     result.inserted,
      skipped:      result.skipped,
      playbookName: playbookName || null,
      mode:         effectiveMode,
      message:      `Generated ${result.inserted} action(s) from "${playbookName || 'playbook'}"`,
    });

  } catch (err) {
    console.error('generate-actions (deal) error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
