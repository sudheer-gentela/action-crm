const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const Joi = require('joi');
const { isValidTimeZone } = require('../utils/repTimezone');

// ─────────────────────────────────────────────────────────────
// Validation schemas (unchanged)
// ─────────────────────────────────────────────────────────────
const registerSchema = Joi.object({
  email:     Joi.string().email().required(),
  password:  Joi.string().min(8).required(),
  firstName: Joi.string().required(),
  lastName:  Joi.string().required(),
  timezone:  Joi.string().optional()
});

const loginSchema = Joi.object({
  email:    Joi.string().email().required(),
  password: Joi.string().required(),
  timezone: Joi.string().optional()
});

// ─────────────────────────────────────────────────────────────
// Helper: look up org membership for a user and return the
// payload fields needed for the JWT and the /verify response.
// Returns { org_id, role, org_name, org_slug } — all null
// (except role which defaults to 'member') if user has no org.
//
// We JOIN organizations so the /verify response can carry the
// human-readable org name. The Chrome extension consumes this
// to display "Saving as <email> · <org_name>" so reps can tell
// at a glance which workspace their LinkedIn captures land in.
// JWT payload still only carries id+role to keep tokens small.
// ─────────────────────────────────────────────────────────────
async function getOrgPayload(userId) {
  const result = await db.query(
    `SELECT ou.org_id, ou.role, o.name AS org_name, o.slug AS org_slug
     FROM org_users ou
     LEFT JOIN organizations o ON o.id = ou.org_id
     WHERE ou.user_id = $1 AND ou.is_active = TRUE
     ORDER BY ou.joined_at ASC
     LIMIT 1`,
    [userId]
  );
  return {
    org_id:   result.rows[0]?.org_id   ?? null,
    role:     result.rows[0]?.role     ?? 'member',
    org_name: result.rows[0]?.org_name ?? null,
    org_slug: result.rows[0]?.org_slug ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// Helper: check if user has active super admin access.
// Returns boolean — used to include is_super_admin in login
// response so the frontend can gate the Platform Admin nav item
// without an extra round-trip.
// ─────────────────────────────────────────────────────────────
async function isSuperAdmin(userId) {
  const result = await db.query(
    `SELECT 1 FROM super_admins WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  return result.rows.length > 0;
}

// ─────────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    // Public self-registration is disabled. Previously this route inserted any
    // anonymous signup into org_id = 1 (the live dogfood org) as a member,
    // granting read access to production data. Until invite-based onboarding
    // exists, accounts are created from the backend only. Set
    // ALLOW_PUBLIC_SIGNUP='true' to re-enable (intentionally explicit).
    if (process.env.ALLOW_PUBLIC_SIGNUP !== 'true') {
      return res.status(403).json({
        error: { message: 'Public registration is disabled. Contact your administrator for access.' },
      });
    }

    const { error } = registerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: { message: error.details[0].message } });
    }

    const { password, firstName, lastName } = req.body;
    // Normalize email: lowercase + trim on write and on every lookup so
    // Foo@x.com and foo@x.com can't become two accounts, and so password-reset
    // (which already lowercases) resolves the same row as login.
    const email = String(req.body.email || '').toLowerCase().trim();
    const regTz = isValidTimeZone(req.body.timezone) ? req.body.timezone : null;

    // Check if user exists — compare case-insensitively so a legacy
    // mixed-case row (stored before emails were normalized) still blocks
    // a duplicate lowercase signup.
    const existingUser = await db.query(
      'SELECT id FROM users WHERE LOWER(email) = $1',
      [email]
    );
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: { message: 'User already exists' } });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user — org_id defaults to seed org (1) from migration
    const result = await db.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, org_id, timezone)
       VALUES ($1, $2, $3, $4, 1, $5)
       RETURNING id, email, first_name, last_name, role, timezone, created_at`,
      [email, passwordHash, firstName, lastName, regTz]
    );
    const user = result.rows[0];

    // Add to org_users so orgContext middleware can find them
    await db.query(
      `INSERT INTO org_users (org_id, user_id, role)
       VALUES (1, $1, 'member')
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [user.id]
    );

    // Build JWT payload with org context
    const orgPayload = await getOrgPayload(user.id);
    const superAdmin = await isSuperAdmin(user.id);

    const token = jwt.sign(
      {
        userId: user.id,        // kept as userId to match existing convention
        email:  user.email,
        org_id: orgPayload.org_id,
        role:   orgPayload.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({
      user: {
        id:             user.id,
        email:          user.email,
        firstName:      user.first_name,
        lastName:       user.last_name,
        role:           user.role,
        timezone:       user.timezone,
        org_id:         orgPayload.org_id,
        org_role:       orgPayload.role,
        org_name:       orgPayload.org_name,
        org_slug:       orgPayload.org_slug,
        is_super_admin: superAdmin,
      },
      token
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: { message: 'Registration failed' } });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { error } = loginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: { message: error.details[0].message } });
    }

    const { password } = req.body;
    // Match the normalization used at registration / password-reset so a
    // capitalized-email account still resolves on login.
    const email = String(req.body.email || '').toLowerCase().trim();

    // Get user — LOWER(email) so accounts stored with mixed case before
    // emails were normalized (input is lowercased above) can still log in.
    const result = await db.query(
      'SELECT * FROM users WHERE LOWER(email) = $1',
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: { message: 'Invalid credentials' } });
    }
    const user = result.rows[0];

    // Verify password
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: { message: 'Invalid credentials' } });
    }

    // Get org membership
    const orgPayload = await getOrgPayload(user.id);
    const superAdmin = await isSuperAdmin(user.id);

    // First-login timezone capture: only set if not already stored, so a
    // value the rep later edits in settings is never overwritten by a login
    // from a differently-configured device.
    if (!user.timezone && isValidTimeZone(req.body.timezone)) {
      try {
        await db.query(
          `UPDATE users SET timezone = $1, updated_at = NOW() WHERE id = $2 AND timezone IS NULL`,
          [req.body.timezone, user.id]
        );
        user.timezone = req.body.timezone;
      } catch (tzErr) {
        console.warn('Timezone capture on login failed (non-fatal):', tzErr.message);
      }
    }
    const token = jwt.sign(
      {
        userId: user.id,        // kept as userId to match existing convention
        email:  user.email,
        org_id: orgPayload.org_id,
        role:   orgPayload.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      user: {
        id:             user.id,
        email:          user.email,
        firstName:      user.first_name,
        lastName:       user.last_name,
        role:           user.role,
        timezone:       user.timezone,
        org_id:         orgPayload.org_id,
        org_role:       orgPayload.role,
        org_name:       orgPayload.org_name,
        org_slug:       orgPayload.org_slug,
        is_super_admin: superAdmin,
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: { message: 'Login failed' } });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/auth/verify
// Used by the frontend on page load to rehydrate user state.
// Now also returns org_id so the frontend can store it.
// ─────────────────────────────────────────────────────────────
router.get('/verify', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: { message: 'No token provided' } });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await db.query(
      'SELECT id, email, first_name, last_name, role, timezone FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: { message: 'User not found' } });
    }
    const user = result.rows[0];

    // Always do a fresh DB lookup for org — handles cases where
    // the JWT is old and doesn't carry org_id yet
    const orgPayload = await getOrgPayload(user.id);
    const superAdmin = await isSuperAdmin(user.id);

    res.json({
      user: {
        id:             user.id,
        email:          user.email,
        firstName:      user.first_name,
        lastName:       user.last_name,
        role:           user.role,
        timezone:       user.timezone,
        org_id:         orgPayload.org_id,
        org_role:       orgPayload.role,
        org_name:       orgPayload.org_name,
        org_slug:       orgPayload.org_slug,
        is_super_admin: superAdmin,
      }
    });
  } catch (error) {
    res.status(401).json({ error: { message: 'Invalid token' } });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/refresh
//
// Contract (matches frontend prospectingShared._refreshToken):
//   Request:  Authorization: Bearer <current token>  (may be expired)
//   Response: { token } — a fresh JWT with current org context
//
// Accepts a token whose signature is valid but which expired within
// REFRESH_GRACE_MS (24h). Beyond the grace window — or on any signature
// problem — the user must log in again. Org context and role are re-read
// from the DB at refresh time so a role/org change since login takes
// effect on the new token rather than being copied forward.
// ─────────────────────────────────────────────────────────────
const REFRESH_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours past expiry

router.post('/refresh', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: { message: 'No token provided', code: 'TOKEN_MISSING' } });
    }

    // Verify the signature while tolerating expiry; expiry is checked
    // manually against the grace window below.
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
    } catch (e) {
      // Bad signature / malformed — never refreshable.
      return res.status(401).json({ error: { message: 'Invalid token', code: 'TOKEN_INVALID' } });
    }

    if (decoded.exp && (Date.now() - decoded.exp * 1000) > REFRESH_GRACE_MS) {
      return res.status(401).json({ error: { message: 'Session expired. Please log in again.', code: 'TOKEN_EXPIRED' } });
    }

    const userId = decoded.userId || decoded.id || decoded.sub;
    if (!userId) {
      return res.status(401).json({ error: { message: 'Invalid token', code: 'TOKEN_INVALID' } });
    }

    // User must still exist; org membership re-resolved fresh.
    const userRes = await db.query(
      'SELECT id, email FROM users WHERE id = $1',
      [userId]
    );
    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: { message: 'User not found', code: 'TOKEN_INVALID' } });
    }
    const user = userRes.rows[0];
    const orgPayload = await getOrgPayload(user.id);

    const newToken = jwt.sign(
      {
        userId: user.id,        // kept as userId to match existing convention
        email:  user.email,
        org_id: orgPayload.org_id,
        role:   orgPayload.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({ token: newToken });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ error: { message: 'Token refresh failed' } });
  }
});

// ─────────────────────────────────────────────────────────────
// Password Reset — dependencies
// ─────────────────────────────────────────────────────────────
const crypto      = require('crypto');
// ─── Gmail REST API sender (no SMTP — works on Railway) ──────────────────────
// Uses Google's token endpoint + Gmail API over HTTPS port 443.
// Required env vars: MAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
// ─────────────────────────────────────────────────────────────────────────────
async function getAccessToken() {
  const params = new URLSearchParams({
    client_id:     process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    grant_type:    'refresh_token',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error('[Mailer] Token exchange failed:', JSON.stringify(data));
    throw new Error(`Token exchange failed: ${data.error} — ${data.error_description}`);
  }
  console.log('[Mailer] Access token obtained successfully');
  return data.access_token;
}

async function sendGmailApi({ to, subject, html }) {
  console.log('[Mailer] MAIL_USER:', process.env.MAIL_USER || 'NOT SET');
  console.log('[Mailer] GMAIL_CLIENT_ID set:', !!process.env.GMAIL_CLIENT_ID);
  console.log('[Mailer] GMAIL_CLIENT_SECRET set:', !!process.env.GMAIL_CLIENT_SECRET);
  console.log('[Mailer] GMAIL_REFRESH_TOKEN set:', !!process.env.GMAIL_REFRESH_TOKEN);

  const accessToken = await getAccessToken();

  const from    = `"GoWarm CRM" <${process.env.MAIL_USER}>`;
  const mime    = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  ].join('\r\n');

  const encoded = Buffer.from(mime).toString('base64url');

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(process.env.MAIL_USER)}/messages/send`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: encoded }),
    }
  );

  const data = await res.json();
  if (!res.ok) {
    console.error('[Mailer] Gmail API send failed:', JSON.stringify(data));
    throw new Error(`Gmail API error: ${data.error?.message || JSON.stringify(data)}`);
  }
  console.log('[Mailer] Gmail API send success — message id:', data.id);
  return data;
}

