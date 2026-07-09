// ─────────────────────────────────────────────────────────────────────────────
// routes/tracking-diagnostics.routes.js
//
// READ-ONLY diagnostics for open/click tracking (Phase 7). Answers the three
// questions that the events table alone cannot:
//
//   1. Is the pixel being added?   → probe decorateHtml() with the live gates
//   2. Is the email being opened?  → email_engagement_events, bot-classified
//   3. Is it being clicked?        → same, event_type='click'
//
// ...plus the two silent failure modes:
//   • TRACKING_TOKEN_SECRET missing → signToken throws → decorateHtml swallows
//     it and returns undecorated HTML. Indistinguishable from a closed gate
//     unless we check the env explicitly. We do.
//   • Snapshot not run → raw events exist but reports read zeroes, because
//     reports read prospecting_metric_daily, not the events table.
//
// Writes NOTHING. The decorate probe runs on a throwaway HTML string; no email
// is sent and no row is inserted.
//
// Mount in server.js next to the other prospecting routes:
//   app.use('/api/tracking-diagnostics', require('./routes/tracking-diagnostics.routes'));
//
//   GET /api/tracking-diagnostics/summary
//   GET /api/tracking-diagnostics/step-logs?limit=25
//   GET /api/tracking-diagnostics/step-log/:id
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const { pool } = require('../config/database');
const S = require('../services/EmailTrackingService');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireRole('owner', 'admin'));

// Throwaway body for the decorate probe: one anchor so click-rewriting has
// something to bite on, one <body> so the pixel has an anchor point.
const PROBE = '<html><body><p>probe <a href="https://gowarmcrm.com">x</a></p></body></html>';

function secretConfigured() {
  return Boolean(process.env.TRACKING_TOKEN_SECRET || process.env.JWT_SECRET);
}

// ── GET /summary ─────────────────────────────────────────────────────────────
// Everything you need to answer "is tracking armed, and is anything landing?"
router.get('/summary', async (req, res) => {
  try {
    const orgId = req.orgId;

    const [domains, campaigns, events, snapshot] = await Promise.all([
      pool.query(
        `SELECT id, hostname, status, last_checked_at, error_message
           FROM tracking_domains WHERE org_id = $1 ORDER BY id`,
        [orgId]
      ),
      pool.query(
        `SELECT id, name, tracking_opens, tracking_clicks
           FROM prospecting_campaigns
          WHERE org_id = $1 AND (tracking_opens OR tracking_clicks)
          ORDER BY id`,
        [orgId]
      ),
      pool.query(
        `SELECT event_type, is_bot, bot_reason,
                count(*)::int AS n, max(occurred_at) AS latest
           FROM email_engagement_events
          WHERE org_id = $1
          GROUP BY 1, 2, 3
          ORDER BY 1, 2`,
        [orgId]
      ),
      // Reports read THIS table, not the events table. If max_d lags today,
      // the nightly snapshot hasn't absorbed recent events yet.
      pool.query(
        `SELECT max(d)::text                          AS max_d,
                COALESCE(sum(opens), 0)::int          AS opens,
                COALESCE(sum(clicks), 0)::int         AS clicks
           FROM prospecting_metric_daily
          WHERE org_id = $1 AND d >= CURRENT_DATE - 30`,
        [orgId]
      ),
    ]);

    const activeHosts = domains.rows.filter((d) => d.status === 'active');

    res.json({
      secret_configured: secretConfigured(),
      domains: domains.rows,
      active_host_count: activeHosts.length,
      // >1 active host + SequenceStepFirer not passing senderEmail means
      // getActiveHostname always returns hosts[0]. Surface it rather than
      // let it silently cross-domain every link.
      multi_host_warning: activeHosts.length > 1,
      campaigns_with_tracking: campaigns.rows,
      events: events.rows,
      events_total: events.rows.reduce((a, r) => a + r.n, 0),
      events_human: events.rows.filter((r) => !r.is_bot).reduce((a, r) => a + r.n, 0),
      snapshot: snapshot.rows[0],
    });
  } catch (err) {
    console.error('[tracking-diagnostics] summary error:', err.message);
    res.status(500).json({ error: { message: 'Failed to load tracking summary' } });
  }
});

// ── GET /step-logs ───────────────────────────────────────────────────────────
// Recent email sends with their event counts — the picker for the detail view.
router.get('/step-logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const r = await pool.query(
      `SELECT ssl.id, ssl.prospect_id, ssl.fired_at, ssl.status,
              p.email AS prospect_email, p.campaign_id,
              pc.name AS campaign_name,
              COUNT(*) FILTER (WHERE e.event_type = 'open'  AND NOT e.is_bot)::int AS opens,
              COUNT(*) FILTER (WHERE e.event_type = 'click' AND NOT e.is_bot)::int AS clicks,
              COUNT(*) FILTER (WHERE e.is_bot)::int                                AS bot_events
         FROM sequence_step_logs ssl
         JOIN prospects p ON p.id = ssl.prospect_id AND p.org_id = ssl.org_id
         LEFT JOIN prospecting_campaigns pc ON pc.id = p.campaign_id AND pc.org_id = p.org_id
         LEFT JOIN email_engagement_events e ON e.step_log_id = ssl.id AND e.org_id = ssl.org_id
        WHERE ssl.org_id = $1 AND ssl.channel = 'email' AND ssl.fired_at IS NOT NULL
        GROUP BY ssl.id, p.email, p.campaign_id, pc.name
        ORDER BY ssl.fired_at DESC
        LIMIT $2`,
      [req.orgId, limit]
    );
    res.json({ step_logs: r.rows });
  } catch (err) {
    console.error('[tracking-diagnostics] step-logs error:', err.message);
    res.status(500).json({ error: { message: 'Failed to load step logs' } });
  }
});

