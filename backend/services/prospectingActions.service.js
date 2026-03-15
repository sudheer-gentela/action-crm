/**
 * prospectingActions.service.js
 *
 * Generates prospecting actions from a playbook's plays for a prospect.
 * Called manually ("Generate Actions" button) or after stage changes.
 *
 * FIXED IN THIS VERSION:
 *   - Now uses playbook_plays rows (the structured plays defined in the
 *     playbook editor) instead of stage_guidance.key_actions text labels.
 *   - Falls back to stage_guidance.key_actions only if no playbook_plays
 *     exist for the stage (backward compatibility).
 *   - Stamps playbook_id, play_id, and playbook_name on each inserted row.
 *   - source_rule column now populated (added by migration).
 *
 * Flow:
 *   1. Load prospect → get current stage + playbook_id
 *   2. Try playbook_plays for this stage first
 *   3. Fallback: load stage_guidance[currentStage].key_actions
 *   4. Load existing actions → deduplicate
 *   5. Insert pending actions for anything not already present
 */

const db            = require('../config/database');
const PlaybookService = require('./playbook.service');

// ── Channel → prospecting_actions.channel mapping ────────────────────────────
// prospecting_actions.channel CHECK: email|linkedin|phone|sms|whatsapp
function resolveProspectChannel(channel) {
  const map = {
    email:         'email',
    linkedin:      'linkedin',
    phone:         'phone',
    call:          'phone',
    meeting:       'phone',
    sms:           'sms',
    whatsapp:      'whatsapp',
    document:      null,
    internal_task: null,
    slack:         null,
  };
  return map[channel] !== undefined ? map[channel] : null;
}

// ── Legacy action template map ────────────────────────────────────────────────
// Used as fallback when no playbook_plays rows exist for a stage.
const ACTION_TEMPLATES = {
  research_company: {
    title: 'Research company',
    actionType: 'research',
    channel: null,
    description: 'Research the prospect\'s company — financials, news, competitors, tech stack.',
    priority: 'medium',
  },
  research_contact: {
    title: 'Research contact',
    actionType: 'research',
    channel: null,
    description: 'Research the contact — background, mutual connections, recent activity.',
    priority: 'medium',
  },
  send_email: {
    title: 'Send outreach email',
    actionType: 'outreach',
    channel: 'email',
    description: 'Compose and send a personalized email to the prospect.',
    priority: 'high',
  },
  send_linkedin: {
    title: 'Send LinkedIn message',
    actionType: 'outreach',
    channel: 'linkedin',
    description: 'Send a LinkedIn connection request or InMail.',
    priority: 'medium',
  },
  follow_up: {
    title: 'Follow up',
    actionType: 'outreach',
    channel: 'email',
    description: 'Send a follow-up message if no response received.',
    priority: 'high',
  },
  make_call: {
    title: 'Make phone call',
    actionType: 'outreach',
    channel: 'phone',
    description: 'Call the prospect — prepare talking points and objection handling.',
    priority: 'high',
  },
  send_sms: {
    title: 'Send SMS',
    actionType: 'outreach',
    channel: 'sms',
    description: 'Send a brief text message to the prospect.',
    priority: 'low',
  },
  send_whatsapp: {
    title: 'Send WhatsApp message',
    actionType: 'outreach',
    channel: 'whatsapp',
    description: 'Send a WhatsApp message to the prospect.',
    priority: 'low',
  },
  qualify: {
    title: 'Qualification call / meeting',
    actionType: 'meeting',
    channel: 'phone',
    description: 'Conduct a qualification conversation to assess fit and readiness.',
    priority: 'high',
  },
  schedule_meeting: {
    title: 'Schedule meeting',
    actionType: 'meeting',
    channel: null,
    description: 'Schedule a discovery or demo meeting with the prospect.',
    priority: 'high',
  },
  send_content: {
    title: 'Share content / case study',
    actionType: 'outreach',
    channel: 'email',
    description: 'Send relevant content, case study, or resource to add value.',
    priority: 'medium',
  },
  schedule_demo: {
    title: 'Schedule demo',
    actionType: 'meeting',
    channel: 'phone',
    description: 'Schedule a product demonstration.',
    priority: 'high',
  },
  intro_to_ae: {
    title: 'Introduce to Account Executive',
    actionType: 'outreach',
    channel: 'email',
    description: 'Warm introduction email to the assigned AE.',
    priority: 'high',
  },
  convert: {
    title: 'Convert to deal',
    actionType: 'task',
    channel: null,
    description: 'Create a deal record from this qualified prospect.',
    priority: 'high',
  },
};

