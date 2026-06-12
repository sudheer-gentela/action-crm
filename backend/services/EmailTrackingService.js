/**
 * EmailTrackingService.js
 *
 * Phase 7 of the Outbound Insights & WBR system (docs/INSIGHTS_WBR_DESIGN.md).
 *
 * Three jobs:
 *   1. TOKENS — compact HMAC-signed tokens carrying (orgId, stepLogId,
 *      linkIndex). No PII in URLs; tokens cannot be forged or enumerated.
 *      Secret: TRACKING_TOKEN_SECRET (falls back to JWT_SECRET).
 *   2. DECORATION — called by SequenceStepFirer at send time (email channel
 *      only). Gated on ALL of: org has an ACTIVE tracking domain (D40 — no
 *      shared fallback, ever), campaign toggle on
 *      (prospecting_config_override.tracking.{opens,clicks}, default OFF).
 *      Clicks: rewrites http(s) hrefs through https://{customerHost}/t/c/{token}.
 *      Opens: appends a 1x1 pixel https://{customerHost}/t/o/{token}.
 *      mailto:/tel:/anchor links and unsubscribe headers are never touched.
 *      NEVER throws into the send path — any failure returns the original
 *      HTML untouched.
 *   3. EVENT RECORDING — called by the public tracking routes. Classifies
 *      bots at write time (D41): known scanner UAs (Outlook SafeLinks,
 *      security appliances), clicks within TOO_SOON_SECONDS of the send
 *      (scanners click on arrival), missing-UA requests. Bot events are
 *      flagged, not dropped. Opens dedupe per (step_log, UTC day) for the
 *      snapshot via a count-once rule at query time.
 */

const crypto = require('crypto');
const db = require('../config/database');

const TOO_SOON_SECONDS = 10;

const SCANNER_UA_RE = /safelinks|microsoft office|outlook-protect|googleimageproxy|barracuda|mimecast|proofpoint|symantec|trendmicro|forcepoint|paloalto|fireeye|bitdefender|python-requests|curl\/|wget\/|go-http-client|okhttp|headlesschrome|phantomjs|bot\b|crawler|spider/i;

function secret() {
  const s = process.env.TRACKING_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error('TRACKING_TOKEN_SECRET / JWT_SECRET not set');
  return s;
}

// ── tokens ───────────────────────────────────────────────────────────────────

