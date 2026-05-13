/**
 * TwilioProviderService
 *
 * Wraps the Twilio Node SDK with the operations Phase 3 needs:
 *   - validateConfig():     startup sanity check on env vars
 *   - initiateCall():       place an outbound two-legged call
 *   - provisionDid():       buy a new DID, wire it to our inbound webhook
 *   - releaseDid():         release a DID back to Twilio's pool
 *   - validateSignature():  verify an incoming webhook is really from Twilio
 *   - buildWebhookUrl():    construct absolute callback URLs (internal)
 *
 * Does NOT touch the database. The route/persistence layer owns DB writes.
 * This service is a pure adapter over the Twilio API.
 *
 * Environment variables consumed:
 *   TWILIO_ACCOUNT_SID         (required) — Twilio account identifier
 *   TWILIO_AUTH_TOKEN          (required) — used for API auth + signature verification
 *   RAILWAY_PUBLIC_DOMAIN      (preferred) — auto-set on Railway, hostname only
 *   BACKEND_PUBLIC_URL         (fallback)  — full https URL for local/non-Railway dev
 *
 * Either RAILWAY_PUBLIC_DOMAIN or BACKEND_PUBLIC_URL must be set; we need a
 * publicly reachable URL so Twilio can deliver TwiML, status, and recording
 * webhooks back to our backend.
 */

const twilio = require('twilio');

// ── Module-level singletons ────────────────────────────────────────────────
// The Twilio Node client is thread-safe and meant to be reused. Lazy-init on
// first call so unit tests can stub it before module load if needed.
let _client = null;

function getClient() {
  if (_client) return _client;
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN env vars are required');
  }
  _client = twilio(sid, token);
  return _client;
}

// ── Constants ─────────────────────────────────────────────────────────────
// Where webhook routes will live in server.js. Centralized so changes here
// stay in sync with the routes file.
const WEBHOOK_PATHS = {
  twiml:           (callId) => `/api/twilio/webhooks/twiml/${callId}`,
  twimlInbound:    (didSid) => `/api/twilio/webhooks/twiml-inbound/${didSid}`,
  status:          (callId) => `/api/twilio/webhooks/status/${callId}`,
  recording:       (callId) => `/api/twilio/webhooks/recording/${callId}`,
};

// Status callback events we want Twilio to fire. All four give us complete
// lifecycle visibility:
//   initiated → row exists; status='initiated'
//   ringing   → at least one leg is ringing; status='ringing'
//   answered  → both legs connected (Twilio's term for in_progress)
//   completed → call ended; final state in (completed|no_answer|failed|busy|canceled)
const STATUS_CALLBACK_EVENTS = ['initiated', 'ringing', 'answered', 'completed'];

// Recording mode. 'record-from-answer-dual' captures both legs as separate
// audio channels (better for downstream transcription with diarization) and
// only starts billing/storage from the moment the second leg answers.
const RECORDING_MODE = 'record-from-answer-dual';


// ── validateConfig ────────────────────────────────────────────────────────
/**
 * Run at server startup to fail fast on missing config rather than blowing
 * up on the first call attempt. Server.js should call this before starting
 * to listen.
 *
 * @returns {Object} resolved config (mostly for logging at boot)
 * @throws  if any required env var is missing
 */
function validateConfig() {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error('Twilio: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
  }
  const base = _resolvePublicBaseUrl();
  if (!base) {
    throw new Error(
      'Twilio: need a public backend URL for webhooks. ' +
      'Set RAILWAY_PUBLIC_DOMAIN (Railway sets this automatically) or BACKEND_PUBLIC_URL for local dev.'
    );
  }
  return {
    account_sid_prefix: sid.slice(0, 8) + '…',  // safe to log
    public_base_url:    base,
  };
}


// ── initiateCall ──────────────────────────────────────────────────────────
/**
 * Place a two-legged outbound call. Twilio dials the rep first; when the rep
 * picks up, Twilio fetches the TwiML URL we hand it, which tells Twilio to
 * dial the prospect and bridge.
 *
 * Required args:
 *   callId         (int)    — our calls.id; embedded in webhook URLs so the
 *                             callback can update the right row
 *   repPhone       (string) — rep's real phone in E.164 (e.g. +14155551234)
 *   repDid         (string) — Twilio DID assigned to this rep in E.164
 *   prospectPhone  (string) — prospect phone in E.164 (validated upstream)
 *
 * Optional args (with defaults from org_action_config.call_settings):
 *   recording        (bool)   — record both legs (default: true)
 *   recordingMode    (string) — Twilio recording mode (default: 'record-from-answer-dual')
 *
 * Returns: { sid, status } from Twilio. `sid` becomes provider_call_id.
 *
 * NOTE: this method does NOT generate TwiML itself. Twilio fetches TwiML
 *       by calling our `twimlUrl` webhook when the rep answers. That route
 *       lives in twilio-webhooks.routes.js (next deliverable) and is
 *       responsible for the <Dial> + optional disclosure <Say>.
 */
