/**
 * /api/twilio/voice  —  browser-dialing (Voice JS SDK v2) support
 *
 * GET /token
 *   Mint a short-lived Twilio Voice AccessToken for the calling rep, scoped to
 *   THIS org's subaccount (API key + TwiML App). The browser softphone
 *   (@twilio/voice-sdk) uses it to register a Device and place outbound calls.
 *
 * The token grants OUTGOING calls only (incomingAllow:false) routed through the
 * subaccount's TwiML App, whose voiceUrl points at
 * /api/twilio/webhooks/voice-app (which dials the prospect from the DB row).
 *
 * Mount in server.js:
 *   app.use('/api/twilio/voice', require('./routes/twilio-voice.routes'));
 */

const express = require('express');
const router  = express.Router();
const twilio  = require('twilio');

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');
const TwilioAccounts    = require('../services/twilioAccounts.service');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

// Token lifetime. Calls are short; the SDK refreshes via tokenWillExpire well
// before this elapses.
const TOKEN_TTL_SECONDS = 3600;

// =========================================================================
// GET /token — issue a Voice AccessToken for the current rep
// =========================================================================
router.get('/token', async (req, res) => {
  let cfg;
  try {
    cfg = await TwilioAccounts.getVoiceConfig(req.orgId);
  } catch (err) {
    console.error('voice/token: getVoiceConfig failed:', err.message);
    return res.status(500).json({ error: { message: 'Failed to load voice config' } });
  }

  if (!cfg) {
    return res.status(503).json({
      error: {
        message: 'Browser calling is not set up for your organization yet. An admin needs to provision Twilio in Org Settings → Prospecting → Twilio.',
        code:    'TWILIO_VOICE_NOT_PROVISIONED',
      },
    });
  }

  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant  = AccessToken.VoiceGrant;

  // Stable per-rep identity. The voice-app webhook keys off our DB callId, not
  // this identity, but a stable identity keeps Twilio call logs readable.
  const identity = `rep-${req.user.userId}`;

  const token = new AccessToken(
    cfg.accountSid,
    cfg.apiKeySid,
    cfg.apiKeySecret,
    { identity, ttl: TOKEN_TTL_SECONDS }
  );
  token.addGrant(new VoiceGrant({
    outgoingApplicationSid: cfg.twimlAppSid,
    incomingAllow:          false,
  }));

  return res.json({
    token:      token.toJwt(),
    identity,
    expires_in: TOKEN_TTL_SECONDS,
  });
});

module.exports = router;
