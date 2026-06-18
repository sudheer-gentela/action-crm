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
const TwilioAccounts      = require('../services/twilioAccounts.service');
const CallSettingsService = require('../services/callSettings.service');
const { requireEntitlement } = require('../services/entitlements.service');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

const adminOnly = requireRole('owner', 'admin');

// Calling is a paid capability. Gate every action that creates or relies on
// billed Twilio resources (subaccount, DIDs) behind the calling entitlement.
// Read-only routes (GET /reps, GET /account, PATCH /settings) stay open so an
// admin can still see state and toggle non-billed prefs even if calling lapses.
const callingEntitled = requireEntitlement('calling');


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
         -- Individual-level calling state. Read via to_jsonb so this query is
         -- safe to run BEFORE the calling_enabled column migration: a missing
         -- key yields null, treated as enabled. Only an explicit false revokes.
         ((to_jsonb(u) ->> 'calling_enabled') IS DISTINCT FROM 'false') AS calling_enabled,
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
router.post('/provision-did/:userId', adminOnly, callingEntitled, async (req, res) => {
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

  // Twilio config check: parent/webhook config + this org has a subaccount.
  try { TwilioProvider.validateConfig(); }
  catch (cfgErr) {
    return res.status(503).json({ error: { message: 'Twilio is not configured for this deployment.' } });
  }
  if (!(await TwilioAccounts.isProvisioned(req.orgId))) {
    return res.status(409).json({
      error: {
        message: 'This org has no Twilio subaccount yet. Provision one first (POST /api/org/admin/twilio/provision-account).',
        code:    'TWILIO_NOT_PROVISIONED',
      },
    });
  }

  // Purchase.
  let provisioned;
  try {
    provisioned = await TwilioProvider.provisionDid({ orgId: req.orgId, areaCode });
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
    try { await TwilioProvider.releaseDid(req.orgId, provisioned.did_sid); }
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
    await TwilioProvider.releaseDid(req.orgId, rep.twilio_did_sid);
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
// POST /claim-did/:userId — assign an existing Twilio DID to a rep
// =========================================================================
// Body: { did_sid: "PN..." }
//
// Used when an admin wants to assign a DID that was provisioned through the
// Twilio console (e.g. the trial DID, a ported number) rather than buying a
// new one through provisionDid. The DID must already exist in our Twilio
// account.
//
// Side-effects:
//   1. Verify the rep exists in this org and doesn't already have a DID
//   2. Verify no other user (in any org) already has this DID — DIDs are
//      globally unique within our Twilio account, so two reps can't share
//   3. Call Twilio API to fetch the number details and update its voice URL
//      to route inbound calls to our backend
//   4. Persist the DID + SID on the rep's user row
//
// Important: step 3 OVERWRITES whatever voice routing was previously
// configured on the Twilio number. The success response surfaces this so
// the admin knows.
// =========================================================================
router.post('/claim-did/:userId', adminOnly, callingEntitled, async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const didSid = String(req.body.did_sid || '').trim();

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: { message: 'Invalid user id' } });
  }
  if (!/^PN[a-f0-9]+$/i.test(didSid)) {
    return res.status(400).json({
      error: {
        message: 'did_sid must be a Twilio phone-number SID starting with PN (find it in the Twilio console)',
        code:    'INVALID_DID_SID',
      },
    });
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

  // Uniqueness: no other user (in ANY org) can be holding this SID. The
  // partial unique index on users.twilio_did would catch this at write
  // time, but the up-front check returns a friendlier error and prevents
  // wasting a Twilio API call.
  const existingRes = await db.pool.query(
    `SELECT id, email, org_id FROM users WHERE twilio_did_sid = $1 LIMIT 1`,
    [didSid]
  );
  if (existingRes.rows.length) {
    const other = existingRes.rows[0];
    const sameOrg = other.org_id === req.orgId;
    return res.status(409).json({
      error: {
        message: sameOrg
          ? `This DID is already assigned to ${other.email}. Release it from that user first.`
          : 'This DID is already in use by another GoWarmCRM organization.',
        code: sameOrg ? 'DID_ASSIGNED_SAME_ORG' : 'DID_ASSIGNED_OTHER_ORG',
      },
    });
  }

  // Twilio config check: parent/webhook config + this org has a subaccount.
  try { TwilioProvider.validateConfig(); }
  catch (cfgErr) {
    return res.status(503).json({ error: { message: 'Twilio is not configured for this deployment.' } });
  }
  if (!(await TwilioAccounts.isProvisioned(req.orgId))) {
    return res.status(409).json({
      error: {
        message: 'This org has no Twilio subaccount yet. Provision one first (POST /api/org/admin/twilio/provision-account).',
        code:    'TWILIO_NOT_PROVISIONED',
      },
    });
  }

  // Claim on Twilio side — verifies SID exists in our account, rewires the
  // voice URL to our inbound webhook.
  let claimed;
  try {
    claimed = await TwilioProvider.claimDid(req.orgId, didSid);
  } catch (err) {
    if (err.code === 'TWILIO_DID_NOT_FOUND') {
      return res.status(404).json({
        error: { message: err.message, code: 'TWILIO_DID_NOT_FOUND' },
      });
    }
    console.error('claimDid error:', err);
    return res.status(502).json({
      error: {
        message: err.message || 'Twilio could not claim the DID',
        code:    err.code ? `TWILIO_${err.code}` : 'TWILIO_ERROR',
      },
    });
  }

  // Persist on the user row.
  try {
    await db.pool.query(
      `UPDATE users
          SET twilio_did                = $1,
              twilio_did_sid            = $2,
              twilio_did_provisioned_at = NOW(),
              updated_at                = NOW()
        WHERE id = $3 AND org_id = $4`,
      [claimed.did, claimed.did_sid, userId, req.orgId]
    );
  } catch (err) {
    // Failure here is unrecoverable — we already overwrote the voice URL
    // on Twilio's side, so the previous routing is gone. Log loudly so the
    // admin sees this in Railway and can manually restore via Twilio
    // console if needed.
    console.error('claim-did: DB write failed after Twilio voice URL update:', {
      did: claimed.did, did_sid: claimed.did_sid, user_id: userId, error: err.message,
    });
    return res.status(500).json({
      error: {
        message: 'Twilio voice URL was updated but the GoWarm DB write failed. Contact support.',
        code:    'DB_WRITE_FAILED_AFTER_CLAIM',
      },
    });
  }

  return res.status(201).json({
    rep_id:                    userId,
    twilio_did:                claimed.did,
    twilio_did_sid:            claimed.did_sid,
    twilio_did_provisioned_at: new Date().toISOString(),
    capabilities:              claimed.capabilities,
    // Surface the overwrite so the UI can show a "previous routing replaced"
    // message. previous_voice_url may be empty/null for never-configured DIDs.
    previous_voice_url:        claimed.previous_voice_url,
    voice_url_overwritten:     !!claimed.previous_voice_url,
  });
});


