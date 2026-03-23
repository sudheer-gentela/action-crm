/**
 * webhooks.routes.js
 * backend/routes/webhooks.routes.js
 *
 * Single entry point for all inbound transcript webhooks.
 * Registered in server.js as: app.use('/webhooks/transcript', router)
 *
 * Routes:
 *   POST /webhooks/transcript/:provider/org/:orgId   — org-level providers
 *   POST /webhooks/transcript/:provider/user/:userId — rep-level providers
 *
 * Valid :provider values:
 *   zoom_org | teams | fireflies_org | fireflies | fathom | gong (future)
 *
 * Each request goes through:
 *   1. Signature verification (provider-specific, uses stored secret)
 *   2. Provider parser → NormalizedTranscript
 *   3. MeetingMatcher → meetingId + userId
 *   4. Store in meeting_transcripts
 *   5. AttendeeReconciler → update attendance_status
 *   6. analyzeTranscript (async, fire-and-forget)
 *   7. Unmatched handling → notify rep if no meeting found
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { pool } = require('../config/database');

const ZoomParser      = require('../services/parsers/ZoomParser');
const TeamsParser     = require('../services/parsers/TeamsParser');
const FirefliesParser = require('../services/parsers/FirefliesParser');

const { findMeeting }    = require('../services/MeetingMatcher');
const { reconcile }      = require('../services/AttendeeReconciler');
const { analyzeTranscript } = require('../services/transcriptAnalyzer');
const notificationService   = require('../services/notificationService');

// ── Parser registry ───────────────────────────────────────────────────────────
const PARSERS = {
  zoom_org:      ZoomParser,
  teams:         TeamsParser,
  fireflies_org: FirefliesParser,
  fireflies:     FirefliesParser,   // personal — same parser, different scope
};

// ── Signature verification ────────────────────────────────────────────────────

/**
 * Verify Zoom webhook signature.
 * Zoom signs: `v0:${timestamp}:${rawBody}` with HMAC-SHA256
 * Header: x-zm-signature = "v0=<hex>"
 * Header: x-zm-request-timestamp
 */
function verifyZoomSignature(req, secret) {
  const timestamp = req.headers['x-zm-request-timestamp'];
  const signature = req.headers['x-zm-signature'];

  if (!timestamp || !signature) return false;

  // Reject if timestamp is older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;

  const message  = `v0:${timestamp}:${req.rawBody}`;
  const expected = 'v0=' + crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature)
  );
}

/**
 * Verify Microsoft Graph client state token.
 * Graph sends the clientState value verbatim — no HMAC, just equality check.
 */
function verifyTeamsSignature(req, secret) {
  // For validation challenge, clientState is in query param
  if (req.query.validationToken) return true;

  const notifications = req.body?.value || [];
  if (!notifications.length) return false;

  // All notifications in the batch share the same clientState
  return notifications.every(n => n.clientState === secret);
}

/**
 * Verify Fireflies webhook token.
 * Fireflies sends X-Fireflies-Token header matching the configured secret.
 */
function verifyFirefliesSignature(req, secret) {
  const token = req.headers['x-fireflies-token'];
  if (!token) return false;

  return crypto.timingSafeEqual(
    Buffer.from(secret),
    Buffer.from(token)
  );
}

const SIGNATURE_VERIFIERS = {
  zoom_org:      verifyZoomSignature,
  teams:         verifyTeamsSignature,
  fireflies_org: verifyFirefliesSignature,
  fireflies:     verifyFirefliesSignature,
};

// ── Secret lookup ─────────────────────────────────────────────────────────────

/**
 * Get webhook secret for org-level provider from org_integrations.
 */
async function getOrgSecret(orgId, provider) {
  const result = await pool.query(
    `SELECT credentials->>'webhook_secret' AS secret, status
     FROM org_integrations
     WHERE org_id           = $1
       AND integration_type = $2`,
    [orgId, provider]
  );

  if (!result.rows.length || result.rows[0].status !== 'active') {
    return null;
  }

  return result.rows[0].secret || null;
}

/**
 * Get webhook secret for rep-level provider from oauth_tokens.webhook_config.
 */
async function getUserSecret(userId, provider) {
  const result = await pool.query(
    `SELECT
       webhook_config->>'webhook_secret' AS secret,
       (webhook_config->>'enabled')::boolean AS enabled,
       org_id
     FROM oauth_tokens
     WHERE user_id  = $1
       AND provider = $2`,
    [userId, provider]
  );

  if (!result.rows.length || !result.rows[0].enabled) {
    return { secret: null, orgId: null };
  }

  return {
    secret: result.rows[0].secret || null,
    orgId:  result.rows[0].org_id,
  };
}

// ── Shared pipeline ───────────────────────────────────────────────────────────
/**
 * After parsing, run the full pipeline:
 * store → match → reconcile → analyze
 */
