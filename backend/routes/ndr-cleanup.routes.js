// ─────────────────────────────────────────────────────────────────────────────
// routes/ndr-cleanup.routes.js
//
// Org Admin tooling for the NDR ("undeliverable") cleanup. Wraps
// services/NdrCleanupService — the same code path scripts/cleanupNdrReplies.js
// uses, so the UI and the CLI can never disagree about what "cleanup" means.
//
// Mount in server.js next to the other prospecting routes:
//   app.use('/api/ndr-cleanup', require('./routes/ndr-cleanup.routes'));
//
//   GET  /api/ndr-cleanup/preview?reprocess=1     — dry run, ROLLBACKs
//   POST /api/ndr-cleanup/apply                   — commits
//
// ── AUTHORISATION ────────────────────────────────────────────────────────────
//
// Two kinds of caller are allowed, and they get different powers:
//
//   org owner / admin  → may clean ONLY their own org (req.orgId). The orgId
//                        query param is ignored for them entirely — it is never
//                        read into a query, so it cannot be used to reach
//                        across a tenant boundary.
//   super admin        → may pass ?orgId= to operate on any org, for support.
//                        Every apply is written to super_admin_audit_log.
//
// The guard runs AFTER orgContext so req.orgId is populated for the common
// case. We deliberately do not use requireRole() directly: it 403s a super
// admin who has no org_users row, which is exactly the person we want to let
// through.
//
// ── SAFETY ───────────────────────────────────────────────────────────────────
//
// GET /preview never commits — NdrCleanupService runs the real mutations inside
// a transaction and ROLLBACKs. POST /apply additionally requires an explicit
// confirm token in the body, so a mis-fired fetch cannot mutate anything.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const { auditLog } = require('../middleware/superAdmin.middleware');
const NdrCleanupService = require('../services/NdrCleanupService');

router.use(authenticateToken);
router.use(orgContext);

/**
 * Allow org owner/admin (own org only) or super admin (any org).
 * Sets req.targetOrgId — the ONLY org id any handler below is permitted to use.
 */
async function requireAdminOrSuperAdmin(req, res, next) {
  try {
    const superRes = await pool.query(
      `SELECT id FROM super_admins WHERE user_id = $1 AND revoked_at IS NULL`,
      [req.userId]
    );
    const isSuper = superRes.rows.length > 0;

    if (isSuper) {
      req.isSuperAdmin = true;
      const requested = req.query.orgId ? parseInt(req.query.orgId, 10) : null;
      req.targetOrgId = Number.isInteger(requested) ? requested : req.orgId;
      return next();
    }

    const roleRes = await pool.query(
      `SELECT role FROM org_users
        WHERE user_id = $1 AND org_id = $2 AND is_active = TRUE`,
      [req.userId, req.orgId]
    );
    const role = roleRes.rows[0]?.role;
    if (!role || !['owner', 'admin'].includes(role)) {
      return res.status(403).json({ error: { message: 'Requires role: owner or admin' } });
    }

    req.isSuperAdmin = false;
    // Non-super admins are pinned to their own org. ?orgId= is not read.
    req.targetOrgId = req.orgId;
    return next();
  } catch (err) {
    console.error('ndr-cleanup guard error:', err);
    return res.status(500).json({ error: { message: 'Internal server error' } });
  }
}

router.use(requireAdminOrSuperAdmin);

// ── GET /preview ─────────────────────────────────────────────────────────────
// Dry run. Returns exactly what an apply would do, having actually executed it
// and rolled back. ?reprocess=1 also reports what BounceDetectionService would
// extract from each NDR body (the TRUE failed recipient), which is usually a
// different prospect from the one the NDR was attached to.
router.get('/preview', async (req, res) => {
  try {
    const reprocess = req.query.reprocess === '1' || req.query.reprocess === 'true';
    const result = await NdrCleanupService.execute({
      orgId: req.targetOrgId,
      reprocess,
      apply: false,
    });
    res.json({ ...result, isSuperAdmin: !!req.isSuperAdmin });
  } catch (err) {
    console.error('ndr-cleanup preview error:', err);
    res.status(500).json({ error: { message: 'Preview failed: ' + err.message } });
  }
});

// ── POST /apply ──────────────────────────────────────────────────────────────
// Body: { confirm: 'CLEANUP', reprocess: boolean }
//
// The confirm token is not security — the guard above is. It exists so that an
// accidental POST (a retried request, a stray click) cannot mutate data.
router.post('/apply', async (req, res) => {
  try {
    const { confirm, reprocess } = req.body || {};
    if (confirm !== 'CLEANUP') {
      return res.status(400).json({
        error: { message: "Refusing to apply without confirm: 'CLEANUP'" },
      });
    }

    const result = await NdrCleanupService.execute({
      orgId: req.targetOrgId,
      reprocess: !!reprocess,
      apply: true,
    });

    if (req.isSuperAdmin) {
      await auditLog(req, 'ndr_cleanup_apply', 'organization', req.targetOrgId, {
        reprocess: !!reprocess,
        stats: result.stats,
      });
    }

    console.log(
      `[ndr-cleanup] user=${req.userId} org=${req.targetOrgId} APPLIED ` +
        `ndrs=${result.stats.ndrEmails} reverted=${result.stats.stagesReverted} ` +
        `events=${result.stats.reprocessed}`
    );

    res.json({ ...result, isSuperAdmin: !!req.isSuperAdmin });
  } catch (err) {
    console.error('ndr-cleanup apply error:', err);
    res.status(500).json({ error: { message: 'Apply failed: ' + err.message } });
  }
});

module.exports = router;
