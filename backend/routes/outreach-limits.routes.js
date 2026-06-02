// ─────────────────────────────────────────────────────────────────────────────
// routes/outreach-limits.routes.js
//
// Org-level prospecting email ceiling configuration.
// Admin-only — reads/writes the org_integrations row for prospecting_email.
//
// Mount in server.js:
//   const outreachLimitsRoutes = require('./routes/outreach-limits.routes');
//   app.use('/api/org/outreach-limits', outreachLimitsRoutes);
// ─────────────────────────────────────────────────────────────────────────────

const express           = require('express');
const router            = express.Router();
const db                = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');

router.use(authenticateToken);
router.use(orgContext);

// ── Admin guard ───────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'org_admin') {
    return res.status(403).json({ error: { message: 'Admin access required' } });
  }
  next();
}

// ── GET / — fetch current org ceiling config ──────────────────────────────────
router.get('/', requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT config, updated_at FROM org_integrations
       WHERE org_id = $1 AND integration_type = 'prospecting_email'`,
      [req.orgId]
    );

    const config = result.rows[0]?.config || {};

    // Legacy reads: linkedinDailyActivationCap was the old name for what's
    // now dailyActivationCap. We keep BOTH on output for back-compat with
    // older consumers (BatchActivateModal reads linkedinDailyActivationCap).
    // The Resolver reads dailyActivationCap.
    const effectiveDailyCap = config.dailyActivationCap
                           ?? config.linkedinDailyActivationCap
                           ?? 25;

    res.json({
      limits: {
        dailyLimitCeiling:      config.dailyLimitCeiling      ?? 100,
        minDelayMinutesCeiling: config.minDelayMinutesCeiling ?? 2,
        defaultDailyLimit:      config.defaultDailyLimit      ?? 50,
        defaultMinDelayMinutes: config.defaultMinDelayMinutes ?? 5,
        // Slice 2 additions
        linkedinDailyActivationCap: effectiveDailyCap,
        activationSlaDays:          config.activationSlaDays  ?? 7,
        researchSlaDays:            config.researchSlaDays    ?? 14,

        // Sending-schedule additions (Slice 2 of the sending-schedule feature).
        // dailyActivationCap is the canonical name going forward. Defaults
        // match SendingScheduleResolver.DEFAULTS so the cascade is consistent.
        dailyActivationCap:    effectiveDailyCap,
        sendWindowStartHour:   config.sendWindowStartHour ?? 8,
        sendWindowStartMinute: config.sendWindowStartMinute ?? 0,
        sendWindowEndHour:     config.sendWindowEndHour   ?? 18,
        sendWindowDays:        Array.isArray(config.sendWindowDays) ? config.sendWindowDays : [1,2,3,4,5],
        sendWindowTimezone:    config.sendWindowTimezone  ?? 'America/New_York',
        // Unified sending schedule (2026_13)
        startMode:             config.startMode      ?? 'fixed_or_now',
        pacingMode:            config.pacingMode      ?? 'cadence',
        cadenceMinutes:        config.cadenceMinutes  ?? 5,
        // Soft per-day LinkedIn release cap (manual connection requests).
        linkedinReleaseCap:    config.linkedinReleaseCap ?? config.dailyActivationCap ?? 25,
        // Budget split policy across the owner's campaigns: 'shared' | 'weighted'.
        budgetMode:            config.budgetMode ?? 'shared',
      },
      updatedAt: result.rows[0]?.updated_at || null,
    });
  } catch (error) {
    console.error('Get outreach limits error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch outreach limits' } });
  }
});

// ── PUT / — update org ceiling config ────────────────────────────────────────
router.put('/', requireAdmin, async (req, res) => {
  try {
    const {
      dailyLimitCeiling,
      minDelayMinutesCeiling,
      defaultDailyLimit,
      defaultMinDelayMinutes,
      // Slice 2 (older — kept for back-compat)
      linkedinDailyActivationCap,
      activationSlaDays,
      researchSlaDays,
      // Sending-schedule Slice 2 — new canonical names
      dailyActivationCap,
      sendWindowStartHour,
      sendWindowEndHour,
      sendWindowDays,
      sendWindowTimezone,
      // Unified sending schedule (2026_13)
      sendWindowStartMinute,
      startMode,
      pacingMode,
      cadenceMinutes,
      linkedinReleaseCap,
      budgetMode,
    } = req.body;

    // Validation
    const errors = [];
    if (dailyLimitCeiling !== undefined) {
      const v = parseInt(dailyLimitCeiling);
      if (isNaN(v) || v < 1 || v > 500) errors.push('dailyLimitCeiling must be between 1 and 500');
    }
    if (minDelayMinutesCeiling !== undefined) {
      const v = parseInt(minDelayMinutesCeiling);
      if (isNaN(v) || v < 0 || v > 120) errors.push('minDelayMinutesCeiling must be between 0 and 120');
    }
    if (defaultDailyLimit !== undefined) {
      const v = parseInt(defaultDailyLimit);
      if (isNaN(v) || v < 1) errors.push('defaultDailyLimit must be at least 1');
    }
    if (defaultMinDelayMinutes !== undefined) {
      const v = parseInt(defaultMinDelayMinutes);
      if (isNaN(v) || v < 0) errors.push('defaultMinDelayMinutes cannot be negative');
    }
    // Slice 2
    if (linkedinDailyActivationCap !== undefined) {
      const v = parseInt(linkedinDailyActivationCap);
      if (isNaN(v) || v < 1 || v > 200) errors.push('linkedinDailyActivationCap must be between 1 and 200');
    }
    if (activationSlaDays !== undefined) {
      const v = parseInt(activationSlaDays);
      if (isNaN(v) || v < 1 || v > 90) errors.push('activationSlaDays must be between 1 and 90');
    }
    if (researchSlaDays !== undefined) {
      const v = parseInt(researchSlaDays);
      if (isNaN(v) || v < 1 || v > 90) errors.push('researchSlaDays must be between 1 and 90');
    }
    // Sending-schedule validations
    if (dailyActivationCap !== undefined) {
      const v = parseInt(dailyActivationCap);
      if (isNaN(v) || v < 1 || v > 500) errors.push('dailyActivationCap must be between 1 and 500');
    }
    if (sendWindowStartHour !== undefined) {
      const v = parseInt(sendWindowStartHour);
      if (isNaN(v) || v < 0 || v > 23) errors.push('sendWindowStartHour must be between 0 and 23');
    }
    if (sendWindowEndHour !== undefined) {
      const v = parseInt(sendWindowEndHour);
      if (isNaN(v) || v < 1 || v > 24) errors.push('sendWindowEndHour must be between 1 and 24');
    }
    if (sendWindowStartHour !== undefined && sendWindowEndHour !== undefined) {
      if (parseInt(sendWindowEndHour) <= parseInt(sendWindowStartHour)) {
        errors.push('sendWindowEndHour must be after sendWindowStartHour');
      }
    }
    if (sendWindowDays !== undefined) {
      if (!Array.isArray(sendWindowDays)) {
        errors.push('sendWindowDays must be an array of 0-6 integers');
      } else {
        const dedup = [...new Set(sendWindowDays.map(d => parseInt(d, 10)))];
        if (dedup.some(d => isNaN(d) || d < 0 || d > 6)) {
          errors.push('sendWindowDays entries must be 0..6 (0=Sun..6=Sat)');
        }
        if (dedup.length === 0) errors.push('sendWindowDays cannot be empty');
      }
    }
    if (sendWindowTimezone !== undefined) {
      if (typeof sendWindowTimezone !== 'string' || !sendWindowTimezone.trim()) {
        errors.push('sendWindowTimezone must be a non-empty string');
      } else {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: sendWindowTimezone });
        } catch (_) {
          errors.push(`sendWindowTimezone "${sendWindowTimezone}" is not a valid IANA timezone`);
        }
      }
    }
    // Unified sending schedule validations
    if (sendWindowStartMinute !== undefined) {
      const v = parseInt(sendWindowStartMinute);
      if (isNaN(v) || v < 0 || v > 59) errors.push('sendWindowStartMinute must be between 0 and 59');
    }
    if (startMode !== undefined && !['on_activate', 'fixed', 'fixed_or_now'].includes(startMode)) {
      errors.push('startMode must be on_activate, fixed, or fixed_or_now');
    }
    if (pacingMode !== undefined && !['cadence', 'spread'].includes(pacingMode)) {
      errors.push('pacingMode must be cadence or spread');
    }
    if (cadenceMinutes !== undefined) {
      const v = parseInt(cadenceMinutes);
      if (isNaN(v) || v < 1 || v > 240) errors.push('cadenceMinutes must be between 1 and 240');
    }
    if (linkedinReleaseCap !== undefined) {
      const v = parseInt(linkedinReleaseCap);
      if (isNaN(v) || v < 1 || v > 200) errors.push('linkedinReleaseCap must be between 1 and 200');
    }
    if (budgetMode !== undefined && !['shared', 'weighted'].includes(budgetMode)) {
      errors.push('budgetMode must be shared or weighted');
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: { message: errors.join('; ') } });
    }

    // Cross-validation: defaults must not exceed ceilings
    const current = await db.query(
      `SELECT config FROM org_integrations
       WHERE org_id = $1 AND integration_type = 'prospecting_email'`,
      [req.orgId]
    );
    const existing = current.rows[0]?.config || {};

    // Reconciliation: if caller sends dailyActivationCap, also mirror it to
    // linkedinDailyActivationCap so legacy reads (resolveActivationLimits,
    // BatchActivateModal) keep working. If they send only the legacy name,
    // mirror it to the canonical name so the Resolver picks it up.
    const incomingCap = dailyActivationCap !== undefined
      ? parseInt(dailyActivationCap, 10)
      : (linkedinDailyActivationCap !== undefined
          ? parseInt(linkedinDailyActivationCap, 10)
          : null);

    const merged = {
      dailyLimitCeiling:      coalesceInt(dailyLimitCeiling,      existing.dailyLimitCeiling,      100),
      minDelayMinutesCeiling: coalesceInt(minDelayMinutesCeiling, existing.minDelayMinutesCeiling, 2),
      defaultDailyLimit:      coalesceInt(defaultDailyLimit,      existing.defaultDailyLimit,      50),
      defaultMinDelayMinutes: coalesceInt(defaultMinDelayMinutes, existing.defaultMinDelayMinutes, 5),
      // Cap — both names kept in sync.
      linkedinDailyActivationCap: incomingCap ?? existing.dailyActivationCap ?? existing.linkedinDailyActivationCap ?? 25,
      dailyActivationCap:         incomingCap ?? existing.dailyActivationCap ?? existing.linkedinDailyActivationCap ?? 25,
      activationSlaDays: coalesceInt(activationSlaDays, existing.activationSlaDays, 7),
      researchSlaDays:   coalesceInt(researchSlaDays,   existing.researchSlaDays,   14),
      // Sending schedule
      sendWindowStartHour: coalesceInt(sendWindowStartHour, existing.sendWindowStartHour, 9),
      sendWindowEndHour:   coalesceInt(sendWindowEndHour,   existing.sendWindowEndHour,   18),
      sendWindowDays:      Array.isArray(sendWindowDays)
                             ? [...new Set(sendWindowDays.map(d => parseInt(d, 10)))].sort()
                             : (Array.isArray(existing.sendWindowDays) ? existing.sendWindowDays : [1,2,3,4,5]),
      sendWindowTimezone:  (typeof sendWindowTimezone === 'string' && sendWindowTimezone.trim())
                             ? sendWindowTimezone.trim()
                             : (existing.sendWindowTimezone || 'America/New_York'),
      // Unified sending schedule (2026_13)
      sendWindowStartMinute: coalesceInt(sendWindowStartMinute, existing.sendWindowStartMinute, 0),
      startMode:  ['on_activate', 'fixed', 'fixed_or_now'].includes(startMode)
                    ? startMode : (existing.startMode || 'fixed_or_now'),
      pacingMode: ['cadence', 'spread'].includes(pacingMode)
                    ? pacingMode : (existing.pacingMode || 'cadence'),
      cadenceMinutes:     coalesceInt(cadenceMinutes,     existing.cadenceMinutes,     5),
      linkedinReleaseCap: coalesceInt(linkedinReleaseCap, existing.linkedinReleaseCap ?? existing.dailyActivationCap, 25),
      budgetMode: ['shared', 'weighted'].includes(budgetMode)
                    ? budgetMode : (existing.budgetMode || 'shared'),
    };

    if (merged.defaultDailyLimit > merged.dailyLimitCeiling) {
      return res.status(400).json({
        error: { message: 'defaultDailyLimit cannot exceed dailyLimitCeiling' }
      });
    }
    if (merged.defaultMinDelayMinutes < merged.minDelayMinutesCeiling) {
      return res.status(400).json({
        error: { message: 'defaultMinDelayMinutes cannot be less than minDelayMinutesCeiling' }
      });
    }

    // Upsert
    const result = await db.query(
      `INSERT INTO org_integrations (org_id, integration_type, status, config, updated_at)
       VALUES ($1, 'prospecting_email', 'active', $2::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (org_id, integration_type) DO UPDATE
         SET config     = $2::jsonb,
             status     = 'active',
             updated_at = CURRENT_TIMESTAMP
       RETURNING config, updated_at`,
      [req.orgId, JSON.stringify(merged)]
    );

    console.log(`⚙️  Outreach limits updated for org ${req.orgId} by user ${req.user.userId}:`, merged);

    res.json({
      limits:    result.rows[0].config,
      updatedAt: result.rows[0].updated_at,
    });
  } catch (error) {
    console.error('Update outreach limits error:', error);
    res.status(500).json({ error: { message: 'Failed to update outreach limits' } });
  }
});

// coalesceInt(incoming, existing, fallback) — incoming is a raw req.body field
// that may be undefined/null/NaN; existing is what's in the DB; fallback is
// the hard default. Numeric coercion happens once here so caller code stays
// linear.
function coalesceInt(incoming, existing, fallback) {
  if (incoming !== undefined && incoming !== null && incoming !== '') {
    const n = parseInt(incoming, 10);
    if (Number.isFinite(n)) return n;
  }
  if (existing !== undefined && existing !== null) {
    const n = parseInt(existing, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

module.exports = router;
