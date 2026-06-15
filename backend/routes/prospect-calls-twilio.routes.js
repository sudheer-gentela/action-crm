/**
 * /api/prospect-calls  —  Phase 3 Twilio extensions
 *
 * Lives in a SEPARATE file from prospect-calls.routes.js to keep Phase 1+2
 * logic untouched. server.js mounts BOTH at the same path; Express runs
 * routes in mount order, so this file's specific paths (/initiate, /:id/status)
 * are matched first.
 *
 * Endpoints:
 *   POST /api/prospect-calls/initiate    Start a Twilio call
 *   GET  /api/prospect-calls/:id/status  Poll endpoint for the in-progress modal
 *
 * Important: the /:id/status route uses an integer-constrained param so it
 * does NOT collide with the existing GET /:id route in prospect-calls.routes.js.
 * Express resolves more-specific routes first; both files use the same prefix,
 * and only this file declares /:id/status.
 *
 * Auth + module gating: same middleware stack as Phase 1+2.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const db                    = require('../config/database');
const authenticateToken     = require('../middleware/auth.middleware');
const { orgContext }        = require('../middleware/orgContext.middleware');
const requireModule         = require('../middleware/requireModule.middleware');
const TwilioProvider        = require('../services/twilioProvider.service');
const TwilioAccounts        = require('../services/twilioAccounts.service');
const CallSettingsService   = require('../services/callSettings.service');
const NotificationService   = require('../services/notificationService');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));


// ── Per-IP rate limiter for /initiate ─────────────────────────────────────
// Layered defence on top of the per-user / per-org caps that already check
// against rows in the calls table. The DB-based caps protect Twilio billing;
// THIS limiter protects against high-frequency attack patterns from a single
// IP — e.g. a stolen JWT being used from one machine to hammer the endpoint.
//
// Numbers are deliberately tighter than per-user (10/min) because a single
// human can't legitimately place more than 5 calls/min from one IP. Spread
// across multiple reps in an office (same egress IP), 30/min/IP covers
// realistic shared-IP scenarios. Hitting this limit returns 429 without
// charging Twilio anything.
const initiateIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  // Don't fall back to req.ip alone — trust proxy is on, so req.ip is the
  // real client IP (Cloudflare → Railway → us). The default keyGenerator
  // does the right thing.
  handler: (req, res) => res.status(429).json({
    error: {
      message: 'Too many call attempts from this network. Slow down.',
      code:    'IP_RATE_LIMIT',
    },
  }),
});


// ── Constants ──────────────────────────────────────────────────────────────
// Default rate-limit caps — overridden per-org via call_settings.rate_limits.
// Window is rolling 60s. These caps protect GoWarmCRM's shared Twilio billing
// from a buggy client looping or a compromised account.
const DEFAULT_RATE_LIMITS = {
  per_user_per_minute: 10,
  per_org_per_minute:  100,
};

// Twilio numeric error codes we surface with friendlier messages. Anything
// not in this map gets passed through with err.code preserved so the
// frontend can branch on it.
//   21219 — trial-account-only: 'to' number must be verified
//   21211 — invalid 'to' number format
//   21214 — invalid 'from' (DID not owned by our account)
//   21610 — 'to' number has unsubscribed (STOP keyword received earlier)
//   13224 — invalid 'to' geographic permissions
const TWILIO_ERROR_FRIENDLY = {
  21219: 'Trial account limitation: the prospect phone must be verified in your Twilio console first. Upgrade past trial to remove this restriction.',
  21211: 'Invalid prospect phone number format. Use E.164 format like +14155551234.',
  21214: 'Your assigned DID is not recognized. Ask your admin to re-provision it.',
  21610: 'This number has previously opted out (STOP). It cannot be dialed.',
  13224: 'Your account does not have permission to call this country.',
};


// ── Helpers ────────────────────────────────────────────────────────────────

// Resolve per-org rate limits from call_settings JSONB, falling back to
// system defaults when missing or malformed.
async function resolveRateLimits(orgId) {
  let settings = {};
  try { settings = await CallSettingsService.getForOrg(orgId); } catch (_) { /* swallow */ }
  const rl = settings.rate_limits || {};
  return {
    per_user_per_minute: Number.isInteger(rl.per_user_per_minute) && rl.per_user_per_minute > 0
      ? rl.per_user_per_minute : DEFAULT_RATE_LIMITS.per_user_per_minute,
    per_org_per_minute:  Number.isInteger(rl.per_org_per_minute) && rl.per_org_per_minute > 0
      ? rl.per_org_per_minute : DEFAULT_RATE_LIMITS.per_org_per_minute,
  };
}

