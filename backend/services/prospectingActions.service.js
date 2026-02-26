/**
 * prospectingActions.service.js
 *
 * Generates prospecting actions from a playbook's stage_guidance.
 * Called manually ("Generate Actions" button) or after stage changes.
 *
 * Flow:
 *   1. Load prospect → get current stage + playbook_id
 *   2. Load playbook → read stage_guidance[currentStage].key_actions
 *   3. Load existing actions for this prospect → deduplicate
 *   4. Create pending actions for any key_action not already present
 */

const db = require('../config/database');

// ── Action type → channel + title mapping ──────────────────────────────────

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
};

function getActionTemplate(key) {
  if (ACTION_TEMPLATES[key]) return ACTION_TEMPLATES[key];
  return {
    title: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    actionType: 'task',
    channel: null,
    description: `Complete: ${key.replace(/_/g, ' ')}`,
    priority: 'medium',
  };
}

function parseDaysFromTimeline(timeline) {
  if (!timeline) return 3;
  const match = timeline.match(/(\d+)/);
  return match ? parseInt(match[1]) : 3;
}

// ═════════════════════════════════════════════════════════════════════════════
// generateForProspect
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @param {number} prospectId
 * @param {number} orgId
 * @param {number} userId
 * @returns {{ created: number, skipped: number, actions: object[] }}
 */
async function generateForProspect(prospectId, orgId, userId) {
  // 1. Load prospect
  const prospectRes = await db.query(
    'SELECT * FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
    [prospectId, orgId]
  );
  if (prospectRes.rows.length === 0) {
    throw new Error('Prospect not found');
  }
  const prospect = prospectRes.rows[0];

  if (!prospect.playbook_id) {
    throw new Error('No playbook assigned to this prospect. Assign a playbook first.');
  }

  // 2. Load playbook
  const pbRes = await db.query(
    'SELECT * FROM playbooks WHERE id = $1 AND org_id = $2',
    [prospect.playbook_id, orgId]
  );
  if (pbRes.rows.length === 0) {
    throw new Error('Assigned playbook not found');
  }
  const playbook = pbRes.rows[0];
  const guidance = playbook.stage_guidance || {};
  const currentStageGuide = guidance[prospect.stage];

  if (!currentStageGuide || !currentStageGuide.key_actions || currentStageGuide.key_actions.length === 0) {
    return {
      created: 0,
      skipped: 0,
      actions: [],
      message: `No key_actions defined for stage "${prospect.stage}" in this playbook.`,
    };
  }

  // 3. Load existing actions for deduplication
  const existingRes = await db.query(
    `SELECT action_type, channel, title, status
     FROM prospecting_actions
     WHERE prospect_id = $1 AND org_id = $2`,
    [prospectId, orgId]
  );

  const existingKeys = new Set();
  existingRes.rows.forEach(a => {
    existingKeys.add(`${a.action_type}:${a.channel || ''}`);
    existingKeys.add(a.title.toLowerCase());
  });

  // 4. Create actions for key_actions not yet present
  const timelineDays = parseDaysFromTimeline(currentStageGuide.timeline);
  const created = [];
  let skipped = 0;

  for (let i = 0; i < currentStageGuide.key_actions.length; i++) {
    const actionKey = currentStageGuide.key_actions[i];
    const template = getActionTemplate(actionKey);

    const dedupeKey = `${template.actionType}:${template.channel || ''}`;
    if (existingKeys.has(dedupeKey) || existingKeys.has(template.title.toLowerCase())) {
      skipped++;
      continue;
    }

    // Stagger due dates across the timeline window
    const dayOffset = Math.ceil((timelineDays / currentStageGuide.key_actions.length) * (i + 1));
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + dayOffset);

    const result = await db.query(
      `INSERT INTO prospecting_actions (
         org_id, user_id, prospect_id, title, description,
         action_type, channel, priority, due_date, source, sequence_step
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'playbook', $10)
       RETURNING *`,
      [
        orgId, userId, prospectId, template.title, template.description,
        template.actionType, template.channel, template.priority,
        dueDate, i + 1,
      ]
    );

    created.push(result.rows[0]);
    existingKeys.add(dedupeKey);
    existingKeys.add(template.title.toLowerCase());
  }

  // 5. Log activity
  if (created.length > 0) {
    await db.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'actions_generated', $3, $4)`,
      [
        prospectId, userId,
        `Generated ${created.length} action(s) from playbook "${playbook.name}" for stage "${prospect.stage}"`,
        JSON.stringify({ playbookId: playbook.id, stage: prospect.stage, actionCount: created.length, skipped }),
      ]
    );
  }

  return { created: created.length, skipped, actions: created };
}

module.exports = { generateForProspect };
