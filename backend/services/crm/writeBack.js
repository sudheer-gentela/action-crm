/**
 * crm/writeBack.js
 *
 * DROP-IN LOCATION: backend/services/crm/writeBack.js
 *
 * Pushes completed GoWarm actions to Salesforce as Tasks.
 *
 * Design decisions:
 *
 * 1. DEDUPLICATION VIA sf_activity_log.
 *    Every action pushed to SF gets a row: (org_id, sf_object_id, direction='outbound').
 *    Before pushing, we check actions.external_refs for an existing SF Task ID,
 *    and sf_activity_log for a prior outbound entry. Either blocks re-push.
 *
 * 2. GoWarm_Source__c ECHO-LOOP PREVENTION.
 *    The SF Task is stamped with GoWarm_Source__c = 'GoWarm'. The inbound sync
 *    skips Tasks with this field set, so we never re-import our own write-backs.
 *    This field must exist on the SF Task object (created by ensureCustomObjects).
 *
 * 3. LINKING PRIORITY: Opportunity > Contact > Account.
 *    SF Task WhatId accepts Opportunity or Account IDs.
 *    SF Task WhoId accepts Contact IDs.
 *    We resolve GoWarm deal/contact/account → SF CRM IDs via external_refs.
 *
 * 4. TWO MODES:
 *    - nightly: called by cron at 04:30 UTC, processes all unsynced completions
 *      from the past 25 hours (safe overlap with 04:00 inbound sync).
 *    - realtime: called inline from actions.routes.js after status→completed.
 *      Fire-and-forget (errors don't affect API response).
 *
 * 5. WRITE-BACK GATE:
 *    Only runs if org_integrations.settings.write_back_enabled = true.
 *    Checked at the top of each run — no-ops silently if disabled.
 *
 * 6. ACTION TYPE → SF TASK TYPE MAPPING.
 *    GoWarm action types map to SF TaskSubtype where possible.
 *    Unknown types fall back to 'Task'.
 */

const { pool }        = require('../../config/database');
const { createClient } = require('../salesforce.client');

// GoWarm action type → SF Task Type string
const ACTION_TYPE_TO_SF = {
  email:         'Email',
  call:          'Call',
  meeting_prep:  'Meeting',
  demo:          'Demo',
  follow_up:     'Task',
  proposal:      'Task',
  research:      'Task',
};

// How many actions to push per org per write-back run
const BATCH_SIZE = 200;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Push completed actions for a single org to Salesforce.
 * Called by nightly cron (all pending) or inline after action completion (single action).
 *
 * @param {number}  orgId
 * @param {object}  [opts]
 * @param {number}  [opts.actionId]    - If set, push only this specific action (realtime mode)
 * @param {number}  [opts.hoursBack]   - Nightly: look back this many hours (default 25)
 * @returns {{ pushed: number, skipped: number, errors: string[] }}
 */
async function runWriteBackForOrg(orgId, { actionId = null, hoursBack = 25 } = {}) {
  // ── Gate check ──────────────────────────────────────────────────────────────
  const intRes = await pool.query(
    `SELECT settings FROM org_integrations WHERE org_id = $1 AND integration_type = 'salesforce'`,
    [orgId]
  );
  if (intRes.rows.length === 0) return { pushed: 0, skipped: 0, errors: [] };

  const settings = intRes.rows[0].settings || {};
  if (!settings.write_back_enabled) return { pushed: 0, skipped: 0, errors: [] };

  // ── Fetch pending actions ───────────────────────────────────────────────────
  const actions = actionId
    ? await _fetchSingleAction(orgId, actionId)
    : await _fetchPendingActions(orgId, hoursBack);

  if (actions.length === 0) return { pushed: 0, skipped: 0, errors: [] };

  // ── Init SF client ──────────────────────────────────────────────────────────
  let sf;
  try {
    sf = await createClient(orgId);
  } catch (err) {
    return { pushed: 0, skipped: 0, errors: [`SF client init failed: ${err.message}`] };
  }

  let pushed  = 0;
  let skipped = 0;
  const errors = [];

  for (const action of actions) {
    try {
      const result = await _pushAction(orgId, action, sf);
      if (result.pushed)  pushed++;
      if (result.skipped) skipped++;
    } catch (err) {
      const msg = `Action ${action.id} ("${action.title}"): ${err.message}`;
      console.error(`  ⚠️  [WriteBack] org ${orgId} — ${msg}`);
      errors.push(msg);
    }
  }

  console.log(
    `📤 [WriteBack] org ${orgId} — pushed:${pushed} skipped:${skipped} errors:${errors.length}`
  );

  return { pushed, skipped, errors };
}

