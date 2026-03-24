/**
 * ContractActionsGenerator.js
 *
 * Generates auto actions for contracts based on CLM playbook plays.
 * Actions are assigned to users based on playbook_play_roles, resolved
 * against the contract's owner_id, legal_assignee_id, and deal team.
 *
 * Role resolution (per playbook_play_roles → org_roles.key):
 *   account_executive → contracts.owner_id
 *   legal             → contracts.legal_assignee_id
 *                        (skipped if no legal assignee set)
 *   sales_manager     → deal_team_members for the contract's linked deal,
 *                        falls back to owner_id if not staffed
 *   any other key     → owner_id as fallback
 *
 * One action row is inserted per (play × assignee). So:
 *   clm_expiring_soon_urgent  → 2 actions: AE + sales_manager
 *   clm_in_review_with_legal  → 2 actions: legal person + AE
 *   all others                → 1 action:  AE only
 */

const db             = require('../config/database');
const { resolveChannel, evaluateConditions } = require('./playbook.service');
const { resolveForPlay } = require('./PlayRouteResolver');

// ROLE_STRATEGY map has been removed — role resolution now delegated to PlayRouteResolver.

// ── Load CLM plays WITH their role assignments ────────────────────────────────

async function loadCLMPlaysWithRoles(orgId) {
  try {
    const result = await db.query(
      `SELECT pp.id, pp.stage_key, pp.title, pp.description,
              pp.channel, pp.priority, pp.due_offset_days,
              pp.execution_type, pp.sort_order,
              COALESCE(
                json_agg(
                  json_build_object(
                    'role_id',        ppr.role_id,
                    'role_key',       dr.key,
                    'ownership_type', ppr.ownership_type
                  )
                ) FILTER (WHERE ppr.id IS NOT NULL),
                '[]'
              ) AS roles
       FROM playbook_plays pp
       JOIN playbooks pb ON pb.id = pp.playbook_id
       LEFT JOIN playbook_play_roles ppr ON ppr.play_id = pp.id
       LEFT JOIN org_roles dr ON dr.id = ppr.role_id
       WHERE pb.org_id      = $1
         AND pb.type        = 'clm'
         AND pp.is_active   = TRUE
         AND pp.execution_type = 'auto'
         AND (pp.trigger_mode IS NULL OR pp.trigger_mode = 'scheduled')
       GROUP BY pp.id
       ORDER BY pp.sort_order ASC`,
      [orgId]
    );
    return result.rows.map(r => ({
      ...r,
      roles: typeof r.roles === 'string' ? JSON.parse(r.roles) : (r.roles || []),
    }));
  } catch (err) {
    console.error('loadCLMPlaysWithRoles error:', err.message);
    return [];
  }
}

// ── Schedule frequency check ──────────────────────────────────────────────────

function shouldFireScheduled(play) {
  const cfg = play.schedule_config || {};
  const frequency = cfg.frequency || 'daily';
  if (frequency === 'daily' || frequency === 'hourly') return true;
  if (frequency === 'weekly') {
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const configuredDay = (cfg.day || '').toLowerCase();
    return configuredDay === days[new Date().getDay()];
  }
  return true;
}

// ── Fire condition context builder ────────────────────────────────────────────

function buildFireContext(contract, renewalContractIds) {
  const ref = contract.status_changed_at || contract.updated_at || contract.created_at;
  const daysInStage = Math.floor((Date.now() - new Date(ref)) / 86400000);

  const expiryDate = contract.expiry_date || contract.end_date;
  const daysToExpiry = expiryDate
    ? Math.ceil((new Date(expiryDate) - Date.now()) / 86400000)
    : null;

  return {
    contractStatus:   contract.status,
    reviewSubStatus:  contract.review_sub_status || null,
    daysInStage,
    daysToExpiry,
    hasRenewal:       renewalContractIds.has(contract.id),
  };
}

