// ─────────────────────────────────────────────────────────────────────────────
// routes/prospect-work.routes.js
//
// Signal-Based Campaigns — Phase 7: the Work-stage API behind the rep's Work
// panel. Mounted at /api/prospect-work (server.js).
//
//   GET    /:prospectId                    live work context (research is
//                                          assembled when the contact opens —
//                                          the verdict is re-computed here,
//                                          never read from stored metadata)
//   POST   /:prospectId/validate           on-page validation → source='rep',
//                                          confidence='high' signal → reeval →
//                                          returns the FRESH context (the
//                                          hook/priority can flip live)
//   POST   /:prospectId/clear-signal       "that's wrong; unknown is the truth"
//   POST   /:prospectId/not-in-role        suppress + spawn find-replacement
//   POST   /:prospectId/clear-not-in-role  undo suppression
//   POST   /:prospectId/replace-contact    capture + classify a better contact
//                                          seen on the page, switch to them
//   POST   /:prospectId/draft              layered draft: angle ← active
//                                          trigger's hook / campaign angle,
//                                          specifics ← research + validations,
//                                          structure/voice ← outreach skill
//
// OUTCOMES ARE NOT HERE (§7 "completion = the recorded outcome"): the panel
// records them on the EXISTING queue endpoints —
//   sent / queued / skipped → PATCH /api/prospecting-actions/:id/status
//   defer with reason       → PATCH /api/prospecting-actions/:id/snooze
// Reuse, don't rebuild.
//
// All queries org-scoped via req.orgId (orgContext); prospecting module gated.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');
const WorkStageService  = require('../services/WorkStageService');
const SkillRunnerService = require('../services/SkillRunnerService');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

function parseId(raw) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sendServiceError(res, err, fallback) {
  const status = err.statusCode || 500;
  if (status >= 500) console.error('[prospect-work]', err);
  return res.status(status).json({
    error: {
      message: err.message || fallback,
      ...(err.code ? { code: err.code } : {}),
      ...(err.existingProspectId ? { existingProspectId: err.existingProspectId } : {}),
    },
  });
}

// ── GET /:prospectId — the live Work-panel payload ───────────────────────────
router.get('/:prospectId', async (req, res) => {
  const prospectId = parseId(req.params.prospectId);
  if (!prospectId) return res.status(400).json({ error: { message: 'Invalid prospect id' } });
  try {
    const ctx = await WorkStageService.buildWorkContext({ orgId: req.orgId, prospectId });
    if (!ctx) return res.status(404).json({ error: { message: 'Prospect not found' } });
    res.json(ctx);
  } catch (err) {
    sendServiceError(res, err, 'Failed to build work context');
  }
});

// ── POST /:prospectId/validate — on-page validation ──────────────────────────
// body: { key, value, entityType?: 'prospect'|'account' }
// `value` is any JSON value; the engine decides what it means. Confirming a
// FAILING value is legitimate — the prospect drops honestly (no silent
// unknowns), and the action auto-resolves via the reeval.
router.post('/:prospectId/validate', async (req, res) => {
  const prospectId = parseId(req.params.prospectId);
  if (!prospectId) return res.status(400).json({ error: { message: 'Invalid prospect id' } });
  const { key, value, entityType } = req.body || {};
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: { message: 'key is required' } });
  }
  if (value === undefined) {
    return res.status(400).json({ error: { message: 'value is required (use clear-signal to mark unknown)' } });
  }
  if (entityType !== undefined && !['prospect', 'account'].includes(entityType)) {
    return res.status(400).json({ error: { message: "entityType must be 'prospect' or 'account'" } });
  }
  try {
    const ctx = await WorkStageService.validateSignal({
      orgId: req.orgId, userId: req.user.userId, prospectId, key, value, entityType,
    });
    res.json(ctx);
  } catch (err) {
    sendServiceError(res, err, 'Failed to validate signal');
  }
});

// ── POST /:prospectId/clear-signal — unknown is the truth ────────────────────
// body: { key, entityType? }
router.post('/:prospectId/clear-signal', async (req, res) => {
  const prospectId = parseId(req.params.prospectId);
  if (!prospectId) return res.status(400).json({ error: { message: 'Invalid prospect id' } });
  const { key, entityType } = req.body || {};
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: { message: 'key is required' } });
  }
  if (entityType !== undefined && !['prospect', 'account'].includes(entityType)) {
    return res.status(400).json({ error: { message: "entityType must be 'prospect' or 'account'" } });
  }
  try {
    const ctx = await WorkStageService.clearSignal({
      orgId: req.orgId, userId: req.user.userId, prospectId, key, entityType,
    });
    res.json(ctx);
  } catch (err) {
    sendServiceError(res, err, 'Failed to clear signal');
  }
});

// ── POST /:prospectId/not-in-role ─────────────────────────────────────────────
router.post('/:prospectId/not-in-role', async (req, res) => {
  const prospectId = parseId(req.params.prospectId);
  if (!prospectId) return res.status(400).json({ error: { message: 'Invalid prospect id' } });
  try {
    const result = await WorkStageService.markNotInRole({
      orgId: req.orgId, userId: req.user.userId, prospectId,
    });
    res.json(result);
  } catch (err) {
    sendServiceError(res, err, 'Failed to mark not-in-role');
  }
});