async function initiateCall({ callId, repPhone, repDid, prospectPhone, recording = true, recordingMode = RECORDING_MODE }) {
  if (!callId || !repPhone || !repDid || !prospectPhone) {
    throw new Error('initiateCall: callId, repPhone, repDid, and prospectPhone are all required');
  }

  const client = getClient();
  const base   = _resolvePublicBaseUrl();

  const params = {
    to:                  repPhone,
    from:                repDid,
    url:                 `${base}${WEBHOOK_PATHS.twiml(callId)}`,
    statusCallback:      `${base}${WEBHOOK_PATHS.status(callId)}`,
    statusCallbackEvent: STATUS_CALLBACK_EVENTS,
    statusCallbackMethod:'POST',
  };

  if (recording) {
    params.record                   = true;
    params.recordingStatusCallback  = `${base}${WEBHOOK_PATHS.recording(callId)}`;
    params.recordingStatusCallbackMethod = 'POST';
    params.recordingChannels        = 'dual';
    // recordingMode is set on the <Dial> in TwiML rather than on the parent
    // call resource — we'll thread it through to the TwiML route via query
    // string. For now it's documented but not used on the parent call.
    void recordingMode;  // suppress unused-var lint
  }

  // Surface Twilio errors with a code that callers can switch on. The most
  // common ones for a trial account are:
  //   21219 — to-number is not verified (trial accounts can only call verified)
  //   21211 — invalid 'to' phone format
  //   21214 — invalid 'from' phone (DID not owned by account)
  try {
    const call = await client.calls.create(params);
    return { sid: call.sid, status: call.status };
  } catch (err) {
    const e = new Error(err.message || 'Twilio call create failed');
    e.code        = err.code;        // Twilio numeric code (e.g. 21219)
    e.status      = err.status;      // HTTP status from Twilio API
    e.moreInfo    = err.moreInfo;    // Twilio docs link
    e.providerErr = true;            // routing layer can branch on this
    throw e;
  }
}


// ── provisionDid ──────────────────────────────────────────────────────────
/**
 * Buy a new DID and wire it to our inbound-call webhook so prospects who
 * dial it get routed to the assigned rep.
 *
 * Required args:
 *   areaCode (string) — 3-digit US area code preference (e.g. '415')
 *
 * Optional args:
 *   country  (string) — ISO country code (default 'US'; only US for Phase 3)
 *
 * Returns: { did, did_sid, area_code, capabilities }
 *
 * Note on cost: each provisioned DID costs ~$1/month on Twilio. Caller
 * (admin route) is responsible for confirming the cost with the admin before
 * invoking this method.
 *
 * The inbound voice URL points to /twiml-inbound/{didSid} rather than
 * /twiml-inbound/{phoneNumber} because the SID is stable and URL-safe; the
 * phone number could collide with URL encoding edge cases.
 */
