/**
 * TwilioProviderService  (per-org / subaccount-scoped)
 *
 * Pure Twilio adapter. Every operation runs against ONE org's Twilio
 * SUBACCOUNT, resolved via twilioAccounts.service.js. This module does not own
 * the DB; it reads credentials through the accounts service and otherwise only
 * talks to Twilio.
 *
 * Public operations (all now take `orgId`):
 *   getClient(orgId)                          → subaccount-scoped Twilio client
 *   initiateCall({ orgId, ... })              → outbound two-legged call (legacy dial-and-bridge)
 *   provisionDid({ orgId, areaCode, ... })    → buy + wire a DID in the org's subaccount
 *   releaseDid(orgId, didSid)                 → release a DID
 *   cancelCall(orgId, callSid, mode)          → cancel/hang up a call
 *   claimDid(orgId, didSid)                   → re-wire an existing DID's voiceUrl
 *   validateSignature(req, orgId)             → verify an inbound webhook (per-subaccount token)
 *   buildWebhookUrl(path)                     → absolute callback URL (internal helper)
 *   validateConfig()                          → boot-time PARENT/webhook sanity check
 *
 * Migration note (single-account → subaccounts): the env vars
 * TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN now hold the PARENT credentials and
 * are used only for subaccount lifecycle (in twilioAccounts.service.js), never
 * for per-org calls. Per-org calls use the subaccount's own SID + auth token.
 */

const twilio         = require('twilio');
const TwilioAccounts = require('./twilioAccounts.service');

// ── Per-org client cache ────────────────────────────────────────────────────
// Twilio clients are reusable; cache one per subaccount SID so we don't rebuild
// (and re-decrypt) on every call. Keyed by subaccount SID, not orgId, so a
// re-provisioned org can't collide with a stale client.
const _clientCache = new Map();   // subaccountSid -> twilio client

/**
 * Resolve a Twilio client scoped to the org's subaccount.
 * @param {number} orgId
 * @returns {Promise<import('twilio').Twilio>}
 * @throws  {Error} code 'TWILIO_NOT_PROVISIONED' if the org has no active subaccount
 */
async function getClient(orgId) {
  const creds = await TwilioAccounts.getCredentials(orgId);
  if (!creds) {
    const e = new Error(`Org ${orgId} has no active Twilio subaccount provisioned`);
    e.code = 'TWILIO_NOT_PROVISIONED';
    throw e;
  }
  const cached = _clientCache.get(creds.accountSid);
  if (cached) return cached;
  const client = twilio(creds.accountSid, creds.authToken);
  _clientCache.set(creds.accountSid, client);
  return client;
}

// ── Constants ─────────────────────────────────────────────────────────────
const WEBHOOK_PATHS = {
  twiml:        (callId) => `/api/twilio/webhooks/twiml/${callId}`,
  twimlInbound: (didSid) => `/api/twilio/webhooks/twiml-inbound/${didSid}`,
  status:       (callId) => `/api/twilio/webhooks/status/${callId}`,
  recording:    (callId) => `/api/twilio/webhooks/recording/${callId}`,
};

const STATUS_CALLBACK_EVENTS = ['initiated', 'ringing', 'answered', 'completed'];
const RECORDING_MODE = 'record-from-answer-dual';


// ── validateConfig (boot-time) ──────────────────────────────────────────────
/**
 * Run at server startup. With subaccounts, the only deployment-wide
 * requirement is the PARENT credentials (for provisioning) plus a public base
 * URL (for webhooks / TwiML App voiceUrl). Per-org readiness is checked at call
 * time via getClient().
 *
 * @returns {Object} resolved parent config (for logging at boot)
 * @throws  if parent creds or public base URL are missing
 */
function validateConfig() {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error('Twilio: parent TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
  }
  const base = _resolvePublicBaseUrl();
  if (!base) {
    throw new Error(
      'Twilio: need a public backend URL for webhooks. ' +
      'Set RAILWAY_PUBLIC_DOMAIN (Railway sets this automatically) or BACKEND_PUBLIC_URL for local dev.'
    );
  }
  return {
    parent_account_sid_prefix: sid.slice(0, 8) + '…',
    public_base_url:           base,
    mode:                      'subaccount-per-org',
  };
}


// ── initiateCall ──────────────────────────────────────────────────────────
/**
 * Place a two-legged outbound call within the org's subaccount. Twilio dials
 * the rep first; when the rep picks up, Twilio fetches the TwiML URL, which
 * dials the prospect and bridges.
 *
 * NOTE: this is the legacy dial-and-bridge path (rep PSTN leg first). The
 * browser-dial softphone supersedes it for orgs on the Voice SDK; kept for
 * fallback / non-browser reps.
 *
 * @param {Object} args
 * @param {number} args.orgId
 * @param {number} args.callId
 * @param {string} args.repPhone       rep phone E.164
 * @param {string} args.repDid         rep's Twilio DID E.164
 * @param {string} args.prospectPhone  prospect phone E.164
 * @param {boolean}[args.recording=true]
 * @param {string} [args.recordingMode]
 * @returns {Promise<{sid: string, status: string}>}
 */
