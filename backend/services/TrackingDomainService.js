/**
 * TrackingDomainService.js
 *
 * Phase 7 of the Outbound Insights & WBR system (docs/INSIGHTS_WBR_DESIGN.md).
 *
 * Lifecycle of per-customer CNAME tracking domains:
 *   request(orgId, hostname)  → row status 'pending' + instructions
 *   verify(orgId, id)         → DNS CNAME check → Cloudflare for SaaS custom
 *                               hostname create/poll → 'active' when the TLS
 *                               cert is issued; 'failed' with a reason else
 *   listForOrg / disable
 *
 * Customer contract (D38): they add ONE record —
 *     CNAME  {their chosen subdomain}  →  track.gowarmcrm.com
 * The CNAME target is permanent; the TLS provider behind it is swappable.
 * Cloudflare specifics (cf_hostname_id) are stored as metadata only.
 *
 * Env: CLOUDFLARE_API_TOKEN (SSL and Certificates / Custom Hostnames write),
 *      CLOUDFLARE_ZONE_ID (the gowarmcrm.com zone),
 *      TRACKING_CNAME_TARGET (default 'track.gowarmcrm.com').
 * When CF env is absent, verify() stops after the DNS check with a clear
 * message instead of failing cryptically (lets DNS setup proceed first).
 */

const dns = require('dns').promises;
const db = require('../config/database');

const CNAME_TARGET = () => process.env.TRACKING_CNAME_TARGET || 'track.gowarmcrm.com';
const CF_API = 'https://api.cloudflare.com/client/v4';

// All outbound calls are time-bounded: Node fetch has NO default timeout,
// and a stalled Cloudflare/DNS call would otherwise hang the verify request
// (and the UI button) for minutes.
const CF_TIMEOUT_MS = 15000;
const DNS_TIMEOUT_MS = 8000;
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s — try Verify again`)), ms)),
  ]);
}
let _fetchImpl = (url, opts = {}) => fetch(url, { signal: AbortSignal.timeout(CF_TIMEOUT_MS), ...opts });
let _resolveCname = (h) => withTimeout(dns.resolveCname(h), DNS_TIMEOUT_MS, 'DNS lookup');
function setFetchImpl(fn) { _fetchImpl = fn; }
function setDnsResolver(fn) { _resolveCname = fn; }

const HOSTNAME_RE = /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63}){1,}$/;

function cfHeaders() {
  return { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' };
}

async function cfCreateHostname(hostname) {
  const res = await _fetchImpl(`${CF_API}/zones/${process.env.CLOUDFLARE_ZONE_ID}/custom_hostnames`, {
    method: 'POST', headers: cfHeaders(),
    body: JSON.stringify({ hostname, ssl: { method: 'http', type: 'dv' } }),
  });
  const data = await res.json();
  if (data.success) return data.result;
  // Already registered → fetch it instead of failing.
  const dup = (data.errors || []).some((e) => /already exists|duplicate/i.test(e.message || ''));
  if (dup) {
    const list = await _fetchImpl(
      `${CF_API}/zones/${process.env.CLOUDFLARE_ZONE_ID}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
      { headers: cfHeaders() }
    );
    const ld = await list.json();
    if (ld.success && ld.result?.[0]) return ld.result[0];
  }
  throw new Error(`Cloudflare hostname create failed: ${(data.errors || []).map((e) => e.message).join('; ') || res.status}`);
}

async function cfGetHostname(id) {
  const res = await _fetchImpl(`${CF_API}/zones/${process.env.CLOUDFLARE_ZONE_ID}/custom_hostnames/${id}`, { headers: cfHeaders() });
  const data = await res.json();
  if (!data.success) throw new Error('Cloudflare hostname status fetch failed');
  return data.result;
}

// ── public API ───────────────────────────────────────────────────────────────

