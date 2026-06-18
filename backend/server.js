// ─────────────────────────────────────────────────────────────────────────────
// server.js — GoWarmCRM backend entry point
//
// Owns: process boot, middleware stack, route mounting, cron schedules.
// Does NOT own: any business logic, validation, or persistence — those live
// in routes/ and services/.
//
// Structure:
//   1. Bootstrap (express, dotenv, app constants)
//   2. Core middleware (security, CORS, ext-key guard, rate limits, body parser)
//   3. Health + public routes
//   4. API routes — grouped by domain
//   5. Error handlers
//   6. listen() + cron registration
//
// Phase 3 additions are isolated under "Twilio (Phase 3)" comments to keep
// the diff easy to read.
// ─────────────────────────────────────────────────────────────────────────────

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);   // Railway / Cloudflare sit in front of us


// ─────────────────────────────────────────────────────────────────────────────
// 2. CORE MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy:   { policy: 'same-origin-allow-popups' },
}));

// CORS — web origins + chrome extension allow-list
const extraCorsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);   // Postman / Railway health checks
    const allowed = [
      'http://localhost:3000',
      'https://action-crm.vercel.app',
      'https://app.gowarmcrm.com',
      ...extraCorsOrigins,
    ];
    if (allowed.includes(origin))                 return cb(null, true);
    if (origin.startsWith('chrome-extension://')) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials:    true,
  methods:        ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-GoWarm-Extension-Key'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 600,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Extension secret-key guard. Chrome-extension origins must pass a header
// check on top of the CORS allow. Preflights bypass — the actual request
// hits this guard.
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  const origin = req.headers.origin || '';
  if (!origin.startsWith('chrome-extension://')) return next();

  const key      = req.headers['x-gowarm-extension-key'];
  const expected = process.env.EXTENSION_API_KEY;
  if (!key || key !== expected) {
    return res.status(403).json({ error: { message: 'Unauthorized extension' } });
  }
  return next();
});

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 2000,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: (req, res) => res.status(429).json({
    success: false,
    error: { message: 'Too many requests. Please try again later.', code: 'RATE_LIMIT_EXCEEDED' },
  }),
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      20,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: (req, res) => res.status(429).json({
    success: false,
    error: { message: 'Too many login attempts. Please try again in 15 minutes.', code: 'AUTH_RATE_LIMIT_EXCEEDED' },
  }),
});
// Insights/WBR Phase 7 — PUBLIC tracking endpoints (pixel + click redirect).
// Hit by recipients' mail clients via per-customer tracking hostnames, so
// they must sit OUTSIDE the /api rate-limiter and auth chain. Security is
// the HMAC token, not auth — see routes/tracking.routes.js header.
app.use('/t', require('./routes/tracking.routes'));

app.use('/api/',      apiLimiter);
app.use('/api/auth/', authLimiter);

// Raw-body capture for /webhooks/* (Zoom/transcript webhooks need raw bytes
// for signature verification). Twilio webhooks are at /api/twilio/webhooks/*
// and do NOT match this prefix, so they pass through the normal urlencoded
// parser below — which is what Twilio's signature validator expects.
app.use((req, res, next) => {
  if (!req.path.startsWith('/webhooks/')) return next();
  // Cap the accumulated body. Without this, a large POST to any /webhooks/...
  // path buffers unbounded in memory before signature verification can reject
  // it. 1MB is generous for transcript/event payloads; abort past it.
  const MAX_WEBHOOK_BYTES = 1024 * 1024; // 1 MB
  let data = '';
  let bytes = 0;
  let aborted = false;
  req.setEncoding('utf8');
  req.on('data', chunk => {
    if (aborted) return;
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > MAX_WEBHOOK_BYTES) {
      aborted = true;
      res.status(413).json({ error: { message: 'Payload too large' } });
      req.destroy();
      return;
    }
    data += chunk;
  });
  req.on('end', () => {
    if (aborted) return;
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch { req.body = {}; }
    next();
  });
});

// Body parsers — raised to 5MB to support bulk CSV import (the prospects/bulk
// endpoint accepts up to 500 prospects per call, which can exceed Express's
// default 100KB limit for rows with multi-field data + LinkedIn URLs).
// 5MB is generous; the row-count cap (500) is the operative ceiling.
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