// ── POST /:prospectId/clear-not-in-role ───────────────────────────────────────
router.post('/:prospectId/clear-not-in-role', async (req, res) => {
  const prospectId = parseId(req.params.prospectId);
  if (!prospectId) return res.status(400).json({ error: { message: 'Invalid prospect id' } });
  try {
    const result = await WorkStageService.clearNotInRole({
      orgId: req.orgId, userId: req.user.userId, prospectId,
    });
    res.json(result);
  } catch (err) {
    sendServiceError(res, err, 'Failed to clear not-in-role');
  }
});

// ── POST /:prospectId/replace-contact ─────────────────────────────────────────
// body: { firstName, lastName, title?, email?, linkedinUrl? }
// 409 with code=DUPLICATE_EMAIL + existingProspectId on an email collision —
// same contract as POST /api/prospects.
router.post('/:prospectId/replace-contact', async (req, res) => {
  const prospectId = parseId(req.params.prospectId);
  if (!prospectId) return res.status(400).json({ error: { message: 'Invalid prospect id' } });
  const { firstName, lastName, title, email, linkedinUrl } = req.body || {};
  if (!firstName || !lastName) {
    return res.status(400).json({ error: { message: 'firstName and lastName are required' } });
  }
  try {
    const result = await WorkStageService.replaceContact({
      orgId: req.orgId, userId: req.user.userId, prospectId,
      firstName, lastName, title, email, linkedinUrl,
    });
    res.status(201).json(result);
  } catch (err) {
    sendServiceError(res, err, 'Failed to replace contact');
  }
});

// ── POST /:prospectId/draft — the layered signal-aware draft ──────────────────
// body: { channel: 'email'|'linkedin', stepIntent?, hookPreferences? }
//
// Assembles signal_context SERVER-SIDE from the live work context (the client
// never gets to invent the hook), then delegates to the existing skill runner:
//   angle       ← verdict.whyNow (top active trigger's hook, else campaign
//                 angle — resolved by the engine through the function taxonomy)
//   specifics   ← rep-validated facts (source='rep' signals) + saved research
//                 (already inside the prospect context the skill builds)
//   structure/voice ← the outreach skill itself. Never "just a template."
router.post('/:prospectId/draft', async (req, res) => {
  const prospectId = parseId(req.params.prospectId);
  if (!prospectId) return res.status(400).json({ error: { message: 'Invalid prospect id' } });

  const { channel, stepIntent, hookPreferences } = req.body || {};
  if (!['email', 'linkedin'].includes(channel)) {
    return res.status(400).json({ error: { message: "channel must be 'email' or 'linkedin'" } });
  }
  if (hookPreferences !== undefined && !Array.isArray(hookPreferences)) {
    return res.status(400).json({ error: { message: 'hookPreferences must be an array of strings' } });
  }

  // Same intent enums as routes/skills.routes.js — kept in sync.
  const EMAIL_INTENTS    = ['first_touch', 'follow_up', 'breakup'];
  const LINKEDIN_INTENTS = ['connection_request', 'post_accept_message', 'nurture_dm'];
  const skillName = channel === 'email' ? 'outreach-email' : 'outreach-linkedin';
  const validIntents = channel === 'email' ? EMAIL_INTENTS : LINKEDIN_INTENTS;
  const intent = stepIntent || validIntents[0];
  if (!validIntents.includes(intent)) {
    return res.status(400).json({ error: { message: `stepIntent must be one of: ${validIntents.join(', ')}` } });
  }

  try {
    const ctx = await WorkStageService.buildWorkContext({ orgId: req.orgId, prospectId });
    if (!ctx) return res.status(404).json({ error: { message: 'Prospect not found' } });

    const verdict = ctx.verdict;
    const signalContext = {
      why_now:        verdict ? verdict.whyNow : null,
      active_trigger: verdict && verdict.activeTrigger ? verdict.activeTrigger.label : null,
      priority:       verdict ? verdict.priority : null,
      campaign:       ctx.campaign ? ctx.campaign.name : null,
      // Rep-validated facts — the on-page validations the draft's specifics
      // draw from. Known values only; the model never sees stale/unknowns as
      // facts (unknown, never false — even in the prompt).
      validated_facts: ctx.signals
        .filter((s) => s.repWritten && s.state === 'known')
        .map((s) => ({ label: s.label, value: s.value })),
      // What's still unconfirmed — the skill is told NOT to assert these.
      unconfirmed: ctx.confirmations.map((c) => c.label),
    };

    const result = await SkillRunnerService.runProspectSkill({
      orgId:      req.orgId,
      userId:     req.user.userId,
      prospectId,
      skillName,
      stepIntent: intent,
      hookPreferences: hookPreferences || null,
      signalContext,
      dryRun:        req.query.dryRun === 'true',
      forceGenerate: req.query.forceGenerate === 'true',
    });
    res.json({ ...result, signalContext });
  } catch (err) {
    sendServiceError(res, err, 'Work-stage draft failed');
  }
});

module.exports = router;
