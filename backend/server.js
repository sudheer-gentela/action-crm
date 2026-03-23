const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────────────────────
// Route imports
// ─────────────────────────────────────────────────────────────
const webhookTranscriptRoutes = require('./routes/webhooks.routes');
const outlookRoutes    = require('./routes/outlook.routes');
const googleRoutes     = require('./routes/google.routes');
const syncRoutes       = require('./routes/sync.routes');
const aiRoutes         = require('./routes/ai.routes');
const promptsRoutes    = require('./routes/prompts.routes');
const dealHealthRoutes = require('./routes/dealHealth.routes');
const storageRoutes    = require('./routes/storage.routes');
const superAdminRoutes  = require('./routes/superAdmin.routes');
const orgAdminRoutes    = require('./routes/orgAdmin.routes');
const playbooksRoutes   = require('./routes/playbooks.routes');
const aiContextRoutes  = require('./routes/ai-context.routes');
const orgRolesRoutes   = require('./routes/org-roles.routes');
const dealTeamRoutes   = require('./routes/deal-team.routes');
const dealContactsRoutes = require('./routes/deal-contacts.routes');
// deal-stages and prospect-stages removed — consolidated into pipeline-stages

// STRAP Framework
const strapRoutes = require('./routes/strap.routes');

// Playbook Plays (role-based)
const playbookPlaysRoutes = require('./routes/playbook-plays.routes');
const dealPlaysRoutes     = require('./routes/deal-plays.routes');

// Org Hierarchy
const orgHierarchyRoutes = require('./routes/orgHierarchy.routes');

// Team Notifications
const teamNotificationsRoutes = require('./routes/teamNotifications.routes');

// Prospecting Module
const prospectsRoutes           = require('./routes/prospects.routes');
const prospectingActionsRoutes  = require('./routes/prospecting-actions.routes');
const accountProspectingRoutes  = require('./routes/account-prospecting.routes');
const unifiedActionsRoutes      = require('./routes/unified-actions.routes');
const prospectContextRoutes     = require('./routes/prospect-context.routes');
const teamsRoutes               = require('./routes/teams.routes');
const userPreferencesRoutes     = require('./routes/user-preferences.routes');

// ── Prospecting Phase 2 routes ────────────────────────────────
const prospectingSendersRoutes  = require('./routes/prospecting-senders.routes');
const outreachLimitsRoutes      = require('./routes/outreach-limits.routes');
const prospectingInboxRoutes    = require('./routes/prospecting-inbox.routes');

// Product Catalog + Deal Products
const productsRoutes = require('./routes/products.routes');

// CLM — Contract Lifecycle Management
const contractsRoutes = require('./routes/contracts.routes');

// ── Handover Module ───────────────────────────────────────────
const teamDimensionsRoutes = require('./routes/team-dimensions.routes');
const accountTeamsRoutes   = require('./routes/account-teams.routes');
const handoversRoutes      = require('./routes/handovers.routes');

// ── Service / Customer Support Module ────────────────────────
const supportRoutes = require('./routes/support.routes');

// ── Sequences (Prospecting Phase 3) ──────────────────────────
const sequencesRoutes = require('./routes/sequences.routes');

// ── Agency / Client Module ────────────────────────────────────
const clientsRoutes      = require('./routes/clients.routes');
const clientPortalRoutes = require('./routes/client-portal.routes');

// ─────────────────────────────────────────────────────────────
// Middleware imports
// ─────────────────────────────────────────────────────────────
require('./middleware/auth.middleware');
require('./middleware/orgContext.middleware');
require('./middleware/superAdmin.middleware');
require('./middleware/requireModule.middleware');

// Trust Railway proxy
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy:   { policy: "same-origin-allow-popups" }
}));

// CORS configuration
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://action-crm.vercel.app',
    process.env.CORS_ORIGIN
  ].filter(Boolean),
  credentials:     true,
  methods:         ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders:  ['Content-Type', 'Authorization'],
  exposedHeaders:  ['Content-Range', 'X-Content-Range'],
  maxAge: 600
}));