if (process.env.NODE_ENV === 'development') app.use(morgan('dev'));


// ─────────────────────────────────────────────────────────────────────────────
// 3. HEALTH + PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});


// ─────────────────────────────────────────────────────────────────────────────
// 4. API ROUTES — grouped by domain
//
// Every router is mounted at a SPECIFIC prefix. There is intentionally NO
// bare `/api` catch-all mount: a previous one (dealHealth) silently swallowed
// every unmatched /api/* request into its auth-gated router, repeatedly
// breaking public webhook routes. Keep it this way — every new router gets
// its own specific prefix, and mount order is not load-bearing.
// ─────────────────────────────────────────────────────────────────────────────

// ── Skills & runs ────────────────────────────────────────────────────────
// skill-context.routes.js was retired in the 2026 skills integration — skill
// context is now built in-process by SkillContextService, called directly by
// SkillRunnerService. No HTTP hop, no shared-secret auth.
app.use('/api/skills',     require('./routes/skills.routes'));
app.use('/api/skill-runs', require('./routes/skill-runs.routes'));
app.use('/api/prospecting-config', require('./routes/prospecting-config.routes'));

app.use('/api/prospecting-wbr',      require('./routes/prospecting-wbr.routes'));
app.use('/api/prospecting-insights', require('./routes/prospecting-insights.routes'));
app.use('/api/tracking-domains',     require('./routes/tracking-domains.routes')); // Insights/WBR Phase 7
app.use('/api/custom-fields',        require('./routes/custom-fields.routes'));

// ── Core CRM ──────────────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth.routes'));
app.use('/api/actions',       require('./routes/actions.routes'));
app.use('/api/deals',         require('./routes/deals.routes'));
app.use('/api/contacts',      require('./routes/contacts.routes'));
app.use('/api/accounts',      require('./routes/accounts.routes'));
app.use('/api/emails',        require('./routes/emails.routes'));
app.use('/api/meetings',      require('./routes/meetings.routes'));
app.use('/api/proposals',     require('./routes/proposals.routes'));
app.use('/api/calendar',      require('./routes/calendar.routes'));
app.use('/api/dashboard',     require('./routes/dashboard.routes'));
app.use('/api/agent',         require('./routes/agent.routes'));
app.use('/api/agent-auth',         require('./routes/agent-auth.routes'));

// ── Reporting (cross-campaign manager dashboards) ─────────────────────────
// Phase 2 of the sequence reporting feature. Read-only aggregation
// endpoints that resolve "who can this viewer see" via
// services/ReportingScopeService, then aggregate sequence_step_logs
// and sequence_enrollments scoped to the resolved user IDs. See
// docs/SEQUENCE_REPORTING_DESIGN.md for the full design.
app.use('/api/reporting',     require('./routes/reporting.routes'));

// ── External integrations ────────────────────────────────────────────────
app.use('/api/outlook',       require('./routes/outlook.routes'));
app.use('/api/google',        require('./routes/google.routes'));
app.use('/api/sync',          require('./routes/sync.routes'));
app.use('/api/ai',            require('./routes/ai.routes'));
app.use('/api/prompts',       require('./routes/prompts.routes'));
app.use('/api/salesforce',    require('./routes/salesforce.routes'));
app.use('/api/hubspot',       require('./routes/hubspot.routes'));


app.use('/api/org/admin/ai',    require('./routes/ai-admin.routes'));
app.use('/api/me/ai',           require('./routes/ai-user.routes'));
app.use('/api/super-admin/ai',  require('./routes/ai-platform.routes'));

// ── Twilio webhooks (Phase 3) ─────────────────────────────────────────────
// Public — NO auth middleware. Each route validates the Twilio signature.
//
// Historical note: dealHealth.routes used to be mounted at a bare `/api`,
// which made it a catch-all — ANY /api/* request not matched by a more
// specific mount fell into dealHealth's router, hit its `router.use(auth)`,
// and got 401'd. That repeatedly broke these webhooks (Twilio sends no JWT).
// dealHealth is now mounted at the specific /api/deal-health prefix below,
// so the catch-all hazard is gone. Mount order here is no longer load-
// bearing — but keeping webhooks grouped with the other integrations is
// still tidy.
app.use('/api/twilio/webhooks', require('./routes/twilio-webhooks.routes'));

