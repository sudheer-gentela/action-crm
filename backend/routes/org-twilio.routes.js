/**
 * /api/org/admin/twilio
 *
 * Admin endpoints for Twilio (Phase 3):
 *
 *   GET    /reps                  List org reps with their DID + phone status
 *   POST   /provision-did/:userId Buy a new DID and assign it to the rep
 *   POST   /release-did/:userId   Release the rep's DID back to Twilio
 *   PATCH  /settings              Update org-level Twilio settings
 *                                 (recording_enabled, recording_disclosure_enabled,
 *                                  rate_limits.{per_user,per_org}_per_minute)
 *
 * Authorization: orgs admin/owner only. Same pattern as orgAdmin.routes.js.
 *
 * Mount in server.js:
 *   app.use('/api/org/admin/twilio', require('./routes/org-twilio.routes'));
 */

const express = require('express');
const router  = express.Router();

const db                  = require('../config/database');
const authenticateToken   = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const requireModule       = require('../middleware/requireModule.middleware');
const TwilioProvider      = require('../services/twilioProvider.service');
const CallSettingsService = require('../services/callSettings.service');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

const adminOnly = requireRole('owner', 'admin');


// =========================================================================
// GET /reps — list reps with their phone + DID status
// =========================================================================
router.get('/reps', adminOnly, async (req, res) => {
  try {
    const { rows } = await db.pool.query(
      `SELECT
         u.id,
         u.email,
         (u.first_name || ' ' || u.last_name) AS name,
         u.role,
         u.phone,
         u.twilio_did,
         u.twilio_did_sid,
         u.twilio_did_provisioned_at,
         (u.phone IS NOT NULL AND u.twilio_did IS NOT NULL) AS ready_to_call
       FROM users u
       JOIN org_users ou ON ou.user_id = u.id AND ou.org_id = u.org_id
      WHERE u.org_id = $1 AND ou.is_active = true
      ORDER BY u.first_name, u.last_name`,
      [req.orgId]
    );
    return res.json({ reps: rows });
  } catch (err) {
    console.error('GET /org/admin/twilio/reps error:', err);
    return res.status(500).json({ error: { message: 'Failed to load reps' } });
  }
});


// =========================================================================
// POST /provision-did/:userId — buy + assign a DID for this rep
// =========================================================================
// Body: { area_code: "415" }
//
// On failure AFTER the Twilio purchase succeeds, we attempt to release the
// DID so we don't end up paying for a number we lost track of.
// =========================================================================
router.post('/provision-did/:userId', adminOnly, async (req, res) => {
  const userId   = parseInt(req.params.userId, 10);
  const areaCode = String(req.body.area_code || '').trim();

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: { message: 'Invalid user id' } });
  }
  if (!/^\d{3}$/.test(areaCode)) {
    return res.status(400).json({ error: { message: 'area_code must be a 3-digit US area code (e.g. "415")' } });
  }

  // Pre-flight: rep exists in this org, no DID yet.
  const repRes = await db.pool.query(
    `SELECT id, twilio_did FROM users WHERE id = $1 AND org_id = $2`,
    [userId, req.orgId]
  );
  if (!repRes.rows.length) {
    return res.status(404).json({ error: { message: 'User not found in this org' } });
  }
  if (repRes.rows[0].twilio_did) {
    return res.status(409).json({
      error: { message: 'This user already has a DID assigned. Release it first.', code: 'DID_ALREADY_ASSIGNED' },
    });
  }

  // Twilio config check.
  try { TwilioProvider.validateConfig(); }
  catch (cfgErr) {
    return res.status(503).json({ error: { message: 'Twilio is not configured for this deployment.' } });
  }

  // Purchase.
  let provisioned;
  try {
    provisioned = await TwilioProvider.provisionDid({ areaCode });
  } catch (err) {
    if (err.code === 'TWILIO_NO_NUMBERS_AVAILABLE') {
      return res.status(409).json({ error: { message: err.message, code: 'NO_NUMBERS_AVAILABLE' } });
    }
    console.error('provisionDid error:', err);
    return res.status(502).json({
      error: {
        message: err.message || 'Failed to provision DID via Twilio',
        code:    err.code ? `TWILIO_${err.code}` : 'TWILIO_ERROR',
      },
    });
  }

  // Persist.
  try {
    await db.pool.query(
      `UPDATE users
          SET twilio_did                = $1,
              twilio_did_sid            = $2,
              twilio_did_provisioned_at = NOW(),
              updated_at                = NOW()
        WHERE id = $3 AND org_id = $4`,
      [provisioned.did, provisioned.did_sid, userId, req.orgId]
    );
  } catch (err) {
    // Roll back the Twilio purchase to avoid orphan billed numbers.
    console.error('provision-did: DB write failed after Twilio purchase, attempting release:', err);
    try { await TwilioProvider.releaseDid(provisioned.did_sid); }
    catch (_) {
      console.error('CRITICAL: DID purchased but neither DB nor Twilio release succeeded:', {
        did: provisioned.did, did_sid: provisioned.did_sid, user_id: userId,
      });
    }
    return res.status(500).json({ error: { message: 'Failed to assign DID to user' } });
  }

  return res.status(201).json({
    rep_id:                    userId,
    twilio_did:                provisioned.did,
    twilio_did_sid:            provisioned.did_sid,
    twilio_did_provisioned_at: new Date().toISOString(),
    area_code:                 provisioned.area_code,
    capabilities:              provisioned.capabilities,
  });
});


