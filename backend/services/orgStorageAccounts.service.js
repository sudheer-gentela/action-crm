// ─────────────────────────────────────────────────────────────────────────────
// orgStorageAccounts.service.js
//
// The org-level cloud credential that writes WhatsApp attachments into the
// customer's own Drive or OneDrive.
//
// WHY IT IS NOT A PER-USER TOKEN
//   The WhatsApp webhook has no signed-in user. Using the folder-mapping
//   creator's credential would stop capture silently the day they left — and
//   unlike a missing file reference, missing WhatsApp media cannot be
//   recovered, because Meta expires it in about 30 days. So the credential
//   belongs to the org and should be a service account, or an admin account
//   that will not be deleted.
//
// WHY IT IS OPTIONAL, AND ONLY REALLY NEEDED FOR ONEDRIVE
//   Verified against both APIs:
//     Google   — in My Drive the UPLOADER owns the file even when it lands in
//                someone else's folder, so a "service account folder" protects
//                nothing. Only a Shared Drive transfers ownership. A Google org
//                using a Shared Drive needs no storage account at all.
//     OneDrive — items belong to the DRIVE they sit in, so a durable account's
//                folder does protect them.
//
// HEALTH AND NOTIFICATION
//   Mirrors SenderTokenHealth.notifyRevokedOnce rather than inventing a second
//   pattern: in-app notification, best-effort email, delivery log, deduped on
//   the unread notification so a broken account nags once and not hourly.
//
//   The difference: a prospecting sender has one rep to tell. A storage account
//   is org-level, and the person who connected it may be exactly the person who
//   left. So org owners/admins are notified too.
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

const PROVIDERS = ['googledrive', 'onedrive'];

function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) {
    throw Object.assign(new Error(`provider must be one of: ${PROVIDERS.join(', ')}`), { status: 400 });
  }
}