// Check whether placing one more call would exceed the per-user OR per-org
// rate cap. Returns null if OK, or an Error with .status=429 + .code if blocked.
// We count any row created with provider='twilio' in the last 60s — this
// includes initiated/ringing/in_progress/completed/failed/etc. It does NOT
// include manually-logged Phase 1+2 rows (provider IS NULL), so the rate
// cap only protects against Twilio-billed activity.
async function checkRateLimits(orgId, userId) {
  const limits = await resolveRateLimits(orgId);

  const { rows } = await db.pool.query(
    `SELECT
       SUM(CASE WHEN user_id = $2 THEN 1 ELSE 0 END)::int AS user_count,
       COUNT(*)::int                                       AS org_count
       FROM calls
      WHERE org_id  = $1
        AND provider = 'twilio'
        AND created_at >= NOW() - INTERVAL '60 seconds'`,
    [orgId, userId]
  );
  const c = rows[0] || { user_count: 0, org_count: 0 };

  if (c.user_count >= limits.per_user_per_minute) {
    const e = new Error(`You've placed ${c.user_count} calls in the last minute. Slow down.`);
    e.status = 429; e.code = 'USER_RATE_LIMIT';
    return e;
  }
  if (c.org_count >= limits.per_org_per_minute) {
    const e = new Error(`Your org has placed ${c.org_count} calls in the last minute. Slow down.`);
    e.status = 429; e.code = 'ORG_RATE_LIMIT';
    return e;
  }
  return null;
}

// Fetch the rep's phone + DID. Returns the user row or throws a 400 with
// a specific error code so the frontend can render the right CTA.
async function loadCallingRep(orgId, userId) {
  const { rows } = await db.pool.query(
    `SELECT id, org_id, phone, twilio_did, twilio_did_sid
       FROM users WHERE id = $1 AND org_id = $2`,
    [userId, orgId]
  );
  if (!rows.length) {
    const e = new Error('User not found'); e.status = 401; throw e;
  }
  const rep = rows[0];

  if (!rep.phone) {
    const e = new Error('Add your phone number in My Preferences before making calls.');
    e.status = 400; e.code = 'REP_PHONE_MISSING';
    throw e;
  }
  if (!rep.twilio_did) {
    const e = new Error('Your admin needs to provision a phone number for you before you can make calls.');
    e.status = 400; e.code = 'REP_DID_MISSING';
    e.notifyAdmins = true;   // calling route handles this side-effect
    throw e;
  }
  return rep;
}

// Notify all org admins/owners that this rep needs a DID. Best-effort —
// failure is logged but does not block the response.
async function notifyAdminsOfMissingDid(orgId, repUserId) {
  try {
    const { rows: admins } = await db.pool.query(
      `SELECT id FROM users
        WHERE org_id = $1 AND role IN ('owner','admin')`,
      [orgId]
    );
    const { rows: repRows } = await db.pool.query(
      `SELECT first_name, last_name FROM users WHERE id = $1`,
      [repUserId]
    );
    const repName = repRows.length
      ? `${repRows[0].first_name} ${repRows[0].last_name}`.trim()
      : `User #${repUserId}`;

    await Promise.all(admins.map(a => NotificationService.createNotification(
      orgId,
      a.id,
      'twilio_did_needed',
      'A rep needs a phone number',
      `${repName} tried to make a call but doesn't have a Twilio DID assigned. Provision one in Org Settings → Prospecting → Twilio.`,
      'user',
      repUserId,
      { rep_user_id: repUserId }
    )));
  } catch (err) {
    console.warn('notifyAdminsOfMissingDid: best-effort notification failed:', err.message);
  }
}