// Deal health — mounted at a SPECIFIC prefix (was a bare `/api` catch-all,
// which silently swallowed unmatched /api/* requests; see note above).
app.use('/api/deal-health',   require('./routes/dealHealth.routes'));

// ── Storage / Admin ───────────────────────────────────────────────────────
app.use('/api/storage',       require('./routes/storage.routes'));
app.use('/api/super',         require('./routes/superAdmin.routes'));
app.use('/api/org/admin',     require('./routes/orgAdmin.routes'));
app.use('/api/org/admin',     require('./routes/teams.routes'));

// ── Playbooks ─────────────────────────────────────────────────────────────
app.use('/api/playbooks',              require('./routes/playbookBuilder.routes'));
app.use('/api/playbook-registrations', require('./routes/playbookRegistrations.routes'));
app.use('/api/playbooks',              require('./routes/playbooks.routes'));   // legacy stage-guidance
app.use('/api/ai',                     require('./routes/ai-context.routes'));
app.use('/api/org-roles',              require('./routes/org-roles.routes'));
app.use('/api/deal-roles',             require('./routes/org-roles.routes'));
app.use('/api/deal-team',              require('./routes/deal-team.routes'));
app.use('/api/deal-contacts',          require('./routes/deal-contacts.routes'));
app.use('/api/straps',                 require('./routes/strap.routes'));
app.use('/api/products',               require('./routes/products.routes'));
app.use('/api/pipeline-stages',        require('./routes/pipeline-stages.routes'));
app.use('/api/playbook-plays',         require('./routes/playbook-plays.routes'));
app.use('/api/deal-plays',             require('./routes/deal-plays.routes'));

// ── Prospecting ───────────────────────────────────────────────────────────
app.use('/api/prospects',             require('./routes/prospects.routes'));
app.use('/api/prospecting-campaigns', require('./routes/prospecting-campaigns.routes'));
app.use('/api/prospecting-actions',   require('./routes/prospecting-actions.routes'));
app.use('/api/accounts',            require('./routes/account-prospecting.routes'));
app.use('/api/actions',             require('./routes/unified-actions.routes'));
app.use('/api/prospect-context',    require('./routes/prospect-context.routes'));
app.use('/api/org-hierarchy',       require('./routes/orgHierarchy.routes'));
app.use('/api/team-notifications',  require('./routes/teamNotifications.routes'));
app.use('/api/users/me',            require('./routes/user-preferences.routes'));
app.use('/api/users/me',            require('./routes/user-phone.routes'));   // Phase 3 — rep phone
app.use('/api/linkedin-profiles',   require('./routes/linkedin-profiles.routes'));
// Bulk LinkedIn connection-acceptance sync from the Chrome extension
// ("Check & update sent / accepted" popup buttons). Seat-bound + owner-scoped.
app.use('/api/linkedin-connections', require('./routes/linkedin-connections.routes'));
// Optional, opt-in LinkedIn connection-request auto-send.
//   linkedin-autosend  → extension actuator surface (claim / confirm / report-failure)
//   linkedin-automation → settings surface (org toggle+caps, per-user opt-in)
app.use('/api/linkedin-autosend',    require('./routes/linkedin-autosend.routes'));
app.use('/api',                      require('./routes/linkedin-automation.routes'));

// Calls.
//   Phase 3 (Twilio: /initiate, /:id/status) mounted FIRST so its specific
//   paths match before the Phase 1+2 catch-all GET /:id.
//   Phase 1+2 (manual log POST /, GET list, GET /inbox, GET /scan-stale,
//   GET /:id, PATCH /:id) handles everything else.
app.use('/api/prospect-calls',      require('./routes/prospect-calls-twilio.routes'));
app.use('/api/prospect-calls',      require('./routes/prospect-calls.routes'));
app.use('/api/prospect-phones',     require('./routes/prospect-phones.routes'));
app.use('/api/org/call-settings',   require('./routes/org-call-settings.routes'));

