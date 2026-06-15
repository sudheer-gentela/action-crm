/**
 * /api/twilio/webhooks
 *
 * Public webhook endpoints called by Twilio (not by the user's browser).
 * No auth/orgContext middleware here — these are unauthenticated by JWT
 * because Twilio doesn't have one. Instead, EVERY route validates the
 * Twilio request signature via TwilioProvider.validateSignature().
 *
 * Per-org/subaccount note: each org's subaccount signs webhooks with its OWN
 * auth token, so validation now needs the org id. The signature middleware is
 * a FACTORY that takes a per-route org resolver (callId → org, or DID SID →
 * org); it resolves the org from the URL params FIRST, then validates with that
 * subaccount's token. This reorders the original flow (which validated before
 * any DB lookup), but the resolver only does a narrow, parameterized id lookup
 * and leaks nothing on failure — an unresolvable org or bad signature both
 * fail closed with a TwiML <Reject/>.
 *
 * Routes:
 *
 *   POST /twiml/:callId
 *     Twilio fetches this when the rep's leg of an outbound call answers.
 *     Returns TwiML that tells Twilio to (optionally announce recording,
 *     then) <Dial> the prospect's number and bridge.
 *
 *   POST /twiml-inbound/:didSid
 *     Twilio fetches this when a prospect calls a rep's DID.
 *     Returns TwiML that announces recording (if enabled) and dials the
 *     rep's real phone, creating a `calls` row with direction='inbound'.
 *
 *   POST /status/:callId
 *     Twilio's status callback. Fires on initiated/ringing/answered/completed.
 *     Updates calls.status and (on completed) duration_seconds.
 *
 *   POST /recording/:callId
 *     Twilio's recording status callback. Fires when recording is ready.
 *     Updates calls.recording_url.
 *
 * Note: Express must parse the body as urlencoded (Twilio doesn't send JSON).
 * server.js's global `express.urlencoded({ extended: true })` handles this.
 *
 * Signature validation reconstructs the URL Twilio called using
 * x-forwarded-proto/host (set by Cloudflare + Railway). server.js sets
 * `app.set('trust proxy', 1)` which is needed for that reconstruction.
 */

const express = require('express');
const router  = express.Router();
const twilioLib = require('twilio');

const db = require('../config/database');
const TwilioProvider = require('../services/twilioProvider.service');
const CallSettingsService = require('../services/callSettings.service');
const CallOutcomeMirrorService = require('../services/callOutcomeMirror.service');


// ── Signature-validation middleware (per-subaccount) ──────────────────────
const REJECT_XML = '<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>';

// Resolve the owning org from a callId-based route (calls.id → calls.org_id).
async function orgFromCallId(req) {
  const callId = parseInt(req.params.callId, 10);
  if (!Number.isInteger(callId) || callId <= 0) return null;
  const { rows } = await db.pool.query(
    `SELECT org_id FROM calls WHERE id = $1 AND provider = 'twilio' LIMIT 1`,
    [callId]
  );
  return rows.length ? rows[0].org_id : null;
}

// Resolve the owning org from a DID-SID route (users.twilio_did_sid → org_id).
async function orgFromDidSid(req) {
  const didSid = req.params.didSid;
  if (!didSid) return null;
  const { rows } = await db.pool.query(
    `SELECT org_id FROM users WHERE twilio_did_sid = $1 LIMIT 1`,
    [didSid]
  );
  return rows.length ? rows[0].org_id : null;
}

// Resolve the owning org from a callId passed in the POST BODY (used by the
// browser-dial /voice-app route, whose URL is a fixed TwiML App path).
async function orgFromBodyCallId(req) {
  const callId = parseInt(req.body && req.body.callId, 10);
  if (!Number.isInteger(callId) || callId <= 0) return null;
  const { rows } = await db.pool.query(
    `SELECT org_id FROM calls WHERE id = $1 AND provider = 'twilio' LIMIT 1`,
    [callId]
  );
  return rows.length ? rows[0].org_id : null;
}

