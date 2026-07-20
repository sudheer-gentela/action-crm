// routes/company-capture.routes.js
//
// DROP-IN LOCATION: backend/routes/company-capture.routes.js
// Mount in server.js: app.use('/api/company-capture', require('./routes/company-capture.routes'));
//
// Phase 10 — the Chrome extension's company-page capture surface (the
// company analogue of linkedin-profiles.routes.js, which remains the /in/*
// person-capture surface).
//
//   GET  /api/company-capture/match?linkedinCompanyUrl=&domain=
//        Read-only account-match preview for the on-page panel:
//        { accountId, accountName, matchedBy: 'linkedin_url'|'domain'|'none' }
//
//   POST /api/company-capture/save
//        One explicit rep tap. Body:
//        { capture: { name, industry, hqCity, hqCountry, description,
//                     memberCount, sizeRange, jobOpenings, latestPostAt,
//                     websiteDomain, linkedinCompanyUrl, slug },
//          createIfMissing?: boolean }   ← true only from the panel's
//                                          explicit "Create account & save"
//        Soft failures (no_matching_account / nothing_extractable /
//        no_company_name) come back 200 + ok:false so the panel can show a
//        notice, not an error state.
//
// All routes org-scoped (req.orgId) and authenticated — same middleware
// stack as linkedin-profiles.routes.js.

const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');
const CompanyPageIngest = require('../services/CompanyPageSignalIngestService');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

// ── GET /match — panel preview ────────────────────────────────────────────────
router.get('/match', async (req, res) => {
  try {
    const match = await CompanyPageIngest.matchAccount({
      orgId: req.orgId,
      linkedinCompanyUrl: req.query.linkedinCompanyUrl || null,
      domain: req.query.domain || null,
      linkedinCompanyId: req.query.linkedinCompanyId || null,
    });
    res.json({ success: true, ...match });
  } catch (err) {
    console.error('[company-capture] match error:', err);
    res.status(500).json({ error: { message: 'Match lookup failed' } });
  }
});

// ── POST /save — the explicit rep tap ─────────────────────────────────────────
router.post('/save', async (req, res) => {
  const { capture, createIfMissing } = req.body || {};
  if (!capture || typeof capture !== 'object') {
    return res.status(400).json({ error: { message: 'capture object is required' } });
  }
  try {
    const result = await CompanyPageIngest.ingestCompanyCapture({
      orgId: req.orgId,
      userId: req.user.userId,
      capture,
      createIfMissing: createIfMissing === true,
    });
    res.json(result);
  } catch (err) {
    console.error('[company-capture] save error:', err);
    res.status(500).json({ error: { message: err.message || 'Save failed' } });
  }
});

module.exports = router;
