const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// 1. ADD these route imports (near your other route imports)
const outlookRoutes = require('./routes/outlook.routes');
const syncRoutes = require('./routes/sync.routes');
const playbookRoutes = require('./routes/playbook.routes');
const aiRoutes = require('./routes/ai.routes');
const promptsRoutes = require('./routes/prompts.routes');


// Trust Railway proxy
app.set('trust proxy', 1);

// Security middleware - Configure helmet to allow CORS
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }
}));

// CORS configuration - MUST be after helmet
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://action-crm.vercel.app',
    process.env.CORS_ORIGIN
  ].filter(Boolean),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 600 // Cache preflight for 10 minutes
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100
});
app.use('/api/', limiter);

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 2. ADD these route registrations (after your existing app.use() statements)
// API Routes
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/actions', require('./routes/actions.routes'));
app.use('/api/deals', require('./routes/deals.routes'));
app.use('/api/contacts', require('./routes/contacts.routes'));
app.use('/api/accounts', require('./routes/accounts.routes'));
app.use('/api/emails', require('./routes/emails.routes'));
app.use('/api/meetings', require('./routes/meetings.routes'));
app.use('/api/proposals', require('./routes/proposals.routes'));
app.use('/api/calendar', require('./routes/calendar.routes'));
app.use('/api/dashboard', require('./routes/dashboard.routes'));
app.use('/api/outlook', outlookRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/playbook', playbookRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/prompts', promptsRoutes);


// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Route not found' } });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║     Action CRM API Server             ║
║     Running on port ${PORT}             ║
║     Environment: ${process.env.NODE_ENV || 'development'}      ║
╚═══════════════════════════════════════╝
  `);
  
  // ✅ Start Bull queue worker after server is running
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
