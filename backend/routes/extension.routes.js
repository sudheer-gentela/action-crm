// routes/extension.routes.js
//
// Backend route powering the LinkedIn Chrome extension's version banner.
//
// The extension polls GET /api/extension/version on service-worker startup
// and every 6 hours. When `latest` here is ahead of the installed version,
// the popup shows an amber "A new version is available" banner linking to
// `download_url`. The install page (install-extension.html) also calls
// this endpoint to keep its headline version string in sync.
//
// Unauthenticated by design — version info isn't sensitive, and an unauth
// endpoint means the check works before the user logs in. The 5-minute
// cache header keeps load near zero even with thousands of installed
// copies polling on their own schedules.
//
// Mount in app.js:
//   app.use('/api/extension', require('./routes/extension.routes'));
//
// ── Release checklist when you ship a new extension build ────────────────────
//   1. Bump `version` in the extension's manifest.json.
//   2. Build the new zip (e.g. gowarm-linkedin-ext-vX.Y.Z.zip).
//   3. Upload the zip so EXTENSION_DOWNLOAD_URL serves it (or so the
//      install page that EXTENSION_DOWNLOAD_URL points to serves it).
//   4. Bump EXTENSION_LATEST_VERSION below and deploy.
//
// Within ~6 hours, every installed extension picks up the new version on
// its next scheduled check. Users who open the popup before then trigger
// an immediate refresh and see the banner on their next popup open.

const express = require('express');
const router  = express.Router();

// ── Single source of truth for the current extension build ──────────────────
//
// These three constants are the only thing you edit per release. Keep
// EXTENSION_LATEST_VERSION exactly in sync with manifest.json's `version`
// in the build you just shipped — that's how the extension knows whether
// the copy on a user's machine is behind.

const EXTENSION_LATEST_VERSION  = '1.7.3';
const EXTENSION_MIN_SUPPORTED   = '1.7.0';
const EXTENSION_DOWNLOAD_URL    = 'https://app.gowarmcrm.com/install-extension';

// ── GET /version ─────────────────────────────────────────────────────────────
//
// Response shape (the extension reads `latest` and `download_url`; the
// other fields are stored for future use but not yet acted on):
//
//   {
//     "latest":        "1.7.3",
//     "download_url":  "https://app.gowarmcrm.com/install-extension",
//     "min_supported": "1.7.0"
//   }

router.get('/version', (req, res) => {
  // Cache for 5 minutes at the CDN/browser edge. The extension polls at
  // most every 6 hours per installed copy, so this cache window is
  // generous — it just protects against unexpected bursts (e.g. many
  // users opening the popup at the same time after a company-wide
  // announcement that a new version exists).
  res.set('Cache-Control', 'public, max-age=300');

  res.json({
    latest:        EXTENSION_LATEST_VERSION,
    download_url:  EXTENSION_DOWNLOAD_URL,
    min_supported: EXTENSION_MIN_SUPPORTED,
  });
});

module.exports = router;
