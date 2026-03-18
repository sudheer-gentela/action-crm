// backend/services/portalEmailService.js
//
// Sends magic link invite emails to client portal users.
// Wire up your email transport below (nodemailer, SendGrid, Resend, Postmark, etc.)
// The function signature is stable — swap the transport without touching clients.routes.js.

/**
 * Send a portal invite email containing the one-time magic link.
 *
 * @param {object} opts
 * @param {string} opts.to          - Recipient email address
 * @param {string} opts.clientName  - Name of the client (e.g. "XYZ Ltd")
 * @param {string} opts.magicLink   - Full magic link URL
 * @param {string} opts.invitedBy   - Full name of the ABC Corp rep who sent the invite
 */
async function sendPortalInviteEmail({ to, clientName, magicLink, invitedBy }) {
  // ─────────────────────────────────────────────────────────────────────────────
  // TODO: replace the console.log below with your actual email transport.
  //
  // ── Option A: nodemailer (if you already have a mailer config) ───────────────
  //
  // const transporter = require('../config/mailer'); // your existing nodemailer setup
  // await transporter.sendMail({
  //   from:    process.env.EMAIL_FROM || 'noreply@yourapp.com',
  //   to,
  //   subject: `You've been invited to the ${clientName} client portal`,
  //   html: buildInviteHtml({ clientName, magicLink, invitedBy }),
  //   text: buildInviteText({ clientName, magicLink, invitedBy }),
  // });
  //
  // ── Option B: Resend ─────────────────────────────────────────────────────────
  //
  // const { Resend } = require('resend');
  // const resend = new Resend(process.env.RESEND_API_KEY);
  // await resend.emails.send({
  //   from:    process.env.EMAIL_FROM || 'noreply@yourapp.com',
  //   to,
  //   subject: `You've been invited to the ${clientName} client portal`,
  //   html:    buildInviteHtml({ clientName, magicLink, invitedBy }),
  // });
  //
  // ── Option C: SendGrid ───────────────────────────────────────────────────────
  //
  // const sgMail = require('@sendgrid/mail');
  // sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  // await sgMail.send({
  //   from:    process.env.EMAIL_FROM || 'noreply@yourapp.com',
  //   to,
  //   subject: `You've been invited to the ${clientName} client portal`,
  //   html:    buildInviteHtml({ clientName, magicLink, invitedBy }),
  //   text:    buildInviteText({ clientName, magicLink, invitedBy }),
  // });
  // ─────────────────────────────────────────────────────────────────────────────

  // Until a transport is wired, log the link so it is never silently lost.
  console.log(`[PORTAL INVITE] To: ${to} | Client: ${clientName} | Invited by: ${invitedBy}`);
  console.log(`[PORTAL INVITE] Magic link: ${magicLink}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Email body builders — edit to match your brand
// ─────────────────────────────────────────────────────────────────────────────

function buildInviteHtml({ clientName, magicLink, invitedBy }) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; margin: 0; padding: 40px 20px;">
  <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <h2 style="margin: 0 0 8px; font-size: 22px; color: #111827;">You've been invited</h2>
    <p style="margin: 0 0 24px; color: #6b7280; font-size: 15px;">
      ${invitedBy} has invited you to access the <strong>${clientName}</strong> client portal.
    </p>
    <a href="${magicLink}"
       style="display: inline-block; background: #7c3aed; color: #ffffff; text-decoration: none;
              font-size: 15px; font-weight: 600; padding: 12px 28px; border-radius: 8px;">
      Access your portal →
    </a>
    <p style="margin: 24px 0 0; color: #9ca3af; font-size: 13px;">
      This link expires in 7 days and can only be used once.<br>
      If you weren't expecting this invitation, you can safely ignore this email.
    </p>
  </div>
</body>
</html>`;
}

function buildInviteText({ clientName, magicLink, invitedBy }) {
  return `You've been invited to the ${clientName} client portal by ${invitedBy}.

Access your portal here:
${magicLink}

This link expires in 7 days and can only be used once.
If you weren't expecting this, you can safely ignore this email.`;
}

module.exports = { sendPortalInviteEmail };
