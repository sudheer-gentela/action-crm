// routes/extension.routes.js
//
// Serves version metadata for the GoWarmCRM LinkedIn Chrome extension.
//
// The extension polls GET /api/extension/version on startup and every
// 6 hours. It compares `latest` against its own manifest version and,
// if it's behind, shows an "update available" banner in the popup that
// links to `download_url`. The install page (install-extension.html)
// also calls this endpoint to display the current version.
//
// SINGLE SOURCE OF TRUTH: extension-version.json (sits next to this
// file). To publish a new extension version, edit that JSON file,
// commit, and push — Railway auto-deploys. No dashboard, no env vars,
// and every version bump is captured in git history.
//
// This route is intentionally UNAUTHENTICATED:
//   - version info is not sensitive
//   - an unauthenticated route means the check still works when the
//     user is logged out of GoWarmCRM

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();

// Path to the version manifest. Kept next to this route file so it
// travels with the backend repo.
const VERSION_FILE = path.join(__dirname, 'extension-version.json');

// Safe fallback used only if the JSON file is missing or unparseable —
// the endpoint should never hard-fail and break the extension's check.
const FALLBACK = {
  latest:        '0.0.0',
  min_supported: '0.0.0',
  download_url:  'https://gowarmcrm.com/install-extension',
};

// Read and parse the version file fresh on each request. The file is
// tiny and the route is edge-cached (below), so the disk read is
// negligible — and reading fresh means a redeploy's new values take
// effect immediately without a process restart.
function readVersionInfo() {
  try {
    const raw  = fs.readFileSync(VERSION_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      latest:        data.latest        || FALLBACK.latest,
      min_supported: data.min_supported || FALLBACK.min_supported,
      download_url:  data.download_url  || FALLBACK.download_url,
    };
  } catch (err) {
    console.error('[extension.routes] could not read extension-version.json:', err.message);
    return FALLBACK;
  }
}

// ── GET /api/extension/version ───────────────────────────────────────────────
router.get('/version', (req, res) => {
  // Cache at the browser/CDN edge for 5 minutes. With many installed
  // copies each polling every 6 hours, this keeps origin load near zero
  // while still letting a version bump propagate quickly.
  res.set('Cache-Control', 'public, max-age=300');

  // CORS: the install page on gowarmcrm.com fetches this from a
  // different origin than api.gowarmcrm.com. Allow it explicitly so
  // the page's version line works. (The extension itself is not
  // subject to page CORS, but this header is harmless for it.)
  res.set('Access-Control-Allow-Origin', '*');

  res.json(readVersionInfo());
});

module.exports = router;

// ─────────────────────────────────────────────────────────────────────────────
// MOUNTING — add this line where your other routes are registered (app.js):
//
//   app.use('/api/extension', require('./routes/extension.routes'));
//
// The full endpoint path becomes: /api/extension/version
//
// IMPORTANT: this route must NOT be behind auth middleware. If your app
// applies auth globally under /api, mount this BEFORE that middleware
// or exempt the /api/extension path — otherwise it returns 401 and the
// extension's version check silently fails.
//
// ─────────────────────────────────────────────────────────────────────────────
// RELEASE CHECKLIST — when you ship a new extension build:
//   1. Bump "version" in the extension's manifest.json
//   2. Build the new zip
//   3. Upload the zip, overwriting gowarm-linkedin-ext-latest.zip
//   4. Edit extension-version.json -> bump "latest" -> commit + push
// Within ~6 hours every installed extension shows the update banner.
// ─────────────────────────────────────────────────────────────────────────────
