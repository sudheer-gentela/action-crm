/**
 * ContractActionsGenerator.js
 *
 * Generates auto actions for contracts based on CLM playbook plays.
 * Mirrors the structure of actionsGenerator.js but driven by contract
 * status/sub-status age rather than deal health parameters.
 *
 * How it works:
 *   1. Loads all active 'auto' plays from the org's CLM playbook via
 *      PlaybookService.getCLMPlays(orgId).
 *   2. For each active contract, checks whether the contract's current
 *      status maps to a play's stage_key AND has been in that status
 *      for >= play.due_offset_days.
 *   3. If the condition is met and no non-completed action with the same
 *      source_rule already exists for this contract, inserts the action.
 *
 * stage_key → contract status/sub-status mapping:
 *   clm_in_review_with_legal    → status=in_review,  review_sub_status=with_legal
 *   clm_in_review_with_sales    → status=in_review,  review_sub_status=with_sales
 *   clm_in_review_with_customer → status=in_review,  review_sub_status=with_customer
 *   clm_in_signatures           → status=in_signatures
 *   clm_expiring_soon           → status=active, days_to_expiry <= 90
 *   clm_expiring_soon_urgent    → status=active, days_to_expiry <= 30
 *   clm_expired_no_renewal      → status=expired, no child contract exists
 *
 * Triggered by:
 *   - The existing cron job in syncScheduler.js / worker.js (add a call to
 *     ContractActionsGenerator.generateAll() alongside ActionsGenerator.generateAll())
 *   - contracts.routes.js on CLM status transitions (generateForContract)
 */

const db             = require('../config/database');
const PlaybookService = require('./playbook.service');

// ── Status → stage_key mapping ────────────────────────────────────────────────

function getStageKey(contract) {
  const { status, review_sub_status } = contract;

  if (status === 'in_review') {
    if (review_sub_status === 'with_legal')    return 'clm_in_review_with_legal';
    if (review_sub_status === 'with_sales')    return 'clm_in_review_with_sales';
    if (review_sub_status === 'with_customer') return 'clm_in_review_with_customer';
    return null;
  }
  if (status === 'in_signatures') return 'clm_in_signatures';

  // active + expiry checks are handled separately (two plays, different thresholds)
  if (status === 'active') return 'clm_expiring_soon'; // refined below

  if (status === 'expired') return 'clm_expired_no_renewal';

  return null;
}

// ── Days in current status ────────────────────────────────────────────────────

function daysInStatus(contract) {
  const ref = contract.status_changed_at || contract.updated_at || contract.created_at;
  return Math.floor((Date.now() - new Date(ref)) / 86400000);
}

// ── Days to expiry ────────────────────────────────────────────────────────────

function daysToExpiry(contract) {
  if (!contract.end_date) return null;
  return Math.ceil((new Date(contract.end_date) - Date.now()) / 86400000);
}

// ── Interpolate description template ─────────────────────────────────────────

function interpolate(template, vars) {
  return (template || '').replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] !== undefined ? vars[key] : `{{${key}}}`
  );
}

// ── Check whether a play should fire for a contract ──────────────────────────

function shouldFire(play, contract, renewalContractIds) {
  const { status, review_sub_status } = contract;
  const stageKey    = play.stage_key;
  const threshold   = play.due_offset_days || 0;
  const elapsed     = daysInStatus(contract);
  const expiry      = daysToExpiry(contract);

  switch (stageKey) {
    case 'clm_in_review_with_legal':
      return status === 'in_review'
        && review_sub_status === 'with_legal'
        && elapsed >= threshold;

    case 'clm_in_review_with_sales':
      return status === 'in_review'
        && review_sub_status === 'with_sales'
        && elapsed >= threshold;

    case 'clm_in_review_with_customer':
      return status === 'in_review'
        && review_sub_status === 'with_customer'
        && elapsed >= threshold;

    case 'clm_in_signatures':
      return status === 'in_signatures'
        && elapsed >= threshold;

    case 'clm_expiring_soon':
      // fires when expiry is within 90 days but NOT within 30 (that's urgent)
      return status === 'active'
        && expiry !== null
        && expiry <= threshold      // threshold = 90 from seed
        && expiry > 30;             // leave the 30-day play to fire separately

    case 'clm_expiring_soon_urgent':
      return status === 'active'
        && expiry !== null
        && expiry <= threshold;     // threshold = 30 from seed

    case 'clm_expired_no_renewal':
      return status === 'expired'
        && !renewalContractIds.has(contract.id);

    default:
      return false;
  }
}

// ── Build template variables for description interpolation ───────────────────

function buildVars(play, contract) {
  return {
    days_in_status:    daysInStatus(contract),
    days_to_expiry:    daysToExpiry(contract) ?? 'unknown',
    days_since_expiry: contract.status === 'expired'
      ? Math.floor((Date.now() - new Date(contract.end_date || contract.updated_at)) / 86400000)
      : 0,
    contract_title:    contract.title || `Contract #${contract.id}`,
    contract_type:     contract.contract_type || 'contract',
  };
}

// ── Map play channel to action_type ──────────────────────────────────────────

const CHANNEL_TO_ACTION_TYPE = {
  email: 'email_send',
  task:  'task_complete',
  call:  'meeting_schedule',
};

// ── Main class ────────────────────────────────────────────────────────────────

class ContractActionsGenerator {

  // ── generateAll ─────────────────────────────────────────────────────────────
  // Called by the cron scheduler alongside ActionsGenerator.generateAll().