// =========================================================================
// POST /initiate — start a Twilio call
// =========================================================================
// Body:
//   prospect_id           (int, required)
//   sequence_step_log_id  (int, optional — links to a sequence step)
//
// Flow:
//   1. Load rep — must have phone + twilio_did
//   2. Load prospect — must have phone
//   3. Check rate limits (per-user and per-org over the last 60s)
//   4. Insert calls row with status='initiated', provider='twilio',
//      outcome=NULL. This row exists BEFORE Twilio is called so the row id
//      can be embedded in the webhook URLs Twilio will call back.
//   5. Call Twilio's calls.create — Twilio dials the rep first
//   6. Update calls.provider_call_id with the returned SID
//
// If Twilio.calls.create fails AFTER the row was inserted, we patch the
// row to status='failed' and surface the error to the rep. The row stays
// in the DB as an auditable record of the attempt.
// =========================================================================
router.post('/initiate', initiateIpLimiter, async (req, res) => {
  const prospectId = parseInt(req.body.prospect_id, 10);
  if (!Number.isInteger(prospectId) || prospectId <= 0) {
    return res.status(400).json({ error: { message: 'prospect_id is required' } });
  }
  const sequenceStepLogId = req.body.sequence_step_log_id
    ? parseInt(req.body.sequence_step_log_id, 10)
    : null;

  // 1. Rep validation (phone + DID).
  let rep;
  try {
    rep = await loadCallingRep(req.orgId, req.user.userId);
  } catch (err) {
    if (err.notifyAdmins) {
      // Fire-and-forget admin notification.
      notifyAdminsOfMissingDid(req.orgId, req.user.userId);
    }
    return res.status(err.status || 400).json({
      error: { message: err.message, code: err.code },
    });
  }

  // 2. Prospect validation.
  const pRes = await db.pool.query(
    `SELECT id, phone, first_name, last_name
       FROM prospects
      WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [prospectId, req.orgId]
  );
  if (!pRes.rows.length) {
    return res.status(404).json({ error: { message: 'Prospect not found' } });
  }
  const prospect = pRes.rows[0];
  if (!prospect.phone) {
    return res.status(400).json({
      error: {
        message: 'This prospect has no phone number on file. Add one before calling.',
        code:    'PROSPECT_PHONE_MISSING',
      },
    });
  }

  // 3. Rate limit check.
  const rateErr = await checkRateLimits(req.orgId, req.user.userId);
  if (rateErr) {
    return res.status(rateErr.status).json({
      error: { message: rateErr.message, code: rateErr.code },
    });
  }

  // 4. Check Twilio is configured BEFORE we insert the calls row. Avoids
  //    orphaned status='initiated' rows. Two layers now:
  //    (a) parent/webhook config present (deployment-wide), and
  //    (b) THIS org has an active Twilio subaccount provisioned.
  try {
    TwilioProvider.validateConfig();
  } catch (cfgErr) {
    return res.status(503).json({
      error: {
        message: 'Twilio is not configured for this deployment.',
        code:    'TWILIO_NOT_CONFIGURED',
      },
    });
  }
  if (!(await TwilioAccounts.isProvisioned(req.orgId))) {
    return res.status(503).json({
      error: {
        message: 'Calling is not set up for your organization yet. An admin needs to provision Twilio in Org Settings → Prospecting → Twilio.',
        code:    'TWILIO_NOT_PROVISIONED',
      },
    });
  }

  // 5. Insert the row. We do this OUTSIDE a transaction — Twilio.calls.create
  //    is a network call that can take 500ms+ and we shouldn't hold a DB
  //    transaction open across it. On failure we patch the row.
  const phoneUsed = prospect.phone;
  let callRow;
  try {
    const insRes = await db.pool.query(
      `INSERT INTO calls
         (org_id, prospect_id, user_id,
          direction, status, outcome,
          phone_used, provider, sequence_step_log_id,
          occurred_at)
       VALUES ($1, $2, $3,
               'outbound', 'initiated', NULL,
               $4, 'twilio', $5,
               CURRENT_TIMESTAMP)
       RETURNING *`,
      [req.orgId, prospectId, req.user.userId,
       phoneUsed, sequenceStepLogId]
    );
    callRow = insRes.rows[0];
  } catch (err) {
    console.error('initiate: INSERT failed', err);
    return res.status(500).json({ error: { message: 'Failed to create call record' } });
  }

  // 6. Place the Twilio call.
  let twilioResult;
  try {
    twilioResult = await TwilioProvider.initiateCall({
      orgId:         req.orgId,
      callId:        callRow.id,
      repPhone:      rep.phone,
      repDid:        rep.twilio_did,
      prospectPhone: prospect.phone,
      recording:     true,    // honors org setting via TwiML route; here it's
                              // the master switch for whether Twilio records
                              // at all. Org-level disable happens in TwiML.
    });
  } catch (err) {
    // Patch the row to 'failed' so it doesn't sit forever in 'initiated'.
    try {
      await db.pool.query(
        `UPDATE calls SET status='failed', updated_at=NOW() WHERE id=$1`,
        [callRow.id]
      );
    } catch (_) { /* swallow */ }

    const friendly = err.code && TWILIO_ERROR_FRIENDLY[err.code];
    return res.status(err.status === 400 ? 400 : 502).json({
      error: {
        message: friendly || err.message || 'Twilio call failed',
        code:    err.code ? `TWILIO_${err.code}` : 'TWILIO_ERROR',
        provider_error: true,
      },
    });
  }

  // 7. Record the SID on the row so webhooks can correlate.
  try {
    await db.pool.query(
      `UPDATE calls SET provider_call_id = $1, updated_at = NOW() WHERE id = $2`,
      [twilioResult.sid, callRow.id]
    );
  } catch (err) {
    // Non-fatal: webhooks key off our internal callId, not the SID.
    console.warn('initiate: failed to write provider_call_id:', err.message);
  }

  return res.status(201).json({
    call: {
      id:               callRow.id,
      prospect_id:      callRow.prospect_id,
      user_id:          callRow.user_id,
      status:           'initiated',
      provider:         'twilio',
      provider_call_id: twilioResult.sid,
      direction:        'outbound',
      phone_used:       phoneUsed,
      occurred_at:      callRow.occurred_at,
    },
    prospect: {
      id:         prospect.id,
      first_name: prospect.first_name,
      last_name:  prospect.last_name,
      phone:      prospect.phone,
    },
  });
});


// =========================================================================
// POST /prepare — create a call row for BROWSER dialing (no server-side call)
// =========================================================================
// Browser-dial flow: the softphone (Voice SDK Device) originates the call, so
// the backend does NOT call Twilio here. It only validates and creates the
// calls row, returning the id. The browser then Device.connect({ params:
// { callId } }); Twilio fetches /webhooks/voice-app, which dials the prospect
// (from this row) with the rep's DID as caller ID. Lifecycle + duration arrive
// via the /webhooks/status/:callId callback exactly as before.
//
// Unlike /initiate (dial-and-bridge), the rep does NOT need a personal phone —
// audio is the browser. The rep DOES still need a DID for caller ID.
//
// Body: { prospect_id (int, required), sequence_step_log_id (int, optional) }
// =========================================================================
router.post('/prepare', initiateIpLimiter, async (req, res) => {
  const prospectId = parseInt(req.body.prospect_id, 10);
  if (!Number.isInteger(prospectId) || prospectId <= 0) {
    return res.status(400).json({ error: { message: 'prospect_id is required' } });
  }
  const sequenceStepLogId = req.body.sequence_step_log_id
    ? parseInt(req.body.sequence_step_log_id, 10)
    : null;

  // 1. Rep needs a DID (caller ID). No personal-phone requirement for browser.
  const repRes = await db.pool.query(
    `SELECT id, twilio_did, twilio_did_sid FROM users WHERE id = $1 AND org_id = $2`,
    [req.user.userId, req.orgId]
  );
  if (!repRes.rows.length) {
    return res.status(401).json({ error: { message: 'User not found' } });
  }
  if (!repRes.rows[0].twilio_did) {
    notifyAdminsOfMissingDid(req.orgId, req.user.userId);
    return res.status(400).json({
      error: {
        message: 'Your admin needs to provision a phone number for you before you can make calls.',
        code:    'REP_DID_MISSING',
      },
    });
  }

  // 2. Prospect must exist + have a phone.
  const pRes = await db.pool.query(
    `SELECT id, phone, first_name, last_name
       FROM prospects
      WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [prospectId, req.orgId]
  );
  if (!pRes.rows.length) {
    return res.status(404).json({ error: { message: 'Prospect not found' } });
  }
  const prospect = pRes.rows[0];
  if (!prospect.phone) {
    return res.status(400).json({
      error: { message: 'This prospect has no phone number on file. Add one before calling.', code: 'PROSPECT_PHONE_MISSING' },
    });
  }

  // 3. Rate limits (same caps as dial-and-bridge).
  const rateErr = await checkRateLimits(req.orgId, req.user.userId);
  if (rateErr) {
    return res.status(rateErr.status).json({ error: { message: rateErr.message, code: rateErr.code } });
  }

  // 4. Twilio must be configured + this org provisioned with a subaccount.
  try {
    TwilioProvider.validateConfig();
  } catch (cfgErr) {
    return res.status(503).json({ error: { message: 'Twilio is not configured for this deployment.', code: 'TWILIO_NOT_CONFIGURED' } });
  }
  if (!(await TwilioAccounts.isProvisioned(req.orgId))) {
    return res.status(503).json({
      error: { message: 'Calling is not set up for your organization yet. An admin needs to provision Twilio in Org Settings → Prospecting → Twilio.', code: 'TWILIO_NOT_PROVISIONED' },
    });
  }

  // 5. Create the row. status='initiated'; provider_call_id filled later by
  //    the voice-app webhook (parent call SID) / status callbacks.
  try {
    const insRes = await db.pool.query(
      `INSERT INTO calls
         (org_id, prospect_id, user_id,
          direction, status, outcome,
          phone_used, provider, sequence_step_log_id,
          occurred_at)
       VALUES ($1, $2, $3,
               'outbound', 'initiated', NULL,
               $4, 'twilio', $5,
               CURRENT_TIMESTAMP)
       RETURNING *`,
      [req.orgId, prospectId, req.user.userId, prospect.phone, sequenceStepLogId]
    );
    const callRow = insRes.rows[0];

    return res.status(201).json({
      call: {
        id:          callRow.id,
        prospect_id: callRow.prospect_id,
        user_id:     callRow.user_id,
        status:      'initiated',
        provider:    'twilio',
        direction:   'outbound',
        phone_used:  prospect.phone,
        occurred_at: callRow.occurred_at,
      },
      prospect: {
        id:         prospect.id,
        first_name: prospect.first_name,
        last_name:  prospect.last_name,
        phone:      prospect.phone,
      },
    });
  } catch (err) {
    console.error('prepare: INSERT failed', err);
    return res.status(500).json({ error: { message: 'Failed to create call record' } });
  }
});