// =========================================================================
// PATCH /reps/:userId/calling — individual-level calling enable/disable
// =========================================================================
// Body: { enabled: boolean }
//
// Org-admin control to revoke or restore calling for a single rep, INDEPENDENT
// of the org-level calling entitlement. Enforced at every call-placement path
// (voice token mint, /prepare, /initiate) via
// TwilioAccounts.isUserCallingEnabled.
//
// Does not touch the rep's DID — a disabled rep keeps their number; they just
// can't place calls until re-enabled.
// =========================================================================
router.patch('/reps/:userId/calling', adminOnly, async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: { message: 'Invalid user id' } });
  }
  if (typeof req.body.enabled !== 'boolean') {
    return res.status(400).json({ error: { message: 'enabled must be boolean' } });
  }

  try {
    const { rows } = await db.pool.query(
      `UPDATE users
          SET calling_enabled = $1,
              updated_at       = NOW()
        WHERE id = $2 AND org_id = $3
      RETURNING id`,
      [req.body.enabled, userId, req.orgId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: { message: 'User not found in this org' } });
    }
    return res.json({ rep_id: userId, calling_enabled: req.body.enabled });
  } catch (err) {
    if (err.code === '42703') {
      // Column not migrated yet.
      return res.status(409).json({
        error: {
          message: 'The calling_enabled column has not been added yet. Run the users.calling_enabled migration first.',
          code:    'MIGRATION_REQUIRED',
        },
      });
    }
    console.error('PATCH /org/admin/twilio/reps/:userId/calling error:', err);
    return res.status(500).json({ error: { message: 'Failed to update calling state' } });
  }
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