// ─── Gmail OAuth2 Transporter ─────────────────────────────────────────────────
// Uses OAuth2 over HTTPS (port 443) instead of SMTP — required on Railway
// which blocks outbound SMTP ports (465/587).
//
// Required env vars:
//   MAIL_USER             — e.g. demo@gowarmcrm.com
//   GMAIL_CLIENT_ID       — from Google Cloud Console OAuth2 credential
//   GMAIL_CLIENT_SECRET   — from Google Cloud Console OAuth2 credential
//   GMAIL_REFRESH_TOKEN   — from OAuth Playground (https://developers.google.com/oauthplayground)
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// Body: { email }
// Always returns 200 — never reveals whether the email exists.
// ─────────────────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: { message: 'Email is required' } });
  }

  try {
    // Look up user — silently succeed even if not found
    const { rows } = await db.query(
      'SELECT id, first_name, email FROM users WHERE LOWER(email) = $1',
      [email.toLowerCase().trim()]
    );

    if (rows.length > 0) {
      const user = rows[0];

      // Invalidate any existing unused tokens for this user
      await db.query(
        `UPDATE password_reset_tokens
         SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );

      // Generate a cryptographically secure raw token (32 bytes = 64 hex chars)
      const rawToken  = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await db.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, tokenHash, expiresAt]
      );

      // Build the reset link — points to the frontend
      const appUrl    = process.env.APP_URL || 'https://app.gowarmcrm.com';
      const resetLink = `${appUrl}/reset-password?token=${rawToken}`;

      // Send email
      console.log(`[ForgotPassword] Attempting to send reset email to ${user.email}`);
      try {
        await sendGmailApi({
          to:      user.email,
          subject: 'Reset your GoWarm CRM password',
          html: `
            <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
              <div style="margin-bottom:24px;">
                <span style="font-size:22px;font-weight:800;color:#1a1a1a;">Go<span style="color:#E8630A;">Warm</span> CRM</span>
              </div>
              <h2 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 12px;">Reset your password</h2>
              <p style="color:#6b7280;font-size:15px;line-height:1.6;margin:0 0 24px;">
                Hi ${user.first_name}, we received a request to reset the password for your GoWarm CRM account.
                Click the button below to choose a new password. This link expires in <strong>1 hour</strong>.
              </p>
              <a href="${resetLink}"
                 style="display:inline-block;padding:12px 28px;background:#E8630A;color:#fff;
                        font-size:15px;font-weight:600;border-radius:8px;text-decoration:none;">
                Reset Password
              </a>
              <p style="color:#9ca3af;font-size:13px;margin:24px 0 0;">
                If you didn't request this, you can safely ignore this email — your password won't change.
              </p>
              <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
              <p style="color:#d1d5db;font-size:12px;margin:0;">GoWarm CRM · This link expires in 1 hour.</p>
            </div>
          `,
        });
        console.log(`[ForgotPassword] ✅ Reset email sent to ${user.email}`);
      } catch (mailErr) {
        console.error('[ForgotPassword] ❌ Mail error:', mailErr.message);
        console.error('[ForgotPassword] Mail error code:', mailErr.code || 'n/a');
      }
    }

    // Always return the same response — prevents email enumeration
    res.json({ message: 'If an account exists for that email, a reset link has been sent.' });

  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: { message: 'Something went wrong. Please try again.' } });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// Body: { token, password }
// ─────────────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: { message: 'Token and new password are required' } });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: { message: 'Password must be at least 8 characters' } });
  }

  // All three writes (password update, mark token used, invalidate siblings)
  // happen in ONE transaction. Previously they were separate statements: a
  // failure after the password UPDATE left the token still valid — replayable
  // to set a second password. FOR UPDATE on the token row also prevents two
  // concurrent submits of the same link from both passing the validity check.
  const client = await db.pool.connect();
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    await client.query('BEGIN');

    // Find a valid, unused, non-expired token — locked for this transaction
    const { rows } = await client.query(
      `SELECT prt.id, prt.user_id
       FROM password_reset_tokens prt
       WHERE prt.token_hash = $1
         AND prt.used_at   IS NULL
         AND prt.expires_at > NOW()
       FOR UPDATE`,
      [tokenHash]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: { message: 'This reset link is invalid or has expired. Please request a new one.' }
      });
    }

    const { id: tokenId, user_id: userId } = rows[0];

    // Hash new password and update user
    const passwordHash = await bcrypt.hash(password, 10);
    await client.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [passwordHash, userId]
    );

    // Mark token as used
    await client.query(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
      [tokenId]
    );

    // Invalidate any other unused tokens for this user
    await client.query(
      `UPDATE password_reset_tokens
       SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL AND id != $2`,
      [userId, tokenId]
    );

    await client.query('COMMIT');

    console.log(`🔐 Password reset successful for user ${userId}`);
    res.json({ message: 'Password reset successfully. You can now sign in.' });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {} // no-op if BEGIN never ran
    console.error('Reset password error:', err);
    res.status(500).json({ error: { message: 'Something went wrong. Please try again.' } });
  } finally {
    client.release();
  }
});

module.exports = router;