async function runPipeline(normalized, orgId, userId) {
  const client = await pool.connect();

  try {
    // 1. Match to a meeting
    const { meetingId, confidence, userId: matchedUserId } =
      await findMeeting(normalized, orgId, userId);

    // Use matched userId if org-level webhook (userId passed in was null)
    const effectiveUserId = userId || matchedUserId;

    // 2. Insert transcript record
    const insertResult = await client.query(
      `INSERT INTO meeting_transcripts
         (org_id, user_id, meeting_id, transcript_text,
          source, meeting_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id`,
      [
        orgId,
        effectiveUserId,
        meetingId || null,
        normalized.transcriptText,
        normalized.sourceProvider,
        normalized.meetingStartTime
          ? new Date(normalized.meetingStartTime)
          : null,
      ]
    );

    const transcriptId = insertResult.rows[0].id;

    // 3. Back-link transcript to meeting
    if (meetingId) {
      await client.query(
        `UPDATE meetings
         SET transcript_id = $1, updated_at = NOW()
         WHERE id = $2 AND org_id = $3`,
        [transcriptId, meetingId, orgId]
      );

      // 4. Reconcile attendees (async — non-fatal if it fails)
      if (normalized.speakerEmails?.length > 0) {
        reconcile(meetingId, orgId, normalized.speakerEmails).catch(err =>
          console.error(`❌ AttendeeReconciler failed for meeting ${meetingId}:`, err.message)
        );
      }
    } else {
      // Unmatched — notify the rep if we have a userId
      console.log(
        `📥 Unmatched transcript ${transcriptId} stored ` +
        `(provider: ${normalized.sourceProvider})`
      );

      if (effectiveUserId) {
        notificationService.createNotification({
          userId:   effectiveUserId,
          orgId,
          type:     'transcript_unmatched',
          title:    'Transcript needs linking',
          message:  `A transcript from ${normalized.sourceProvider} arrived but couldn't be matched to a meeting. ` +
                    `Title: "${normalized.meetingTitle || 'Unknown'}". Please link it manually.`,
          metadata: { transcriptId, sourceProvider: normalized.sourceProvider },
        }).catch(err =>
          console.error('Failed to send unmatched transcript notification:', err.message)
        );
      }
    }

    // 5. Trigger AI analysis (async, fire-and-forget)
    if (effectiveUserId) {
      analyzeTranscript(transcriptId, effectiveUserId)
        .then(() => console.log(`✅ Webhook transcript ${transcriptId} analysis complete`))
        .catch(err => console.error(`❌ Webhook transcript ${transcriptId} analysis failed:`, err.message));
    }

    return { transcriptId, meetingId, confidence };

  } finally {
    client.release();
  }
}

// ── Org-level route ───────────────────────────────────────────────────────────
router.post('/:provider/org/:orgId', async (req, res) => {
  const { provider, orgId } = req.params;
  const parsedOrgId = parseInt(orgId);

  // ── Special: Zoom URL validation challenge ──────────────────
  if (provider === 'zoom_org' && req.body?.event === 'endpoint.url_validation') {
    const hashForValidate = crypto
      .createHmac('sha256', req.body.payload?.plainToken || '')
      .update(req.body.payload?.plainToken || '')
      .digest('hex');
    return res.json({
      plainToken:     req.body.payload.plainToken,
      encryptedToken: hashForValidate,
    });
  }

  // ── Special: Teams validation challenge ────────────────────
  if (provider === 'teams' && req.query.validationToken) {
    return res.status(200)
      .set('Content-Type', 'text/plain')
      .send(req.query.validationToken);
  }

  // ── Validate provider ───────────────────────────────────────
  if (!PARSERS[provider]) {
    return res.status(400).json({ error: { message: `Unknown provider: ${provider}` } });
  }

  // ── Verify signature ────────────────────────────────────────
  const secret = await getOrgSecret(parsedOrgId, provider).catch(() => null);

  if (!secret) {
    console.warn(`⚠️  Webhook rejected: no active integration for ${provider} org ${parsedOrgId}`);
    return res.status(401).json({ error: { message: 'Integration not configured or inactive' } });
  }

  const verifier = SIGNATURE_VERIFIERS[provider];
  if (verifier && !verifier(req, secret)) {
    console.warn(`⚠️  Webhook signature invalid for ${provider} org ${parsedOrgId}`);
    return res.status(401).json({ error: { message: 'Invalid webhook signature' } });
  }

  // ── Respond immediately (providers expect fast 2xx) ─────────
  res.status(202).json({ received: true });

  // ── Parse + pipeline (async after response) ─────────────────
  try {
    const parser     = PARSERS[provider];
    const normalized = await parser.parse({ ...req.body, _sourceProvider: provider });
    await runPipeline(normalized, parsedOrgId, null);
  } catch (err) {
    if (err.message === 'URL_VALIDATION_CHALLENGE' || err.message === 'VALIDATION_CHALLENGE') {
      return; // Already handled above
    }
    console.error(`❌ Webhook pipeline error (${provider} org ${parsedOrgId}):`, err.message);
  }
});

// ── User-level route ──────────────────────────────────────────────────────────
router.post('/:provider/user/:userId', async (req, res) => {
  const { provider, userId } = req.params;
  const parsedUserId = parseInt(userId);

  // ── Validate provider ───────────────────────────────────────
  if (!PARSERS[provider]) {
    return res.status(400).json({ error: { message: `Unknown provider: ${provider}` } });
  }

  // ── Verify signature + get orgId ────────────────────────────
  const { secret, orgId } = await getUserSecret(parsedUserId, provider).catch(() => ({ secret: null, orgId: null }));

  if (!secret || !orgId) {
    console.warn(`⚠️  Webhook rejected: no active tool for ${provider} user ${parsedUserId}`);
    return res.status(401).json({ error: { message: 'Tool not configured or inactive' } });
  }

  const verifier = SIGNATURE_VERIFIERS[provider];
  if (verifier && !verifier(req, secret)) {
    console.warn(`⚠️  Webhook signature invalid for ${provider} user ${parsedUserId}`);
    return res.status(401).json({ error: { message: 'Invalid webhook signature' } });
  }

  // ── Respond immediately ──────────────────────────────────────
  res.status(202).json({ received: true });

  // ── Parse + pipeline ─────────────────────────────────────────
  try {
    const parser     = PARSERS[provider];
    const normalized = await parser.parse({ ...req.body, _sourceProvider: provider });
    await runPipeline(normalized, orgId, parsedUserId);
  } catch (err) {
    console.error(`❌ Webhook pipeline error (${provider} user ${parsedUserId}):`, err.message);
  }
});

module.exports = router;
