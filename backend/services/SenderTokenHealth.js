/**
 * SenderTokenHealth.js
 *
 * DROP-IN LOCATION: backend/services/SenderTokenHealth.js  (NEW FILE)
 *
 * Single source of truth for prospecting-sender OAuth credential health.
 * Before this existed, the "is the refresh token still good?" logic was
 * duplicated in three places (googleService.sendEmail, the /validate route,
 * and implicitly in the firer's send path). This centralises it so the
 * firer, the approve guard, and the daily sweep all agree.
 *
 * Health is stamped onto prospecting_sender_accounts.account_data.token_health
 * (a jsonb sub-key — no migration needed):
 *
 *   { status: 'healthy' | 'revoked',
 *     reason: <string|null>,
 *     checked_at:  <ISO>,      // last successful probe
 *     detected_at: <ISO> }     // when revocation was first seen
 *
 * On a confirmed revocation (invalid_grant) we ALSO flip is_active=false so the
 * firer's capacity picker (which already filters is_active=true) stops choosing
 * the dead sender automatically. Reconnecting via the existing OAuth callback
 * upsert sets is_active=true again and overwrites account_data, clearing health.
 *
 * NOTE on "expiry": Google/Microsoft do NOT publish a refresh-token expiry date.
 * The token dies on events (revoke, password change, inactivity, or an OAuth app
 * left in "Testing" status → 7-day refresh tokens). So health here is a verified
 * status + timestamp, not a countdown. The short-lived ACCESS-token expiry lives
 * in the existing expires_at column and is auto-refreshed; it is not what breaks.
 */

const axios = require('axios');
const { pool: defaultPool } = require('../config/database');

// Matches Google (`invalid_grant`) and Microsoft (`AADSTS700082/AADSTS70008/
// AADSTS50173`) revocation/expiry signals, plus the human-readable variant.
const REVOKED_RE = /invalid_grant|Token has been expired or revoked|AADSTS(700082|70008|50173|700084)/i;

/**
 * Is this thrown/HTTP error a confirmed credential revocation (vs. a transient
 * network/5xx blip)? Used to distinguish "reconnect the sender" from "retry".
 */
function isRevokedError(err) {
  if (!err) return false;
  const haystack =
    (err.response && err.response.data && (err.response.data.error_description || err.response.data.error)) ||
    err.message ||
    String(err);
  return REVOKED_RE.test(String(haystack));
}

// ── Provider refresh probes ──────────────────────────────────────────────────
// Each returns { access_token, expires_in } on success or throws.

async function _googleRefresh(refreshToken) {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  });
  const { data } = await axios.post(
    'https://oauth2.googleapis.com/token',
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return data;
}

async function _outlookRefresh(refreshToken) {
  const tenantId = process.env.MICROSOFT_TENANT_ID;
  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
    scope:         'https://graph.microsoft.com/Mail.Send offline_access',
  });
  const { data } = await axios.post(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return data;
}

/**
 * Live-probe a sender's refresh token without persisting anything.
 * Returns: { valid, revoked, reason, accessToken, expiresAt }
 */
async function probe(sender) {
  if (!sender || !sender.refresh_token) {
    return { valid: false, revoked: true, reason: 'No refresh token — please reconnect this account.', accessToken: null, expiresAt: null };
  }
  try {
    let data;
    if (sender.provider === 'gmail')        data = await _googleRefresh(sender.refresh_token);
    else if (sender.provider === 'outlook') data = await _outlookRefresh(sender.refresh_token);
    else return { valid: false, revoked: false, reason: `Unknown provider: ${sender.provider}`, accessToken: null, expiresAt: null };

    const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);
    return { valid: true, revoked: false, reason: null, accessToken: data.access_token, expiresAt };
  } catch (err) {
    const revoked = isRevokedError(err);
    const reason = revoked
      ? 'Access was revoked — please reconnect this account.'
      : `Token validation failed: ${err.message}`;
    return { valid: false, revoked, reason, accessToken: null, expiresAt: null };
  }
}

// ── Health stamping ──────────────────────────────────────────────────────────

/**
 * Stamp a sender healthy and persist the freshly-minted access token.
 * Does NOT touch is_active (reconnection / explicit toggles own that).
 */