// Factory: build a signature-validation middleware for routes whose org is
// resolved by `orgResolver(req) -> Promise<orgId|null>`. Fails closed (TwiML
// <Reject/>) when the org can't be resolved or the signature doesn't verify
// against that subaccount's auth token. The resolved org is stashed on
// req.twilioOrgId for the handler to reuse if it wants.
function requireTwilioSignature(orgResolver) {
  return async (req, res, next) => {
    if (!req.headers['x-twilio-signature']) {
      console.warn('twilio-webhooks: missing X-Twilio-Signature for', req.originalUrl);
      return res.status(403).type('text/xml').send(REJECT_XML);
    }

    let orgId = null;
    try {
      orgId = await orgResolver(req);
    } catch (e) {
      console.error('twilio-webhooks: org resolution error for', req.originalUrl, e.message);
      orgId = null;
    }
    if (!orgId) {
      console.warn('twilio-webhooks: could not resolve org for', req.originalUrl);
      return res.status(403).type('text/xml').send(REJECT_XML);
    }

    let ok = false;
    try {
      ok = await TwilioProvider.validateSignature(req, orgId);
    } catch (e) {
      console.error('twilio-webhooks: signature validation error for', req.originalUrl, e.message);
      ok = false;
    }
    if (!ok) {
      console.warn('twilio-webhooks: signature validation FAILED for', req.originalUrl);
      return res.status(403).type('text/xml').send(REJECT_XML);
    }

    req.twilioOrgId = orgId;
    return next();
  };
}


