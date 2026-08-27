#!/usr/bin/env node
/**
 * checkSmtp.js
 *
 * DROP-IN LOCATION: backend/scripts/checkSmtp.js  (NEW FILE)
 *
 * Answers "is SMTP actually wired up on THIS service?" without guessing.
 *
 * ── WHY A SCRIPT AND NOT JUST THE TEST ENDPOINT ─────────────────────────────
 *
 * POST /api/org-admin/test-email runs on the API service. But notification
 * email is sent by the QUEUE PROCESSOR, which runs on the WORKER. They are
 * separate Railway services with separate environment variables.
 *
 * So a green test-email on the API proves nothing about whether the worker can
 * send — and the worker is the only thing that ever sends a notification. This
 * script runs wherever you point it, which is the whole point:
 *
 *     railway run --service <api>    node backend/scripts/checkSmtp.js
 *     railway run --service <worker> node backend/scripts/checkSmtp.js
 *
 * Both must pass.
 *
 * ── WHAT IT CHECKS, IN ORDER ────────────────────────────────────────────────
 *
 *   1. Which env vars are present  — catches "set on the wrong service"
 *   2. What From address resolves  — catches a From your provider will reject
 *   3. transport.verify()          — real TCP + TLS + AUTH, sends nothing
 *   4. An actual send              — only with --to, only if you ask
 *
 * Step 3 is the one that matters. It fails on a wrong host, a closed port, a
 * bad password or a TLS mismatch, and it does it without putting mail in
 * anyone's inbox.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *
 *   node backend/scripts/checkSmtp.js
 *   node backend/scripts/checkSmtp.js --to you@example.com
 *
 * Exit code 0 = healthy, 1 = something is wrong (so CI can use it).
 */

const nodemailer = require('nodemailer');

const args   = process.argv.slice(2);
const toArg  = args.includes('--to') ? args[args.indexOf('--to') + 1] : null;

const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad  = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

// Never print a password, not even masked-but-recoverable. Length only —
// enough to spot a truncated paste or a trailing newline, useless to a
// shoulder-surfer or a log scraper.
const shape = (v) => (v ? `set (${v.length} chars)` : 'NOT SET');

(async () => {
  let failed = false;

  head('1. Environment');
  const host   = process.env.SMTP_HOST;
  const user   = process.env.SMTP_USER;
  const pass   = process.env.SMTP_PASS;
  const port   = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;

  console.log(`  SMTP_HOST                 ${host || 'NOT SET'}`);
  console.log(`  SMTP_PORT                 ${port}${process.env.SMTP_PORT ? '' : '  (default)'}`);
  console.log(`  SMTP_USER                 ${user || 'NOT SET'}`);
  console.log(`  SMTP_PASS                 ${shape(pass)}`);
  console.log(`  SMTP_SECURE               ${secure}${process.env.SMTP_SECURE ? '' : `  (derived from port ${port})`}`);
  console.log(`  NOTIFICATIONS_FROM_EMAIL  ${process.env.NOTIFICATIONS_FROM_EMAIL || 'NOT SET'}`);
  console.log(`  SMTP_FROM                 ${process.env.SMTP_FROM || 'NOT SET'}`);

  // getTransport() requires exactly these three. Any one missing and
  // sendSystemEmail() returns { sent:false, reason:'smtp_not_configured' }
  // silently — no throw, no retry, nothing in an error log.
  if (!host || !user || !pass) {
    bad('SMTP_HOST, SMTP_USER and SMTP_PASS are all required. '
      + 'With any one missing, every email silently no-ops.');
    console.log('\n  Nothing else can be checked. Set them on THIS service and re-run.\n');
    process.exit(1);
  }
  ok('All three required variables are present');

  head('2. From address');
  const from = process.env.NOTIFICATIONS_FROM_EMAIL
            || process.env.SMTP_FROM
            || process.env.SMTP_USER
            || 'no-reply@gowarmcrm.com';
  console.log(`  Resolved From: ${from}`);
  if (!process.env.NOTIFICATIONS_FROM_EMAIL && !process.env.SMTP_FROM) {
    warn(`Falling back to SMTP_USER. On SES/Postmark/SendGrid the username is `
       + `usually an API key or IAM id, NOT a sendable address — every send `
       + `will be rejected. Set NOTIFICATIONS_FROM_EMAIL explicitly.`);
  } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from.replace(/^.*</, '').replace(/>.*$/, ''))) {
    warn('That does not look like a valid address.');
  } else {
    ok('From address is explicitly configured');
  }

  head('3. Connection + authentication');
  console.log(`  Connecting to ${host}:${port} (secure=${secure})…`);
  const tx = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });

  try {
    await tx.verify();
    ok('Connected, TLS negotiated, credentials accepted — nothing was sent');
  } catch (err) {
    failed = true;
    bad(`verify() failed: ${err.message}`);
    const m = String(err.message || '');
    if (/EAUTH|535|Invalid login|Username and Password/i.test(m)) {
      console.log('    → Credentials rejected. On SES these are SMTP credentials,');
      console.log('      which are NOT your AWS access key/secret.');
    } else if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(m)) {
      console.log('    → Cannot reach the host. Check the hostname, and whether');
      console.log('      the port is blocked outbound. Try 587 if you are on 465.');
    } else if (/wrong version number|SSL|TLS/i.test(m)) {
      console.log('    → TLS mismatch. Port 465 needs secure=true; 587 needs false');
      console.log('      (STARTTLS). Set SMTP_SECURE to match the port.');
    }
  }

  if (toArg && !failed) {
    head('4. Live send');
    try {
      const info = await tx.sendMail({
        from, to: toArg,
        subject: 'GoWarmCRM SMTP check',
        text: `Sent from ${process.env.RAILWAY_SERVICE_NAME || 'this service'} at ${new Date().toISOString()}.`,
        html: `<p>Sent from <strong>${process.env.RAILWAY_SERVICE_NAME || 'this service'}</strong> at ${new Date().toISOString()}.</p>`,
      });
      ok(`Accepted by the server — messageId ${info.messageId}`);
      console.log(`    Accepted: ${JSON.stringify(info.accepted)}`);
      if (info.rejected?.length) warn(`Rejected: ${JSON.stringify(info.rejected)}`);
      console.log('    "Accepted" means the SMTP server took it, not that it reached');
      console.log('    the inbox. Check the destination, including spam.');
    } catch (err) {
      failed = true;
      bad(`Send failed: ${err.message}`);
      if (/not verified|MessageRejected|550/i.test(String(err.message))) {
        console.log('    → The From address is probably not verified with your provider,');
        console.log('      or the account is still in a sandbox that only allows');
        console.log('      sending to pre-verified recipients.');
      }
    }
  } else if (!toArg && !failed) {
    head('4. Live send');
    console.log('  Skipped. Re-run with --to you@example.com to send one.');
  }

  head(failed ? 'RESULT: not working' : 'RESULT: SMTP is wired up on this service');
  if (!failed) {
    console.log('  Remember: this proves THIS service can send. Notification email is');
    console.log('  sent by the queue processor on the WORKER — run this there too.');
  }
  console.log('');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\nUnexpected error:', err);
  process.exit(1);
});