async function persistRefreshed(db, senderId, accessToken, expiresAt) {
  const health = JSON.stringify({ status: 'healthy', reason: null, checked_at: new Date().toISOString() });
  await db.query(
    `UPDATE prospecting_sender_accounts
        SET access_token = COALESCE($2, access_token),
            expires_at   = COALESCE($3, expires_at),
            account_data = jsonb_set(COALESCE(account_data,'{}'::jsonb), '{token_health}', $4::jsonb, true),
            updated_at   = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [senderId, accessToken || null, expiresAt || null, health]
  );
}

/**
 * Mark a sender revoked: stamp health AND deactivate so the firer's picker
 * stops selecting it. Idempotent — re-marking just refreshes the reason.
 */
async function markRevoked(db, senderId, reason) {
  const health = JSON.stringify({
    status: 'revoked',
    reason: reason || 'Access was revoked — please reconnect this account.',
    detected_at: new Date().toISOString(),
  });
  await db.query(
    `UPDATE prospecting_sender_accounts
        SET is_active    = false,
            account_data = jsonb_set(COALESCE(account_data,'{}'::jsonb), '{token_health}', $2::jsonb, true),
            updated_at   = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [senderId, health]
  );
}

// ── Notification (deduped: one per sender until read) ────────────────────────

async function notifyRevokedOnce(db, { orgId, userId, sender, reason }) {
  if (!userId) return; // client-owned senders have no single rep to notify
  try {
    // Dedupe: skip if there's already an unread revocation alert for this sender.
    const dup = await db.query(
      `SELECT 1 FROM notifications
        WHERE org_id = $1 AND user_id = $2
          AND type = 'sender_token_revoked'
          AND entity_type = 'prospecting_sender' AND entity_id = $3
          AND read_at IS NULL
        LIMIT 1`,
      [orgId, userId, sender.id]
    );
    if (dup.rows.length) return;

    const { createNotification } = require('./notificationService');
    const notif = await createNotification(
      orgId,
      userId,
      'sender_token_revoked',
      'Email sender needs reconnecting',
      `${sender.email} can no longer send — its connection expired or was revoked. `
        + `Reconnect it in Settings → Outreach to resume your sequences.`,
      'prospecting_sender',
      sender.id,
      { email: sender.email, provider: sender.provider, reason: reason || null }
    );
    const notificationId = (notif && notif.id) || null;

    const DeliveryLog = require('./notificationDeliveryLog');
    // Audit the in-app delivery.
    await DeliveryLog.record(db, {
      orgId, userId, notificationId, channel: 'in_app', status: 'sent',
      subject: 'Email sender needs reconnecting',
      metadata: { senderId: sender.id, email: sender.email, provider: sender.provider },
    });

    // Best-effort immediate email (only fires if SMTP is configured server-side;
    // otherwise systemMailer just logs and skips). Deduped along with the in-app
    // notification above, so it's at most one email per sender until reconnected.
    try {
      const { rows: [u] } = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
      if (u && u.email) {
        const { sendSystemEmail } = require('./systemMailer');
        const emailSubject = `Action needed: reconnect ${sender.email}`;
        const r = await sendSystemEmail({
          to: u.email,
          subject: emailSubject,
          html:
            `<p>Your outreach sender <strong>${sender.email}</strong> can no longer send — `
            + `its connection expired or was revoked.</p>`
            + `<p>Reconnect it in <a href="https://app.gowarmcrm.com/#/settings/preferences">`
            + `Settings → My Preferences → Outreach Sender Accounts</a> to resume your sequences.</p>`
            + (reason ? `<p style="color:#6b7280;font-size:12px">Details: ${reason}</p>` : ''),
          text:
            `Your outreach sender ${sender.email} can no longer send (expired or revoked). `
            + `Reconnect it at https://app.gowarmcrm.com/#/settings/preferences to resume your sequences.`,
        });
        // Audit the email delivery (sent / failed / skipped-when-unconfigured).
        await DeliveryLog.record(db, {
          orgId, userId, notificationId, channel: 'email', recipient: u.email,
          subject: emailSubject,
          status: r && r.sent ? 'sent' : (r && r.reason === 'smtp_not_configured' ? 'skipped' : 'failed'),
          reason: r && r.sent ? null : (r && r.reason) || null,
          metadata: { senderId: sender.id },
        });
      }
    } catch (mailErr) {
      console.warn(`SenderTokenHealth: revoke email failed for sender ${sender?.id}:`, mailErr.message);
    }
  } catch (e) {
    // Never let a notification failure block the send/sweep path.
    console.warn(`SenderTokenHealth: notify failed for sender ${sender?.id}:`, e.message);
  }
}

