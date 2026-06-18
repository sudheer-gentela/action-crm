// services/LinkedInRefreshNudge.js
//
// Server-side half of the weekly "refresh connection status" feature.
//
// We deliberately do NOT auto-open LinkedIn or poll Voyager from the server —
// there is no server-side LinkedIn session, and the extension's own warning is
// that automated/background Voyager traffic is what gets accounts flagged. So
// the server's job is only to NUDGE: once a week, for any bound LinkedIn seat
// whose connection data hasn't been refreshed in a while, drop an idempotent
// prospecting_action reminding that rep to click "Check & update". The actual
// read still happens human-in-the-loop (the on-demand popup buttons), or
// opportunistically in the extension when a My Network tab is already open
// (see background.js gowarmWeeklyHarvest).
//
// Freshness signal: user_linkedin_seats.last_seen_at is bumped every time the
// rep runs a sync (bindSeat updates it). A seat not seen in STALE_DAYS days is
// "due for a refresh".
//
// Idempotent: one open nudge action per user per week (dedup on source +
// recent due_date), so re-running the cron — or running it twice — never piles
// up duplicate reminders.

const STALE_DAYS  = 7;   // a seat unsynced this long is "due"
const DEDUP_DAYS  = 7;   // don't create a second nudge within this window

async function nudgeStaleSeats(pool) {
  const client = await pool.connect();
  try {
    // Only orgs that have the prospecting module enabled. We join seats →
    // users to attribute the action, and insert one action per stale seat that
    // doesn't already have a recent open nudge.
    const result = await client.query(
      `INSERT INTO prospecting_actions
              (org_id, user_id, prospect_id, title, description,
               action_type, channel, status, priority, due_date, source, metadata)
       SELECT s.org_id,
              s.user_id,
              NULL,
              'Refresh your LinkedIn connection status',
              'It''s been a while since your sent/accepted connection data was '
                || 'updated in GoWarm. Open the extension and click '
                || '"Check & update sent" / "Check & update accepted" so your '
                || 'prospects reflect the latest LinkedIn activity.',
              'outreach', 'linkedin', 'pending', 'low',
              NOW(), 'linkedin_refresh_nudge',
              jsonb_build_object('seatId', s.id, 'publicIdentifier', s.public_identifier,
                                 'lastSeenAt', s.last_seen_at)
         FROM user_linkedin_seats s
        WHERE s.last_seen_at < NOW() - ($1 || ' days')::interval
          AND NOT EXISTS (
            SELECT 1 FROM prospecting_actions pa
             WHERE pa.source  = 'linkedin_refresh_nudge'
               AND pa.user_id = s.user_id
               AND pa.org_id  = s.org_id
               AND pa.status != 'completed'
               AND pa.due_date > NOW() - ($2 || ' days')::interval
          )
       RETURNING id`,
      [String(STALE_DAYS), String(DEDUP_DAYS)]
    );
    const inserted = result.rowCount || 0;
    if (inserted > 0) {
      console.log(`🔗 LinkedInRefreshNudge: created ${inserted} weekly refresh nudge(s)`);
    }
    return { inserted };
  } catch (err) {
    console.error('LinkedInRefreshNudge.nudgeStaleSeats error:', err.message);
    return { inserted: 0 };
  } finally {
    client.release();
  }
}

module.exports = { nudgeStaleSeats, STALE_DAYS, DEDUP_DAYS };