// Prospecting Phase 2
app.use('/api/prospecting-senders', require('./routes/prospecting-senders.routes'));
app.use('/api/org/outreach-limits', require('./routes/outreach-limits.routes'));
// Slice 2: per-rep activation target (lives next to outreach-limits since
// they're conceptually paired — org ceiling + per-user override).
app.use('/api/me/activation-target', require('./routes/user-activation-target.routes'));
app.use('/api/prospecting/inbox',   require('./routes/prospecting-inbox.routes'));
app.use('/api/prospecting/activity', require('./routes/prospecting-activity.routes'));

// ── Twilio (Phase 3) ──────────────────────────────────────────────────────
// Admin endpoints — DID provisioning per rep, org status, available numbers.
// Owner/admin only (role enforced inside the routes file).
app.use('/api/org/admin/twilio', require('./routes/org-twilio.routes'));

// Browser dialing (Voice JS SDK v2): mints per-org subaccount access tokens.
app.use('/api/twilio/voice',     require('./routes/twilio-voice.routes'));

// Rep self-serve: personal phone for the Twilio outbound flow.
app.use('/api/users/me/phone',   require('./routes/user-phone.routes'));

// ── CLM, Handover, Support, Sequences, Agency ────────────────────────────
app.use('/api/contracts',       require('./routes/contracts.routes'));
app.use('/api/team-dimensions', require('./routes/team-dimensions.routes'));
app.use('/api/account-teams',   require('./routes/account-teams.routes'));
app.use('/api/handovers',       require('./routes/handovers.routes'));
app.use('/api/support',         require('./routes/support.routes'));
app.use('/api/sequences',       require('./routes/sequences.routes'));
app.use('/api/clients',         require('./routes/clients.routes'));
app.use('/api/portal',          require('./routes/client-portal.routes'));

// ── Workflow ──────────────────────────────────────────────────────────────
app.use('/api/super',     require('./routes/workflow.superAdmin.routes'));
app.use('/api/org/admin', require('./routes/workflow.orgAdmin.routes'));

// ── External webhooks (Zoom transcripts, etc.) ────────────────────────────
// Note: /webhooks/* (no /api/ prefix) — see raw-body capture above.
app.use('/webhooks/transcript', require('./routes/webhooks.routes'));
app.use('/api/transcripts',     require('./routes/transcripts.routes'));

// ── Misc ──────────────────────────────────────────────────────────────────
app.use('/api/action-config',   require('./routes/action-config.routes'));
app.use('/api/extension', require('./routes/extension.routes'));

// ── Public org context ────────────────────────────────────────────────────
const authenticateToken = require('./middleware/auth.middleware');
const { orgContext }    = require('./middleware/orgContext.middleware');
const { pool }          = require('./config/database');
app.get('/api/org/context', authenticateToken, orgContext, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT settings->'modules' AS modules FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const raw = r.rows[0]?.modules || {};
    // Normalize legacy scalar AND new {allowed, enabled} shapes onto a bool.
    const modules = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => {
        if (v !== null && typeof v === 'object') return [k, !!v.enabled];
        return [k, v === true || v === 'true' || v === 1 || v === '1'];
      })
    );
    res.json({ modules });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load org context' } });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// 4b. MCP SERVER (agent access) — mounted BEFORE the 404 handler
//
// mcp-server.mjs is ESM (the MCP SDK and jose are ESM-only), so it cannot be
// require()'d from this CommonJS file. We mount an empty router now — its
// position in the stack is fixed, ahead of the 404 below — and populate it via
// dynamic import a few ms later at boot. Adds /mcp plus the two OAuth discovery
// routes (/.well-known/oauth-protected-resource and /.well-known/oauth-authorization-server).
// ─────────────────────────────────────────────────────────────────────────────

const mcpRouter = express.Router();
app.use('/', mcpRouter);
import('./mcp-server.mjs')
  .then(({ registerMcp }) => {
    registerMcp(mcpRouter);
    console.log('✅ MCP server mounted at /mcp');
  })
  .catch(err => console.error('❌ MCP mount failed:', err.message));