// ── Template interpolation ────────────────────────────────────────────────────

function interpolate(template, vars) {
  return (template || '').replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] !== undefined ? vars[key] : `{{${key}}}`
  );
}

function buildVars(play, contract, fireContext) {
  return {
    days_in_status:    fireContext.daysInStage,
    days_to_expiry:    fireContext.daysToExpiry ?? 'unknown',
    days_since_expiry: contract.status === 'expired'
      ? Math.floor((Date.now() - new Date(contract.expiry_date || contract.end_date || contract.updated_at)) / 86400000)
      : 0,
    contract_title: contract.title || `Contract #${contract.id}`,
    contract_type:  contract.contract_type || 'contract',
  };
}

// ── Insert one action row ─────────────────────────────────────────────────────

async function insertCLMAction(orgId, userId, contract, play, title, description) {
  const actionType = resolveChannel(play.channel).action_type;
  const dueDate    = new Date(Date.now() + 2 * 86400000);

  await db.query(
    `INSERT INTO actions (
       org_id, user_id, type, title, description, action_type,
       priority, due_date, contract_id, deal_id, account_id,
       source, source_rule, is_internal, next_step, deal_stage,
       status, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $3,
       $6, $7, $8, $9, $10,
       'auto_generated', $11, FALSE, $12, 'clm',
       'yet_to_start', NOW()
     )`,
    [
      orgId, userId, actionType, title, description,
      play.priority || 'medium', dueDate,
      contract.id, contract.deal_id || null, contract.account_id || null,
      `clm_${play.stage_key}`, play.channel || 'email',
    ]
  );
}

// ── Process one play for one contract ─────────────────────────────────────────

async function processPlayForContract(orgId, contract, play, renewalContractIds) {
  if (!shouldFireScheduled(play)) return 0;

  const fireContext = buildFireContext(contract, renewalContractIds);
  const conditions  = Array.isArray(play.fire_conditions) ? play.fire_conditions : [];
  if (!evaluateConditions(conditions, fireContext)) return 0;

  const vars        = buildVars(play, contract, fireContext);
  const title       = interpolate(play.title, vars);
  const description = interpolate(play.description, vars);
  let   inserted    = 0;

  const roles = Array.isArray(play.roles) ? play.roles : [];

  // No roles defined → fall back to owner via resolver
  if (roles.length === 0) {
    const userIds = await resolveForPlay({
      orgId,
      roleKey:      null,
      roleId:       null,
      entity:       contract,
      entityType:   'contract',
      callerUserId: contract.owner_id,
    });
    const userId = userIds[0];
    if (!userId) return 0;
    try {
      await insertCLMAction(orgId, userId, contract, play, title, description);
      return 1;
    } catch (err) {
      console.error(`  ❌ CLM insert (no-role) contract ${contract.id}:`, err.message);
      return 0;
    }
  }

  // One action per unique resolved user across all roles
  const seenUserIds = new Set();

  for (const role of roles) {
    const userIds = await resolveForPlay({
      orgId,
      roleKey:      role.role_key || null,
      roleId:       role.role_id  || null,
      entity:       contract,
      entityType:   'contract',
      callerUserId: contract.owner_id,
    });

    for (const userId of userIds) {
      if (seenUserIds.has(userId)) continue;
      seenUserIds.add(userId);
      try {
        await insertCLMAction(orgId, userId, contract, play, title, description);
        inserted++;
      } catch (err) {
        console.error(`  ❌ CLM insert (role=${role.role_key}) contract ${contract.id}:`, err.message);
      }
    }
  }

  return inserted;
}

// ── Main class ────────────────────────────────────────────────────────────────

class ContractActionsGenerator {

