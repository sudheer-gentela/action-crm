// ============================================================================
// routes/skills.routes.js
//
// User-facing skill-execution endpoints. Authenticated by the normal user JWT
// + orgContext — NOT the retired SKILL_RUNNER_TOKEN shared secret. orgId and
// userId come from the authenticated session.
//
// Slice 3:
//   POST /api/skills/outreach-email/run
//        body: { prospectId, stepIntent?: 'first_touch'|'follow_up'|'breakup',
//                hookPreferences?: string[] }
//        Default stepIntent is 'first_touch'.
//
//   POST /api/skills/outreach-linkedin/run
//        body: { prospectId, stepIntent?: 'connection_request'|'post_accept_message'|'nurture_dm',
//                hookPreferences?: string[] }
//        Default stepIntent is 'connection_request'.
//
//   POST /api/skills/discovery-call-prep/run
//        body: { dealId, methodology?: 'meddic' | 'challenger' }
//
//   POST /api/skills/outreach-personalization/run
//        DEPRECATED — returns 410 Gone. Callers should use outreach-email
//        and outreach-linkedin in parallel for the first-touch package.
//
// All non-deprecated endpoints delegate to SkillRunnerService.
// ============================================================================

const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');
const SkillRunnerService = require('../services/SkillRunnerService');
const ProspectClassifier = require('../services/ProspectClassifier');
const { sanitizeOrgConfig } = require('../config/prospectingConfigSchema');

router.use(authenticateToken);
router.use(orgContext);

// Valid intent enums — kept in sync with PersonalizationDispatcher and both
// new skills' SKILL.md files.
const EMAIL_INTENTS    = ['first_touch', 'follow_up', 'breakup'];
const LINKEDIN_INTENTS = ['connection_request', 'post_accept_message', 'nurture_dm'];

// Helper: normalize a thrown service error into an HTTP response.
function sendSkillError(res, err, fallbackMsg) {
  const status = err.statusCode || 500;
  console.error('[skills route]', err.message);
  return res.status(status).json({
    error: { message: err.message || fallbackMsg },
    ...(err.runId ? { runId: err.runId } : {}),
  });
}

// ── POST /outreach-email/run ─────────────────────────────────────────────────
// Generates one email for a prospect. step_intent picks the template.
router.post(
  '/outreach-email/run',
  requireModule('prospecting'),
  async (req, res) => {
    const { prospectId, stepIntent, hookPreferences } = req.body || {};
    if (!prospectId || !/^\d+$/.test(String(prospectId))) {
      return res.status(400).json({ error: { message: 'prospectId (numeric) is required' } });
    }
    if (hookPreferences !== undefined && !Array.isArray(hookPreferences)) {
      return res.status(400).json({ error: { message: 'hookPreferences must be an array of strings' } });
    }
    const intent = stepIntent || 'first_touch';
    if (!EMAIL_INTENTS.includes(intent)) {
      return res.status(400).json({
        error: { message: `stepIntent must be one of: ${EMAIL_INTENTS.join(', ')}` },
      });
    }

    try {
      const result = await SkillRunnerService.runProspectSkill({
        orgId:     req.orgId,
        userId:    req.user.userId,
        prospectId: parseInt(prospectId, 10),
        skillName: 'outreach-email',
        hookPreferences: hookPreferences || null,
        stepIntent: intent,
        // Inspect-before-send + manual override + provenance/lint preview.
        dryRun:        req.query.dryRun === 'true',
        forceGenerate: req.query.forceGenerate === 'true',
        explain:       req.query.explain === 'true',
      });
      return res.json(result);
    } catch (err) {
      return sendSkillError(res, err, 'Outreach email skill failed');
    }
  }
);

