// =============================================================================
// whatsappSession.superAdmin.routes.js
// =============================================================================
// Platform-wide view of WhatsApp session capture across every tenant.
//
// Mount in server.js alongside the other super-admin mounts:
//   app.use('/api/super', require('./routes/whatsappSession.superAdmin.routes'));
//
// All routes inherit authenticateToken + requireSuperAdmin, matching
// workflow.superAdmin.routes.js.
//
// WHY THIS EXISTS
//   Session capture fails quietly. A worker stops, a handset goes untouched for
//   14 days, WhatsApp ends a session — and the tenant sees nothing wrong until
//   someone asks why a project has no WhatsApp history. Nobody is watching a
//   per-org settings page. This is the one screen where "which of my customers
//   is silently broken right now" is answerable.
//
//   Deliberately NO message content: this is an operational health view, not a
//   window into tenants' conversations. Counts and timestamps only.
// =============================================================================

'use strict';

const express           = require('express');
const router            = express.Router();
const { pool }          = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { requireSuperAdmin } = require('../middleware/superAdmin.middleware');

router.use(authenticateToken, requireSuperAdmin);

// GET /super/whatsapp-sessions — every tenant's session, worst first
router.get('/whatsapp-sessions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id,
              s.org_id,
              o.name                AS org_name,
              s.label,
              s.wa_phone,
              s.status,
              s.status_detail,
              s.capture_mode,
              s.capture_enabled,
              s.connected_at,
              s.heartbeat_at,
              s.heartbeat_seconds,
              s.last_message_at,
              s.phone_last_seen_at,
              s.reconnect_count,
              s.last_reconnect_at,
              round(EXTRACT(EPOCH FROM (now() - s.heartbeat_at)) / 60)::int      AS heartbeat_stale_minutes,
              floor(EXTRACT(EPOCH FROM (now() - s.phone_last_seen_at)) / 86400)::int AS phone_stale_days,
              (SELECT count(*) FROM whatsapp_session_groups g
                WHERE g.session_id = s.id)                       AS groups_total,
              (SELECT count(*) FROM whatsapp_session_groups g
                WHERE g.session_id = s.id AND g.is_watched)      AS groups_watched,
              (SELECT count(*) FROM whatsapp_session_groups g
                WHERE g.session_id = s.id AND g.binding_status = 'bound') AS groups_bound,
              (SELECT count(*) FROM whatsapp_messages m
                WHERE m.org_id = s.org_id AND m.capture_source = 'session'
                  AND m.created_at > now() - interval '24 hours') AS messages_24h
         FROM whatsapp_sessions s
         JOIN organizations o ON o.id = s.org_id
        WHERE s.status <> 'disabled'
        ORDER BY
          -- Broken first, then at-risk, then healthy. A super admin opening
          -- this page should not have to scan for the problems.
          CASE s.status WHEN 'logged_out' THEN 0 WHEN 'disconnected' THEN 1 ELSE 2 END,
          s.heartbeat_at ASC NULLS FIRST`
    );

    const sessions = rows.map((r) => {
      const warnings = [];
      const budgetMin = Math.ceil(((r.heartbeat_seconds || 60) * 3) / 60);

      if (r.status === 'logged_out') {
        warnings.push({ level: 'critical', message: 'WhatsApp ended the session — needs a rescan from the handset.' });
      }
      if (r.status === 'connected' && r.heartbeat_stale_minutes != null && r.heartbeat_stale_minutes > budgetMin) {
        warnings.push({ level: 'critical', message: `No heartbeat for ${r.heartbeat_stale_minutes} minutes — the worker is not running.` });
      }
      if (r.status === 'connected' && r.heartbeat_at == null) {
        warnings.push({ level: 'warning', message: 'Connected but has never sent a heartbeat.' });
      }
      // The 14-day rule is the most common way a working session dies weeks
      // after setup, and it is entirely preventable with a nudge.
      if (r.phone_stale_days != null && r.phone_stale_days >= 10) {
        warnings.push({
          level: r.phone_stale_days >= 13 ? 'critical' : 'warning',
          message: `Handset unconfirmed for ${r.phone_stale_days} days — WhatsApp unlinks companion devices at 14.`,
        });
      }
      if (r.phone_last_seen_at == null && r.status === 'connected') {
        warnings.push({ level: 'warning', message: 'Handset check-in has never been recorded.' });
      }
      if (r.reconnect_count >= 10) {
        warnings.push({ level: 'warning', message: `${r.reconnect_count} reconnects — the number may be rate-limited or contested.` });
      }
      if (r.capture_enabled === false) {
        warnings.push({ level: 'warning', message: 'Capture is switched off for this tenant.' });
      }
      if (r.status === 'connected' && Number(r.groups_watched) === 0) {
        warnings.push({ level: 'warning', message: 'Connected but no groups are being captured — nothing is being stored.' });
      }

      return {
        ...r,
        groups_total:   Number(r.groups_total),
        groups_watched: Number(r.groups_watched),
        groups_bound:   Number(r.groups_bound),
        messages_24h:   Number(r.messages_24h),
        warnings,
        healthy: warnings.every((w) => w.level !== 'critical'),
      };
    });

    res.json({
      sessions,
      summary: {
        total:     sessions.length,
        connected: sessions.filter((s) => s.status === 'connected').length,
        critical:  sessions.filter((s) => !s.healthy).length,
        atRisk:    sessions.filter((s) => s.healthy && s.warnings.length > 0).length,
      },
    });
  } catch (e) {
    console.error('[super/whatsapp-sessions]', e.message);
    res.status(500).json({ error: { message: e.message } });
  }
});

// POST /super/whatsapp-sessions/:id/disable
//
// The support lever: kill a tenant's capture without waiting for their admin.
// Wipes key material as well, because a disabled session holding live
// credentials is the worst of both worlds.
router.post('/whatsapp-sessions/:id/disable', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      `UPDATE whatsapp_sessions
          SET status = 'disabled',
              status_detail = $2,
              updated_at = now()
        WHERE id = $1 AND status <> 'disabled'
        RETURNING org_id`,
      [id, `disabled by super admin (user ${req.userId})`]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'Session not found or already disabled' } });

    await pool.query(`DELETE FROM whatsapp_session_auth WHERE session_id = $1`, [id]);
    console.warn(`[super] whatsapp session ${id} (org ${rows[0].org_id}) disabled by user ${req.userId}`);
    res.json({ ok: true, sessionId: id, orgId: rows[0].org_id });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

module.exports = router;