/**
 * Called from the firer when a send throws invalid_grant. Deactivate + notify
 * once. Returns nothing; the caller decides whether to fail over or pause.
 */
async function handleRevokedAtSend(db, { sender, orgId, userId, reason }) {
  await markRevoked(db, sender.id, reason);
  await notifyRevokedOnce(db, { orgId, userId, sender, reason });
}

/**
 * Probe + persist outcome for one sender. Used by the daily sweep and the
 * approve guard. notify=true emits the deduped alert on a NEW revocation.
 * Returns { valid, revoked, reason }.
 */
async function validateAndPersist(db, sender, { notify = true } = {}) {
  const res = await probe(sender);
  if (res.valid) {
    await persistRefreshed(db, sender.id, res.accessToken, res.expiresAt);
    return { valid: true, revoked: false, reason: null };
  }
  if (res.revoked) {
    await markRevoked(db, sender.id, res.reason);
    if (notify) {
      await notifyRevokedOnce(db, { orgId: sender.org_id, userId: sender.user_id, sender, reason: res.reason });
    }
  }
  return { valid: false, revoked: res.revoked, reason: res.reason };
}

/**
 * Pre-approve guard. Confirms the rep has at least one sender that can actually
 * send right now. Probes the rep's active senders, marks any dead ones, and:
 *   - if at least one is healthy → returns { ok: true }
 *   - otherwise → throws an Error with .needsReconnect = true and
 *     .senders = [{ id, email, provider }] so the route can return a 409 the
 *     UI turns into a one-click "Reconnect <email>" prompt.
 *
 * Short-circuits on the first healthy sender so a healthy pool costs one probe.
 */
async function assertUserCanSend(db, orgId, userId) {
  const { rows: senders } = await db.query(
    `SELECT id, org_id, user_id, provider, email, refresh_token, account_data
       FROM prospecting_sender_accounts
      WHERE org_id = $1 AND user_id = $2 AND client_id IS NULL AND is_active = true
      ORDER BY id ASC`,
    [orgId, userId]
  );

  if (!senders.length) {
    const err = new Error('No active email sender connected. Connect Gmail or Outlook in Settings → Outreach before approving.');
    err.needsReconnect = true;
    err.senders = [];
    throw err;
  }

  const dead = [];
  for (const s of senders) {
    const res = await validateAndPersist(db, s, { notify: true });
    if (res.valid) return { ok: true };       // a healthy sender exists — allow approve
    if (res.revoked) dead.push({ id: s.id, email: s.email, provider: s.provider });
    // Non-revoked (transient) failures are NOT counted as dead — we don't want a
    // network blip to block approval. If ALL probes were transient, we fall
    // through and allow (the firer retries at send time as before).
  }

  if (dead.length === senders.length) {
    const err = new Error('Your email sender(s) need reconnecting before you can approve. Reconnect in Settings → Outreach.');
    err.needsReconnect = true;
    err.senders = dead;
    throw err;
  }
  return { ok: true };
}

/**
 * Daily sweep (cron). Probes every active sender, refreshes healthy ones, and
 * deactivates + notifies on newly-revoked ones. Returns counts.
 */
async function sweepActiveSenders(db = defaultPool) {
  const { rows: senders } = await db.query(
    `SELECT id, org_id, user_id, provider, email, refresh_token, account_data
       FROM prospecting_sender_accounts
      WHERE is_active = true`
  );
  let healthy = 0, revoked = 0, transient = 0;
  for (const s of senders) {
    try {
      const res = await validateAndPersist(db, s, { notify: true });
      if (res.valid)        healthy++;
      else if (res.revoked) revoked++;
      else                  transient++;
    } catch (e) {
      transient++;
      console.warn(`SenderTokenHealth.sweep: sender ${s.id} probe error:`, e.message);
    }
  }
  return { checked: senders.length, healthy, revoked, transient };
}

module.exports = {
  isRevokedError,
  probe,
  persistRefreshed,
  markRevoked,
  notifyRevokedOnce,
  handleRevokedAtSend,
  validateAndPersist,
  assertUserCanSend,
  sweepActiveSenders,
  REVOKED_RE,
};