// =========================================================================
// GET /:id/status — lightweight poll endpoint for the in-progress modal
// =========================================================================
// The frontend polls this every 1-2 seconds while the modal is open. Returns
// only the minimum fields needed to drive the UI state machine, so we don't
// re-fetch the full call row dozens of times.
//
// Frontend stops polling when status reaches a terminal state.
// =========================================================================
router.get('/:id/status', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: { message: 'Invalid call id' } });
  }

  try {
    const { rows } = await db.pool.query(
      `SELECT id, status, duration_seconds, recording_url, provider_call_id, outcome
         FROM calls
        WHERE id = $1 AND org_id = $2`,
      [id, req.orgId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: { message: 'Call not found' } });
    }

    const c = rows[0];
    const TERMINAL = ['completed', 'no_answer', 'failed', 'busy', 'canceled'];
    return res.json({
      id:                  c.id,
      status:              c.status,
      is_terminal:         TERMINAL.includes(c.status),
      needs_outcome:       c.status === 'completed' && c.outcome === null,
      duration_seconds:    c.duration_seconds,
      recording_url:       c.recording_url,
      provider_call_id:    c.provider_call_id,
    });
  } catch (err) {
    console.error('GET /:id/status error:', err);
    return res.status(500).json({ error: { message: 'Failed to fetch status' } });
  }
});