async function request(orgId, hostnameRaw, userId) {
  const hostname = String(hostnameRaw || '').trim().toLowerCase().replace(/\.$/, '');
  if (!HOSTNAME_RE.test(hostname) || hostname.split('.').length < 3) {
    throw new Error('Enter a subdomain of your company domain, e.g. t.yourcompany.com');
  }
  const r = await db.query(
    `INSERT INTO tracking_domains (org_id, hostname, status, created_by)
     VALUES ($1, $2, 'pending', $3)
     ON CONFLICT (hostname) DO UPDATE
       SET status = CASE WHEN tracking_domains.status = 'disabled'
                         THEN 'pending' ELSE tracking_domains.status END,
           error_message = CASE WHEN tracking_domains.status = 'disabled'
                                THEN NULL ELSE tracking_domains.error_message END,
           updated_at = now()
     RETURNING *`,
    [orgId, hostname, userId || null]
  );
  const row = r.rows[0];
  if (row.org_id !== orgId) throw new Error('That hostname is registered to another workspace');
  return {
    ...row,
    instructions: {
      record_type: 'CNAME',
      host: hostname,
      target: CNAME_TARGET(),
      note: 'Add this record at your DNS provider, then click Verify. Propagation can take a few minutes.',
    },
  };
}

/** DNS check → CF registration → activation. Idempotent; safe to re-click. */
async function verify(orgId, id) {
  const r = await db.query(`SELECT * FROM tracking_domains WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (r.rows.length === 0) throw new Error('Tracking domain not found');
  const row = r.rows[0];

  const fail = async (msg) => {
    await db.query(
      `UPDATE tracking_domains SET status = 'failed', error_message = $2, last_checked_at = now(), updated_at = now() WHERE id = $1`,
      [id, msg]
    );
    return { id, hostname: row.hostname, status: 'failed', error_message: msg };
  };

  // 1) DNS: CNAME must resolve to the target.
  let cnames = [];
  try {
    cnames = await _resolveCname(row.hostname);
  } catch (e) {
    return fail(`DNS lookup found no CNAME for ${row.hostname} yet — add: CNAME ${row.hostname} → ${CNAME_TARGET()} (then allow a few minutes for propagation)`);
  }
  const target = CNAME_TARGET().toLowerCase();
  if (!cnames.some((c) => String(c).toLowerCase().replace(/\.$/, '') === target)) {
    return fail(`CNAME points to ${cnames.join(', ')} — it must point to ${CNAME_TARGET()}`);
  }

  // 2) Cloudflare for SaaS registration (skipped cleanly when not configured).
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ZONE_ID) {
    return fail('DNS verified ✓ — but Cloudflare for SaaS is not configured on the server (set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID), so the TLS certificate cannot be issued yet');
  }
  try {
    // A stored cf_hostname_id can go stale (e.g. the hostname was deleted in
    // the Cloudflare dashboard). Treat fetch failure as "doesn't exist" and
    // fall through to creating a fresh registration.
    let cf = null;
    if (row.cf_hostname_id) {
      try { cf = await cfGetHostname(row.cf_hostname_id); } catch (e) { cf = null; }
    }
    if (!cf) cf = await cfCreateHostname(row.hostname);
    const sslStatus = cf?.ssl?.status || cf?.status || 'unknown';
    const active = sslStatus === 'active';
    await db.query(
      `UPDATE tracking_domains
          SET status = $2, cf_hostname_id = $3, error_message = NULL,
              last_checked_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, active ? 'active' : 'verifying', cf.id || row.cf_hostname_id]
    );
    return {
      id, hostname: row.hostname,
      status: active ? 'active' : 'verifying',
      ssl_status: sslStatus,
      note: active ? 'Tracking domain is live.' : 'DNS verified ✓ — certificate is being issued (usually under a minute). Click Verify again shortly.',
    };
  } catch (e) {
    return fail(e.message);
  }
}

async function listForOrg(orgId) {
  const r = await db.query(
    `SELECT id, hostname, status, error_message, last_checked_at, created_at
       FROM tracking_domains WHERE org_id = $1 ORDER BY created_at DESC`,
    [orgId]
  );
  return r.rows.map((row) => ({
    ...row,
    instructions: row.status === 'active' ? null : {
      record_type: 'CNAME', host: row.hostname, target: CNAME_TARGET(),
    },
  }));
}

async function disable(orgId, id) {
  const r = await db.query(
    `UPDATE tracking_domains SET status = 'disabled', updated_at = now()
      WHERE id = $1 AND org_id = $2 RETURNING id, hostname, status`,
    [id, orgId]
  );
  if (r.rows.length === 0) throw new Error('Tracking domain not found');
  return r.rows[0];
}

module.exports = { request, verify, listForOrg, disable, setFetchImpl, setDnsResolver };
