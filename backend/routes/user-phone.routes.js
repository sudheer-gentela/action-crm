/**
 * /api/users/me/phone
 *
 * Phase 3 — manages the rep's personal phone number. Used by Twilio to dial
 * the rep first in the two-legged outbound call.
 *
 *   GET   /  Return current phone + whether a DID is assigned
 *   PATCH /  Update the user's phone number (E.164 format)
 *
 * Storage: users.phone (column, not user_preferences JSONB) because the
 * Twilio service needs to JOIN against this from many query paths.
 *
 * Mount in server.js (alongside existing user-preferences mount):
 *   app.use('/api/users/me', require('./routes/user-phone.routes'));
 */

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const { isValidTimeZone } = require('../utils/repTimezone');

router.use(authenticateToken);
router.use(orgContext);

// Loose E.164 check. Real validation happens at Twilio call time.
const E164_RE = /^\+[1-9]\d{7,14}$/;


// ── Personal timezone ────────────────────────────────────────────────────────
//   GET   /timezone  Return the rep's stored IANA timezone (null if unset)
//   PATCH /timezone  Update it. Validated against the IANA set app-side.
// Stored on users.timezone (column). NULL is treated as UTC at format time.
router.get('/timezone', async (req, res) => {
  try {
    const { rows } = await db.pool.query(
      `SELECT timezone FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'User not found' } });
    return res.json({ timezone: rows[0].timezone || null });
  } catch (err) {
    console.error('GET /users/me/timezone error:', err);
    return res.status(500).json({ error: { message: 'Failed to load timezone' } });
  }
});

router.patch('/timezone', async (req, res) => {
  if (!('timezone' in req.body)) {
    return res.status(400).json({ error: { message: 'timezone is required (IANA string or null)' } });
  }

  let tz = req.body.timezone;
  if (tz === '' || tz === null || tz === undefined) {
    tz = null; // clearing reverts to UTC at format time
  } else if (!isValidTimeZone(tz)) {
    return res.status(400).json({
      error: { message: 'timezone must be a valid IANA name (e.g. Asia/Kolkata)', code: 'INVALID_TIMEZONE' },
    });
  }

  try {
    await db.pool.query(
      `UPDATE users SET timezone = $1, updated_at = NOW() WHERE id = $2`,
      [tz, req.user.userId]
    );
    return res.json({ timezone: tz });
  } catch (err) {
    console.error('PATCH /users/me/timezone error:', err);
    return res.status(500).json({ error: { message: 'Failed to save timezone' } });
  }
});


router.get('/phone', async (req, res) => {
  try {
    const { rows } = await db.pool.query(
      `SELECT phone, twilio_did, twilio_did_provisioned_at
         FROM users WHERE id = $1 AND org_id = $2`,
      [req.user.userId, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'User not found' } });

    const u = rows[0];
    return res.json({
      phone:                     u.phone,
      twilio_did:                u.twilio_did,
      twilio_did_provisioned_at: u.twilio_did_provisioned_at,
      ready_to_call:             !!(u.phone && u.twilio_did),
    });
  } catch (err) {
    console.error('GET /users/me/phone error:', err);
    return res.status(500).json({ error: { message: 'Failed to load phone' } });
  }
});


router.patch('/phone', async (req, res) => {
  if (!('phone' in req.body)) {
    return res.status(400).json({ error: { message: 'phone is required (string or null)' } });
  }

  let phone = req.body.phone;
  if (phone === '' || phone === null || phone === undefined) {
    phone = null;
  } else {
    phone = String(phone).trim();
    if (!E164_RE.test(phone)) {
      return res.status(400).json({
        error: { message: 'Phone must be in E.164 format (e.g. +14155551234)', code: 'INVALID_PHONE_FORMAT' },
      });
    }
  }

  try {
    await db.pool.query(
      `UPDATE users SET phone = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3`,
      [phone, req.user.userId, req.orgId]
    );
    return res.json({ phone });
  } catch (err) {
    console.error('PATCH /users/me/phone error:', err);
    return res.status(500).json({ error: { message: 'Failed to save phone' } });
  }
});


module.exports = router;
