// routes/help.routes.js
// ─────────────────────────────────────────────────────────────
// Hard gate for the Help Center.
//
// Two endpoints:
//   GET /api/help/grant?role=<activeRole>   (auth required)
//       → verifies the caller server-side, computes which guides their
//         role may read, and returns a short-lived SIGNED token plus the
//         guide that matches their active role.
//
//   GET /api/help/:guide                     (NO auth header — token in URL/cookie)
//       → verifies the signed token (from ?t= on first hit, or the help_t
//         cookie on in-bundle navigation), checks the requested guide is in
//         the token's allow-list, and serves the static HTML — or 401/403.
//
// Why a signed URL + cookie (not the normal Bearer header):
//   The guides open in a NEW TAB, and a plain navigation can't send an
//   Authorization header. So the app fetches a grant (with its Bearer
//   token) and opens /api/help/<guide>?t=<signed>. The page route then
//   drops a short-lived, HttpOnly cookie so the in-bundle links
//   (“← All guides”, the landing cards) keep working without re-minting.
//
// Roles are determined SERVER-SIDE here (org role from the JWT, super-admin
// from the super_admins table) — the client cannot grant itself access.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const jwt     = require('jsonwebtoken');
const db      = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');

const router = express.Router();

// Dedicated secret if provided, else reuse the app JWT secret so this works
// with zero new env vars. Setting HELP_URL_SECRET separately is recommended.
const SECRET     = process.env.HELP_URL_SECRET || process.env.JWT_SECRET;
const TTL        = process.env.HELP_URL_TTL || '15m';
const COOKIE_MS  = 15 * 60 * 1000; // keep roughly aligned with TTL
const HELP_DIR   = path.join(__dirname, '..', 'help');

// Whitelist of servable guides → filenames (prevents path traversal).
const FILES = {
  index:      'index.html',
  superadmin: 'superadmin.html',
  orgadmin:   'orgadmin.html',
  enduser:    'enduser.html',
};

// Map an app "active role" slug to the guide it should open.
const ROLE_TO_GUIDE = {
  'super-admin': 'superadmin', 'super_admin': 'superadmin', 'superadmin': 'superadmin', 'super-user': 'superadmin',
  'org-admin': 'orgadmin', 'org_admin': 'orgadmin', 'admin': 'orgadmin', 'orgadmin': 'orgadmin',
  'member': 'enduser', 'rep': 'enduser', 'user': 'enduser', 'enduser': 'enduser',
};

async function isSuperAdmin(userId) {
  const r = await db.query(
    `SELECT 1 FROM super_admins WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  return r.rows.length > 0;
}

// Same access model as the soft gate / App.js role derivation.
function guidesFor(orgRole, superAdmin) {
  const g = ['enduser'];
  if (orgRole === 'owner' || orgRole === 'admin') g.push('orgadmin');
  if (superAdmin) { g.push('orgadmin', 'superadmin'); }
  return Array.from(new Set(g));
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// Remove landing cards the viewer can't access (the in-page JS soft-gate can't
// see the app's localStorage from this origin, so we filter server-side here).
function filterLandingCards(html, allowed) {
  return html.replace(
    /\n\s*<a class="lp-card" data-guide="([a-z]+)"[\s\S]*?<\/a>\n/g,
    (match, guide) => (allowed.includes(guide) ? match : '\n')
  );
}

function errorPage(title, body) {
  return `<!doctype html><meta charset="utf-8">
<title>${title}</title>
<style>body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#F6F7F9;color:#2B3340;
display:grid;place-items:center;height:100vh;margin:0}
.card{background:#fff;border:1px solid #E5E7EB;border-radius:14px;padding:32px 36px;max-width:420px;
box-shadow:0 8px 24px rgba(16,24,40,.06);text-align:center}
h1{color:#1A3A5C;font-size:19px;margin:0 0 8px}p{color:#6B7280;margin:0}b{color:#E8630A}</style>
<div class="card"><h1>${title}</h1><p>${body}</p></div>`;
}

// ── GET /api/help/grant ──────────────────────────────────────
router.get('/grant', authenticateToken, async (req, res) => {
  try {
    const orgRole    = req.user.role || 'member';   // JWT carries the org role
    const superAdmin = await isSuperAdmin(req.userId);
    const guides     = guidesFor(orgRole, superAdmin);

    // Pick the guide for the role the user is currently in; clamp to allowed.
    const want = String(req.query.role || '').toLowerCase();
    let primary = ROLE_TO_GUIDE[want] || guides[guides.length - 1];
    if (!guides.includes(primary)) primary = guides[guides.length - 1];

    const token = jwt.sign({ guides, uid: req.userId }, SECRET, { expiresIn: TTL });
    res.json({ token, guides, primary });
  } catch (e) {
    console.error('[help-grant]', e.message);
    res.status(500).json({ error: { message: 'Could not open help right now.' } });
  }
});

// ── GET /api/help/:guide ─────────────────────────────────────
router.get('/:guide', (req, res) => {
  const key  = String(req.params.guide).replace(/\.html$/i, '').toLowerCase();
  const file = FILES[key];
  if (!file) return res.status(404).type('html').send(errorPage('Not found', 'That help page does not exist.'));

  // token: query on first hit, cookie on in-bundle navigation
  const raw = req.query.t || parseCookies(req.headers.cookie).help_t;
  let decoded;
  try { decoded = jwt.verify(raw, SECRET); }
  catch {
    return res.status(401).type('html').send(
      errorPage('Link expired', 'Please reopen <b>Help &amp; Guides</b> from inside GoWarmCRM.')
    );
  }

  const allowed = decoded.guides || [];
  // 'index' (the landing) is viewable by any valid token; its cards are
  // filtered to the allowed set below.
  if (key !== 'index' && !allowed.includes(key)) {
    return res.status(403).type('html').send(
      errorPage('Not available for your role', 'This guide is for a different role. Open <b>Help &amp; Guides</b> from the app to see yours.')
    );
  }

  let html;
  try { html = fs.readFileSync(path.join(HELP_DIR, file), 'utf8'); }
  catch { return res.status(500).type('html').send(errorPage('Unavailable', 'The help content could not be loaded.')); }

  if (key === 'index') html = filterLandingCards(html, allowed);

  // Refresh the short-lived cookie so relative in-bundle links keep working.
  res.cookie('help_t', raw, {
    httpOnly: true, secure: true, sameSite: 'lax',
    path: '/api/help', maxAge: COOKIE_MS,
  });
  res.type('html').send(html);
});

module.exports = router;
