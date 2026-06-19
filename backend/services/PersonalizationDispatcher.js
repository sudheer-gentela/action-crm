// ============================================================================
// services/PersonalizationDispatcher.js
//
// Slice 3 — Routes each step of a sequence through the right skill with the
// right intent, returning a fully-populated personalised_steps blob ready to
// drop into sequence_enrollments.personalised_steps.
//
// The dispatcher exists because:
//   - Slice 2's bulk-activate had awkward "linkedin → step 1, email → step 2"
//     mapping logic that only worked for one specific sequence shape.
//   - The retired outreach-personalization skill emitted both at once, baking
//     a 2-step assumption into the skill itself.
//   - Sequences can now be 1, 3, 5, 8 steps — any shape.
//
// The dispatcher:
//   1. Loads the sequence's steps in order
//   2. For each step:
//      a. Resolves intent (sequence_steps.step_intent override, else infers
//         from channel + position + engagement_history)
//      b. Picks the right skill (outreach-email or outreach-linkedin)
//      c. Calls SkillRunnerService.runProspectSkill with the intent
//      d. Maps the skill output onto the step (subject/body/task_note)
//   3. Returns { [stepOrder]: { subject, body, task_note, personalize_sources } }
//      ready for sequence_enrollments.personalised_steps.
//
// Steps with channel='call' or 'task' get pass-through (no personalisation
// needed; the firer renders them from the sequence template). Steps with
// inferred intent that doesn't apply (e.g. linkedin step but engagement has
// no connection_accepted yet) get the most defensible default + a note.
//
// Errors per-step are captured into errors[] rather than throwing — the
// caller may want to proceed with partial personalisation rather than abort
// the entire batch. Callers that want strict behaviour can check errors.length.
// ============================================================================

const { pool } = require('../config/database');
const SkillRunnerService = require('./SkillRunnerService');
const Entitlements = require('./entitlements.service');

// ─────────────────────────────────────────────────────────────────────────────
// Intent enums — kept in sync with the two new skills' SKILL.md files.
// ─────────────────────────────────────────────────────────────────────────────
const EMAIL_INTENTS    = ['first_touch', 'follow_up', 'breakup'];
const LINKEDIN_INTENTS = ['connection_request', 'post_accept_message', 'nurture_dm'];

const SKILL_FOR_CHANNEL = {
  email:    'outreach-email',
  linkedin: 'outreach-linkedin',
  // call/task: no skill — handled as pass-through
};

