// contractApprovalService.js
// Internal approval track — independent of legal review.

const { pool, withOrgTransaction } = require('../config/database');

async function getApprovalConfig(orgId) {
  const r = await pool.query(
    `SELECT cac.*, u.first_name, u.last_name, u.email
     FROM contract_approval_config cac
     LEFT JOIN users u ON u.id = cac.approver_user_id
     WHERE cac.org_id=$1 ORDER BY cac.step_order ASC`, [orgId]
  );
  return r.rows.map(row => ({
    id:             row.id,
    contractType:   row.contract_type,
    valueThreshold: row.value_threshold ? parseFloat(row.value_threshold) : null,
    approverRole:   row.approver_role,
    approverUserId: row.approver_user_id,
    approverName:   row.first_name ? `${row.first_name} ${row.last_name}` : null,
    stepOrder:      row.step_order,
    isRequired:     row.is_required,
  }));
}

async function saveApprovalConfig(orgId, rules) {
  return withOrgTransaction(orgId, async (client) => {
    await client.query(`DELETE FROM contract_approval_config WHERE org_id=$1`, [orgId]);
    for (const rule of rules) {
      await client.query(
        `INSERT INTO contract_approval_config
           (org_id,contract_type,value_threshold,approver_role,approver_user_id,step_order,is_required)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orgId, rule.contractType||'*', rule.valueThreshold||null, rule.approverRole,
         rule.approverUserId||null, rule.stepOrder||1, rule.isRequired !== false]
      );
    }
  });
}

async function resolveApproverIds(orgId, rule, ownerId) {
  switch (rule.approver_role) {
    case 'specific_user':
      return rule.approver_user_id ? [rule.approver_user_id] : [];
    case 'reporting_manager': {
      const r = await pool.query(
        `SELECT manager_id FROM org_hierarchy WHERE user_id=$1 AND org_id=$2`, [ownerId, orgId]
      );
      return r.rows[0]?.manager_id ? [r.rows[0].manager_id] : [];
    }
    case 'legal_team': {
      const r = await pool.query(
        `SELECT DISTINCT tm.user_id FROM team_memberships tm
         JOIN teams t ON t.id=tm.team_id WHERE t.org_id=$1 AND t.dimension='legal'`, [orgId]
      );
      return r.rows.map(x => x.user_id);
    }
    case 'finance_team': {
      const r = await pool.query(
        `SELECT DISTINCT tm.user_id FROM team_memberships tm
         JOIN teams t ON t.id=tm.team_id WHERE t.org_id=$1 AND t.dimension='finance'`, [orgId]
      );
      return r.rows.map(x => x.user_id);
    }
    default: return [];
  }
}

async function startApprovalChain(orgId, contractId, userId) {
  return withOrgTransaction(orgId, async (client) => {
    const cr = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`, [contractId, orgId]
    );
    if (!cr.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    const contract = cr.rows[0];

    if (contract.internal_approval_status === 'pending') {
      const e = new Error('Approval chain already in progress'); e.status = 400; throw e;
    }
    if (contract.internal_approval_status === 'approved') {
      const e = new Error('Already approved'); e.status = 400; throw e;
    }

    const cfgRes = await client.query(
      `SELECT * FROM contract_approval_config
       WHERE org_id=$1 AND (contract_type=$2 OR contract_type='*')
         AND (value_threshold IS NULL OR value_threshold <= $3)
       ORDER BY step_order ASC`,
      [orgId, contract.contract_type, contract.value || 0]
    );

    if (!cfgRes.rows.length) {
      // No rules — auto-approve
      await client.query(
        `UPDATE contracts SET internal_approval_status='approved' WHERE id=$1 AND org_id=$2`,
        [contractId, orgId]
      );
      await client.query(
        `INSERT INTO contract_events (contract_id,org_id,event_type,actor_id,payload)
         VALUES ($1,$2,'internal_approval_auto_approved',$3,'{}')`, [contractId, orgId, userId]
      );
      return { autoApproved: true, approvers: [] };
    }

    // Cancel any prior approvals
    await client.query(
      `UPDATE contract_approvals SET status='cancelled' WHERE contract_id=$1 AND org_id=$2`,
      [contractId, orgId]
    );

    const inserted = [];
    for (const rule of cfgRes.rows) {
      const ids = await resolveApproverIds(orgId, rule, contract.owner_id);
      for (const uid of ids) {
        const r = await client.query(
          `INSERT INTO contract_approvals
             (contract_id,org_id,step_order,approver_user_id,approver_role,status,is_required)
           VALUES ($1,$2,$3,$4,$5,'pending',$6) RETURNING *`,
          [contractId, orgId, rule.step_order, uid, rule.approver_role, rule.is_required]
        );
        inserted.push(r.rows[0]);
      }
    }

    await client.query(
      `UPDATE contracts SET internal_approval_status='pending' WHERE id=$1 AND org_id=$2`,
      [contractId, orgId]
    );
    await client.query(
      `INSERT INTO contract_events (contract_id,org_id,event_type,actor_id,payload)
       VALUES ($1,$2,'internal_approval_started',$3,$4)`,
      [contractId, orgId, userId, JSON.stringify({ approverCount: inserted.length })]
    );

    const firstStep = Math.min(...inserted.map(r => r.step_order));
    return { autoApproved: false, approvers: inserted.filter(r => r.step_order === firstStep) };
  });
}

async function processDecision(orgId, approvalId, userId, decision, note) {
  return withOrgTransaction(orgId, async (client) => {
    const ar = await client.query(
      `SELECT ca.*, c.owner_id FROM contract_approvals ca
       JOIN contracts c ON c.id=ca.contract_id
       WHERE ca.id=$1 AND ca.org_id=$2 FOR UPDATE`, [approvalId, orgId]
    );
    if (!ar.rows[0]) { const e = new Error('Approval not found'); e.status = 404; throw e; }
    const a = ar.rows[0];

    if (a.approver_user_id !== parseInt(userId, 10)) {
      const e = new Error('Not your approval'); e.status = 403; throw e;
    }
    if (a.status !== 'pending') {
      const e = new Error('Already decided'); e.status = 400; throw e;
    }

    await client.query(
      `UPDATE contract_approvals SET status=$3, decision_note=$4, decided_at=NOW()
       WHERE id=$1 AND org_id=$2`, [approvalId, orgId, decision, note||null]
    );
    await client.query(
      `INSERT INTO contract_events (contract_id,org_id,event_type,actor_id,payload)
       VALUES ($1,$2,$3,$4,$5)`,
      [a.contract_id, orgId,
       decision === 'approved' ? 'internal_approval_step_approved' : 'internal_approval_rejected',
       userId, JSON.stringify({ approvalId, stepOrder: a.step_order, note })]
    );

    if (decision === 'rejected' && a.is_required) {
      await client.query(
        `UPDATE contracts SET internal_approval_status='rejected' WHERE id=$1 AND org_id=$2`,
        [a.contract_id, orgId]
      );
      await client.query(
        `UPDATE contract_approvals SET status='cancelled'
         WHERE contract_id=$1 AND org_id=$2 AND status='pending' AND id!=$3`,
        [a.contract_id, orgId, approvalId]
      );
      return { outcome: 'rejected', contractId: a.contract_id, ownerId: a.owner_id };
    }

    const remaining = await client.query(
      `SELECT * FROM contract_approvals
       WHERE contract_id=$1 AND org_id=$2 AND status='pending' AND is_required=TRUE`,
      [a.contract_id, orgId]
    );

    if (!remaining.rows.length) {
      await client.query(
        `UPDATE contracts SET internal_approval_status='approved' WHERE id=$1 AND org_id=$2`,
        [a.contract_id, orgId]
      );
      await client.query(
        `INSERT INTO contract_events (contract_id,org_id,event_type,actor_id,payload)
         VALUES ($1,$2,'internal_fully_approved',$3,'{}')`, [a.contract_id, orgId, userId]
      );
      return { outcome: 'all_approved', contractId: a.contract_id, ownerId: a.owner_id };
    }

    const nextStep = Math.min(...remaining.rows.map(r => r.step_order));
    const nextIds  = remaining.rows.filter(r => r.step_order === nextStep).map(r => r.approver_user_id);
    return { outcome: 'step_approved', contractId: a.contract_id, ownerId: a.owner_id, nextApproverIds: nextIds };
  });
}

async function getPendingApprovals(orgId, userId) {
  const r = await pool.query(
    `SELECT ca.*, c.title, c.contract_type, c.status AS contract_status,
            c.value, c.currency, c.owner_id,
            u.first_name AS owner_first_name, u.last_name AS owner_last_name
     FROM contract_approvals ca
     JOIN contracts c ON c.id=ca.contract_id
     LEFT JOIN users u ON u.id=c.owner_id
     WHERE ca.org_id=$1 AND ca.approver_user_id=$2 AND ca.status='pending'
       AND c.deleted_at IS NULL ORDER BY ca.created_at ASC`, [orgId, userId]
  );
  return r.rows;
}

module.exports = {
  getApprovalConfig, saveApprovalConfig,
  startApprovalChain, processDecision, getPendingApprovals,
};
