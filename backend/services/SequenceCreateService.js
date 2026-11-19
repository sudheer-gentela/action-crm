// ─────────────────────────────────────────────────────────────────────────────
// SequenceCreateService.js
// ─────────────────────────────────────────────────────────────────────────────
// The one place an outreach sequence (and its steps) gets created.
//
// Two callers share this:
//   • routes/sequences.routes.js  POST /       (the UI SequenceBuilder)
//   • mcp-server.mjs  create_sequence           (agents)
//
// Same pattern as CampaignCreateService: validation lives here once so the
// agent path cannot drift from the UI path. Callers own auth and response
// shape. createSequence() returns { ok:false, status, message } for caller
// mistakes and throws only on infrastructure failure.
//
// Two rules that did NOT exist before this file (sequence_steps.channel and
// .step_intent have no DB CHECK constraint, and POST / never validated them):
//
//   1. channel must be one of CHANNELS. Anything else used to be saved and then
//      silently ignored by SequenceStepFirer — a step that never fires. Now 400.
//      The UI's <select> only offers these four, so UI saves are unaffected.
//
//   2. step_intent must belong to the step's channel. A mismatch is NORMALISED
//      to null ("auto-infer"), not rejected: SequenceBuilder keeps a stale
//      intent in state when a rep switches a step's channel (e.g. picks
//      'follow_up', then changes the step to Call), and rejecting would make an
//      ordinary UI save fail. null is exactly what the dispatcher falls back to
//      anyway (PersonalizationDispatcher.isValidIntentForChannel). The MCP tool
//      validates strictly up front so agents get a clear error instead.
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

const CHANNELS = ['email', 'linkedin', 'call', 'task'];

// Mirrors PersonalizationDispatcher EMAIL_INTENTS / LINKEDIN_INTENTS and the
// SequenceBuilder dropdowns. Call and task steps have no intent.
const INTENTS_BY_CHANNEL = {
  email:    ['first_touch', 'follow_up', 'breakup'],
  linkedin: ['connection_request', 'post_accept_message', 'nurture_dm'],
  call:     [],
  task:     [],
};

// The only lifecycle states a NEW sequence may start in. 'draft' sequences are
// listed (GET / hides only 'archived') but every enrollment path requires
// status='active', so nothing can be enrolled until someone publishes it.
const CREATE_STATUSES = ['active', 'draft'];

// Template variables SequenceStepFirer.renderTemplate actually substitutes.
// Anything else in {{...}} is sent to the prospect verbatim.
const TEMPLATE_TOKENS = ['first_name', 'last_name', 'full_name', 'title', 'company', 'industry', 'domain'];

const reject = (status, message) => ({ ok: false, status, message });

function normaliseIntent(channel, intent) {
  if (!intent) return null;
  return (INTENTS_BY_CHANNEL[channel] || []).includes(intent) ? intent : null;
}

/**
 * Create a sequence with its steps, in one transaction.
 *
 * @param {object} args
 * @param {number} args.orgId
 * @param {number} args.userId  - becomes created_by (the owner for edit rights)
 * @param {object} args.input   - request-shaped fields (same names POST / accepts)
 * @param {string} [args.status='active'] - trusted, caller-chosen lifecycle state.
 *        Deliberately NOT read from `input`: the UI has never been able to set it
 *        on create, and keeping it out of the body keeps it that way.
 * @returns {Promise<{ok:true, sequence:object} | {ok:false, status:number, message:string}>}
 */
async function createSequence({ orgId, userId, input, status = 'active' }) {
  const body = input || {};
  const {
    name, description, require_approval = true, ai_enabled = false,
    personalize_config_default = null, steps = [], visibility = 'shared',
    allow_manager_edit = false, stop_on_connection_accept = false,
    thread_replies = false, pin_sender = false, thread_subject_mode = 'keep',
    thread_failover_mode = 'defer', body_format = 'html',
  } = body;

  if (!CREATE_STATUSES.includes(status)) {
    // Programming error in a caller, not user input — but fail safe, not 500.
    return reject(400, `status must be one of: ${CREATE_STATUSES.join(', ')}`);
  }
  if (typeof name !== 'string' || !name.trim()) {
    return reject(400, 'name is required');
  }
  if (!Array.isArray(steps)) {
    return reject(400, 'steps must be an array');
  }
  for (let i = 0; i < steps.length; i++) {
    const ch = steps[i]?.channel;
    if (!CHANNELS.includes(ch)) {
      return reject(400, `Step ${i + 1}: channel must be one of ${CHANNELS.join(', ')} (got ${JSON.stringify(ch ?? null)})`);
    }
  }

  const vis = visibility === 'private' ? 'private' : 'shared';

  // Threaded-reply config (2026_71). Clamp enums to the CHECK-constrained values
  // and enforce the invariant: threading forces sender pinning on.
  // 2026_76: html unless explicitly plain. Unknown values fall back rather than
  // hitting the CHECK constraint with a 500.
  const bodyFormat         = body_format === 'plain' ? 'plain' : 'html';
  const threadReplies      = thread_replies === true;
  const pinSender          = threadReplies ? true : (pin_sender === true);
  const threadSubjectMode  = thread_subject_mode === 're' ? 're' : 'keep';
  const threadFailoverMode = thread_failover_mode === 'break' ? 'break' : 'defer';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const seqRes = await client.query(
      `INSERT INTO sequences (org_id, name, description, created_by, require_approval, ai_enabled, personalize_config_default, visibility, allow_manager_edit, stop_on_connection_accept,
                             thread_replies, pin_sender, thread_subject_mode, thread_failover_mode,
                             body_format, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [orgId, name.trim(), description || null, userId, require_approval,
       ai_enabled === true,
       personalize_config_default ? JSON.stringify(personalize_config_default) : null,
       vis, allow_manager_edit === true, stop_on_connection_accept === true,
       threadReplies, pinSender, threadSubjectMode, threadFailoverMode,
       bodyFormat, status]
    );
    const seq = seqRes.rows[0];

    const insertedSteps = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const sr = await client.query(
        `INSERT INTO sequence_steps
                     (sequence_id, org_id, step_order, channel, delay_days, delay_hours,
                      subject_template, body_template, task_note, require_approval,
                      personalize_config, step_intent, include_signature)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [seq.id, orgId, i + 1, s.channel, s.delay_days ?? 0, s.delay_hours ?? 0,
         s.subject_template || null, s.body_template || null, s.task_note || null,
         s.require_approval !== undefined ? s.require_approval : null,
         s.personalize_config ? JSON.stringify(s.personalize_config) : null,
         // Slice 3: step_intent — null means "auto-infer at dispatch time".
         // Normalised: a cross-channel leftover becomes null (see header).
         normaliseIntent(s.channel, s.step_intent),
         // 2026_74: omitted means true, so callers that don't know about the flag
         // keep the signature.
         s.include_signature !== false]
      );
      insertedSteps.push(sr.rows[0]);
    }

    await client.query('COMMIT');
    return { ok: true, sequence: { ...seq, steps: insertedSteps } };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createSequence,
  CHANNELS,
  INTENTS_BY_CHANNEL,
  TEMPLATE_TOKENS,
};
