const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const Joi = require('joi');

// ─────────────────────────────────────────────────────────────
// Validation schemas (unchanged)
// ─────────────────────────────────────────────────────────────
const registerSchema = Joi.object({
  email:     Joi.string().email().required(),
  password:  Joi.string().min(8).required(),
  firstName: Joi.string().required(),
  lastName:  Joi.string().required()
});

const loginSchema = Joi.object({
  email:    Joi.string().email().required(),
  password: Joi.string().required()
});

// ─────────────────────────────────────────────────────────────
// Helper: look up org membership for a user and return the
// payload fields needed for the JWT.
// Returns { org_id, role } — both null if user has no org yet.
// ─────────────────────────────────────────────────────────────
async function getOrgPayload(userId) {
  const result = await db.query(
    `SELECT org_id, role
     FROM org_users
     WHERE user_id = $1 AND is_active = TRUE
     ORDER BY joined_at ASC
     LIMIT 1`,
    [userId]
  );
  return {
    org_id: result.rows[0]?.org_id ?? null,
    role:   result.rows[0]?.role   ?? 'member',
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
    const { error } = registerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: { message: error.details[0].message } });
    }

    const { email, password, firstName, lastName } = req.body;

    // Check if user exists
    const existingUser = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: { message: 'User already exists' } });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user — org_id defaults to seed org (1) from migration
    const result = await db.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, org_id)
       VALUES ($1, $2, $3, $4, 1)
       RETURNING id, email, first_name, last_name, role, created_at`,
      [email, passwordHash, firstName, lastName]
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
        org_id:         orgPayload.org_id,
        org_role:       orgPayload.role,
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

    const { email, password } = req.body;

    // Get user
    const result = await db.query(
      'SELECT * FROM users WHERE email = $1',
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

    // Build JWT — org_id now included
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
        org_id:         orgPayload.org_id,
        org_role:       orgPayload.role,
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
      'SELECT id, email, first_name, last_name, role FROM users WHERE id = $1',
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
        org_id:         orgPayload.org_id,
        org_role:       orgPayload.role,
        is_super_admin: superAdmin,
      }
    });
  } catch (error) {
    res.status(401).json({ error: { message: 'Invalid token' } });
  }
});

module.exports = router;

// ─────────────────────────────────────────────────────────────
// Password Reset — dependencies
// ─────────────────────────────────────────────────────────────
const crypto      = require('crypto');
const nodemailer  = require('nodemailer');

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
let _transporter = null;
function getTransporter(force = false) {
  if (!_transporter || force) {
    console.log('[Mailer] Initialising OAuth2 transporter — MAIL_USER:', process.env.MAIL_USER || 'NOT SET');
    console.log('[Mailer] GMAIL_CLIENT_ID set:', !!process.env.GMAIL_CLIENT_ID);
    console.log('[Mailer] GMAIL_CLIENT_SECRET set:', !!process.env.GMAIL_CLIENT_SECRET);
    console.log('[Mailer] GMAIL_REFRESH_TOKEN set:', !!process.env.GMAIL_REFRESH_TOKEN);
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type:         'OAuth2',
        user:         process.env.MAIL_USER,
        clientId:     process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        refreshToken: process.env.GMAIL_REFRESH_TOKEN,
      },
    });
  }
  return _transporter;
}

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
      'SELECT id, first_name, email FROM users WHERE email = $1',
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
        await getTransporter().sendMail({
          from:    `"GoWarm CRM" <${process.env.MAIL_USER}>`,
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
        // Log but don't expose mail errors to the client
        console.error('Password reset mail error:', mailErr.message);
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

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Find a valid, unused, non-expired token
    const { rows } = await db.query(
      `SELECT prt.id, prt.user_id
       FROM password_reset_tokens prt
       WHERE prt.token_hash = $1
         AND prt.used_at   IS NULL
         AND prt.expires_at > NOW()`,
      [tokenHash]
    );

    if (rows.length === 0) {
      return res.status(400).json({
        error: { message: 'This reset link is invalid or has expired. Please request a new one.' }
      });
    }

    const { id: tokenId, user_id: userId } = rows[0];

    // Hash new password and update user
    const passwordHash = await bcrypt.hash(password, 10);
    await db.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [passwordHash, userId]
    );

    // Mark token as used
    await db.query(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
      [tokenId]
    );

    // Invalidate any other unused tokens for this user
    await db.query(
      `UPDATE password_reset_tokens
       SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL AND id != $2`,
      [userId, tokenId]
    );

    console.log(`🔐 Password reset successful for user ${userId}`);
    res.json({ message: 'Password reset successfully. You can now sign in.' });

  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: { message: 'Something went wrong. Please try again.' } });
  }
});