// ── GET /step-log/:id ────────────────────────────────────────────────────────
// The real test: run the live gates for THIS prospect and report which one
// (if any) would have suppressed decoration.
router.get('/step-log/:id', async (req, res) => {
  try {
    const stepLogId = parseInt(req.params.id, 10);
    if (!Number.isInteger(stepLogId)) {
      return res.status(400).json({ error: { message: 'Invalid step log id' } });
    }

    const r = await pool.query(
      `SELECT ssl.id, ssl.org_id, ssl.prospect_id, ssl.channel, ssl.status,
              ssl.fired_at, ssl.body,
              p.campaign_id, p.email AS prospect_email,
              pc.name AS campaign_name, pc.tracking_opens, pc.tracking_clicks,
              psa.email AS sender_email, psa.provider
         FROM sequence_step_logs ssl
         JOIN prospects p ON p.id = ssl.prospect_id AND p.org_id = ssl.org_id
         LEFT JOIN prospecting_campaigns pc ON pc.id = p.campaign_id AND pc.org_id = p.org_id
         LEFT JOIN emails em ON em.id = ssl.email_id AND em.org_id = ssl.org_id
         LEFT JOIN prospecting_sender_accounts psa ON psa.id = em.sender_account_id
        WHERE ssl.id = $1 AND ssl.org_id = $2`,
      [stepLogId, req.orgId]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Step log not found' } });
    }
    const x = r.rows[0];

    // Gate B — resolve the host exactly as the send path would. NOTE: the send
    // path in SequenceStepFirer does NOT pass senderEmail, so we probe both:
    // what the code WOULD pick if aligned, and what it ACTUALLY picks today.
    const hostAligned = await S.getActiveHostname(pool, x.org_id, x.sender_email || undefined);
    const hostActual  = await S.getActiveHostname(pool, x.org_id, undefined);

    // The probe. decorateHtml never throws; identical output = a gate failed.
    const out = await S.decorateHtml(pool, {
      orgId: x.org_id, prospectId: x.prospect_id, stepLogId: x.id, html: PROBE,
    });
    const decorated = out !== PROBE;

    const body = x.body || '';
    const anchors  = (body.match(/<a\b[^>]*href\s*=\s*["']https?:\/\//gi) || []).length;
    const bareUrls = (body.match(/https?:\/\/\S+/gi) || []).length;

    const ev = await pool.query(
      `SELECT id, event_type, is_bot, bot_reason, link_index, url,
              left(user_agent, 160) AS user_agent, occurred_at
         FROM email_engagement_events
        WHERE step_log_id = $1 AND org_id = $2
        ORDER BY id DESC LIMIT 50`,
      [stepLogId, req.orgId]
    );

    // Name the first failing gate, in send-path order.
    let verdict = 'decorated';
    if (!decorated) {
      if (!secretConfigured())            verdict = 'secret_missing';
      else if (!x.campaign_id)            verdict = 'no_campaign';
      else if (!x.tracking_opens && !x.tracking_clicks) verdict = 'toggles_off';
      else if (!hostActual)               verdict = 'no_active_domain';
      else                                verdict = 'unknown';
    }

    res.json({
      step_log: {
        id: x.id, prospect_id: x.prospect_id, prospect_email: x.prospect_email,
        status: x.status, fired_at: x.fired_at,
        sender_email: x.sender_email, provider: x.provider,
      },
      gates: {
        secret_configured: secretConfigured(),
        campaign_id: x.campaign_id,
        campaign_name: x.campaign_name,
        tracking_opens: x.tracking_opens === true,
        tracking_clicks: x.tracking_clicks === true,
        host_actual: hostActual,
        host_aligned_with_sender: hostAligned,
        // True when the two disagree: the sender's domain has a matching
        // tracking host, but the send path can't reach it (senderEmail is
        // never passed). Links go out cross-domain.
        host_misalignment: Boolean(hostAligned && hostActual && hostAligned !== hostActual),
      },
      decoration: {
        decorated,
        verdict,
        pixel_present: /\/t\/o\//.test(out),
        link_rewritten: /\/t\/c\//.test(out),
      },
      body_shape: {
        anchor_hrefs: anchors,
        bare_urls: bareUrls,
        // Click tracking rewrites <a href="http..."> only. Bare URLs in a
        // plain-text body are wrapped by plainTextToHtml at send time, so this
        // is a hint, not a verdict.
        clicks_may_have_nothing_to_rewrite:
          x.tracking_clicks === true && anchors === 0 && bareUrls > 0,
      },
      events: ev.rows,
    });
  } catch (err) {
    console.error('[tracking-diagnostics] step-log error:', err.message);
    res.status(500).json({ error: { message: 'Failed to run diagnostic' } });
  }
});

module.exports = router;