async function provisionDid({ areaCode, country = 'US' } = {}) {
  if (!areaCode || !/^\d{3}$/.test(String(areaCode))) {
    throw new Error('provisionDid: areaCode must be a 3-digit US area code (e.g. "415")');
  }

  const client = getClient();
  const base   = _resolvePublicBaseUrl();

  // Search for a local number with voice capability in the requested area.
  // limit:1 because we just need one match; admin can retry with a different
  // area code if none is available.
  const available = await client.availablePhoneNumbers(country)
    .local
    .list({ areaCode, voiceEnabled: true, limit: 1 });

  if (!available.length) {
    const e = new Error(`No local numbers available in area code ${areaCode}`);
    e.code  = 'TWILIO_NO_NUMBERS_AVAILABLE';
    throw e;
  }

  const candidate = available[0];

  // Purchase it. The voiceUrl is set BEFORE the purchase completes so there's
  // no window where the number is owned but routes nowhere.
  // We do a placeholder voiceUrl first, then patch it with the real SID after
  // creation — required because we don't know the SID until the buy succeeds.
  const placeholderVoiceUrl = `${base}/api/twilio/webhooks/twiml-inbound/PENDING`;
  const purchased = await client.incomingPhoneNumbers.create({
    phoneNumber: candidate.phoneNumber,
    voiceUrl:    placeholderVoiceUrl,
    voiceMethod: 'POST',
  });

  // Now we have the SID; patch the voiceUrl to include it.
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
 * Release a DID back to Twilio's pool. Stops the monthly charge. Used when
 * an admin removes a rep or reassigns their number.
 *
 * @param {string} didSid — Twilio's PN... SID for the number
 * @returns {boolean} true on success
 *
 * IMPORTANT: after release, the DID may be re-issued to a different Twilio
 * customer immediately. Make sure the DB row for this rep's twilio_did is
 * cleared in the same transaction that invokes this method, or you'll have
 * a phantom DID record that points at someone else's number.
 */
async function releaseDid(didSid) {
  if (!didSid) throw new Error('releaseDid: didSid is required');
  const client = getClient();
  await client.incomingPhoneNumbers(didSid).remove();
  return true;
}


// ── validateSignature ─────────────────────────────────────────────────────
/**
 * Verify that a webhook request actually came from Twilio. Without this,
 * anyone who knows the URL of one of our webhook routes could forge a
 * status/recording callback and corrupt our calls table.
 *
 * Twilio signs the request URL + form-body params with HMAC-SHA1 keyed on
 * our Auth Token. The signature is in the X-Twilio-Signature header.
 *
 * @param {Object} req — Express request object. Must have:
 *                       req.headers['x-twilio-signature']
 *                       req.body  (parsed urlencoded form)
 *                       req.originalUrl
 * @returns {boolean}
 *
 * USAGE NOTES:
 * - The URL Twilio signed is the FULL URL it called, not Express's relative
 *   path. We reconstruct it from req.protocol + req.get('host') + req.originalUrl.
 * - Express must be configured to trust the proxy header so req.protocol
 *   returns 'https' when behind Cloudflare/Railway. server.js sets this via
 *   app.set('trust proxy', ...) — confirm before relying on this.
 * - When `extended: true` is set on express.urlencoded(), the parsed body
 *   keys/values are what Twilio used as signing params. Good.
 */
function validateSignature(req) {
  const signature = req.headers['x-twilio-signature'];
  if (!signature) return false;

  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;

  // Reconstruct the URL Twilio used. Honour x-forwarded-proto so we get
  // 'https' even when our Express server itself is HTTP behind Cloudflare.
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host'] || req.get('host');
  const url   = `${proto}://${host}${req.originalUrl}`;

  // req.body is the parsed urlencoded form Twilio sent.
  const params = req.body || {};

  return twilio.validateRequest(token, signature, url, params);
}


// ── buildWebhookUrl ───────────────────────────────────────────────────────
/**
 * Construct an absolute webhook URL. Exported so the route layer can use it
 * if it ever needs to log or echo back the URL Twilio is expected to call.
 *
 * @param {string} path — must start with '/'
 * @returns {string} absolute https URL
 */
function buildWebhookUrl(path) {
  const base = _resolvePublicBaseUrl();
  if (!base) throw new Error('buildWebhookUrl: no public base URL configured');
  return `${base}${path}`;
}


// ── _resolvePublicBaseUrl (internal) ──────────────────────────────────────
// Railway auto-sets RAILWAY_PUBLIC_DOMAIN to a bare hostname (no scheme).
// For local dev or non-Railway hosting, BACKEND_PUBLIC_URL is the escape
// hatch — must include https:// scheme.
function _resolvePublicBaseUrl() {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  if (process.env.BACKEND_PUBLIC_URL) {
    // Strip trailing slash so concatenation with WEBHOOK_PATHS values is clean.
    return process.env.BACKEND_PUBLIC_URL.replace(/\/+$/, '');
  }
  return null;
}


// ── Exports ───────────────────────────────────────────────────────────────
module.exports = {
  validateConfig,
  initiateCall,
  provisionDid,
  releaseDid,
  validateSignature,
  buildWebhookUrl,
  // Expose constants for the route/webhook layer to reuse without
  // hardcoding the path shape in two places.
  WEBHOOK_PATHS,
  STATUS_CALLBACK_EVENTS,
  RECORDING_MODE,
};