  static async generateAll() {
    try {
      console.log('📄 Starting ContractActionsGenerator — generating CLM actions...');

      // Load all active non-terminal contracts
      const contractsRes = await db.query(`
        SELECT c.*, c.status_changed_at
        FROM contracts c
        WHERE c.deleted_at IS NULL
          AND c.status NOT IN ('void', 'terminated')
      `);

      const contracts = contractsRes.rows;
      if (contracts.length === 0) {
        console.log('📄 No active contracts — skipping CLM action generation.');
        return { success: true, generated: 0, inserted: 0 };
      }

      // Find all contract IDs that are children (renewals/amendments) —
      // used to determine whether an expired contract has a renewal in progress.
      const childRes = await db.query(
        `SELECT DISTINCT parent_contract_id FROM contracts
         WHERE parent_contract_id IS NOT NULL AND deleted_at IS NULL`
      );
      const renewalContractIds = new Set(childRes.rows.map(r => r.parent_contract_id));

      // Group contracts by org so we load CLM plays once per org
      const byOrg = {};
      for (const c of contracts) {
        if (!c.org_id) continue;
        if (!byOrg[c.org_id]) byOrg[c.org_id] = [];
        byOrg[c.org_id].push(c);
      }

      // Delete existing auto CLM actions that are not yet started / in progress
      await db.query(
        `DELETE FROM actions
         WHERE contract_id IS NOT NULL
           AND source = 'auto_generated'
           AND status IN ('yet_to_start', 'in_progress')`
      );

      let totalGenerated = 0;
      let totalInserted  = 0;

      for (const [orgId, orgContracts] of Object.entries(byOrg)) {
        const plays = await PlaybookService.getCLMPlays(parseInt(orgId));
        if (!plays.length) {
          console.warn(`⚠️  No CLM plays found for org ${orgId} — skipping`);
          continue;
        }

        for (const contract of orgContracts) {
          for (const play of plays) {
            if (!shouldFire(play, contract, renewalContractIds)) continue;

            totalGenerated++;

            const vars        = buildVars(play, contract);
            const title       = interpolate(play.title, vars);
            const description = interpolate(play.description, vars);
            const actionType  = CHANNEL_TO_ACTION_TYPE[play.channel] || 'task_complete';
            const dueDate     = new Date(Date.now() + 2 * 86400000); // due in 2 days

            try {
              await db.query(
                `INSERT INTO actions (
                   org_id, user_id, type, title, description, action_type,
                   priority, due_date, contract_id, deal_id, account_id,
                   source, source_rule, is_internal, next_step, status, created_at
                 )
                 SELECT
                   $1, c.owner_id, $3, $4, $5, $6,
                   $7, $8, $9, c.deal_id, c.account_id,
                   'auto_generated', $10, FALSE, $11, 'yet_to_start', NOW()
                 FROM contracts c
                 WHERE c.id = $9
                   AND c.org_id = $1`,
                [
                  parseInt(orgId),
                  null,              // placeholder — user_id from subquery
                  actionType,
                  title,
                  description,
                  actionType,
                  play.priority || 'medium',
                  dueDate,
                  contract.id,
                  `clm_${play.stage_key}`,
                  play.channel || 'email',
                ]
              );
              totalInserted++;
            } catch (err) {
              console.error(`  ❌ CLM action insert failed for contract ${contract.id}:`, err.message);
            }
          }
        }
      }

      console.log(`✅ CLM generateAll complete — generated: ${totalGenerated} inserted: ${totalInserted}`);
      return { success: true, generated: totalGenerated, inserted: totalInserted };

    } catch (error) {
      console.error('❌ Error in ContractActionsGenerator.generateAll:', error);
      return { success: false, error: error.message };
    }
  }

  // ── generateForContract ──────────────────────────────────────────────────────
  // Called from contracts.routes.js on status transitions.
  // Deletes existing auto actions for this contract and regenerates.

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

      // Clear existing auto actions for this specific contract
      await db.query(
        `DELETE FROM actions
         WHERE contract_id = $1
           AND source = 'auto_generated'
           AND status IN ('yet_to_start', 'in_progress')`,
        [contractId]
      );

      const plays = await PlaybookService.getCLMPlays(orgId);
      let inserted = 0;

      for (const play of plays) {
        if (!shouldFire(play, contract, renewalContractIds)) continue;

        const vars        = buildVars(play, contract);
        const title       = interpolate(play.title, vars);
        const description = interpolate(play.description, vars);
        const actionType  = CHANNEL_TO_ACTION_TYPE[play.channel] || 'task_complete';
        const dueDate     = new Date(Date.now() + 2 * 86400000);

        try {
          await db.query(
            `INSERT INTO actions (
               org_id, user_id, type, title, description, action_type,
               priority, due_date, contract_id, deal_id, account_id,
               source, source_rule, is_internal, next_step, status, created_at
             )
             SELECT
               $1, c.owner_id, $3, $4, $5, $6,
               $7, $8, $9, c.deal_id, c.account_id,
               'auto_generated', $10, FALSE, $11, 'yet_to_start', NOW()
             FROM contracts c
             WHERE c.id = $9
               AND c.org_id = $1`,
            [
              orgId,
              null,
              actionType,
              title,
              description,
              actionType,
              play.priority || 'medium',
              dueDate,
              contractId,
              `clm_${play.stage_key}`,
              play.channel || 'email',
            ]
          );
          inserted++;
        } catch (err) {
          console.error(`  ❌ CLM action insert failed for contract ${contractId}:`, err.message);
        }
      }

      console.log(`✅ Generated ${inserted} CLM actions for contract ${contractId}`);
      return inserted;

    } catch (error) {
      console.error('Error in ContractActionsGenerator.generateForContract:', error);
      return 0;
    }
  }
}

module.exports = ContractActionsGenerator;
