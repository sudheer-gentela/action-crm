// ─────────────────────────────────────────────────────────────────────────────
// routes/contact-roles.routes.js   → /api/contact-roles
//
// Configurable roles for external project people. Same shape as
// org-roles.routes.js, which does the equivalent job for internal roles.
//
//   GET    /?side=customer|vendor|partner   list (active only unless ?all=true)
//   POST   /                                create           (admin)
//   PATCH  /:id                             rename / activate / reorder (admin)
//   DELETE /:id                             remove, or deactivate if in use (admin)
//   POST   /reorder                         { side, ids: [] }  (admin)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const svc               = require('../services/contactRoles.service');
const { pool }          = require('../config/database');

router.use(authenticateToken, orgContext);

const fail = (res, err) => res.status(err.status || 500).json({ error: { message: err.message } });

// Reading the list is open — every contact picker needs it. Changing it is not.
async function adminOnly(req, res, next) {
  const { rows } = await pool.query(
    `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2`, [req.orgId, req.user.userId]);
  if (!['owner', 'admin'].includes(rows[0]?.role)) {
    return res.status(403).json({ error: { message: 'Only an org admin can change contact roles' } });
  }
  next();
}

router.get('/', async (req, res) => {
  try {
    res.json(await svc.list(req.orgId, {
      side: req.query.side || null,
      includeInactive: String(req.query.all) === 'true',
    }));
  } catch (err) { fail(res, err); }
});

router.post('/', adminOnly, async (req, res) => {
  try {
    const { side, name, sortOrder } = req.body || {};
    res.status(201).json(await svc.create(req.orgId, { side, name, sortOrder }));
  } catch (err) { fail(res, err); }
});

router.patch('/:id', adminOnly, async (req, res) => {
  try {
    res.json(await svc.update(req.orgId, parseInt(req.params.id, 10), req.body || {}));
  } catch (err) { fail(res, err); }
});

router.delete('/:id', adminOnly, async (req, res) => {
  try {
    res.json(await svc.remove(req.orgId, parseInt(req.params.id, 10)));
  } catch (err) { fail(res, err); }
});

router.post('/reorder', adminOnly, async (req, res) => {
  try {
    const { side, ids } = req.body || {};
    res.json(await svc.reorder(req.orgId, side, Array.isArray(ids) ? ids : []));
  } catch (err) { fail(res, err); }
});

module.exports = router;
