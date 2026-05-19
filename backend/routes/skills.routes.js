// ============================================================================
// routes/skills.routes.js
//
// User-facing skill-execution endpoints. Authenticated by the normal user JWT
// + orgContext — NOT the retired SKILL_RUNNER_TOKEN shared secret. orgId and
// userId come from the authenticated session.
//
//   POST /api/skills/outreach-personalization/run
//        body: { prospectId, hookPreferences?: string[] }
//
//   POST /api/skills/discovery-call-prep/run
//        body: { dealId, methodology?: 'meddic' | 'challenger' }
//
// Both delegate to SkillRunnerService, which builds context in-process,
// resolves a model via AIClientResolver, runs the skill, logs token usage,
// and persists a skill_runs row.
// ============================================================================

const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');
const SkillRunnerService = require('../services/SkillRunnerService');

router.use(authenticateToken);
router.use(orgContext);

// Helper: normalize a thrown service error into an HTTP response.
function sendSkillError(res, err, fallbackMsg) {
  const status = err.statusCode || 500;
  console.error('[skills route]', err.message);
  return res.status(status).json({
    error: { message: err.message || fallbackMsg },
    ...(err.runId ? { runId: err.runId } : {}),
  });
}

// ── POST /outreach-personalization/run ───────────────────────────────────────
// Prospecting-module gated. Generates the first-touch outreach package for a
// prospect.
router.post(
  '/outreach-personalization/run',
  requireModule('prospecting'),
  async (req, res) => {
    const { prospectId, hookPreferences } = req.body || {};
    if (!prospectId || !/^\d+$/.test(String(prospectId))) {
      return res.status(400).json({ error: { message: 'prospectId (numeric) is required' } });
    }
    if (hookPreferences !== undefined && !Array.isArray(hookPreferences)) {
      return res.status(400).json({ error: { message: 'hookPreferences must be an array of strings' } });
    }

    try {
      const result = await SkillRunnerService.runProspectSkill({
        orgId:     req.orgId,
        userId:    req.user.userId,
        prospectId: parseInt(prospectId, 10),
        skillName: 'outreach-personalization',
        hookPreferences: hookPreferences || null,
      });
      // result.ok === false for parse failures — still a 200 with the detail,
      // so the UI can show "the model returned unparseable output, retry".
      return res.json(result);
    } catch (err) {
      return sendSkillError(res, err, 'Outreach skill failed');
    }
  }
);

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

module.exports = router;