// ── Helpers ────────────────────────────────────────────────────────────────
// XML-escape any value we interpolate into TwiML. Prospect notes, names, etc.
// could in theory contain & < > " ' — the Say tag must be valid XML.
function xmlEscape(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Resolve the org's recording + disclosure settings with safe defaults.
// Reads from org_action_config.call_settings JSONB; falls back to
// system defaults when the row doesn't exist (fresh orgs).
async function resolveTwilioSettings(orgId) {
  let settings;
  try {
    settings = await CallSettingsService.getForOrg(orgId);
  } catch (_) {
    settings = {};
  }
  return {
    recording_enabled:            settings.recording_enabled !== false,           // default true
    recording_disclosure_enabled: settings.recording_disclosure_enabled !== false, // default true
  };
}

// Map a Twilio call-status string (CallStatus param) onto our calls.status
// enum. Twilio's vocabulary:
//   queued, initiated, ringing, in-progress, completed,
//   busy, failed, no-answer, canceled
// Note the hyphens — we strip them so our DB enum matches.
function mapTwilioStatus(twilioStatus) {
  if (!twilioStatus) return null;
  const s = String(twilioStatus).toLowerCase().replace(/-/g, '_');
  // 'queued' is a pre-initiated state Twilio uses internally; treat it as
  // 'initiated' so we don't have to add another enum value.
  if (s === 'queued') return 'initiated';
  return s;
}


// =========================================================================
// POST /twiml/:callId — outbound TwiML
// =========================================================================
// Fired when the rep's leg of an outbound call is answered. Returns TwiML
// instructing Twilio to (optionally announce recording, then) dial the
// prospect and bridge.
//
// Twilio passes these form params we care about:
//   CallSid    — same provider_call_id we already have
//   CallStatus — should be 'in-progress' when this fires
//
// Our :callId is our internal calls.id, which we use to look up the
// prospect's phone and the rep's DID (callerId for the outbound leg).
// =========================================================================
router.post('/twiml/:callId', requireTwilioSignature(orgFromCallId), async (req, res) => {
  const callId = parseInt(req.params.callId, 10);
  if (!Number.isInteger(callId) || callId <= 0) {
    return res.status(400).type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>'
    );
  }

  try {
    // Look up the call row + prospect phone + rep DID in one round-trip.
    // We need the DID as the callerId for the second leg so Caller ID on
    // the prospect's phone shows the rep's DID, not Twilio's pool number.
    const { rows } = await db.pool.query(
      `SELECT c.id, c.org_id, c.prospect_id, c.user_id, c.status,
              c.phone_used   AS prospect_phone,
              p.first_name   AS prospect_first_name,
              u.twilio_did   AS rep_did
         FROM calls c
         JOIN prospects p ON p.id = c.prospect_id
         JOIN users     u ON u.id = c.user_id
        WHERE c.id = $1 AND c.provider = 'twilio'
        LIMIT 1`,
      [callId]
    );

    if (!rows.length) {
      console.warn(`twiml: no twilio call row found for id=${callId}`);
      return res.status(404).type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This call could not be connected.</Say><Hangup/></Response>'
      );
    }

    const row = rows[0];

    if (!row.prospect_phone) {
      // Prospect has no phone on file. Tell the rep and hang up.
      return res.type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response>' +
        '<Say voice="alice">The prospect has no phone number on file. Please add one in Go Warm and try again.</Say>' +
        '<Hangup/>' +
        '</Response>'
      );
    }

    const { recording_enabled, recording_disclosure_enabled } = await resolveTwilioSettings(row.org_id);

    // Build TwiML with the SDK's helper so we don't have to hand-roll XML.
    // VoiceResponse handles attribute encoding for us.
    const VoiceResponse = twilioLib.twiml.VoiceResponse;
    const twiml = new VoiceResponse();

    // Brief connecting prompt so the rep doesn't hear silence.
    twiml.say({ voice: 'alice' },
      `Connecting your call${row.prospect_first_name ? ` to ${xmlEscape(row.prospect_first_name)}` : ''}.`
    );

    // Recording disclosure (US two-party consent best practice). Played to
    // the rep BEFORE the prospect is dialed; the prospect will hear it as
    // soon as their leg answers because recordingStatusCallbackEvent on the
    // <Dial> announces from-answer.
    if (recording_enabled && recording_disclosure_enabled) {
      twiml.say({ voice: 'alice' }, 'This call may be recorded.');
    }

    // Build the <Dial>. callerId is the rep's DID so the prospect sees a
    // proper inbound caller ID, not Twilio's pool number.
    const dialOpts = {
      callerId: row.rep_did,
      timeout:  30,                  // ring the prospect for 30s
      answerOnBridge: true,          // don't bill until both legs connected
    };
    if (recording_enabled) {
      dialOpts.record = TwilioProvider.RECORDING_MODE;  // 'record-from-answer-dual'
      dialOpts.recordingStatusCallback       = TwilioProvider.buildWebhookUrl(
        TwilioProvider.WEBHOOK_PATHS.recording(callId)
      );
      dialOpts.recordingStatusCallbackMethod = 'POST';
      dialOpts.recordingStatusCallbackEvent  = 'completed';
    }

    const dial = twiml.dial(dialOpts);
    dial.number(row.prospect_phone);

    return res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('twiml route error:', err);
    // Fallback TwiML — don't leak error details to the Twilio call.
    return res.status(500).type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response><Say>An error occurred. Please try again.</Say><Hangup/></Response>'
    );
  }
});


