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
const outlookRoutes    = require('./routes/outlook.routes');
const googleRoutes     = require('./routes/google.routes');
const syncRoutes       = require('./routes/sync.routes');
const playbookRoutes   = require('./routes/playbook.routes');
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
const dealStagesRoutes = require('./routes/deal-stages.routes');
const prospectStagesRoutes = require('./routes/prospect-stages.routes');

// STRAP Framework
const strapRoutes = require('./routes/strap.routes');

// Playbook Plays (role-based)
const playbookPlaysRoutes = require('./routes/playbook-plays.routes');
const dealPlaysRoutes     = require('./routes/deal-plays.routes');

// Org Hierarchy (Feature 2 — contact reporting structure + account parent/subsidiary)
const orgHierarchyRoutes = require('./routes/orgHierarchy.routes');

// Feature 1 — Team Notifications (inbox + preferences + triggers — single route file)
const teamNotificationsRoutes = require('./routes/teamNotifications.routes');

// Prospecting Module
const prospectsRoutes           = require('./routes/prospects.routes');
const prospectingActionsRoutes  = require('./routes/prospecting-actions.routes');
const accountProspectingRoutes  = require('./routes/account-prospecting.routes');
const unifiedActionsRoutes      = require('./routes/unified-actions.routes');
const prospectContextRoutes     = require('./routes/prospect-context.routes');
const teamsRoutes               = require('./routes/teams.routes');

// Product Catalog + Deal Products
const productsRoutes = require('./routes/products.routes');

// CLM — Contract Lifecycle Management
const contractsRoutes = require('./routes/contracts.routes');

// ─────────────────────────────────────────────────────────────
// Middleware imports
// auth middleware is used inside individual route files.
// orgContext is also used inside route files — NOT globally here
// because auth.routes.js (login/register) must never have it.
//
// Importing here just so it's accessible and so Railway can
// fail fast at startup if the file is missing.
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
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// ─────────────────────────────────────────────────────────────
// Health check (no auth, no org context needed)
// ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────
// API Routes
//
// Pattern for multi-org routes:
//   Each route FILE is responsible for applying:
//     1. authenticateToken  — verifies JWT
//     2. orgContext         — resolves + validates org_id → req.orgId
//   on every handler that touches org-scoped data.
//
//   auth.routes.js is the ONE exception — login/register/verify
//   do NOT use orgContext (user has no token yet).
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
app.use('/api/playbook',  playbookRoutes);
app.use('/api/ai',        aiRoutes);
app.use('/api/prompts',   promptsRoutes);
app.use('/api',           dealHealthRoutes);
app.use('/api/storage',   storageRoutes);
app.use('/api/super',      superAdminRoutes);
app.use('/api/org/admin',  orgAdminRoutes);
app.use('/api/org/admin',  teamsRoutes);        // Teams & team memberships
app.use('/api/playbooks',  playbooksRoutes);
app.use('/api/ai',         aiContextRoutes);
app.use('/api/org-roles',  orgRolesRoutes);
app.use('/api/deal-roles', orgRolesRoutes);     // backward compat alias
app.use('/api/deal-team',  dealTeamRoutes);
app.use('/api/deal-contacts', dealContactsRoutes);
app.use('/api/deal-stages',   dealStagesRoutes);
app.use('/api/straps',        strapRoutes);     // STRAP Framework
app.use('/api/prospect-stages', prospectStagesRoutes);
app.use('/api/products',        productsRoutes); // Product Catalog + Deal Line Items

const pipelineStagesRoutes = require('./routes/pipeline-stages.routes');
app.use('/api/pipeline-stages', pipelineStagesRoutes);

// ─── Playbook Plays (role-based) ─────────────────────────────
app.use('/api/playbook-plays', playbookPlaysRoutes);  // Play definitions (admin CRUD)
app.use('/api/deal-plays',     dealPlaysRoutes);       // Deal play instances (execution)

// ─── Prospecting Module ──────────────────────────────────────
app.use('/api/prospects',           prospectsRoutes);
app.use('/api/prospecting-actions', prospectingActionsRoutes);
app.use('/api/accounts',            accountProspectingRoutes); // /:id/prospecting, /:id/coverage
app.use('/api/actions',             unifiedActionsRoutes);     // /unified
app.use('/api/prospect-context',    prospectContextRoutes);    // /:prospectId, /icp-config/current
app.use('/api/org-hierarchy',       orgHierarchyRoutes);       // Feature 2: contact org chart + account hierarchy
app.use('/api/team-notifications',  teamNotificationsRoutes);  // Feature 1: team notifications

// ─── CLM — Contract Lifecycle Management ─────────────────────
app.use('/api/contracts', contractsRoutes);

// ─── Public org context — accessible to ALL authenticated members ─────────
// Returns org module flags so the frontend can gate UI without an admin call.
const authenticateToken   = require('./middleware/auth.middleware');
const { orgContext }      = require('./middleware/orgContext.middleware');
const { pool: ctxPool }   = require('./config/database');
app.get('/api/org/context', authenticateToken, orgContext, async (req, res) => {
  try {
    const r = await ctxPool.query(
      `SELECT settings->'modules' AS modules FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const modules = r.rows[0]?.modules || {};
    res.json({ modules });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load org context' } });
  }
});

// ─────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    }
  });
});

app.use((req, res) => {
  res.status(404).json({ error: { message: 'Route not found' } });
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

  console.log('🚨 DEPLOY CHECK v2 — if you see this, new code is live');
  console.log('🚀 Starting Bull queue worker...');
  try {
    require('./jobs/worker');
    console.log('✅ Bull queue worker initialized');
  } catch (error) {
    console.error('❌ Failed to start Bull worker:', error.message);
    console.error('   Queue processing will not work!');
  }

  // ─────────────────────────────────────────────────────────────
  // Cron jobs
  // Install: npm install node-cron
  // ─────────────────────────────────────────────────────────────
  try {
    const cron = require('node-cron');
    const AgentProposalService = require('./services/AgentProposalService');

    // Every hour: expire agent proposals past their expires_at date
    cron.schedule('0 * * * *', async () => {
      try {
        const count = await AgentProposalService.expireStale();
        if (count > 0) {
          console.log(`🕐 Cron: expired ${count} stale agent proposals`);
        }
      } catch (err) {
        console.error('🕐 Cron: expireStale error:', err.message);
      }
    });

    // CLM — Every hour: expire active contracts past their expiry_date
    cron.schedule('0 * * * *', async () => {
      try {
        const count = await require('./services/contractService').expireContracts();
        if (count > 0) console.log(`📄 CLM Cron: expired ${count} contracts`);
      } catch (err) {
        console.error('📄 CLM Cron: expireContracts error:', err.message);
      }
    });

    // CLM — Daily 9am: unsigned follow-ups + expiry warnings
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

    console.log('✅ Agentic framework cron jobs initialized (proposal expiry: hourly)');
    console.log('✅ CLM cron jobs initialized (contract expiry: hourly, notifications: daily 9am)');
  } catch (error) {
    console.error('⚠️  Failed to initialize cron jobs:', error.message);
    console.error('   Install node-cron: npm install node-cron');
    console.error('   Proposals will not auto-expire until this is resolved.');
  }
});

module.exports = app;