/**
 * Run nightly write-back for all orgs that have it enabled.
 * Called by the 04:30 UTC cron in server.js.
 *
 * @returns {{ orgs: number, pushed: number, errors: number }}
 */
async function runNightlyWriteBack() {
  const res = await pool.query(`
    SELECT org_id FROM org_integrations
    WHERE integration_type = 'salesforce'
      AND instance_url IS NOT NULL
      AND connected_at IS NOT NULL
      AND (settings->>'write_back_enabled')::boolean = true
  `);

  let totalPushed = 0;
  let totalErrors = 0;

  for (const row of res.rows) {
    try {
      const result = await runWriteBackForOrg(row.org_id, { hoursBack: 25 });
      totalPushed += result.pushed;
      totalErrors += result.errors.length;
    } catch (err) {
      console.error(`[WriteBack] org ${row.org_id} nightly run failed: ${err.message}`);
      totalErrors++;
    }
  }

  return { orgs: res.rows.length, pushed: totalPushed, errors: totalErrors };
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE PUSH LOGIC
// ─────────────────────────────────────────────────────────────────────────────

async function _pushAction(orgId, action, sf) {
  // Skip if already pushed — check external_refs for existing SF Task ID
  const existingSfTaskId = action.external_refs?.salesforce?.task_id;
  if (existingSfTaskId) return { skipped: true };

  // Skip if already logged as outbound in sf_activity_log
  const logged = await pool.query(
    `SELECT 1 FROM sf_activity_log
     WHERE org_id = $1 AND gw_action_id = $2 AND direction = 'outbound' LIMIT 1`,
    [orgId, action.id]
  );
  if (logged.rows.length > 0) return { skipped: true };

  // Resolve SF IDs for linking
  const sfLinks = await _resolveSfLinks(orgId, action);

  // If we have no SF object to link to, skip — unlinked Tasks are noise
  if (!sfLinks.whatId && !sfLinks.whoId) {
    return { skipped: true };
  }

  // Build SF Task payload
  const taskData = _buildSfTask(action, sfLinks);

  // Create the SF Task
  const sfTaskId = await sf.createTask(taskData);

  // Log to sf_activity_log to prevent re-push
  await pool.query(`
    INSERT INTO sf_activity_log
      (org_id, sf_object_id, sf_object_type, direction, gw_action_id, gw_entity_type, gw_entity_id, created_at)
    VALUES ($1, $2, 'Task', 'outbound', $3, 'action', $4, NOW())
    ON CONFLICT (org_id, sf_object_id) DO NOTHING
  `, [orgId, sfTaskId, action.id, action.id]);

  // Stamp the GoWarm action with the SF Task ID in external_refs
  await pool.query(`
    UPDATE actions
    SET external_refs = COALESCE(external_refs, '{}'::jsonb) ||
      jsonb_build_object('salesforce', jsonb_build_object(
        'task_id', $2::text,
        'pushed_at', $3::text
      )),
      updated_at = NOW()
    WHERE id = $1
  `, [action.id, sfTaskId, new Date().toISOString()]);

  return { pushed: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// SF TASK BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function _buildSfTask(action, sfLinks) {
  const taskType = ACTION_TYPE_TO_SF[action.type] || 'Task';

  // SF Task ActivityDate must be a date string (YYYY-MM-DD)
  const activityDate = action.completed_at
    ? new Date(action.completed_at).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

  const subject = action.title
    ? `[GoWarm] ${action.title}`
    : '[GoWarm] Action completed';

  const description = [
    action.description || '',
    action.context     || '',
    `\n— Completed via GoWarm on ${activityDate}`,
  ].filter(Boolean).join('\n\n').trim();

  const task = {
    Subject:         subject,
    Status:          'Completed',
    ActivityDate:    activityDate,
    Description:     description || null,
    Type:            taskType,
    GoWarm_Source__c: 'GoWarm',   // Echo-loop prevention flag
  };

  // WhatId: Opportunity takes priority over Account
  if (sfLinks.whatId) task.WhatId = sfLinks.whatId;

  // WhoId: Contact
  if (sfLinks.whoId) task.WhoId = sfLinks.whoId;

  // OwnerId: map GoWarm user → SF user via email
  if (sfLinks.ownerSfUserId) task.OwnerId = sfLinks.ownerSfUserId;

  return task;
}

// ─────────────────────────────────────────────────────────────────────────────
// SF ID RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve GoWarm deal/contact/account → Salesforce CRM IDs.
 * Uses external_refs JSONB on each entity — same pattern as orchestrator.
 *
 * @returns {{ whatId: string|null, whoId: string|null, ownerSfUserId: string|null }}
 */
async function _resolveSfLinks(orgId, action) {
  let whatId = null;
  let whoId  = null;
  let ownerSfUserId = null;

  // WhatId: resolve deal → SF Opportunity ID
  if (action.deal_id) {
    const res = await pool.query(
      `SELECT external_refs FROM deals WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [action.deal_id, orgId]
    );
    const sfId = res.rows[0]?.external_refs?.salesforce?.id;
    if (sfId) whatId = sfId;
  }

  // WhatId fallback: resolve account → SF Account ID (if no deal)
  if (!whatId && action.account_id) {
    const res = await pool.query(
      `SELECT external_refs FROM accounts WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [action.account_id, orgId]
    );
    const sfId = res.rows[0]?.external_refs?.salesforce?.id;
    if (sfId) whatId = sfId;
  }

  // WhoId: resolve contact → SF Contact ID
  if (action.contact_id) {
    const res = await pool.query(
      `SELECT external_refs FROM contacts WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [action.contact_id, orgId]
    );
    const sfId = res.rows[0]?.external_refs?.salesforce?.id;
    if (sfId) whoId = sfId;
  }

  // Owner: resolve GoWarm user email → SF User ID
  // SF User IDs are stored in org_hierarchy or we can look up via SF SOQL.
  // For simplicity, we store the SF user_id in the oauth_tokens account_data
  // for the org admin — for individual reps we skip OwnerId and let SF default it.
  // A future enhancement could maintain a user→sf_user_id map.

  return { whatId, whoId, ownerSfUserId };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB QUERIES
// ─────────────────────────────────────────────────────────────────────────────

async function _fetchPendingActions(orgId, hoursBack) {
  // Fetch completed actions not yet in sf_activity_log as outbound
  const res = await pool.query(`
    SELECT a.id, a.title, a.type, a.description, a.context,
           a.deal_id, a.contact_id, a.account_id,
           a.completed_at, a.external_refs
    FROM actions a
    WHERE a.org_id    = $1
      AND a.completed = true
      AND a.completed_at >= NOW() - ($2 || ' hours')::interval
      AND NOT EXISTS (
        SELECT 1 FROM sf_activity_log sal
        WHERE sal.org_id       = a.org_id
          AND sal.gw_action_id = a.id
          AND sal.direction    = 'outbound'
      )
    ORDER BY a.completed_at ASC
    LIMIT $3
  `, [orgId, hoursBack, BATCH_SIZE]);

  return res.rows;
}

async function _fetchSingleAction(orgId, actionId) {
  const res = await pool.query(`
    SELECT a.id, a.title, a.type, a.description, a.context,
           a.deal_id, a.contact_id, a.account_id,
           a.completed_at, a.external_refs
    FROM actions a
    WHERE a.id      = $1
      AND a.org_id  = $2
      AND a.completed = true
  `, [actionId, orgId]);

  return res.rows;
}

module.exports = { runWriteBackForOrg, runNightlyWriteBack };