async function assertOrgAdmin(orgId, userId) {
  const { rows } = await pool.query(
    `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
  if (!['owner', 'admin'].includes(rows[0]?.role)) {
    throw Object.assign(new Error('Only an org admin can change storage accounts'), { status: 403 });
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Never returns tokens. This feeds a settings screen, not a provider call. */
async function get(orgId, provider) {
  assertProvider(provider);
  const { rows } = await pool.query(
    `SELECT a.id, a.provider, a.email, a.label, a.is_active,
            a.expires_at, a.last_error, a.last_error_at, a.last_used_at, a.created_at,
            (u.first_name || ' ' || u.last_name) AS connected_by_name
       FROM org_storage_accounts a
       LEFT JOIN users u ON u.id = a.connected_by
      WHERE a.org_id = $1 AND a.provider = $2`,
    [orgId, provider]
  );
  return rows[0] || null;
}

async function list(orgId) {
  const out = {};
  for (const p of PROVIDERS) out[p] = await get(orgId, p);
  return { accounts: out };
}

/**
 * The credential the uploader actually uses. Internal — returns tokens, so it
 * must never be reachable from a route.
 */
async function getCredential(orgId, provider) {
  assertProvider(provider);
  const { rows } = await pool.query(
    `SELECT * FROM org_storage_accounts
      WHERE org_id = $1 AND provider = $2 AND is_active`,
    [orgId, provider]
  );
  return rows[0] || null;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Store the credential after an admin completes OAuth AS THE SERVICE ACCOUNT.
 *
 * `email` is recorded and shown prominently in Settings because the common
 * mistake is an admin clicking Connect while still signed in as themselves,
 * silently wiring up their own OneDrive. Showing which account is connected is
 * the only way that error is visible.
 */
async function connect(orgId, userId, provider, { email, label, accessToken, refreshToken, expiresAt, accountData }) {
  assertProvider(provider);
  await assertOrgAdmin(orgId, userId);
  if (!accessToken) throw Object.assign(new Error('accessToken is required'), { status: 400 });

  const { rows } = await pool.query(
    `INSERT INTO org_storage_accounts
       (org_id, provider, email, label, access_token, refresh_token, expires_at,
        account_data, connected_by, is_active, last_error, last_error_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'{}'::jsonb),$9,true,NULL,NULL)
     ON CONFLICT (org_id, provider) DO UPDATE SET
       email = EXCLUDED.email, label = EXCLUDED.label,
       access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at, account_data = EXCLUDED.account_data,
       connected_by = EXCLUDED.connected_by,
       -- Reconnecting clears the failure, which is what makes the notification
       -- dedupe correct: one alert per outage, not one per sweep.
       is_active = true, last_error = NULL, last_error_at = NULL,
       updated_at = now()
     RETURNING id, provider, email`,
    [orgId, provider, email || null, label || null, accessToken, refreshToken || null,
     expiresAt || null, accountData ? JSON.stringify(accountData) : null, userId]
  );
  return { account: rows[0], reconnected: true };
}

async function disconnect(orgId, userId, provider) {
  assertProvider(provider);
  await assertOrgAdmin(orgId, userId);
  const { rowCount } = await pool.query(
    `DELETE FROM org_storage_accounts WHERE org_id = $1 AND provider = $2`, [orgId, provider]);
  if (!rowCount) throw Object.assign(new Error('No storage account connected'), { status: 404 });
  // Files already written are untouched — they live in the customer's storage
  // and are theirs. Only future capture stops.
  return { disconnected: true };
}

async function markUsed(orgId, provider) {
  await pool.query(
    `UPDATE org_storage_accounts SET last_used_at = now(), updated_at = now()
      WHERE org_id = $1 AND provider = $2`, [orgId, provider]);
}

/**
 * Record a credential failure and tell somebody.
 *
 * Deactivates so the uploader stops trying, then notifies once. Called only for
 * failures that a reconnect fixes — a transient network error must not
 * deactivate a working account.
 */
async function markBroken(orgId, provider, reason) {
  const { rows } = await pool.query(
    `UPDATE org_storage_accounts
        SET is_active = false, last_error = $3, last_error_at = now(), updated_at = now()
      WHERE org_id = $1 AND provider = $2 AND is_active
      RETURNING id, email, provider, connected_by`,
    [orgId, provider, String(reason || '').slice(0, 500)]
  );
  if (!rows.length) return { alreadyBroken: true };   // already flagged; do not re-notify
  await notifyBrokenOnce(orgId, rows[0], reason);
  return { deactivated: true };
}

// ── Notification ─────────────────────────────────────────────────────────────

/**
 * In-app + email, deduped on the unread notification.
 *
 * Mirrors SenderTokenHealth.notifyRevokedOnce. The one deliberate difference:
 * recipients are the connector AND every org owner/admin, because a storage
 * account outlives the person who set it up and the likeliest cause of the
 * outage is that person leaving.
 */
async function notifyBrokenOnce(orgId, account, reason) {
  const providerName = account.provider === 'onedrive' ? 'OneDrive' : 'Google Drive';
  const title = 'Project file storage needs reconnecting';
  const body =
    `${account.email || providerName} can no longer store files. WhatsApp attachments are not ` +
    `being saved, and WhatsApp deletes them after about 30 days — anything that arrives before ` +
    `this is fixed will be lost. Reconnect in Settings → Storage.`;

  try {
    const { rows: recipients } = await pool.query(
      `SELECT DISTINCT u.id, u.email
         FROM org_users ou
         JOIN users u ON u.id = ou.user_id
        WHERE ou.org_id = $1 AND ou.is_active
          AND (ou.role IN ('owner','admin') OR u.id = $2)`,
      [orgId, account.connected_by || null]
    );

    const { createNotification } = require('./notificationService');
    const DeliveryLog = require('./notificationDeliveryLog');
    const { sendSystemEmail } = require('./systemMailer');

    for (const r of recipients) {
      // One alert per person per outage: skip while an unread one exists.
      const dup = await pool.query(
        `SELECT 1 FROM notifications
          WHERE org_id = $1 AND user_id = $2 AND type = 'storage_account_revoked'
            AND entity_type = 'org_storage_account' AND entity_id = $3
            AND read_at IS NULL LIMIT 1`,
        [orgId, r.id, account.id]
      );
      if (dup.rows.length) continue;

      const notif = await createNotification(
        orgId, r.id, 'storage_account_revoked', title, body,
        'org_storage_account', account.id,
        { email: account.email, provider: account.provider, reason: reason || null }
      );

      await DeliveryLog.record(pool, {
        orgId, userId: r.id, notificationId: (notif && notif.id) || null,
        channel: 'in_app', status: 'sent', subject: title,
        metadata: { accountId: account.id, provider: account.provider },
      });

      if (r.email) {
        const emailSubject = `Action needed: reconnect file storage for ${providerName}`;
        let mailResult = null;
        try {
          mailResult = await sendSystemEmail({ to: r.email, subject: emailSubject, text: body });
        } catch (mailErr) {
          // Email is best-effort; the in-app row is the source of truth. Losing
          // the email must not lose the alert.
          mailResult = { sent: false, reason: mailErr.message };
          console.warn('[orgStorageAccounts] alert email failed:', mailErr.message);
        }
        // Record what ACTUALLY happened. sendSystemEmail resolves rather than
        // throwing when SMTP is unconfigured, so logging 'sent' unconditionally
        // would fill the audit trail with emails that were never sent — the
        // exact record you would consult after asking "why didn't anyone know?".
        // Status mapping matches SenderTokenHealth.
        await DeliveryLog.record(pool, {
          orgId, userId: r.id, notificationId: (notif && notif.id) || null,
          channel: 'email', recipient: r.email, subject: emailSubject,
          status: mailResult && mailResult.sent
            ? 'sent'
            : (mailResult && mailResult.reason === 'smtp_not_configured' ? 'skipped' : 'failed'),
          reason: mailResult && mailResult.sent ? null : (mailResult && mailResult.reason) || null,
          metadata: { accountId: account.id, provider: account.provider },
        });
      }
    }
  } catch (err) {
    console.error('[orgStorageAccounts] notifyBrokenOnce failed:', err.message);
  }
}

/**
 * A usable access token for the org's storage account, refreshed if stale.
 *
 * The capture worker runs from a webhook, so there is nobody to re-authenticate
 * interactively — the refresh has to be automatic, and a failure has to be
 * recorded rather than thrown into a queue that will retry it forever.
 *
 * A refresh failure calls markBroken: the account deactivates, capture stops,
 * and the org is notified. Retrying a revoked credential cannot succeed, and
 * burning the retry budget on it means the attachment expires before anyone
 * hears about the real problem.
 */
async function getFreshAccessToken(orgId, provider) {
  const cred = await getCredential(orgId, provider);
  if (!cred) return null;

  const stale = cred.expires_at && new Date(cred.expires_at).getTime() < Date.now() + 5 * 60 * 1000;
  if (!stale) return cred.access_token;
  if (!cred.refresh_token) {
    await markBroken(orgId, provider, 'no refresh token — reconnect required');
    return null;
  }

  const axios = require('axios');
  try {
    let accessToken, expiresIn, newRefresh;

    if (provider === 'onedrive') {
      const { refreshMicrosoftToken } = require('../config/microsoftScopes');
      const { data } = await refreshMicrosoftToken(axios, cred.refresh_token);
      accessToken = data.access_token; expiresIn = data.expires_in; newRefresh = data.refresh_token;
    } else {
      const { data } = await axios.post('https://oauth2.googleapis.com/token',
        new URLSearchParams({
          client_id:     process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          refresh_token: cred.refresh_token,
          grant_type:    'refresh_token',
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      accessToken = data.access_token; expiresIn = data.expires_in; newRefresh = data.refresh_token;
    }

    await pool.query(
      `UPDATE org_storage_accounts
          SET access_token = $3,
              refresh_token = COALESCE($4, refresh_token),
              expires_at = now() + ($5 || ' seconds')::interval,
              updated_at = now()
        WHERE org_id = $1 AND provider = $2`,
      [orgId, provider, accessToken, newRefresh || null, String(expiresIn || 3600)]
    );
    return accessToken;
  } catch (err) {
    const detail = err.response?.data?.error_description || err.response?.data?.error || err.message;
    await markBroken(orgId, provider, `refresh failed: ${detail}`);
    return null;
  }
}

// ── Upload target ────────────────────────────────────────────────────────────

/**
 * Where a project's inbound attachments go, and whether they can go anywhere.
 *
 * Returns null when the project has no upload target or the org has no active
 * account for that provider — the caller then marks the message 'skipped'
 * rather than failing, so a missed attachment stays visible instead of
 * disappearing.
 */
async function resolveUploadTarget(orgId, handoverId) {
  const { rows } = await pool.query(
    `SELECT pf.provider, pf.folder_id, pf.folder_name, h.media_capture_mode
       FROM project_folders pf
       JOIN sales_handovers h ON h.id = pf.handover_id
      WHERE pf.org_id = $1 AND pf.handover_id = $2 AND pf.is_upload_target
      LIMIT 1`,
    [orgId, handoverId]
  );
  if (!rows.length) return null;

  const target = rows[0];
  if (target.media_capture_mode === 'never') return null;

  const credential = await getCredential(orgId, target.provider);
  if (!credential) return null;

  return {
    provider:    target.provider,
    folderId:    target.folder_id,
    folderName:  target.folder_name,
    captureMode: target.media_capture_mode,
    credential,
  };
}

module.exports = {
  PROVIDERS,
  get, list, getCredential, connect, disconnect,
  markUsed, markBroken, notifyBrokenOnce, resolveUploadTarget, getFreshAccessToken,
};