function getLegacyTemplate(key) {
  if (ACTION_TEMPLATES[key]) return ACTION_TEMPLATES[key];
  return {
    title:      key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    actionType: 'task',
    channel:    null,
    description: `Complete: ${key.replace(/_/g, ' ')}`,
    priority:   'medium',
  };
}

function parseDaysFromTimeline(timeline) {
  if (!timeline) return 3;
  const match = timeline.match(/(\d+)/);
  return match ? parseInt(match[1]) : 3;
}

// ═════════════════════════════════════════════════════════════════════════════
// generateForProspect — main entry point
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @param {number} prospectId
 * @param {number} orgId
 * @param {number} userId
 * @returns {{ created: number, skipped: number, actions: object[], source: string }}
 */
async function generateForProspect(prospectId, orgId, userId) {
  // 1. Load prospect
  const prospectRes = await db.query(
    'SELECT * FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
    [prospectId, orgId]
  );
  if (prospectRes.rows.length === 0) throw new Error('Prospect not found');
  const prospect = prospectRes.rows[0];

  if (!prospect.playbook_id) {
    throw new Error('No playbook assigned to this prospect. Assign a playbook first.');
  }

  // 2. Load playbook
  const pbRes = await db.query(
    'SELECT * FROM playbooks WHERE id = $1 AND org_id = $2',
    [prospect.playbook_id, orgId]
  );
  if (pbRes.rows.length === 0) throw new Error('Assigned playbook not found');
  const playbook = pbRes.rows[0];
  const playbookName = playbook.name;

  // 3. Load existing actions for deduplication
  const existingRes = await db.query(
    `SELECT action_type, channel, title, play_id, status
     FROM prospecting_actions
     WHERE prospect_id = $1 AND org_id = $2 AND status != 'skipped'`,
    [prospectId, orgId]
  );
  const existingPlayIds = new Set(existingRes.rows.filter(a => a.play_id).map(a => a.play_id));
  const existingKeys    = new Set(existingRes.rows.map(a => a.title.toLowerCase()));

  // 4. Try playbook_plays rows first (FIXED PATH)
  const playsResult = await PlaybookService.getPlaysForStage(orgId, prospect.playbook_id, prospect.stage);

  if (playsResult.length > 0) {
    return await _generateFromPlays(
      prospect, orgId, userId, playsResult,
      playbook, playbookName, existingPlayIds, existingKeys
    );
  }

  // 5. Fallback: stage_guidance.key_actions (legacy path — backward compat)
  const guidance     = typeof playbook.stage_guidance === 'string'
    ? JSON.parse(playbook.stage_guidance)
    : (playbook.stage_guidance || {});
  const stageGuide   = guidance[prospect.stage];

  if (!stageGuide?.key_actions?.length) {
    return {
      created: 0, skipped: 0, actions: [],
      source:  'none',
      message: `No plays or key_actions defined for stage "${prospect.stage}" in this playbook.`,
    };
  }

  return await _generateFromLegacyGuidance(
    prospect, orgId, userId, stageGuide,
    playbook, playbookName, existingKeys
  );
}

// ── Path A: generate from playbook_plays rows ─────────────────────────────────