// ─────────────────────────────────────────────────────────────────────────────
// 5. ERROR HANDLERS — must be last
// ─────────────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: { message: 'Route not found' } });
});

app.use((err, req, res, next) => {
  // Always log the full detail server-side (Railway logs).
  console.error('Error:', err.stack || err.message || err);

  const isDev = process.env.NODE_ENV === 'development';
  const status = err.status || 500;

  // In production, do NOT leak err.message to the client — it can expose
  // internals (body-parser errors, CORS rejections like "CORS blocked: <origin>",
  // anything thrown past a handler). Return a generic message and keep the
  // detail in the server log above. Dev keeps message + stack for debugging.
  res.status(status).json({
    error: {
      message: isDev ? (err.message || 'Internal server error') : 'Internal server error',
      ...(isDev && { stack: err.stack }),
    },
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 6. BOOT — listen + cron + Twilio config check
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║     GoWarm CRM API Server             ║`);
  console.log(`║     Port: ${String(PORT).padEnd(28)}║`);
  console.log(`║     Env:  ${(process.env.NODE_ENV || 'development').padEnd(28)}║`);
  console.log(`╚═══════════════════════════════════════╝\n`);

  // ── Bull queue worker ───────────────────────────────────────────────────
  try {
    require('./jobs/worker');
    console.log('✅ Bull queue worker initialized');
  } catch (err) {
    console.error('❌ Bull worker failed to start — queue processing disabled:', err.message);
  }

  // ── Twilio (Phase 3) config check ───────────────────────────────────────
  // Non-fatal. Phase 1+2 manual call logging keeps working without Twilio;
  // only /api/prospect-calls/initiate returns 503 when missing.
  try {
    const TwilioProvider = require('./services/twilioProvider.service');
    const cfg = TwilioProvider.validateConfig();
    console.log('🔌 Twilio configured:', cfg);
  } catch (err) {
    console.warn('⚠️  Twilio NOT configured —', err.message);
  }

  // ── Cron jobs ───────────────────────────────────────────────────────────
  try {
    const cron = require('node-cron');
    require('./jobs/modelDiscoveryScheduler').startScheduler();

    // Hourly: expire stale agent proposals
    cron.schedule('0 * * * *', async () => {
      try {
        const count = await require('./services/AgentProposalService').expireStale();
        if (count > 0) console.log(`🕐 Cron: expired ${count} stale agent proposals`);
      } catch (err) {
        console.error('🕐 Cron expireStale error:', err.message);
      }
    });

    // Hourly: expire CLM contracts
    cron.schedule('0 * * * *', async () => {
      try {
        const count = await require('./services/contractService').expireContracts();
        if (count > 0) console.log(`📄 CLM Cron: expired ${count} contracts`);
      } catch (err) {
        console.error('📄 CLM Cron expireContracts error:', err.message);
      }
    });

    // Daily 09:00: CLM contract notifications (unsigned + expiring)
    cron.schedule('0 9 * * *', async () => {
      try {
        const NS = require('./services/contractNotificationService');
        const [unsigned, expiring] = await Promise.all([
          NS.notifyUnsignedContracts(),
          NS.notifyExpiringContracts(),
        ]);
        console.log(`📄 CLM Cron: ${unsigned} unsigned follow-ups, ${expiring} expiry warnings sent`);
      } catch (err) {
        console.error('📄 CLM Cron notification error:', err.message);
      }
    });

    // Every 1 min: fire due sequence steps. The real send throttle is the
    // per-sender min-delay cooldown (default 5 min) inside fireDueSteps —
    // each tick sends at most one email per sender, so the cron must run
    // MORE often than the cooldown for the cooldown to be the binding limit.
    cron.schedule('* * * * *', async () => {
      try {
        const { fired, stopped, errors } = await require('./services/SequenceStepFirer').fireDueSteps();
        if (fired > 0 || stopped > 0) {
          console.log(`📨 Sequences Cron: ${fired} fired, ${stopped} auto-stopped, ${errors} errors`);
        }
      } catch (err) {
        console.error('📨 Sequences Cron error:', err.message);
      }
    });

    // Every 5 min: reclaim expired LinkedIn auto-send leases back to 'scheduled'.
    // A 'sending' linkedin row whose lease_expires_at has passed means the rep's
    // browser went away before the extension confirmed the click; re-offering it
    // is safe (the extension confirms immediately after a successful Connect, so
    // an expired lease almost always means the click never happened). This is the
    // safe counterpart to the email reaper, which is scoped to channel='email'
    // precisely so it never fail+pauses one of these leases.
    cron.schedule('*/5 * * * *', async () => {
      try {
        const { pool } = require('./config/database');
        const { reclaimed } = await require('./services/LinkedInAutoSendService').reclaimExpiredLeases(pool);
        if (reclaimed > 0) {
          console.log(`🔗 LinkedIn auto-send Cron: reclaimed ${reclaimed} expired lease(s)`);
        }
      } catch (err) {
        console.error('🔗 LinkedIn auto-send reclaim Cron error:', err.message);
      }
    });

    // Weekly (Mon 14:00 UTC): nudge reps whose LinkedIn connection data is stale
    // to run a manual "Check & update". Server-side reminder only — never opens
    // LinkedIn or polls Voyager (see LinkedInRefreshNudge for why).
    cron.schedule('0 14 * * 1', async () => {
      try {
        const { pool } = require('./config/database');
        const { inserted } = await require('./services/LinkedInRefreshNudge').nudgeStaleSeats(pool);
        if (inserted > 0) {
          console.log(`🔗 LinkedIn refresh-nudge Cron: ${inserted} nudge(s) created`);
        }
      } catch (err) {
        console.error('🔗 LinkedIn refresh-nudge Cron error:', err.message);
      }
    });

    // Nightly 04:30 UTC: Salesforce write-back (30 min after inbound sync)
    cron.schedule('30 4 * * *', async () => {
      try {
        const { runNightlyWriteBack } = require('./services/crm/writeBack');
        const result = await runNightlyWriteBack();
        if (result.pushed > 0 || result.errors > 0) {
          console.log(`📤 WriteBack Cron: ${result.orgs} orgs, ${result.pushed} pushed, ${result.errors} errors`);
        }
      } catch (err) {
        console.error('📤 WriteBack Cron error:', err.message);
      }
    });

    // Every 30 min: flag Twilio calls stuck in non-terminal status
    // (initiated/ringing/in_progress) past the org's stuck_call_window_hours
    // (default 2h). Catches cases where Twilio status webhooks never fired.
    cron.schedule('*/30 * * * *', async () => {
      try {
        const { scanAndFlag } = require('./services/stuckCallCleanup.service');
        const result = await scanAndFlag();
        if (result.flagged > 0 || result.errors > 0) {
          console.log(`📞 StuckCall Cron: ${result.orgs} orgs scanned, ${result.flagged} flagged, ${result.errors} errors (${result.ms}ms)`);
        }
      } catch (err) {
        console.error('📞 StuckCall Cron error:', err.message);
      }
    });

    // Daily 09:00 UTC: campaign SLA sweeps (Slice 2). Inserts rolled-up
    // prospecting_actions for campaigns whose research-stage or target-stage
    // backlog is older than the org's configured SLA window.
    cron.schedule('0 9 * * *', async () => {
      try {
        const { syncOverdueActivations, syncOverdueResearch } =
          require('./services/CampaignSweeps');
        const [a, r] = await Promise.all([
          syncOverdueActivations(),
          syncOverdueResearch(),
        ]);
        const total = (a.inserted || 0) + (r.inserted || 0);
        if (total > 0) {
          console.log(`📍 CampaignSweeps Cron: activations ${a.inserted}/${a.scanned}, research ${r.inserted}/${r.scanned}`);
        }
      } catch (err) {
        console.error('📍 CampaignSweeps Cron error:', err.message);
      }
    });


    console.log('✅ Cron jobs initialized (proposals hourly, CLM hourly+daily, sequences 1m, SF write-back 04:30 UTC, stuck calls 30m, campaign SLA 09:00 UTC)');
  } catch (err) {
    console.error('⚠️  Failed to initialize cron jobs:', err.message);
  }
});

module.exports = app;