// ── POST /outreach-linkedin/run ──────────────────────────────────────────────
// Generates one LinkedIn artifact for a prospect. step_intent picks the template.
router.post(
  '/outreach-linkedin/run',
  requireModule('prospecting'),
  async (req, res) => {
    const { prospectId, stepIntent, hookPreferences } = req.body || {};
    if (!prospectId || !/^\d+$/.test(String(prospectId))) {
      return res.status(400).json({ error: { message: 'prospectId (numeric) is required' } });
    }
    if (hookPreferences !== undefined && !Array.isArray(hookPreferences)) {
      return res.status(400).json({ error: { message: 'hookPreferences must be an array of strings' } });
    }
    const intent = stepIntent || 'connection_request';
    if (!LINKEDIN_INTENTS.includes(intent)) {
      return res.status(400).json({
        error: { message: `stepIntent must be one of: ${LINKEDIN_INTENTS.join(', ')}` },
      });
    }

    try {
      const result = await SkillRunnerService.runProspectSkill({
        orgId:     req.orgId,
        userId:    req.user.userId,
        prospectId: parseInt(prospectId, 10),
        skillName: 'outreach-linkedin',
        hookPreferences: hookPreferences || null,
        stepIntent: intent,
        // Inspect-before-send + manual override + provenance/lint preview.
        dryRun:        req.query.dryRun === 'true',
        forceGenerate: req.query.forceGenerate === 'true',
        explain:       req.query.explain === 'true',
      });
      return res.json(result);
    } catch (err) {
      return sendSkillError(res, err, 'Outreach LinkedIn skill failed');
    }
  }
);

// ── POST /outreach-personalization/run (DEPRECATED) ──────────────────────────
// Slice 3 retires this skill. Returns 410 Gone with the redirect hint. Kept
// as a route (not removed) so callers see a useful error rather than a 404.
//
// Frontend OutreachSkillPanel was updated in Slice 3 to call the two new
// endpoints in parallel; if you see a request hit this path, it's coming
// from a stale browser cache or a script that hasn't been updated.
router.post('/outreach-personalization/run', (req, res) => {
  res.status(410).json({
    error: {
      message: 'outreach-personalization has been retired. ' +
               'Call /api/skills/outreach-email/run AND /api/skills/outreach-linkedin/run ' +
               '(in parallel, with step_intent: first_touch / connection_request) for an equivalent first-touch package.',
      code: 'SKILL_RETIRED',
      replacedBy: ['outreach-email', 'outreach-linkedin'],
    },
  });
});

// ── POST /discovery-call-prep/run ────────────────────────────────────────────
// Deal-side skill. Deals are a core module, so only auth + orgContext gate it.
router.post('/discovery-call-prep/run', async (req, res) => {
  const { dealId, methodology } = req.body || {};
  if (!dealId || !/^\d+$/.test(String(dealId))) {
    return res.status(400).json({ error: { message: 'dealId (numeric) is required' } });
  }

  try {
    const result = await SkillRunnerService.runDealSkill({
      orgId:     req.orgId,
      userId:    req.user.userId,
      dealId:    parseInt(dealId, 10),
      skillName: 'discovery-call-prep',
      methodology: methodology || null,
    });
    return res.json(result);
  } catch (err) {
    return sendSkillError(res, err, 'Discovery call prep skill failed');
  }
});

// ── POST /classify/preview ───────────────────────────────────────────────────
// Title-classifier keyword tuning loop. The config surface is KEYWORDS; this
// endpoint runs them (after the SAME sanitization a save applies) against
// sample titles and returns the resulting function/seniority/decision_maker
// plus a trace showing which keyword matched and the regex it compiled to — so
// an operator can correct their keywords until the output is right, BEFORE
// saving. Pure: no model call, no writes.
//
// body: { titles: string[] (1..50), classifier?: {function_rules, seniority_rules, decision_maker} }
//   classifier omitted -> previews the built-in defaults only.
router.post('/classify/preview', requireModule('prospecting'), (req, res) => {
  const { titles, classifier } = req.body || {};
  if (!Array.isArray(titles) || titles.length === 0) {
    return res.status(400).json({ error: { message: 'titles must be a non-empty array of strings' } });
  }
  if (titles.length > 50) {
    return res.status(400).json({ error: { message: 'titles is capped at 50 per preview' } });
  }
  // Validate/normalize the draft classifier through the org sanitizer so the
  // preview reflects exactly what would be stored and enforced (bad enum values
  // / empty keyword lists are dropped here, visibly).
  const sanitized = sanitizeOrgConfig({ title_classifier: classifier || {} }).title_classifier;

  const results = titles.map(title => {
    const r = ProspectClassifier.classifyTitleTrace(String(title || ''), sanitized);
    return {
      title: String(title || ''),
      function: r.function,
      seniority: r.seniority,
      decision_maker: r.decision_maker,
      trace: r.trace,
    };
  });

  return res.json({ classifier: sanitized, results });
});

module.exports = router;