async function initiateCall({ orgId, callId, repPhone, repDid, prospectPhone, recording = true, recordingMode = RECORDING_MODE }) {
  if (!orgId || !callId || !repPhone || !repDid || !prospectPhone) {
    throw new Error('initiateCall: orgId, callId, repPhone, repDid, and prospectPhone are all required');
  }

  const client = await getClient(orgId);
  const base   = _resolvePublicBaseUrl();

  const params = {
    to:                   repPhone,
    from:                 repDid,
    url:                  `${base}${WEBHOOK_PATHS.twiml(callId)}`,
    statusCallback:       `${base}${WEBHOOK_PATHS.status(callId)}`,
    statusCallbackEvent:  STATUS_CALLBACK_EVENTS,
    statusCallbackMethod: 'POST',
  };

  if (recording) {
    params.record                        = true;
    params.recordingStatusCallback       = `${base}${WEBHOOK_PATHS.recording(callId)}`;
    params.recordingStatusCallbackMethod = 'POST';
    params.recordingChannels             = 'dual';
    void recordingMode;
  }

  // Common Twilio error codes (now that accounts are upgraded subaccounts, the
  // trial-only 21219 unverified-to-number error no longer applies):
  //   21211 — invalid 'to' phone format
  //   21214 — invalid 'from' phone (DID not owned by THIS subaccount)
  //   13227 — geo permission: subaccount not allowed to dial this destination
  try {
    const call = await client.calls.create(params);
    return { sid: call.sid, status: call.status };
  } catch (err) {
    const e = new Error(err.message || 'Twilio call create failed');
    e.code        = err.code;
    e.status      = err.status;
    e.moreInfo    = err.moreInfo;
    e.providerErr = true;
    throw e;
  }
}


// ── provisionDid ──────────────────────────────────────────────────────────
/**
 * Buy a new DID inside the org's subaccount and wire it to our inbound webhook.
 *
 * @param {Object} args
 * @param {number} args.orgId
 * @param {string} args.areaCode  3-digit US area code
 * @param {string} [args.country='US']
 * @returns {Promise<{did, did_sid, area_code, capabilities}>}
 */
async function provisionDid({ orgId, areaCode, country = 'US' } = {}) {
  if (!orgId) throw new Error('provisionDid: orgId is required');
  if (!areaCode || !/^\d{3}$/.test(String(areaCode))) {
    throw new Error('provisionDid: areaCode must be a 3-digit US area code (e.g. "415")');
  }

  const client = await getClient(orgId);
  const base   = _resolvePublicBaseUrl();

  const available = await client.availablePhoneNumbers(country)
    .local
    .list({ areaCode, voiceEnabled: true, limit: 1 });

  if (!available.length) {
    const e = new Error(`No local numbers available in area code ${areaCode}`);
    e.code  = 'TWILIO_NO_NUMBERS_AVAILABLE';
    throw e;
  }

  const candidate = available[0];

  const placeholderVoiceUrl = `${base}/api/twilio/webhooks/twiml-inbound/PENDING`;
  const purchased = await client.incomingPhoneNumbers.create({
    phoneNumber: candidate.phoneNumber,
    voiceUrl:    placeholderVoiceUrl,
    voiceMethod: 'POST',
  });

  await client.incomingPhoneNumbers(purchased.sid).update({
    voiceUrl: `${base}${WEBHOOK_PATHS.twimlInbound(purchased.sid)}`,
  });

  return {
    did:          purchased.phoneNumber,
    did_sid:      purchased.sid,
    area_code:    areaCode,
    capabilities: purchased.capabilities,
  };
}


// ── releaseDid ────────────────────────────────────────────────────────────
/**
 * Release a DID back to Twilio's pool from the org's subaccount.
 * @param {number} orgId
 * @param {string} didSid  PN... SID
 * @returns {Promise<boolean>}
 */
async function releaseDid(orgId, didSid) {
  if (!orgId)  throw new Error('releaseDid: orgId is required');
  if (!didSid) throw new Error('releaseDid: didSid is required');
  const client = await getClient(orgId);
  await client.incomingPhoneNumbers(didSid).remove();
  return true;
}


// ── cancelCall ──────────────────────────────────────────────────────────────
/**
 * Terminate an in-flight call in the org's subaccount.
 *   queued|ringing|initiated → update({status:'canceled'})
 *   in-progress              → update({status:'completed'})
 *
 * @param {number} orgId
 * @param {string} callSid  CA... SID
 * @param {string} [mode='cancel']  'cancel' (pre-connect) or 'hangup' (in-progress)
 * @returns {Promise<{sid, status} | null>}  null if the call already ended
 */
