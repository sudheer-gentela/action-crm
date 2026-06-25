/**
 * systemMailer.js
 *
 * DROP-IN LOCATION: backend/services/systemMailer.js  (NEW FILE)
 *
 * Minimal transactional/system email sender for platform notifications
 * (e.g. "reconnect your sender"). Distinct from outreach sending, which goes
 * through the rep's connected Gmail/Outlook. This uses an env-configured SMTP
 * transport via nodemailer (already a dependency).
 *
 * SAFE BY DEFAULT: if SMTP env vars are not set, sendSystemEmail() logs and
 * returns { sent:false } instead of throwing — so shipping this changes nothing
 * until you provide credentials. It activates the moment these are set:
 *
 *   SMTP_HOST                 e.g. email-smtp.us-east-1.amazonaws.com
 *   SMTP_PORT                 default 587 (use 465 for implicit TLS)
 *   SMTP_USER
 *   SMTP_PASS
 *   SMTP_SECURE               'true' to force TLS (auto-true when port=465)
 *   NOTIFICATIONS_FROM_EMAIL  From address (falls back to SMTP_FROM / SMTP_USER)
 */

const nodemailer = require('nodemailer');

let _transport = null;
let _resolved = false;

function getTransport() {
  if (_resolved) return _transport;
  _resolved = true;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    _transport = null;
    return null;
  }

  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;

  _transport = nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
  });
  return _transport;
}

function fromAddress() {
  return process.env.NOTIFICATIONS_FROM_EMAIL
      || process.env.SMTP_FROM
      || process.env.SMTP_USER
      || 'no-reply@gowarmcrm.com';
}

/**
 * Best-effort system email. Never throws; returns { sent, reason? }.
 */
async function sendSystemEmail({ to, subject, html, text }) {
  if (!to) return { sent: false, reason: 'no_recipient' };

  const tx = getTransport();
  if (!tx) {
    console.log(`✉️  systemMailer: SMTP not configured — skipped email to ${to} ("${subject}")`);
    return { sent: false, reason: 'smtp_not_configured' };
  }

  try {
    await tx.sendMail({ from: fromAddress(), to, subject, html, text: text || undefined });
    return { sent: true };
  } catch (e) {
    console.warn(`✉️  systemMailer: send failed to ${to}:`, e.message);
    return { sent: false, reason: e.message };
  }
}

module.exports = {
  sendSystemEmail,
  isConfigured: () => !!getTransport(),
};
