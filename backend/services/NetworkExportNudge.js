// services/NetworkExportNudge.js
//
// Server-side half of the weekly/biweekly/monthly "refresh your network export"
// reminder (Design & Execution Tracker §G-P1, D5).
//
// Like LinkedInRefreshNudge, the server only NUDGES — it never opens LinkedIn or
// triggers an export. The actual export is human-initiated (the rep clicks
// "Download my data" on LinkedIn, then uploads). This job just reminds reps
// whose latest snapshot has aged past THEIR cadence.
//
// Freshness signal: MAX(connection_snapshots.imported_at) per (org, owner) — the
// real last-ingest time. No last_export_at column needed (avoids coupling to
// seat binding, which is optional for a CSV upload).
//
// Cadence (per-user, D5) comes from NetworkJobChangeConfig (default weekly).
// 'on_demand' opts out of reminders entirely.
//
// Delivery: notifications bell + Slack fan-out via notificationService
// .createNotification (NOT prospecting_actions — that table requires a non-null
// prospect_id, and this reminder isn't tied to a prospect).
//
// Idempotent: at most one open reminder per user per cadence window (dedup on
// type + created_at), so re-running the cron never piles up.

'use strict';

const Config = require('./NetworkJobChangeConfig');
const { createNotification } = require('./notificationService');

const CADENCE_DAYS = { weekly: 7, biweekly: 14, monthly: 30 };
const NOTIF_TYPE   = 'network_export_due';

async function nudgeStaleExports(pool) {
  const client = await pool.connect();
  try {
    // Reps who have used the feature at least once, with their latest snapshot.
    const { rows } = await client.query(
      `SELECT org_id, owner_id AS user_id, MAX(imported_at) AS last_export
         FROM connection_snapshots
        GROUP BY org_id, owner_id`
    );

    let created = 0;
    for (const r of rows) {
      const cfg = await Config.resolveForUser(client, { orgId: r.org_id, userId: r.user_id });
      const cadence = cfg.exportCadence;
      if (cadence === 'on_demand') continue;
      const days = CADENCE_DAYS[cadence] || CADENCE_DAYS.weekly;

      const ageMs = Date.now() - new Date(r.last_export).getTime();
      if (ageMs < days * 86400000) continue; // still fresh

      // Dedup: already reminded within this cadence window?
      const dup = await client.query(
        `SELECT 1 FROM notifications
          WHERE org_id = $1 AND user_id = $2 AND type = $3
            AND created_at > now() - ($4 || ' days')::interval
          LIMIT 1`,
        [r.org_id, r.user_id, NOTIF_TYPE, String(days)]
      );
      if (dup.rows.length) continue;

      const ageDays = Math.floor(ageMs / 86400000);
      await createNotification(
        r.org_id, r.user_id, NOTIF_TYPE,
        'Refresh your LinkedIn network',
        `Your network snapshot is ${ageDays} days old. Export your LinkedIn connections `
        + `(Settings → Data privacy → Get a copy of your data) and upload it to catch new job changes.`,
        'network', null,
        { lastExport: r.last_export, cadence, ageDays }
      );
      created++;
    }

    if (created > 0) {
      console.log(`📤 NetworkExportNudge: created ${created} export reminder(s)`);
    }
    return { created };
  } catch (err) {
    console.error('NetworkExportNudge.nudgeStaleExports error:', err.message);
    return { created: 0 };
  } finally {
    client.release();
  }
}

module.exports = { nudgeStaleExports, CADENCE_DAYS, NOTIF_TYPE };