  static async generateAll() {
    try {
      console.log('📄 ContractActionsGenerator — starting nightly CLM sweep...');

      const contractsRes = await db.query(`
        SELECT * FROM contracts
        WHERE deleted_at IS NULL
          AND status NOT IN ('void', 'terminated', 'cancelled')
      `);

      const contracts = contractsRes.rows;
      if (contracts.length === 0) {
        console.log('📄 No active contracts — skipping.');
        return { success: true, generated: 0, inserted: 0 };
      }

      const childRes = await db.query(
        `SELECT DISTINCT parent_contract_id FROM contracts
         WHERE parent_contract_id IS NOT NULL AND deleted_at IS NULL`
      );
      const renewalContractIds = new Set(childRes.rows.map(r => r.parent_contract_id));

      // Group by org — load plays once per org
      const byOrg = {};
      for (const c of contracts) {
        if (!c.org_id) continue;
        (byOrg[c.org_id] = byOrg[c.org_id] || []).push(c);
      }

      // Wipe all pending auto CLM actions — regenerate fresh
      await db.query(
        `DELETE FROM actions
         WHERE contract_id IS NOT NULL
           AND source = 'auto_generated'
           AND status IN ('yet_to_start', 'in_progress')`
      );

      let totalInserted = 0;

      for (const [orgId, orgContracts] of Object.entries(byOrg)) {
        const plays = await loadCLMPlaysWithRoles(parseInt(orgId));
        if (!plays.length) {
          console.warn(`⚠️  No CLM plays for org ${orgId} — skipping`);
          continue;
        }

        for (const contract of orgContracts) {
          for (const play of plays) {
            totalInserted += await processPlayForContract(
              parseInt(orgId), contract, play, renewalContractIds
            );
          }
        }
      }

      console.log(`✅ CLM sweep complete — inserted ${totalInserted} actions`);
      return { success: true, inserted: totalInserted };

    } catch (error) {
      console.error('❌ ContractActionsGenerator.generateAll:', error);
      return { success: false, error: error.message };
    }
  }

  static async generateForContract(contractId) {
    try {
      const contractRes = await db.query(
        `SELECT * FROM contracts WHERE id = $1 AND deleted_at IS NULL`,
        [contractId]
      );
      if (contractRes.rows.length === 0) return 0;

      const contract = contractRes.rows[0];
      const orgId    = contract.org_id;

      const childRes = await db.query(
        `SELECT DISTINCT parent_contract_id FROM contracts
         WHERE parent_contract_id IS NOT NULL AND deleted_at IS NULL`
      );
      const renewalContractIds = new Set(childRes.rows.map(r => r.parent_contract_id));

      await db.query(
        `DELETE FROM actions
         WHERE contract_id = $1
           AND source = 'auto_generated'
           AND status IN ('yet_to_start', 'in_progress')`,
        [contractId]
      );

      const plays = await loadCLMPlaysWithRoles(orgId);

      let inserted = 0;
      for (const play of plays) {
        inserted += await processPlayForContract(orgId, contract, play, renewalContractIds);
      }

      // ── AI Enhancement (optional, module-gated) ──────────────────────────
      try {
        const ActionConfigService = require('./actionConfig.service');
        const actionConfig = await ActionConfigService.getConfig(contract.owner_id, orgId);
        if (ActionConfigService.isAiEnabledForModule(actionConfig, 'clm')) {
          const CLMAIEnhancer = require('./CLMAIEnhancer');
          const aiInserted = await CLMAIEnhancer.enhance(contract, orgId, contract.owner_id);
          if (aiInserted > 0) {
            console.log(`  🤖 CLM AI: ${aiInserted} additional action(s) for contract ${contractId}`);
            inserted += aiInserted;
          }
        }
      } catch (aiErr) {
        console.error('CLM AI enhancement skipped (non-blocking):', aiErr.message);
      }

      console.log(`✅ Generated ${inserted} CLM actions for contract ${contractId}`);
      return inserted;

    } catch (error) {
      console.error('ContractActionsGenerator.generateForContract error:', error);
      return 0;
    }
  }
}

module.exports = ContractActionsGenerator;