// =========================================================================
// POST /twiml-inbound/:didSid — inbound TwiML
// =========================================================================
// Fired when a prospect dials a rep's DID. We look up which rep owns the
// DID (via twilio_did_sid), record the inbound call, and dial the rep's
// real phone to bridge.
//
// Twilio form params:
//   From  — the prospect's number (the inbound caller)
//   To    — our DID (E.164)
//   CallSid — Twilio's call id
// =========================================================================
router.post('/twiml-inbound/:didSid', requireTwilioSignature(orgFromDidSid), async (req, res) => {
  const didSid     = req.params.didSid;
  const fromNumber = req.body.From || null;   // prospect's number
  const callSid    = req.body.CallSid || null;

  if (!didSid || !callSid) {
    return res.status(400).type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>'
    );
  }

  try {
    // Find the rep by DID SID.
    const userRes = await db.pool.query(
      `SELECT id AS user_id, org_id, phone AS rep_phone, twilio_did
         FROM users
        WHERE twilio_did_sid = $1
        LIMIT 1`,
      [didSid]
    );
    if (!userRes.rows.length) {
      console.warn(`twiml-inbound: no rep owns did_sid=${didSid}`);
      return res.status(404).type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response><Say>This number is not currently in service.</Say><Hangup/></Response>'
      );
    }
    const rep = userRes.rows[0];

    if (!rep.rep_phone) {
      return res.type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response><Say>This number is not configured to receive calls right now.</Say><Hangup/></Response>'
      );
    }

    // Try to match the inbound number to a known prospect (best-effort —
    // exact match on prospects.phone). This is intentionally simple; fuzzy
    // matching (country code variants, parentheses, etc.) is a Phase 4
    // problem. If no match, prospect_id stays null.
    let matchedProspectId = null;
    if (fromNumber) {
      const pRes = await db.pool.query(
        `SELECT id FROM prospects
          WHERE org_id = $1 AND phone = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [rep.org_id, fromNumber]
      );
      if (pRes.rows.length) matchedProspectId = pRes.rows[0].id;
    }

    // Insert the call row in status='ringing' (Twilio just rang the DID,
    // we're about to dial the rep). outcome stays NULL until captured.
    // Mirror writes are SKIPPED for inbound until status='completed' arrives
    // and the rep captures an outcome — at that point the standard logging
    // path runs the mirror service. This avoids creating activity rows for
    // calls that never connect.
    await db.pool.query(
      `INSERT INTO calls
         (org_id, user_id, prospect_id, direction, status,
          provider, provider_call_id, phone_used,
          occurred_at)
       VALUES ($1, $2, $3, 'inbound', 'ringing',
               'twilio', $4, $5,
               CURRENT_TIMESTAMP)
       ON CONFLICT DO NOTHING`,
      [rep.org_id, rep.user_id, matchedProspectId, callSid, fromNumber || null]
    );

    // Build TwiML to dial the rep.
    const { recording_enabled, recording_disclosure_enabled } = await resolveTwilioSettings(rep.org_id);
    const VoiceResponse = twilioLib.twiml.VoiceResponse;
    const twiml = new VoiceResponse();

    if (recording_enabled && recording_disclosure_enabled) {
      twiml.say({ voice: 'alice' }, 'This call may be recorded.');
    }

    const dialOpts = {
      callerId: fromNumber || rep.twilio_did,
      timeout:  25,
      answerOnBridge: true,
    };
    if (recording_enabled) {
      dialOpts.record = TwilioProvider.RECORDING_MODE;
    }

    const dial = twiml.dial(dialOpts);
    dial.number(rep.rep_phone);

    return res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('twiml-inbound route error:', err);
    return res.status(500).type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response><Say>An error occurred.</Say><Hangup/></Response>'
    );
  }
});


// =========================================================================
// POST /status/:callId — call lifecycle updates
// =========================================================================
// Twilio fires this for each of the statusCallbackEvents we requested:
// initiated, ringing, answered, completed.
//
// Form params (the ones we care about):
//   CallStatus       — 'initiated' | 'ringing' | 'in-progress' | 'completed' | …
//   CallDuration     — total call duration in seconds (only on 'completed')
//   CallSid          — same as provider_call_id
//   AnsweredBy       — 'human' | 'machine_*' (only when AMD is on; we don't use it)
//
// We don't write through CallOutcomeMirrorService here — the mirror tracks
// outcome-driven counters and there's no outcome yet at this stage. The
// mirror will run later, when the rep captures an outcome via LogCallModal
// (which POSTs to /api/prospect-calls as a status='completed' row update).
// =========================================================================
router.post('/status/:callId', requireTwilioSignature(orgFromCallId), async (req, res) => {
  const callId = parseInt(req.params.callId, 10);
  if (!Number.isInteger(callId) || callId <= 0) {
    return res.status(400).end();
  }

  const newStatus = mapTwilioStatus(req.body.CallStatus);
  if (!newStatus) {
    console.warn('status: missing/invalid CallStatus', req.body.CallStatus);
    return res.status(200).end();  // 200 so Twilio doesn't retry on bad input
  }

  // CallDuration is a string of seconds; only present on completed.
  const durationSec = req.body.CallDuration != null
    ? parseInt(req.body.CallDuration, 10)
    : null;

  try {
    // Guarded update — don't allow regressing from a terminal state. If the
    // row is already in 'completed' and a stray 'ringing' arrives (Twilio
    // delivery order isn't strictly guaranteed), we ignore it.
    const TERMINAL = ['completed', 'no_answer', 'failed', 'busy', 'canceled'];

    // Build the SET clause dynamically — only set duration on completed.
    const params = [newStatus, callId];
    let updateClause = 'status = $1, updated_at = NOW()';
    if (TERMINAL.includes(newStatus) && Number.isInteger(durationSec) && durationSec >= 0) {
      params.unshift(durationSec);  // becomes $1
      updateClause = 'duration_seconds = $1, status = $2, updated_at = NOW()';
      params[1] = newStatus;        // now $2
      params[2] = callId;           // now $3
    }
    const callIdParamIdx = params.length;

    const result = await db.pool.query(
      `UPDATE calls
          SET ${updateClause}
        WHERE id = $${callIdParamIdx}
          AND provider = 'twilio'
          AND status NOT IN ('completed', 'no_answer', 'failed', 'busy', 'canceled')
        RETURNING id, status, duration_seconds`,
      params
    );

    if (!result.rows.length) {
      // Either row not found, or already terminal. Either way, ack 200 so
      // Twilio stops retrying.
      return res.status(200).end();
    }

    return res.status(200).end();
  } catch (err) {
    console.error('status route error:', err);
    // 500 makes Twilio retry — give us another chance to record it.
    return res.status(500).end();
  }
});


// =========================================================================
// POST /recording/:callId — recording URL
// =========================================================================
// Twilio fires this when a recording is ready, with these form params:
//   RecordingSid       — Twilio's recording id (REL...)
//   RecordingUrl       — base URL; append .mp3 or .wav for the audio file
//   RecordingStatus    — 'completed' | 'failed' | 'absent'
//   RecordingDuration  — seconds
//
// We store the canonical .mp3 URL on calls.recording_url. Twilio holds the
// audio (reference-only storage per Phase 3 decision).
// =========================================================================
router.post('/recording/:callId', requireTwilioSignature(orgFromCallId), async (req, res) => {
  const callId  = parseInt(req.params.callId, 10);
  const recUrl  = req.body.RecordingUrl  || null;
  const recStat = req.body.RecordingStatus || null;

  if (!Number.isInteger(callId) || callId <= 0) {
    return res.status(400).end();
  }

  // Only persist when the recording actually exists. 'failed' / 'absent'
  // we just ack and move on; the rep can still log an outcome manually.
  if (recStat !== 'completed' || !recUrl) {
    return res.status(200).end();
  }

  // Append .mp3 so the URL is directly playable. Twilio serves both .mp3
  // and .wav at the same base URL.
  const mp3Url = recUrl.endsWith('.mp3') ? recUrl : `${recUrl}.mp3`;

  try {
    await db.pool.query(
      `UPDATE calls
          SET recording_url = $1, updated_at = NOW()
        WHERE id = $2 AND provider = 'twilio'`,
      [mp3Url, callId]
    );
    return res.status(200).end();
  } catch (err) {
    console.error('recording route error:', err);
    return res.status(500).end();
  }
});


// =========================================================================
// POST /voice-app — browser-dial outbound TwiML (Voice SDK Device.connect)
// =========================================================================
// Fired by Twilio when a rep's softphone Device.connect({ params: { callId } })
// originates a call. This IS the subaccount's TwiML App voiceUrl. The browser
// is one leg; this TwiML dials the prospect (the other leg) with the rep's DID
// as caller ID and bridges them.
//
// SECURITY: we IGNORE any client-supplied "To" and dial the prospect phone from
// the DB row identified by callId — this prevents a holder of a valid token
// from dialing arbitrary numbers (toll fraud). Signature is validated against
// the org's subaccount (orgFromBodyCallId) before we get here.
//
// Twilio body params we use:
//   callId   — custom param from Device.connect (our calls.id)
//   CallSid  — the parent (browser-leg) call SID; captured as provider_call_id
// =========================================================================
router.post('/voice-app', requireTwilioSignature(orgFromBodyCallId), async (req, res) => {
  const callId  = parseInt(req.body.callId, 10);
  const callSid = req.body.CallSid || null;

  if (!Number.isInteger(callId) || callId <= 0) {
    return res.status(400).type('text/xml').send(REJECT_XML);
  }

  try {
    const { rows } = await db.pool.query(
      `SELECT c.id, c.org_id, c.status, c.direction,
              c.phone_used AS prospect_phone,
              p.first_name AS prospect_first_name,
              u.twilio_did AS rep_did
         FROM calls c
         JOIN prospects p ON p.id = c.prospect_id
         JOIN users     u ON u.id = c.user_id
        WHERE c.id = $1 AND c.provider = 'twilio'
        LIMIT 1`,
      [callId]
    );

    if (!rows.length) {
      return res.status(404).type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This call could not be connected.</Say><Hangup/></Response>'
      );
    }
    const row = rows[0];

    // Defensive: only bridge outbound rows that haven't already finished.
    const TERMINAL = ['completed', 'no_answer', 'failed', 'busy', 'canceled'];
    if (row.direction !== 'outbound' || TERMINAL.includes(row.status)) {
      return res.type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'
      );
    }
    if (!row.prospect_phone || !row.rep_did) {
      return res.type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response><Say voice="alice">This call is missing a phone number. Please check the prospect in Go Warm.</Say><Hangup/></Response>'
      );
    }

    // Capture the parent (browser-leg) SID for correlation/cancel. Best-effort.
    if (callSid) {
      db.pool.query(
        `UPDATE calls SET provider_call_id = $1, updated_at = NOW()
          WHERE id = $2 AND provider_call_id IS NULL`,
        [callSid, callId]
      ).catch((e) => console.warn('voice-app: provider_call_id write failed:', e.message));
    }

    const { recording_enabled, recording_disclosure_enabled } = await resolveTwilioSettings(row.org_id);

    const VoiceResponse = twilioLib.twiml.VoiceResponse;
    const twiml = new VoiceResponse();

    if (recording_enabled && recording_disclosure_enabled) {
      twiml.say({ voice: 'alice' }, 'This call may be recorded.');
    }

    const dialOpts = {
      callerId:       row.rep_did,
      answerOnBridge: true,
    };
    if (recording_enabled) {
      dialOpts.record = TwilioProvider.RECORDING_MODE;
      dialOpts.recordingStatusCallback       = TwilioProvider.buildWebhookUrl(
        TwilioProvider.WEBHOOK_PATHS.recording(callId)
      );
      dialOpts.recordingStatusCallbackMethod = 'POST';
      dialOpts.recordingStatusCallbackEvent  = 'completed';
    }

    const dial = twiml.dial(dialOpts);
    // Status callbacks on the prospect (dialed) leg drive calls.status/duration,
    // same handler the dial-and-bridge path uses.
    dial.number({
      statusCallback:       TwilioProvider.buildWebhookUrl(TwilioProvider.WEBHOOK_PATHS.status(callId)),
      statusCallbackMethod: 'POST',
      statusCallbackEvent:  TwilioProvider.STATUS_CALLBACK_EVENTS,
    }, row.prospect_phone);

    return res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('voice-app route error:', err);
    return res.status(500).type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>An error occurred. Please try again.</Say><Hangup/></Response>'
    );
  }
});


module.exports = router;
