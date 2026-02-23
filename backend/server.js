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
const dealRolesRoutes  = require('./routes/deal-roles.routes');
const dealTeamRoutes   = require('./routes/deal-team.routes');
const dealContactsRoutes = require('./routes/deal-contacts.routes');


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
//
// Migration status:
//   [x] auth.routes.js       — org_id in JWT, no orgContext needed
//   [ ] actions.routes.js    — next to update
//   [ ] deals.routes.js
//   [ ] contacts.routes.js
//   [ ] accounts.routes.js
//   [ ] emails.routes.js
//   [ ] meetings.routes.js
//   [ ] proposals.routes.js
//   [ ] calendar.routes.js
//   [ ] dashboard.routes.js
//   [ ] outlook.routes.js
//   [ ] sync.routes.js
//   [ ] playbook.routes.js
//   [ ] ai.routes.js
//   [ ] prompts.routes.js
//   [ ] dealHealth.routes.js
//   [ ] storage.routes.js
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
app.use('/api/outlook',   outlookRoutes);
app.use('/api/sync',      syncRoutes);
app.use('/api/playbook',  playbookRoutes);
app.use('/api/ai',        aiRoutes);
app.use('/api/prompts',   promptsRoutes);
app.use('/api',           dealHealthRoutes);
app.use('/api/storage',   storageRoutes);
app.use('/api/super',      superAdminRoutes);
app.use('/api/org/admin',  orgAdminRoutes);
app.use('/api/playbooks',  playbooksRoutes);
app.use('/api/ai',         aiContextRoutes);
app.use('/api/deal-roles', dealRolesRoutes);
app.use('/api/deal-team',  dealTeamRoutes);
app.use('/api/deal-contacts', dealContactsRoutes);

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

  console.log('🚀 Starting Bull queue worker...');
  try {
    require('./jobs/worker');
    console.log('✅ Bull queue worker initialized');
  } catch (error) {
    console.error('❌ Failed to start Bull worker:', error.message);
    console.error('   Queue processing will not work!');
  }
});

module.exports = app;