// =========================================================================
// POST /release-did/:userId — release the rep's DID back to Twilio
// =========================================================================
router.post('/release-did/:userId', adminOnly, async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: { message: 'Invalid user id' } });
  }

  const repRes = await db.pool.query(
    `SELECT id, twilio_did, twilio_did_sid FROM users WHERE id = $1 AND org_id = $2`,
    [userId, req.orgId]
  );
  if (!repRes.rows.length) {
    return res.status(404).json({ error: { message: 'User not found in this org' } });
  }
  const rep = repRes.rows[0];
  if (!rep.twilio_did_sid) {
    return res.status(409).json({ error: { message: 'This user has no DID assigned.', code: 'NO_DID' } });
  }

  // Clear DB first — once the DID is released on Twilio, it may be re-issued
  // to a different customer almost immediately. The DB row must reflect that.
  try {
    await db.pool.query(
      `UPDATE users
          SET twilio_did                = NULL,
              twilio_did_sid            = NULL,
              twilio_did_provisioned_at = NULL,
              updated_at                = NOW()
        WHERE id = $1 AND org_id = $2`,
      [userId, req.orgId]
    );
  } catch (err) {
    console.error('release-did: DB clear failed:', err);
    return res.status(500).json({ error: { message: 'Failed to clear DID assignment' } });
  }

  // Then release on Twilio.
  try {
    await TwilioProvider.releaseDid(rep.twilio_did_sid);
  } catch (err) {
    console.error('CRITICAL: DID cleared from DB but Twilio release failed:', {
      did: rep.twilio_did, did_sid: rep.twilio_did_sid, user_id: userId, error: err.message,
    });
    return res.status(207).json({
      warning: {
        message: 'DID was unassigned in GoWarm but the Twilio release call failed. Manual cleanup needed in Twilio console.',
        twilio_did:     rep.twilio_did,
        twilio_did_sid: rep.twilio_did_sid,
      },
    });
  }

  return res.json({ released: true, twilio_did: rep.twilio_did });
});


// =========================================================================
// PATCH /settings — org-level Twilio toggles + rate limits
// =========================================================================
router.patch('/settings', adminOnly, async (req, res) => {
  const patch = {};

  if ('recording_enabled' in req.body) {
    if (typeof req.body.recording_enabled !== 'boolean') {
      return res.status(400).json({ error: { message: 'recording_enabled must be boolean' } });
    }
    patch.recording_enabled = req.body.recording_enabled;
  }

  if ('recording_disclosure_enabled' in req.body) {
    if (typeof req.body.recording_disclosure_enabled !== 'boolean') {
      return res.status(400).json({ error: { message: 'recording_disclosure_enabled must be boolean' } });
    }
    patch.recording_disclosure_enabled = req.body.recording_disclosure_enabled;
  }

  if (req.body.rate_limits && typeof req.body.rate_limits === 'object') {
    const rl = req.body.rate_limits;
    const out = {};
    if ('per_user_per_minute' in rl) {
      const n = Number(rl.per_user_per_minute);
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        return res.status(400).json({ error: { message: 'rate_limits.per_user_per_minute must be an integer 1-100' } });
      }
      out.per_user_per_minute = n;
    }
    if ('per_org_per_minute' in rl) {
      const n = Number(rl.per_org_per_minute);
      if (!Number.isInteger(n) || n < 1 || n > 1000) {
        return res.status(400).json({ error: { message: 'rate_limits.per_org_per_minute must be an integer 1-1000' } });
      }
      out.per_org_per_minute = n;
    }
    if (Object.keys(out).length) patch.rate_limits = out;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: { message: 'No editable fields supplied' } });
  }

  try {
    const updated = await CallSettingsService.setForOrg(req.orgId, patch, req.user.userId);
    return res.json({ settings: updated });
  } catch (err) {
    console.error('PATCH /org/admin/twilio/settings error:', err);
    const msg = err.message || 'Failed to update Twilio settings';
    const isValidation = /must be|required|cannot|exceeds/i.test(msg);
    return res.status(isValidation ? 400 : 500).json({ error: { message: msg } });
  }
});


module.exports = router;