// =========================================================================
// GET /account — this org's Twilio subaccount status (safe summary)
// =========================================================================
// Never returns secrets — only SIDs, last4s, and provisioning state. Drives
// the admin "Twilio setup" panel and the per-org cost screen's header.
// =========================================================================
router.get('/account', adminOnly, async (req, res) => {
  try {
    const row = await TwilioAccounts.getRow(req.orgId);
    if (!row) {
      return res.json({ provisioned: false });
    }
    return res.json({
      provisioned:        row.status === 'active',
      status:             row.status,
      subaccount_sid:     row.subaccount_sid,
      friendly_name:      row.friendly_name,
      api_key_sid:        row.api_key_sid || null,
      twiml_app_sid:      row.twiml_app_sid || null,
      auth_token_last4:   row.auth_token_last4 || null,
      softphone_ready:    !!(row.api_key_sid && row.twiml_app_sid),
      created_at:         row.created_at,
    });
  } catch (err) {
    console.error('GET /org/admin/twilio/account error:', err);
    return res.status(500).json({ error: { message: 'Failed to load Twilio account status' } });
  }
});


// =========================================================================
// POST /provision-account — create this org's Twilio subaccount
// =========================================================================
// Body (optional): { friendly_name: "Acme Corp" }
//
// Creates the subaccount + an API key + a TwiML App (for browser dialing) and
// stores the encrypted credentials. Idempotent: if the org already has a
// subaccount, returns the existing summary with already_existed=true rather
// than creating a duplicate. Must succeed before provision-did / claim-did /
// calling will work for this org.
//
// Requires parent Twilio creds (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN) and
// AI_CREDS_KEY for credential encryption.
// =========================================================================
router.post('/provision-account', adminOnly, callingEntitled, async (req, res) => {
  // Parent/webhook config must be present to create subaccounts + TwiML Apps.
  try { TwilioProvider.validateConfig(); }
  catch (cfgErr) {
    return res.status(503).json({
      error: { message: 'Twilio parent account is not configured for this deployment.', code: 'TWILIO_NOT_CONFIGURED' },
    });
  }

  const friendlyName = typeof req.body.friendly_name === 'string' && req.body.friendly_name.trim()
    ? req.body.friendly_name.trim()
    : undefined;

  try {
    const result = await TwilioAccounts.provisionSubaccount({ orgId: req.orgId, friendlyName });
    return res.status(result.already_existed ? 200 : 201).json({ account: result });
  } catch (err) {
    if (err.code === 'ENTITLEMENT_REQUIRED') {
      return res.status(402).json({
        error: {
          message:     'Calling is not included in your plan. Contact your account owner to enable it.',
          code:        'ENTITLEMENT_REQUIRED',
          entitlement: 'calling',
        },
      });
    }
    if (err.code === 'ENCRYPTION_NOT_CONFIGURED') {
      return res.status(503).json({
        error: { message: 'Credential encryption is not configured (AI_CREDS_KEY missing).', code: 'ENCRYPTION_NOT_CONFIGURED' },
      });
    }
    console.error('provision-account error:', err);
    return res.status(502).json({
      error: {
        message: err.message || 'Failed to provision Twilio subaccount',
        code:    err.code ? `TWILIO_${err.code}` : 'TWILIO_ERROR',
      },
    });
  }
});


module.exports = router;
