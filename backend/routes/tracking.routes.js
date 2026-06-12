// ─────────────────────────────────────────────────────────────────────────────
// routes/tracking.routes.js — Phase 7 (docs/INSIGHTS_WBR_DESIGN.md)
//
// PUBLIC, UNAUTHENTICATED endpoints — a deliberate exception to the auth
// pattern. They are hit by recipients' mail clients and browsers via the
// per-customer tracking hostnames (Host header carries t.customerco.com;
// Cloudflare for SaaS proxies to this origin). Security model: HMAC tokens
// (unforgeable, no PII, org cross-checked against the Host) — there is
// nothing to authenticate and nothing sensitive to leak.
//
// Mount in server.js BEFORE any auth middleware, next to other app.use lines:
//   app.use('/t', require('./routes/tracking.routes'));
//
//   GET /t/o/:token        → 1x1 transparent GIF (open)
//   GET /t/c/:token?u=URL  → 302 redirect to URL (click)
//
// Both endpoints ALWAYS answer fast and safely: bad/expired/foreign tokens
// still get the pixel / a redirect (to the u param when present and sane,
// else the marketing site) — recipients never see an error page because of
// our bookkeeping. Event insertion is awaited but never throws (service
// contract).
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const EmailTrackingService = require('../services/EmailTrackingService');

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const FALLBACK_REDIRECT = 'https://gowarmcrm.com';

function clientIp(req) {
  return (req.headers['cf-connecting-ip'] ||
          String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
          req.socket?.remoteAddress || '');
}

/** Only ever redirect to http(s) URLs — never javascript:/data: etc. */
function safeUrl(u) {
  try {
    const parsed = new URL(String(u));
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : null;
  } catch (e) { return null; }
}

router.get('/o/:token', async (req, res) => {
  await EmailTrackingService.recordEvent({
    token: req.params.token, eventType: 'open',
    host: req.headers.host, userAgent: req.headers['user-agent'], ip: clientIp(req),
  });
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Content-Length': PIXEL.length,
  });
  res.status(200).end(PIXEL);
});

router.get('/c/:token', async (req, res) => {
  const dest = safeUrl(req.query.u);
  await EmailTrackingService.recordEvent({
    token: req.params.token, eventType: 'click',
    host: req.headers.host, userAgent: req.headers['user-agent'], ip: clientIp(req),
    urlParam: dest,
  });
  res.redirect(302, dest || FALLBACK_REDIRECT);
});

module.exports = router;
