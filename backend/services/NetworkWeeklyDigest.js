// services/NetworkWeeklyDigest.js
//
// Weekly team-wide roll-up of network job changes (Design & Execution Tracker
// §G-P2, §F "org digest"). The cross-rep view no single rep could assemble:
// "this week your team's network saw N job changes — here's who moved, where,
// and who holds the relationship."
//
// Recipients: active org owners/admins (RevOps) — per D10, they see everything.
// Delivery: notifications bell + Slack via notificationService.createNotification.
// Idempotent: at most one digest per recipient per 7-day window.
//
// Run weekly from a cron (e.g. Monday 15:00 UTC, after the export nudge):
//   const { sent } = await require('./services/NetworkWeeklyDigest').sendWeeklyDigests(pool);

'use strict';

const { createNotification } = require('./notificationService');

const WINDOW_DAYS = 7;
const NOTIF_TYPE  = 'network_weekly_digest';
const MAX_NOTABLE = 12;

function ownerName(first, last) {
  return [first, last].filter(Boolean).join(' ').trim() || 'A teammate';
}

async function sendWeeklyDigests(pool) {
  const client = await pool.connect();
  try {
    // Orgs with any job-change activity in the window.
    const orgsRes = await client.query(
      `SELECT DISTINCT org_id
         FROM connection_job_events
        WHERE detected_at > now() - ($1 || ' days')::interval
          AND event_type IN ('company_change', 'role_change')`,
      [String(WINDOW_DAYS)]
    );

    let sent = 0;
    for (const { org_id: orgId } of orgsRes.rows) {
      // Counts.
      const c = (await client.query(
        `SELECT
           count(*)                                        AS total,
           count(*) FILTER (WHERE is_from_customer_account) AS champion_left,
           count(*) FILTER (WHERE is_into_target_account)   AS into_target,
           count(*) FILTER (WHERE is_into_icp_role)         AS into_icp
         FROM connection_job_events
        WHERE org_id = $1 AND detected_at > now() - ($2 || ' days')::interval
          AND event_type IN ('company_change', 'role_change')`,
        [orgId, String(WINDOW_DAYS)]
      )).rows[0];

      const total = Number(c.total) || 0;
      if (total === 0) continue;

      // Notable moves (champion-left or into-target), newest first.
      const notable = (await client.query(
        `SELECT e.is_from_customer_account, e.is_into_target_account,
                e.from_company, e.to_company,
                c.full_name,
                u.first_name AS owner_first, u.last_name AS owner_last,
                fa.name AS from_account, ta.name AS to_account
           FROM connection_job_events e
           JOIN linkedin_connections c ON c.id = e.connection_id AND c.org_id = e.org_id
           LEFT JOIN users u ON u.id = e.owner_id
           LEFT JOIN accounts fa ON fa.id = e.from_account_id AND fa.org_id = e.org_id
           LEFT JOIN accounts ta ON ta.id = e.to_account_id   AND ta.org_id = e.org_id
          WHERE e.org_id = $1 AND e.detected_at > now() - ($2 || ' days')::interval
            AND (e.is_from_customer_account = true OR e.is_into_target_account = true)
          ORDER BY e.detected_at DESC
          LIMIT $3`,
        [orgId, String(WINDOW_DAYS), MAX_NOTABLE]
      )).rows;

      // Recipients: active owners/admins.
      const recips = (await client.query(
        `SELECT u.id, u.first_name, u.last_name
           FROM org_users ou JOIN users u ON u.id = ou.user_id
          WHERE ou.org_id = $1 AND ou.is_active = true
            AND ou.role IN ('owner', 'admin')`,
        [orgId]
      )).rows;
      if (recips.length === 0) continue;

      // Build the summary body.
      const headline = [];
      if (Number(c.champion_left)) headline.push(`${c.champion_left} champion(s) left a customer`);
      if (Number(c.into_target))   headline.push(`${c.into_target} into target accounts`);
      if (Number(c.into_icp))      headline.push(`${c.into_icp} into ICP roles`);

      const lines = [];
      lines.push(`Your team's network saw ${total} job change(s) this week`
        + (headline.length ? `: ${headline.join(', ')}.` : '.'));
      if (notable.length) {
        lines.push('');
        lines.push('Notable:');
        for (const n of notable) {
          const who = n.full_name || 'A connection';
          const owner = ownerName(n.owner_first, n.owner_last);
          if (n.is_into_target_account) {
            lines.push(`• ${who} (${owner}'s connection) joined ${n.to_company || 'a new company'}`
              + (n.to_account ? ` — ${n.to_account} (target)` : ''));
          } else {
            lines.push(`• ${who} (${owner}'s connection) left ${n.from_company || 'a company'}`
              + (n.from_account ? ` — churn risk at ${n.from_account}` : ''));
          }
        }
      }
      const body = lines.join('\n');
      const title = `Weekly network digest: ${total} job change(s) across your team`;

      for (const r of recips) {
        // Dedup: one digest per recipient per window.
        const dup = await client.query(
          `SELECT 1 FROM notifications
            WHERE org_id = $1 AND user_id = $2 AND type = $3
              AND created_at > now() - ($4 || ' days')::interval
            LIMIT 1`,
          [orgId, r.id, NOTIF_TYPE, String(WINDOW_DAYS)]
        );
        if (dup.rows.length) continue;

        await createNotification(
          orgId, r.id, NOTIF_TYPE, title, body, 'network', null,
          { total, championLeft: Number(c.champion_left), intoTarget: Number(c.into_target), intoIcp: Number(c.into_icp) }
        );
        sent++;
      }
    }

    if (sent > 0) console.log(`📈 NetworkWeeklyDigest: sent ${sent} digest(s)`);
    return { sent };
  } catch (err) {
    console.error('NetworkWeeklyDigest.sendWeeklyDigests error:', err.message);
    return { sent: 0 };
  } finally {
    client.release();
  }
}

module.exports = { sendWeeklyDigests, WINDOW_DAYS, NOTIF_TYPE };