// ─────────────────────────────────────────────────────────────
// Rate limiting
// ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 2000,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: { message: 'Too many requests. Please try again later.', code: 'RATE_LIMIT_EXCEEDED' }
    });
  }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      20,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: { message: 'Too many login attempts. Please try again in 15 minutes.', code: 'AUTH_RATE_LIMIT_EXCEEDED' }
    });
  }
});

app.use('/api/',      limiter);
app.use('/api/auth/', authLimiter);

// ─────────────────────────────────────────────────────────────
// Body parsing & logging
// ─────────────────────────────────────────────────────────────

// Capture raw body for webhook signature verification (Zoom requires this)
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks/')) {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      req.rawBody = data;
      try {
        req.body = JSON.parse(data);
      } catch (e) {
        req.body = {};
      }
      next();
    });
  } else {
    next();
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// ─────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth.routes'));
app.use('/api/actions',   require('./routes/actions.routes'));
app.use('/api/deals',     require('./routes/deals.routes'));
app.use('/api/contacts',  require('./routes/contacts.routes'));
app.use('/api/accounts',  require('./routes/accounts.routes'));
app.use('/api/emails',    require('./routes/emails.routes'));
app.use('/api/meetings',  require('./routes/meetings.routes'));
app.use('/api/proposals', require('./routes/proposals.routes'));
app.use('/api/calendar',  require('./routes/calendar.routes'));
app.use('/api/dashboard', require('./routes/dashboard.routes'));
app.use('/api/agent',     require('./routes/agent.routes'));
app.use('/api/outlook',   outlookRoutes);
app.use('/api/google',    googleRoutes);
app.use('/api/sync',      syncRoutes);
app.use('/api/ai',        aiRoutes);
app.use('/api/prompts',   promptsRoutes);
app.use('/api',           dealHealthRoutes);
app.use('/api/storage',   storageRoutes);
app.use('/api/super',      superAdminRoutes);
app.use('/api/org/admin',  orgAdminRoutes);
app.use('/api/org/admin',  teamsRoutes);
app.use('/api/playbooks',  playbooksRoutes);
app.use('/api/ai',         aiContextRoutes);
app.use('/api/org-roles',  orgRolesRoutes);
app.use('/api/deal-roles', orgRolesRoutes);
app.use('/api/deal-team',  dealTeamRoutes);
app.use('/api/deal-contacts', dealContactsRoutes);
app.use('/api/straps',        strapRoutes);
app.use('/api/products',      productsRoutes);

const pipelineStagesRoutes = require('./routes/pipeline-stages.routes');
app.use('/api/pipeline-stages', pipelineStagesRoutes);

// ─── Playbook Plays ───────────────────────────────────────────
app.use('/api/playbook-plays', playbookPlaysRoutes);
app.use('/api/deal-plays',     dealPlaysRoutes);

// ─── Prospecting Module ───────────────────────────────────────
app.use('/api/prospects',           prospectsRoutes);
app.use('/api/prospecting-actions', prospectingActionsRoutes);
app.use('/api/accounts',            accountProspectingRoutes);
app.use('/api/actions',             unifiedActionsRoutes);
app.use('/api/prospect-context',    prospectContextRoutes);
app.use('/api/org-hierarchy',       orgHierarchyRoutes);
app.use('/api/team-notifications',  teamNotificationsRoutes);
app.use('/api/users/me',            userPreferencesRoutes);

// ── Prospecting Phase 2 ───────────────────────────────────────
app.use('/api/prospecting-senders', prospectingSendersRoutes);
app.use('/api/org/outreach-limits', outreachLimitsRoutes);
app.use('/api/prospecting/inbox',   prospectingInboxRoutes);

// ─── CLM ──────────────────────────────────────────────────────
app.use('/api/contracts', contractsRoutes);

// ─── Handover Module ──────────────────────────────────────────
app.use('/api/team-dimensions', teamDimensionsRoutes);
app.use('/api/account-teams',   accountTeamsRoutes);
app.use('/api/handovers',       handoversRoutes);

// ─── Service / Customer Support Module ───────────────────────
app.use('/api/support', supportRoutes);

// ─── Sequences (Prospecting Phase 3) ─────────────────────────
app.use('/api/sequences', sequencesRoutes);

// ─── Agency / Client Module ───────────────────────────────────
app.use('/api/clients', clientsRoutes);
app.use('/api/portal',  clientPortalRoutes);

// ─── Workflow Module ───────────────────────────────────
app.use('/api/super',     require('./routes/workflow.superAdmin.routes'));
app.use('/api/org/admin', require('./routes/workflow.orgAdmin.routes'));

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 3B — Register webhook route (in the API routes section)
// ─────────────────────────────────────────────────────────────────────────────
app.use(''/webhooks/transcript', webhookTranscriptRoutes);
app.use('/api/transcripts', require('./routes/transcripts.routes'));


// ─── Public org context ───────────────────────────────────────
const authenticateToken   = require('./middleware/auth.middleware');
const { orgContext }      = require('./middleware/orgContext.middleware');
const { pool: ctxPool }   = require('./config/database');
app.get('/api/org/context', authenticateToken, orgContext, async (req, res) => {
  try {
    const r = await ctxPool.query(
      `SELECT settings->'modules' AS modules FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const raw = r.rows[0]?.modules || {};
    const modules = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, v === true || v === 'true' || v === 1 || v === '1'])
    );
    res.json({ modules });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load org context' } });
  }
});

// ─────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Route not found' } });
});

app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║     Action CRM API Server             ║
║     Running on port ${PORT}             ║
║     Environment: ${process.env.NODE_ENV || 'development'}      ║
╚═══════════════════════════════════════╝
  `);

  console.log('🚨 DEPLOY CHECK v8 — agency module: clients + portal routes mounted');
  console.log('🚀 Starting Bull queue worker...');
  try {
    require('./jobs/worker');
    console.log('✅ Bull queue worker initialized');
  } catch (error) {
    console.error('❌ Failed to start Bull worker:', error.message);
    console.error('   Queue processing will not work!');
  }

  try {
    const cron = require('node-cron');
    const AgentProposalService = require('./services/AgentProposalService');

    cron.schedule('0 * * * *', async () => {
      try {
        const count = await AgentProposalService.expireStale();
        if (count > 0) console.log(`🕐 Cron: expired ${count} stale agent proposals`);
      } catch (err) {
        console.error('🕐 Cron: expireStale error:', err.message);
      }
    });

    cron.schedule('0 * * * *', async () => {
      try {
        const count = await require('./services/contractService').expireContracts();
        if (count > 0) console.log(`📄 CLM Cron: expired ${count} contracts`);
      } catch (err) {
        console.error('📄 CLM Cron: expireContracts error:', err.message);
      }
    });

    cron.schedule('0 9 * * *', async () => {
      try {
        const NS = require('./services/contractNotificationService');
        const [unsigned, expiring] = await Promise.all([
          NS.notifyUnsignedContracts(),
          NS.notifyExpiringContracts(),
        ]);
        console.log(`📄 CLM Cron: ${unsigned} unsigned follow-ups, ${expiring} expiry warnings sent`);
      } catch (err) {
        console.error('📄 CLM Cron: notification error:', err.message);
      }
    });

    // ── Sequences: fire due steps every 15 minutes ────────────
    cron.schedule('*/15 * * * *', async () => {
      try {
        const SequenceStepFirer = require('./services/SequenceStepFirer');
        const { fired, stopped, errors } = await SequenceStepFirer.fireDueSteps();
        if (fired > 0 || stopped > 0) {
          console.log(`📨 Sequences Cron: ${fired} steps fired, ${stopped} auto-stopped on reply, ${errors} errors`);
        }
      } catch (err) {
        console.error('📨 Sequences Cron: error:', err.message);
      }
    });

    console.log('✅ Agentic framework cron jobs initialized (proposal expiry: hourly)');
    console.log('✅ CLM cron jobs initialized (contract expiry: hourly, notifications: daily 9am)');
    console.log('✅ Sequences cron initialized (fire due steps: every 15 min)');
  } catch (error) {
    console.error('⚠️  Failed to initialize cron jobs:', error.message);
    console.error('   Install node-cron: npm install node-cron');
  }
});

module.exports = app;