function b64u(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

/** token = b64u(payload).b64u(hmac16(payload)) ; payload = "orgId.stepLogId.linkIndex" */
function signToken(orgId, stepLogId, linkIndex = 0) {
  const payload = `${orgId}.${stepLogId}.${linkIndex}`;
  const mac = crypto.createHmac('sha256', secret()).update(payload).digest().subarray(0, 16);
  return `${b64u(Buffer.from(payload))}.${b64u(mac)}`;
}

/** Returns { orgId, stepLogId, linkIndex } or null on any tamper/garbage. */
function verifyToken(token) {
  try {
    const [p, m] = String(token).split('.');
    if (!p || !m) return null;
    const payload = unb64u(p).toString('utf8');
    const expect = crypto.createHmac('sha256', secret()).update(payload).digest().subarray(0, 16);
    const got = unb64u(m);
    if (got.length !== expect.length || !crypto.timingSafeEqual(expect, got)) return null;
    const [orgId, stepLogId, linkIndex] = payload.split('.').map(Number);
    if (!Number.isInteger(orgId) || !Number.isInteger(stepLogId)) return null;
    return { orgId, stepLogId, linkIndex: Number.isInteger(linkIndex) ? linkIndex : 0 };
  } catch (e) { return null; }
}

// ── decoration ───────────────────────────────────────────────────────────────

/** Org's active tracking hostname or null. */
async function getActiveHostname(client, orgId) {
  const r = await client.query(
    `SELECT hostname FROM tracking_domains WHERE org_id = $1 AND status = 'active' LIMIT 1`,
    [orgId]
  );
  return r.rows[0]?.hostname || null;
}

/** Campaign toggles via the prospect's campaign. Default OFF (D39, amended:
 *  dedicated columns — the config-override jsonb is replace-on-save and
 *  would silently wipe a tracking key). */
async function getCampaignTracking(client, orgId, prospectId) {
  const r = await client.query(
    `SELECT pc.tracking_opens AS opens, pc.tracking_clicks AS clicks
       FROM prospects p
       LEFT JOIN prospecting_campaigns pc ON pc.id = p.campaign_id AND pc.org_id = p.org_id
      WHERE p.id = $1 AND p.org_id = $2`,
    [prospectId, orgId]
  );
  const row = r.rows[0] || {};
  return { opens: row.opens === true, clicks: row.clicks === true };
}

const HREF_RE = /(<a\b[^>]*?\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi;

/** Rewrite hrefs + append pixel. Pure function — exported for tests. */
function decorate(html, { host, orgId, stepLogId, opens, clicks }) {
  let out = String(html || '');
  if (clicks) {
    let idx = 0;
    out = out.replace(HREF_RE, (full, pre, q, url) => {
      // Never rewrite links already on the tracking host (idempotence).
      if (url.includes(`//${host}/`)) return full;
      const token = signToken(orgId, stepLogId, idx++);
      return `${pre}${q}https://${host}/t/c/${token}?u=${encodeURIComponent(url)}${q}`;
    });
  }
  if (opens) {
    const pixel = `<img src="https://${host}/t/o/${signToken(orgId, stepLogId, 0)}" width="1" height="1" alt="" style="display:none" />`;
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${pixel}</body>`) : out + pixel;
  }
  return out;
}

/**
 * Send-path entry point. Returns decorated HTML, or the ORIGINAL html on any
 * gate failure or error — this function must never break a send.
 */
async function decorateHtml(client, { orgId, prospectId, stepLogId, html }) {
  try {
    const toggles = await getCampaignTracking(client, orgId, prospectId);
    if (!toggles.opens && !toggles.clicks) return html;
    const host = await getActiveHostname(client, orgId);
    if (!host) return html;   // D40: no active domain → no tracking, no fallback
    return decorate(html, { host, orgId, stepLogId, opens: toggles.opens, clicks: toggles.clicks });
  } catch (err) {
    console.error(`[EmailTracking] decorate failed org=${orgId} log=${stepLogId}: ${err.message} — sending untracked`);
    return html;
  }
}

// ── event recording (called by public routes) ────────────────────────────────

function classifyBot({ userAgent, firedAt, eventType }) {
  if (!userAgent) return 'no_ua';
  if (SCANNER_UA_RE.test(userAgent)) return 'scanner_ua';
  if (eventType === 'click' && firedAt) {
    const ageSec = (Date.now() - new Date(firedAt).getTime()) / 1000;
    if (ageSec >= 0 && ageSec < TOO_SOON_SECONDS) return 'too_soon';
  }
  return null;
}

/**
 * Verify token, cross-check the Host header against the token org's active
 * domain (a token replayed on another customer's hostname is rejected),
 * classify, insert. Returns { ok, url } — url only for clicks.
 * Never throws; tracking endpoints must always answer fast.
 */
async function recordEvent({ token, eventType, host, userAgent, ip, urlParam }) {
  try {
    const t = verifyToken(token);
    if (!t) return { ok: false };

    const r = await db.query(
      `SELECT ssl.prospect_id, ssl.fired_at, td.hostname
         FROM sequence_step_logs ssl
         LEFT JOIN tracking_domains td ON td.org_id = ssl.org_id AND td.status = 'active'
        WHERE ssl.id = $1 AND ssl.org_id = $2`,
      [t.stepLogId, t.orgId]
    );
    if (r.rows.length === 0) return { ok: false };
    const row = r.rows[0];
    // Host cross-check is INFORMATIONAL only (logged, never flags is_bot):
    // the HMAC token already prevents forgery, and tying metrics validity to
    // proxy Host-header behavior would silently zero data on infra config
    // changes. See D41.
    if (row.hostname && host && !String(host).toLowerCase().startsWith(row.hostname.toLowerCase())) {
      console.warn(`[EmailTracking] host mismatch: event for org ${t.orgId} arrived on '${host}' (expected '${row.hostname}')`);
    }

    const botReason = classifyBot({ userAgent, firedAt: row.fired_at, eventType });
    await db.query(
      `INSERT INTO email_engagement_events
         (org_id, step_log_id, prospect_id, event_type, url, link_index,
          user_agent, ip, is_bot, bot_reason, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())`,
      [
        t.orgId, t.stepLogId, row.prospect_id, eventType,
        eventType === 'click' ? String(urlParam || '').slice(0, 2000) : null,
        t.linkIndex, String(userAgent || '').slice(0, 500), String(ip || '').slice(0, 64),
        botReason !== null, botReason,
      ]
    );
    return { ok: true, url: urlParam || null };
  } catch (err) {
    console.error(`[EmailTracking] recordEvent error: ${err.message}`);
    return { ok: false };
  }
}

module.exports = {
  decorateHtml,
  recordEvent,
  // exported for tests / routes
  signToken,
  verifyToken,
  decorate,
  classifyBot,
  getActiveHostname,
};