// ─────────────────────────────────────────────────────────────────────────────
// isOrgAiEnabled — org-level master switch for outreach personalisation.
//
// Stored at organizations.settings.prospecting_config.ai_enabled (same blob the
// rest of the org outreach config already lives in, so no migration). The flag
// is opt-OUT: only the literal boolean false disables AI. NULL / missing / any
// other value → enabled, so existing orgs are unaffected.
//
// This is the single chokepoint: personaliseEnrollment() is the one function
// every AI path flows through (firer JIT, bulk-activate eager, the
// ai-personalise-enrollment preview, and the whole-sequence preview), so a
// guard here disables AI org-wide. When disabled, callers receive an empty
// personalisedSteps map and every consumer already falls back to the sequence
// template (renderTemplate in SequenceStepFirer; { engine: 'template' } in the
// preview routes). No call site needs to change.
//
// Lookup failure is treated as "enabled" — a transient DB hiccup must never
// silently switch a whole org to templates without the operator choosing it.
// ─────────────────────────────────────────────────────────────────────────────
async function isOrgAiEnabled(orgId) {
  try {
    const r = await pool.query(
      `SELECT (settings->'prospecting_config'->>'ai_enabled') AS ai_enabled
         FROM organizations
        WHERE id = $1`,
      [orgId]
    );
    // Column is text here (->>). Only the explicit string 'false' disables.
    return r.rows[0]?.ai_enabled !== 'false';
  } catch (err) {
    console.warn(`PersonalizationDispatcher: org AI flag lookup failed for org ${orgId}; defaulting to enabled: ${err.message}`);
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// inferIntent — when sequence_steps.step_intent is NULL, infer from
// channel + step_order + engagement_history.
//
// Rules (matching the Slice 3 spec):
//   Email:
//     - No prior outbound email AND step_order is the first email-channel
//       step in the sequence → first_touch
//     - Any later email step OR there's already a prior outbound email
//       → follow_up
//     - breakup: NEVER auto-inferred — must be explicit on the step
//
//   LinkedIn:
//     - First LinkedIn step in the sequence with no prior LinkedIn activity
//       → connection_request
//     - LinkedIn step after a linkedin_connection_accepted event in
//       engagement_history → post_accept_message
//     - Any other LinkedIn step → nurture_dm
//
// engagementHistory is the array of events from the skill context payload.
// Each entry has { type, timestamp, direction }.
// ─────────────────────────────────────────────────────────────────────────────
function inferIntent({ channel, step, allSteps, engagementHistory }) {
  const history = Array.isArray(engagementHistory) ? engagementHistory : [];

  if (channel === 'email') {
    // Index this step among email steps in the sequence (ordered by step_order).
    const emailSteps = allSteps.filter(s => s.channel === 'email');
    const isFirstEmailStep = emailSteps.length > 0 && emailSteps[0].id === step.id;

    const hasPriorOutboundEmail = history.some(e =>
      e.type === 'email_sent' && e.direction === 'outbound'
    );

    if (isFirstEmailStep && !hasPriorOutboundEmail) return 'first_touch';
    return 'follow_up';
  }

  if (channel === 'linkedin') {
    const liSteps = allSteps.filter(s => s.channel === 'linkedin');
    const isFirstLinkedinStep = liSteps.length > 0 && liSteps[0].id === step.id;

    const hasPriorLinkedinActivity = history.some(e => e.type && e.type.startsWith('linkedin_'));
    const hasConnectionAccepted = history.some(e => e.type === 'linkedin_connection_accepted');

    // First LinkedIn step in the sequence: connection_request unless we
    // already have an accepted connection (re-engagement case).
    if (isFirstLinkedinStep && !hasConnectionAccepted) return 'connection_request';

    // After the connection has been accepted, treat the next LinkedIn step
    // as a post-accept DM. Subsequent LinkedIn steps are nurture DMs.
    if (hasConnectionAccepted) {
      const hasPriorPostAcceptDm = history.some(e => e.type === 'linkedin_message_sent');
      return hasPriorPostAcceptDm ? 'nurture_dm' : 'post_accept_message';
    }

    // LinkedIn step without an accepted connection AND it's not the first
    // LinkedIn step in the sequence: unusual. Default to nurture_dm and let
    // the skill flag in confidence_notes.
    return 'nurture_dm';
  }

  return null;   // call/task — caller handles pass-through
}

// ─────────────────────────────────────────────────────────────────────────────
// validateExplicitIntent — when sequence_steps.step_intent is set, ensure it
// matches the step's channel. Misconfiguration shouldn't crash the dispatch.
// ─────────────────────────────────────────────────────────────────────────────
function isValidIntentForChannel(channel, intent) {
  if (channel === 'email')    return EMAIL_INTENTS.includes(intent);
  if (channel === 'linkedin') return LINKEDIN_INTENTS.includes(intent);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// mapSkillOutput — turns skill output into the personalised_steps[stepOrder]
// shape that the firer reads. The two skills return slightly different shapes:
//
//   outreach-email:    { email: {subject, preview_text, body}, hook, ... }
//   outreach-linkedin: { linkedin: {body, character_count}, hook, ... }
//
// Both flatten into the canonical { subject, body, task_note,
// personalize_sources } shape stored on the enrollment.
// ─────────────────────────────────────────────────────────────────────────────
function mapSkillOutput({ skillName, skillResult, channel }) {
  if (!skillResult || !skillResult.ok || !skillResult.output) {
    return null;   // skill failed; caller decides whether to fall through
  }
  const out = skillResult.output;
  const sources = {
    engine: 'skill',
    skillName,
    runId: skillResult.runId,
    hook: out.hook || null,
    stepIntent: out.step_intent || null,
    referencesPriorEvent: out.references_prior_email || out.references_prior_event || null,
    // Rep-facing decision inputs the skill already produces. Surfaced on the
    // draft card so the rep can judge "AI draft vs sequence default vs edit"
    // without re-deriving the reasoning. Previously dropped here — that loss
    // was the gap, not the skill.
    rationale:       (typeof out.rationale === 'string' && out.rationale.trim()) ? out.rationale.trim() : null,
    confidenceNotes: (typeof out.confidence_notes === 'string' && out.confidence_notes.trim()) ? out.confidence_notes.trim() : null,
  };

  if (skillName === 'outreach-email') {
    if (!out.email) return null;
    return {
      subject: out.email.subject || '',
      body: out.email.body || '',
      task_note: null,
      personalize_sources: sources,
    };
  }
  if (skillName === 'outreach-linkedin') {
    if (!out.linkedin) return null;
    // LinkedIn step bodies are rendered into the LinkedIn task card in the
    // inbox; no email subject is needed. task_note carries the intent so the
    // rep sees at a glance what kind of LinkedIn artifact this is.
    const intent = out.step_intent || 'connection_request';
    const noteMap = {
      connection_request:   'Connection request — copy the note, open the profile, send.',
      post_accept_message:  'Post-accept DM — send via LinkedIn messaging after they accept.',
      nurture_dm:           'Follow-up DM on LinkedIn — copy and send.',
    };
    return {
      subject: '',
      body: out.linkedin.body || '',
      task_note: noteMap[intent] || 'LinkedIn message — copy and send.',
      personalize_sources: sources,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// loadSequenceSteps — fetches all steps for a sequence, ordered.
// ─────────────────────────────────────────────────────────────────────────────
async function loadSequenceSteps(sequenceId, orgId) {
  const r = await pool.query(
    `SELECT id, sequence_id, step_order, channel, delay_days,
            subject_template, body_template, task_note, step_intent
       FROM sequence_steps
      WHERE sequence_id = $1 AND org_id = $2
   ORDER BY step_order ASC`,
    [sequenceId, orgId]
  );
  return r.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// loadEngagementHistory — lightweight read for inferIntent. Mirrors the
// shape SkillContextService.buildEngagementHistory produces, since the
// dispatcher needs the same data BEFORE calling the skill (to pick intent).
//
// We don't want to call buildEngagementHistory directly because it requires
// a full prospect row and pulls extra data we don't need. Instead, read just
// the type+direction+timestamp triples for the prospect.
// ─────────────────────────────────────────────────────────────────────────────
async function loadEngagementHistory(prospectId, orgId) {
  const events = [];

  // Email events
  const pRes = await pool.query(
    `SELECT email FROM prospects WHERE id = $1 AND org_id = $2`,
    [prospectId, orgId]
  );
  const email = pRes.rows[0]?.email;
  if (email) {
    const eRes = await pool.query(
      `SELECT direction, sent_at
         FROM emails
        WHERE org_id = $1
          AND (LOWER(to_address) = LOWER($2) OR LOWER(from_address) = LOWER($2))
     ORDER BY sent_at DESC NULLS LAST
        LIMIT 30`,
      [orgId, email]
    );
    for (const row of eRes.rows) {
      events.push({
        type: row.direction === 'sent' ? 'email_sent' : 'email_received',
        timestamp: row.sent_at,
        direction: row.direction === 'sent' ? 'outbound' : 'inbound',
      });
    }
  }

  // LinkedIn events from prospecting_activities.
  //
  // The only writer of LinkedIn touches is POST /prospects/:id/linkedin-event,
  // which stores a single bucket activity_type='linkedin_event' and puts the
  // granular event ('connection_request_sent', 'connection_accepted',
  // 'message_sent', 'inmail_sent', 'reply_received', ...) in metadata->>'event'.
  // (Sequence-driven LinkedIn touches land as 'sequence_step_completed' and are
  // not LinkedIn-evidence events — the rep attests the touch via linkedin-event.)
  //
  // We read that bucket and NORMALISE each granular event into the
  // 'linkedin_*' type names that inferIntent() consumes, so the intent logic
  // below is unchanged. The map is intentionally narrow — only the events that
  // affect intent inference are carried through.
  const LINKEDIN_EVENT_TYPE_MAP = {
    connection_request_sent: 'linkedin_connection_request_sent',
    connection_accepted:     'linkedin_connection_accepted',
    message_sent:            'linkedin_message_sent',
    inmail_sent:             'linkedin_message_sent',
    reply_received:          'linkedin_message_replied',
  };
  const aRes = await pool.query(
    `SELECT metadata->>'event' AS event, created_at
       FROM prospecting_activities
      WHERE prospect_id = $1
        AND activity_type = 'linkedin_event'
        AND metadata->>'event' IS NOT NULL
   ORDER BY created_at DESC
      LIMIT 30`,
    [prospectId]
  );
  for (const row of aRes.rows) {
    const mappedType = LINKEDIN_EVENT_TYPE_MAP[row.event];
    if (!mappedType) continue; // ignore events that don't affect intent (e.g. profile_viewed)
    events.push({
      type: mappedType,
      timestamp: row.created_at,
      direction: null,
    });
  }

  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public — personaliseEnrollment
//
// Walks the sequence, calls the right skill per step, returns the personalised
// steps blob and a list of any per-step errors.
//
// Inputs:
//   orgId, userId, sequenceId, prospectId
//   Optional:
//     hookPreferences  — pass-through to every personalisable step
//
// Output:
//   {
//     personalisedSteps: { [stepOrder]: { subject, body, task_note, personalize_sources } },
//     errors:            [{ stepOrder, channel, intent, reason }],
//     summary:           { total, personalised, skipped, errored }
//   }
//
// Never throws on per-step failures — those go into errors[]. Throws on
// hard failures (sequence not found, no steps, etc.) with statusCode.
// ─────────────────────────────────────────────────────────────────────────────
async function personaliseEnrollment({ orgId, userId, sequenceId, prospectId, hookPreferences, onlyStepOrder }) {
  if (!orgId || !userId || !sequenceId || !prospectId) {
    const e = new Error('orgId, userId, sequenceId, prospectId all required');
    e.statusCode = 400;
    throw e;
  }

  const steps = await loadSequenceSteps(sequenceId, orgId);
  if (steps.length === 0) {
    const e = new Error(`Sequence ${sequenceId} has no steps`);
    e.statusCode = 400;
    throw e;
  }

  // ── AI gate: platform entitlement AND org switch ───────────────────────────
  // AI runs only when BOTH are on, mirroring the modules allowed/enabled model:
  //   entitlements.ai            — PLATFORM "allowed" (has the org paid?)
  //   prospecting_config.ai_enabled — ORG admin "enabled" (do they want it on?)
  //
  // When either is off, short-circuit before any skill call: return an empty
  // personalisedSteps map so every caller falls back to the sequence template.
  // All steps count as 'skipped' (not 'errored') and we keep the existing
  // orgAiDisabled flag so bulk-activate / the firer / the preview routes
  // (which already branch on it) render templates with no call-site change.
  // The extra aiEntitled/aiEnabled fields let callers and telemetry tell
  // "unpaid" apart from "switched off" without changing the fallback contract.
  const aiEntitled = await Entitlements.isEntitled(orgId, 'ai');
  const aiEnabled  = await isOrgAiEnabled(orgId);
  if (!aiEntitled || !aiEnabled) {
    return {
      personalisedSteps: {},
      errors: [],
      summary: { total: steps.length, personalised: 0, skipped: steps.length, errored: 0 },
      orgAiDisabled: true,
      aiEntitled,
      aiEnabled,
    };
  }

  const engagementHistory = await loadEngagementHistory(prospectId, orgId);

  const personalisedSteps = {};
  const errors = [];
  let personalised = 0, skipped = 0, errored = 0;

  for (const step of steps) {
    // JIT mode: when the firer asks for a single step, personalise only that
    // one (the others are personalised lazily as the enrollment advances).
    if (onlyStepOrder != null && step.step_order !== onlyStepOrder) continue;
    const channel = step.channel;

    // call/task — skip personalisation, the firer renders templates
    if (!SKILL_FOR_CHANNEL[channel]) {
      skipped++;
      continue;
    }

    // Resolve intent: explicit override wins, else infer
    let intent = step.step_intent;
    let intentSource = 'override';
    if (intent && !isValidIntentForChannel(channel, intent)) {
      // Invalid override (e.g. someone set an email intent on a LinkedIn step
      // and a migration brought it across). Fall through to inference.
      errors.push({
        stepOrder: step.step_order,
        channel,
        intent,
        reason: `Explicit intent '${intent}' is not valid for channel '${channel}'; falling back to inference.`,
      });
      intent = null;
    }
    if (!intent) {
      intent = inferIntent({ channel, step, allSteps: steps, engagementHistory });
      intentSource = 'inferred';
    }
    if (!intent) {
      errors.push({
        stepOrder: step.step_order,
        channel,
        intent: null,
        reason: `Could not resolve intent for channel '${channel}' at step ${step.step_order}.`,
      });
      errored++;
      continue;
    }

    const skillName = SKILL_FOR_CHANNEL[channel];

    // Run the skill
    let skillResult;
    try {
      skillResult = await SkillRunnerService.runProspectSkill({
        orgId, userId, prospectId, skillName,
        hookPreferences,
        stepIntent: intent,
      });
    } catch (err) {
      errors.push({
        stepOrder: step.step_order,
        channel,
        intent,
        reason: `Skill call failed: ${err.message}`,
      });
      errored++;
      continue;
    }

    const mapped = mapSkillOutput({ skillName, skillResult, channel });
    if (!mapped) {
      errors.push({
        stepOrder: step.step_order,
        channel,
        intent,
        reason: `Skill returned unparseable or empty output (status: ${skillResult?.status || 'unknown'}).`,
      });
      errored++;
      continue;
    }

    // Stamp intent source on the personalize_sources so the rep can see
    // whether the intent was overridden or inferred.
    mapped.personalize_sources.intentSource = intentSource;

    personalisedSteps[String(step.step_order)] = mapped;
    personalised++;
  }

  return {
    personalisedSteps,
    errors,
    summary: { total: steps.length, personalised, skipped, errored },
  };
}

module.exports = {
  personaliseEnrollment,
  // Exported for unit tests:
  inferIntent,
  isValidIntentForChannel,
  mapSkillOutput,
  isOrgAiEnabled,
  EMAIL_INTENTS,
  LINKEDIN_INTENTS,
  SKILL_FOR_CHANNEL,
  // Exported so SequenceStepFirer can resolve a NULL LinkedIn step's intent
  // via the SAME inference used here (avoids duplicating the event mapping).
  loadSequenceSteps,
  loadEngagementHistory,
};
