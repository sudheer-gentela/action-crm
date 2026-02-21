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