async function _generateFromPlays(prospect, orgId, userId, plays, playbook, playbookName, existingPlayIds, existingKeys) {
  const created = [];
  let skipped   = 0;

  for (let i = 0; i < plays.length; i++) {
    const play = plays[i];

    // Skip if already have an action from this exact play
    if (existingPlayIds.has(play.id)) { skipped++; continue; }
    // Also title-dedup as safety net
    if (existingKeys.has(play.title.toLowerCase())) { skipped++; continue; }

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + (parseInt(play.due_offset_days) || 3));

    const channel = resolveProspectChannel(play.channel);

    const result = await db.query(
      `INSERT INTO prospecting_actions (
         org_id, user_id, prospect_id,
         title, description,
         action_type, channel,
         priority, due_date,
         source, source_rule,
         suggested_action,
         playbook_id, play_id, playbook_name,
         sequence_step, status
       ) VALUES (
         $1, $2, $3,
         $4, $5,
         'playbook_play', $6,
         $7, $8,
         'playbook', 'playbook_play',
         $9,
         $10, $11, $12,
         $13, 'pending'
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        orgId, userId, prospect.id,
        play.title, play.description || null,
        channel,
        play.priority || 'medium', dueDate,
        play.suggested_action || null,
        playbook.id, play.id, playbookName,
        i + 1,
      ]
    );

    if (result.rows[0]) {
      created.push(result.rows[0]);
      existingPlayIds.add(play.id);
      existingKeys.add(play.title.toLowerCase());
    }
  }

  // Log activity
  if (created.length > 0) {
    await db.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'actions_generated', $3, $4)`,
      [
        prospect.id, userId,
        `Generated ${created.length} action(s) from playbook plays "${playbookName}" for stage "${prospect.stage}"`,
        JSON.stringify({ playbookId: playbook.id, stage: prospect.stage, actionCount: created.length, skipped, source: 'playbook_plays' }),
      ]
    ).catch(() => {});
  }

  return { created: created.length, skipped, actions: created, source: 'playbook_plays' };
}

// ── Path B: legacy stage_guidance.key_actions fallback ───────────────────────

async function _generateFromLegacyGuidance(prospect, orgId, userId, stageGuide, playbook, playbookName, existingKeys) {
  const timelineDays = parseDaysFromTimeline(stageGuide.timeline);
  const created = [];
  let skipped   = 0;

  for (let i = 0; i < stageGuide.key_actions.length; i++) {
    const actionKey  = stageGuide.key_actions[i];
    const template   = getLegacyTemplate(actionKey);
    const dedupeKey  = template.title.toLowerCase();

    if (existingKeys.has(dedupeKey)) { skipped++; continue; }

    const dayOffset = Math.ceil((timelineDays / stageGuide.key_actions.length) * (i + 1));
    const dueDate   = new Date();
    dueDate.setDate(dueDate.getDate() + dayOffset);

    const result = await db.query(
      `INSERT INTO prospecting_actions (
         org_id, user_id, prospect_id,
         title, description,
         action_type, channel,
         priority, due_date,
         source, source_rule,
         playbook_id, playbook_name,
         sequence_step, status
       ) VALUES (
         $1, $2, $3,
         $4, $5,
         $6, $7,
         $8, $9,
         'playbook', 'playbook_guidance',
         $10, $11,
         $12, 'pending'
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        orgId, userId, prospect.id,
        template.title, template.description,
        template.actionType, template.channel,
        template.priority, dueDate,
        playbook.id, playbookName,
        i + 1,
      ]
    );

    if (result.rows[0]) {
      created.push(result.rows[0]);
      existingKeys.add(dedupeKey);
    } else {
      skipped++;
    }
  }

  if (created.length > 0) {
    await db.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'actions_generated', $3, $4)`,
      [
        prospect.id, userId,
        `Generated ${created.length} action(s) from playbook guidance "${playbookName}" for stage "${prospect.stage}"`,
        JSON.stringify({ playbookId: playbook.id, stage: prospect.stage, actionCount: created.length, skipped, source: 'legacy_guidance' }),
      ]
    ).catch(() => {});
  }

  return { created: created.length, skipped, actions: created, source: 'legacy_guidance' };
}

module.exports = { generateForProspect };
