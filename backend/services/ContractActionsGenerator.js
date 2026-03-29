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
const ActionPersister    = require('./ActionPersister');

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

// ── Upsert one CLM diagnostic alert ──────────────────────────────────────────
// Replaces insertCLMAction — uses ActionPersister so created_at/status are
// preserved across nightly runs (no delete-then-insert).

async function upsertCLMAction(orgId, userId, contract, play, title, description) {
  const { action_type, next_step } = resolveChannel(play.channel);
  const dueDate = new Date(Date.now() + 2 * 86400000);
  const sourceRule = `clm_${play.stage_key}`;

  return ActionPersister.upsertDiagnosticAlert({
    entityType:      'contract',
    entityId:        contract.id,
    sourceRule,
    title,
    description,
    actionType:      action_type,
    priority:        play.priority || 'medium',
    dueDate,
    nextStep:        next_step || 'email',
    isInternal:      false,
    dealStage:       'clm',
    dealId:          contract.deal_id    || null,
    accountId:       contract.account_id || null,
    orgId,
    userId,
  });
}

// ── Process one play for one contract ─────────────────────────────────────────
// Returns { inserted, sourceRule } so caller can track which rules fired.

async function processPlayForContract(orgId, contract, play, renewalContractIds) {
  if (!shouldFireScheduled(play)) return { inserted: 0, sourceRule: null };

  const fireContext = buildFireContext(contract, renewalContractIds);
  const conditions  = Array.isArray(play.fire_conditions) ? play.fire_conditions : [];
  if (!evaluateConditions(conditions, fireContext)) return { inserted: 0, sourceRule: null };

  const vars        = buildVars(play, contract, fireContext);
  const title       = interpolate(play.title, vars);
  const description = interpolate(play.description, vars);
  const sourceRule  = `clm_${play.stage_key}`;
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
    if (!userId) return { inserted: 0, sourceRule };
    try {
      await upsertCLMAction(orgId, userId, contract, play, title, description);
      return { inserted: 1, sourceRule };
    } catch (err) {
      console.error(`  ❌ CLM upsert (no-role) contract ${contract.id}:`, err.message);
      return { inserted: 0, sourceRule };
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
        await upsertCLMAction(orgId, userId, contract, play, title, description);
        inserted++;
      } catch (err) {
        console.error(`  ❌ CLM upsert (role=${role.role_key}) contract ${contract.id}:`, err.message);
      }
    }
  }

  return { inserted, sourceRule: inserted > 0 ? sourceRule : null };
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
        return { success: true, upserted: 0, resolved: 0 };
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

      // ── NO DELETE — replaced with per-contract upsert + resolve ──────────
      // Diagnostic alerts are upserted in place (title/description updated,
      // created_at and status preserved). Stale alerts are auto-completed.

      let totalUpserted = 0;
      let totalResolved = 0;

      for (const [orgId, orgContracts] of Object.entries(byOrg)) {
        const plays = await loadCLMPlaysWithRoles(parseInt(orgId));
        if (!plays.length) {
          console.warn(`⚠️  No CLM plays for org ${orgId} — skipping`);
          continue;
        }

        for (const contract of orgContracts) {
          const firedRules = [];

          for (const play of plays) {
            const { inserted, sourceRule } = await processPlayForContract(
              parseInt(orgId), contract, play, renewalContractIds
            );
            if (inserted > 0 && sourceRule) {
              firedRules.push(sourceRule);
              totalUpserted += inserted;
            }
          }

          // Resolve CLM alerts whose conditions are no longer true
          const resolved = await ActionPersister.resolveStaleDiagnostics({
            entityType: 'contract',
            entityId:   contract.id,
            firedRules,
            orgId:      parseInt(orgId),
          });
          if (resolved > 0) totalResolved += resolved;
        }
      }

      console.log(`✅ CLM sweep complete — upserted: ${totalUpserted}, stale resolved: ${totalResolved}`);
      return { success: true, upserted: totalUpserted, resolved: totalResolved };

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

      // ── No DELETE — upsert diagnostics, resolve stale ─────────────────────
      const plays = await loadCLMPlaysWithRoles(orgId);
      const firedRules = [];
      let inserted = 0;

      for (const play of plays) {
        const playResult = await processPlayForContract(orgId, contract, play, renewalContractIds);
        if (playResult.inserted > 0 && playResult.sourceRule) {
          firedRules.push(playResult.sourceRule);
          inserted += playResult.inserted;
        }
      }

      const resolved = await ActionPersister.resolveStaleDiagnostics({
        entityType: 'contract',
        entityId:   contractId,
        firedRules,
        orgId,
      });

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
