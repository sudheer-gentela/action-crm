/**
 * emails-unified-route.js
 *
 * ADD THIS ROUTE to your existing backend/routes/emails.routes.js
 *
 * This adds two new endpoints:
 *   GET /api/emails/gmail    - fetch Gmail emails for display
 *   GET /api/emails/unified  - fetch from all connected providers
 *
 * Add these BEFORE any parameterized routes like /:id
 */

// Add this import at the top of emails.routes.js:
// const UnifiedEmailProvider = require('../services/UnifiedEmailProvider');

// ============================================================
// ADD THESE ROUTES to emails.routes.js
// ============================================================

// -- GET /gmail -- fetch Gmail emails for display --
router.get('/gmail', authenticateToken, async (req, res) => {
  try {
    const { top = 50, skip = 0, dealId } = req.query;
    const UnifiedEmailProvider = require('../services/UnifiedEmailProvider');

    const result = await UnifiedEmailProvider.fetchEmails(
      req.user.userId, 'gmail', { top: parseInt(top), skip: parseInt(skip) }
    );

    let emails = result.emails;

    if (dealId) {
      const dbResult = await pool.query(
        "SELECT external_id FROM emails WHERE deal_id = $1 AND user_id = $2 AND org_id = $3 AND provider = 'gmail'",
        [dealId, req.user.userId, req.orgId]
      );
      const dealEmailIds = new Set(dbResult.rows.map(r => r.external_id));
      emails = emails.filter(e => dealEmailIds.has(e.id));
    }

    res.json({ success: true, data: emails });
  } catch (error) {
    console.error('Error fetching Gmail emails:', error);
    if (error.message.includes('No tokens found')) {
      return res.status(403).json({ success: false, error: 'Gmail not connected' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// -- GET /unified -- fetch from ALL connected providers --
router.get('/unified', authenticateToken, async (req, res) => {
  try {
    const { top = 50, dealId } = req.query;
    const UnifiedEmailProvider = require('../services/UnifiedEmailProvider');
    const providers = await UnifiedEmailProvider.getConnectedProviders(req.user.userId);

    const allEmails = [];

    for (const provider of providers) {
      try {
        const result = await UnifiedEmailProvider.fetchEmails(
          req.user.userId, provider, { top: parseInt(top) }
        );
        allEmails.push(...result.emails);
      } catch (err) {
        console.warn('Failed to fetch ' + provider + ' emails:', err.message);
      }
    }

    // Sort by date descending
    allEmails.sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));

    // Optionally filter by deal
    let filtered = allEmails;
    if (dealId) {
      const dbResult = await pool.query(
        'SELECT external_id, provider FROM emails WHERE deal_id = $1 AND user_id = $2 AND org_id = $3',
        [dealId, req.user.userId, req.orgId]
      );
      const dealEmailIds = new Set(dbResult.rows.map(r => r.external_id));
      filtered = allEmails.filter(e => dealEmailIds.has(e.id));
    }

    res.json({
      success:   true,
      data:      filtered.slice(0, parseInt(top)),
      providers: providers,
    });
  } catch (error) {
    console.error('Error fetching unified emails:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