// =========================================================================
// POST /:id/cancel — abort an in-flight Twilio call
// =========================================================================
// Two scenarios this handles:
//   1. Pre-connect cancel: rep clicked "Call via Twilio" but realized wrong
//      prospect; wants to abort BEFORE Twilio connects to the prospect.
//      Status is 'initiated' or 'ringing'. Twilio API: status='canceled'.
//      Final state: 'canceled'.
//   2. Mid-call hangup: rep is on the call (status='in_progress') and wants
//      to end it from the UI. Twilio API: status='completed'.
//      Final state: 'completed' (and outcome stays NULL — by design, the
//      rep can disposition later via the "Outcome not captured" recovery
//      flow if they change their mind).
//
// Authorization: rep can only cancel their own calls (user_id match).
// Org admins do NOT bypass this — call ownership is a per-rep concern.
//
// Idempotency: if the call is already in a terminal state, we just return
// the current state without calling Twilio again.
// =========================================================================
router.post('/:id/cancel', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: { message: 'Invalid call id' } });
  }

  // Load the call row.
  const { rows } = await db.pool.query(
    `SELECT id, org_id, user_id, status, provider_call_id
       FROM calls
      WHERE id = $1 AND org_id = $2 AND provider = 'twilio'`,
    [id, req.orgId]
  );
  if (!rows.length) {
    return res.status(404).json({ error: { message: 'Call not found' } });
  }
  const call = rows[0];

  // Ownership: only the rep who placed the call can cancel it.
  if (call.user_id !== req.user.userId) {
    return res.status(403).json({
      error: { message: 'You can only cancel your own calls', code: 'NOT_CALL_OWNER' },
    });
  }

  // Idempotency: already terminal → just return current state.
  const TERMINAL = ['completed', 'no_answer', 'failed', 'busy', 'canceled'];
  if (TERMINAL.includes(call.status)) {
    return res.json({
      id:     call.id,
      status: call.status,
      already_terminal: true,
    });
  }

  if (!call.provider_call_id) {
    // No SID means /initiate failed AFTER row insert but BEFORE Twilio
    // call create. Twilio doesn't know about this row. Just mark it
    // canceled locally.
    await db.pool.query(
      `UPDATE calls SET status='canceled', updated_at=NOW() WHERE id=$1`,
      [id]
    );
    return res.json({ id, status: 'canceled', no_twilio_sid: true });
  }

  // Decide the Twilio API mode based on our current view of the call state.
  // 'in_progress' → hangup (Twilio status='completed')
  // anything else non-terminal ('initiated', 'ringing') → cancel
  const mode = call.status === 'in_progress' ? 'hangup' : 'cancel';

  try {
    await TwilioProvider.cancelCall(call.org_id, call.provider_call_id, mode);
  } catch (err) {
    console.error('cancel: Twilio API error:', err.message, 'code=', err.code);
    return res.status(502).json({
      error: {
        message: 'Twilio could not cancel the call. The call may still be active.',
        code:    err.code ? `TWILIO_${err.code}` : 'TWILIO_ERROR',
      },
    });
  }

  // Update our DB. The status webhook will likely arrive shortly with the
  // same final state — the existing webhook guard prevents double-writes.
  // We update proactively so the frontend's status poll sees the change
  // immediately rather than waiting for Twilio's webhook latency.
  const finalStatus = mode === 'hangup' ? 'completed' : 'canceled';
  await db.pool.query(
    `UPDATE calls
        SET status = $1, updated_at = NOW()
      WHERE id = $2
        AND status NOT IN ('completed','no_answer','failed','busy','canceled')`,
    [finalStatus, id]
  );

  return res.json({
    id,
    status: finalStatus,
    mode,
  });
});


module.exports = router;
