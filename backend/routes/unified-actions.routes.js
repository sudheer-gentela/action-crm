const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');

router.use(authenticateToken);
router.use(orgContext);

// ── GET /api/actions/unified ─────────────────────────────────────────────────
// Returns combined deal + prospecting actions for the unified Actions view.
// Supports ?source=all|deals|prospecting, ?scope=mine|team|org
router.get('/unified', async (req, res) => {
  try {
    const { scope = 'mine', source = 'all' } = req.query;

    // Build owner filter
    let ownerFilter = '';
    const params = [req.orgId];

    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      params.push(teamIds);
      ownerFilter = `AND user_id = ANY($${params.length}::int[])`;
    } else if (scope === 'org') {
      ownerFilter = '';
    } else {
      params.push(req.user.userId);
      ownerFilter = `AND user_id = $${params.length}`;
    }

    const results = { dealActions: [], prospectingActions: [] };

    // Fetch deal actions
    if (source === 'all' || source === 'deals') {
      const dealActionsRes = await db.query(
        `SELECT a.*, d.name AS deal_name, d.stage AS deal_stage, d.value AS deal_value,
                acc.name AS account_name
         FROM actions a
         LEFT JOIN deals d ON a.deal_id = d.id
         LEFT JOIN accounts acc ON d.account_id = acc.id
         WHERE a.org_id = $1 ${ownerFilter}
           AND a.status IN ('pending','in_progress','snoozed')
         ORDER BY
           CASE a.status WHEN 'pending' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'snoozed' THEN 3 ELSE 4 END,
           CASE a.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
           a.due_date ASC NULLS LAST`,
        params
      );

      results.dealActions = dealActionsRes.rows.map(row => ({
        ...row,
        actionSource: 'deal',
        deal: row.deal_id ? {
          id:    row.deal_id,
          name:  row.deal_name,
          stage: row.deal_stage,
          value: row.deal_value,
        } : null,
        account: row.account_name ? { name: row.account_name } : null,
      }));
    }

    // Fetch prospecting actions
    if (source === 'all' || source === 'prospecting') {
      const pActionsRes = await db.query(
        `SELECT pa.*,
                p.first_name AS prospect_first_name,
                p.last_name  AS prospect_last_name,
                p.email      AS prospect_email,
                p.company_name AS prospect_company_name,
                p.stage      AS prospect_stage
         FROM prospecting_actions pa
         LEFT JOIN prospects p ON pa.prospect_id = p.id
         WHERE pa.org_id = $1 ${ownerFilter}
           AND pa.status IN ('pending','in_progress','snoozed')
         ORDER BY
           CASE pa.status WHEN 'pending' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'snoozed' THEN 3 ELSE 4 END,
           CASE pa.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
           pa.due_date ASC NULLS LAST`,
        params
      );

      results.prospectingActions = pActionsRes.rows.map(row => ({
        ...row,
        actionSource: 'prospecting',
        prospect: row.prospect_id ? {
          id:          row.prospect_id,
          firstName:   row.prospect_first_name,
          lastName:    row.prospect_last_name,
          email:       row.prospect_email,
          companyName: row.prospect_company_name,
          stage:       row.prospect_stage,
        } : null,
      }));
    }

    // Merge and sort for unified view
    const allActions = [
      ...results.dealActions,
      ...results.prospectingActions,
    ].sort((a, b) => {
      // Priority sort first
      const priorityOrder = { critical: 1, high: 2, medium: 3, low: 4 };
      const pa = priorityOrder[a.priority] || 99;
      const pb = priorityOrder[b.priority] || 99;
      if (pa !== pb) return pa - pb;

      // Then by due date
      const da = a.due_date ? new Date(a.due_date) : new Date('2099-01-01');
      const db2 = b.due_date ? new Date(b.due_date) : new Date('2099-01-01');
      return da - db2;
    });

    res.json({
      actions: allActions,
      counts: {
        total:        allActions.length,
        deals:        results.dealActions.length,
        prospecting:  results.prospectingActions.length,
      },
    });
  } catch (error) {
    console.error('Unified actions error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch unified actions' } });
  }
});

module.exports = router;