async function cancelCall(orgId, callSid, mode = 'cancel') {
  if (!orgId)   throw new Error('cancelCall: orgId is required');
  if (!callSid) throw new Error('cancelCall: callSid is required');
  if (mode !== 'cancel' && mode !== 'hangup') {
    throw new Error(`cancelCall: mode must be 'cancel' or 'hangup', got '${mode}'`);
  }
  const client = await getClient(orgId);
  const targetStatus = mode === 'hangup' ? 'completed' : 'canceled';

  try {
    const call = await client.calls(callSid).update({ status: targetStatus });
    return { sid: call.sid, status: call.status };
  } catch (err) {
    if (err.code === 20404 || err.code === 21220) return null;
    const e = new Error(err.message || 'Twilio call cancel failed');
    e.code        = err.code;
    e.status      = err.status;
    e.providerErr = true;
    throw e;
  }
}


// ── claimDid ────────────────────────────────────────────────────────────────
/**
 * Re-wire the voiceUrl of an existing DID already in the org's subaccount so
 * inbound calls route to GoWarmCRM. Does not buy a number.
 *
 * @param {number} orgId
 * @param {string} didSid  PN... SID
 * @returns {Promise<{did, did_sid, capabilities, previous_voice_url}>}
 */
async function claimDid(orgId, didSid) {
  if (!orgId) throw new Error('claimDid: orgId is required');
  if (!didSid || typeof didSid !== 'string' || !/^PN[a-f0-9]+$/i.test(didSid)) {
    const e = new Error('claimDid: didSid must be a Twilio phone-number SID (PN...)');
    e.code = 'INVALID_DID_SID';
    throw e;
  }
  const client = await getClient(orgId);
  const base   = _resolvePublicBaseUrl();

  let phoneNumber;
  try {
    phoneNumber = await client.incomingPhoneNumbers(didSid).fetch();
  } catch (err) {
    if (err.code === 20404 || err.status === 404) {
      const e = new Error(`No phone number with SID ${didSid} exists in this subaccount`);
      e.code = 'TWILIO_DID_NOT_FOUND';
      throw e;
    }
    throw err;
  }

  const newVoiceUrl = `${base}${WEBHOOK_PATHS.twimlInbound(didSid)}`;
  await client.incomingPhoneNumbers(didSid).update({
    voiceUrl:    newVoiceUrl,
    voiceMethod: 'POST',
  });

  return {
    did:                phoneNumber.phoneNumber,
    did_sid:            phoneNumber.sid,
    capabilities:       phoneNumber.capabilities,
    previous_voice_url: phoneNumber.voiceUrl || null,
  };
}


// ── validateSignature ─────────────────────────────────────────────────────
/**
 * Verify an inbound webhook actually came from Twilio, using the SUBACCOUNT's
 * auth token (each subaccount signs with its own token).
 *
 * The route must resolve which org the callback belongs to FIRST (callId → org,
 * or DID SID → org) and pass that orgId here. This reorders the original flow,
 * where validation happened before any DB lookup.
 *
 * @param {Object} req    Express request (x-twilio-signature header, parsed body, originalUrl)
 * @param {number} orgId  the org whose subaccount the webhook targets
 * @returns {Promise<boolean>}
 */
async function validateSignature(req, orgId) {
  const signature = req.headers['x-twilio-signature'];
  if (!signature) return false;
  if (!orgId) return false;

  const token = await TwilioAccounts.getAuthToken(orgId);
  if (!token) return false;

  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.get('host');
  const url   = `${proto}://${host}${req.originalUrl}`;
  const params = req.body || {};

  return twilio.validateRequest(token, signature, url, params);
}


// ── buildWebhookUrl ─────────────────────────────────────────────────────────
function buildWebhookUrl(path) {
  const base = _resolvePublicBaseUrl();
  if (!base) throw new Error('buildWebhookUrl: no public base URL configured');
  return `${base}${path}`;
}


// ── _resolvePublicBaseUrl (internal) ──────────────────────────────────────
function _resolvePublicBaseUrl() {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  if (process.env.BACKEND_PUBLIC_URL) {
    return process.env.BACKEND_PUBLIC_URL.replace(/\/+$/, '');
  }
  return null;
}


// ── Exports ───────────────────────────────────────────────────────────────
module.exports = {
  getClient,
  validateConfig,
  initiateCall,
  provisionDid,
  releaseDid,
  cancelCall,
  claimDid,
  validateSignature,
  buildWebhookUrl,
  WEBHOOK_PATHS,
  STATUS_CALLBACK_EVENTS,
  RECORDING_MODE,
};
