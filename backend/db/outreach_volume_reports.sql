-- ─────────────────────────────────────────────────────────────────────────────
-- outreach_volume_reports.sql
--
-- Daily outreach volume: product level → org → user → contact.
-- Read-only. Safe to run against production.
--
-- Verified against db/schema.sql in this codebase:
--   sequence_step_logs (org_id, enrollment_id, prospect_id, channel, status,
--                       fired_at, sender_account_id)
--   sequence_enrollments (id, sequence_id, prospect_id, enrolled_by, enrolled_at)
--   prospecting_metric_daily (org_id, metric_date, campaign_id, sequence_id,
--                       channel, sender_account_id, owner_id, sent, enrolled,
--                       connections_sent, calls_logged, replies, ...)
--   calls (org_id, user_id, prospect_id, occurred_at, direction, outcome)
--   prospecting_activities (org_id, prospect_id, user_id, activity_type, metadata)
--
-- ATTRIBUTION NOTE (read this before trusting any "by user" number):
--   sequence_step_logs has NO user_id. There are two defensible actors:
--     a) sequence_enrollments.enrolled_by — the rep who put the contact in flight
--     b) prospects.owner_id              — the rep who owns the contact
--   prospecting_metric_daily uses (b). Queries below use (a) and expose (b)
--   alongside so you can see where they diverge. Pick one and standardise.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- Q1. PRODUCT LEVEL — daily outreach volume across all orgs
--     Reads the nightly rollup. Fastest query; no scan of step logs.
--     Caveat: metric_date is ORG-LOCAL, so a cross-org row mixes calendars by
--     up to ~1 day. Fine for trend/volume; use Q2 if you need a single clock.
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pmd.metric_date                    AS day,
       COUNT(DISTINCT pmd.org_id)         AS orgs_active,
       SUM(pmd.sent)::int                 AS sequence_touches_sent,
       SUM(pmd.connections_sent)::int     AS linkedin_connects_sent,
       SUM(pmd.calls_logged)::int         AS calls_logged,
       SUM(pmd.enrolled)::int             AS enrollments,
       SUM(pmd.prospects_added)::int      AS contacts_added,
       SUM(pmd.replies)::int              AS replies
  FROM prospecting_metric_daily pmd
 WHERE pmd.metric_date >= CURRENT_DATE - INTERVAL '30 days'
 GROUP BY pmd.metric_date
 ORDER BY pmd.metric_date DESC;


-- ═════════════════════════════════════════════════════════════════════════════
-- Q2. PRODUCT LEVEL, BY ORG — daily, single UTC clock, distinct contacts
--     This is the one to use for "how many contacts are we actually touching".
--     touches != contacts: a 3-step day on one prospect is 3 touches, 1 contact.
-- ═════════════════════════════════════════════════════════════════════════════
SELECT (ssl.fired_at AT TIME ZONE 'UTC')::date        AS day,
       o.id                                          AS org_id,
       o.name                                        AS org,
       o.status                                       AS org_status,
       COUNT(*)::int                                  AS touches,
       COUNT(DISTINCT ssl.prospect_id)::int           AS distinct_contacts,
       COUNT(DISTINCT se.enrolled_by)::int            AS active_reps
  FROM sequence_step_logs ssl
  JOIN sequence_enrollments se ON se.id  = ssl.enrollment_id
  JOIN organizations        o  ON o.id   = ssl.org_id
 WHERE ssl.status IN ('sent', 'completed', 'replied')
   AND ssl.fired_at >= now() - INTERVAL '30 days'
 GROUP BY 1, 2, 3, 4
 ORDER BY day DESC, distinct_contacts DESC;


-- ═════════════════════════════════════════════════════════════════════════════
-- Q3. BY ORG × USER × CHANNEL — daily rep-level volume
--     Set :days to taste. Add `AND ssl.org_id = <id>` to focus one tenant.
-- ═════════════════════════════════════════════════════════════════════════════
SELECT (ssl.fired_at AT TIME ZONE 'UTC')::date        AS day,
       o.name                                        AS org,
       se.enrolled_by                                AS rep_id,
       COALESCE(u.first_name || ' ' || u.last_name, u.email, '(unattributed)') AS rep,
       ssl.channel,
       COUNT(*)::int                                  AS touches,
       COUNT(DISTINCT ssl.prospect_id)::int           AS distinct_contacts,
       COUNT(*) FILTER (WHERE ssl.status = 'replied')::int AS replied
  FROM sequence_step_logs ssl
  JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
  JOIN organizations        o  ON o.id  = ssl.org_id
  LEFT JOIN users           u  ON u.id  = se.enrolled_by
 WHERE ssl.status IN ('sent', 'completed', 'replied')
   AND ssl.fired_at >= now() - INTERVAL '14 days'
 GROUP BY 1, 2, 3, 4, 5
 ORDER BY day DESC, org, touches DESC;


-- ═════════════════════════════════════════════════════════════════════════════
-- Q4. WHO WAS OUTREACHED TO — contact-level roster for one day
--     Replace the date. This is the audit-grade list: one row per touch,
--     with the contact, the rep, the sequence, the campaign, the sender.
-- ═════════════════════════════════════════════════════════════════════════════
SELECT (ssl.fired_at AT TIME ZONE 'UTC')                AS sent_at_utc,
       o.name                                            AS org,
       COALESCE(u.first_name || ' ' || u.last_name, u.email) AS rep,
       COALESCE(NULLIF(TRIM(p.first_name || ' ' || p.last_name), ''), p.email, '(no name)') AS contact,
       p.email                                           AS contact_email,
       p.title,
       p.company_name,
       p.linkedin_url,
       ssl.channel,
       ssl.status,
       ssl.subject,
       s.name                                            AS sequence,
       pc.name                                           AS campaign,
       ssl.sender_account_id,
       ow.first_name || ' ' || ow.last_name              AS prospect_owner  -- attribution cross-check
  FROM sequence_step_logs      ssl
  JOIN sequence_enrollments    se ON se.id = ssl.enrollment_id
  JOIN prospects               p  ON p.id  = ssl.prospect_id
  JOIN organizations           o  ON o.id  = ssl.org_id
  LEFT JOIN sequences          s  ON s.id  = se.sequence_id
  LEFT JOIN prospecting_campaigns pc ON pc.id = p.campaign_id
  LEFT JOIN users              u  ON u.id  = se.enrolled_by
  LEFT JOIN users              ow ON ow.id = p.owner_id
 WHERE ssl.status IN ('sent', 'completed', 'replied')
   AND (ssl.fired_at AT TIME ZONE 'UTC')::date = CURRENT_DATE - 1   -- ← set day
 ORDER BY ssl.fired_at DESC;


-- ═════════════════════════════════════════════════════════════════════════════
-- Q5. ALL CHANNELS UNIFIED — daily distinct contacts touched per org × user
--     Sequence sends + logged calls + LinkedIn connection requests, deduped to
--     one (day, rep, contact) tuple so a contact hit on two channels in one day
--     counts once per channel but once overall.
-- ═════════════════════════════════════════════════════════════════════════════
WITH touches AS (
  -- sequence sends (email / linkedin / whatsapp / call steps — whatever's set)
  SELECT ssl.org_id,
         se.enrolled_by                              AS user_id,
         ssl.prospect_id,
         ssl.channel,
         (ssl.fired_at AT TIME ZONE 'UTC')::date     AS day
    FROM sequence_step_logs ssl
    JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
   WHERE ssl.status IN ('sent', 'completed', 'replied')
     AND ssl.fired_at >= now() - INTERVAL '30 days'

  UNION ALL
  -- outbound calls logged outside a sequence step
  SELECT c.org_id, c.user_id, c.prospect_id, 'call',
         (c.occurred_at AT TIME ZONE 'UTC')::date
    FROM calls c
   WHERE c.direction = 'outbound'
     AND c.prospect_id IS NOT NULL
     AND c.sequence_step_log_id IS NULL          -- avoid double-count with above
     AND c.occurred_at >= now() - INTERVAL '30 days'

  UNION ALL
  -- LinkedIn connection requests
  SELECT a.org_id, a.user_id, a.prospect_id, 'linkedin_connect',
         (a.created_at)::date
    FROM prospecting_activities a
   WHERE a.activity_type = 'linkedin_connection_sent'
     AND a.created_at >= now() - INTERVAL '30 days'
)
SELECT t.day,
       o.name                                            AS org,
       COALESCE(u.first_name || ' ' || u.last_name, '(unattributed)') AS rep,
       COUNT(*)::int                                      AS touches,
       COUNT(DISTINCT t.prospect_id)::int                 AS distinct_contacts,
       COUNT(DISTINCT t.prospect_id) FILTER (WHERE t.channel = 'email')::int    AS contacts_email,
       COUNT(DISTINCT t.prospect_id) FILTER (WHERE t.channel LIKE 'linkedin%')::int AS contacts_linkedin,
       COUNT(DISTINCT t.prospect_id) FILTER (WHERE t.channel = 'call')::int     AS contacts_call,
       COUNT(DISTINCT t.prospect_id) FILTER (WHERE t.channel = 'whatsapp')::int AS contacts_whatsapp
  FROM touches t
  JOIN organizations o ON o.id = t.org_id
  LEFT JOIN users    u ON u.id = t.user_id
 GROUP BY 1, 2, 3
 ORDER BY t.day DESC, distinct_contacts DESC;


-- ═════════════════════════════════════════════════════════════════════════════
-- Q6. SNAPSHOT HEALTH — is the nightly rollup actually current?
--     Q1 is only as good as the 03:30 UTC cron in jobs/syncScheduler.js.
--     Any org whose max(metric_date) lags yesterday has a stale rollup.
-- ═════════════════════════════════════════════════════════════════════════════
SELECT o.id                                   AS org_id,
       o.name                                 AS org,
       MAX(pmd.metric_date)                   AS latest_snapshot,
       (CURRENT_DATE - 1) - MAX(pmd.metric_date) AS days_behind,
       MAX(pmd.computed_at)                   AS last_computed_at
  FROM organizations o
  LEFT JOIN prospecting_metric_daily pmd ON pmd.org_id = o.id
 WHERE o.status = 'active'
   AND EXISTS (SELECT 1 FROM prospects p WHERE p.org_id = o.id)
 GROUP BY o.id, o.name
 ORDER BY days_behind DESC NULLS FIRST;


-- ═════════════════════════════════════════════════════════════════════════════
-- Q7. RECIPIENT PRESSURE — contacts hit more than once in a rolling window
--     Deliverability / annoyance guard, and a fast way to spot a runaway org.
-- ═════════════════════════════════════════════════════════════════════════════
SELECT o.name                                  AS org,
       p.email                                 AS contact_email,
       p.company_name,
       COUNT(*)::int                            AS touches_7d,
       COUNT(DISTINCT ssl.channel)::int         AS channels,
       COUNT(DISTINCT se.enrolled_by)::int      AS distinct_reps,
       MIN(ssl.fired_at)                        AS first_touch,
       MAX(ssl.fired_at)                        AS last_touch
  FROM sequence_step_logs ssl
  JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
  JOIN prospects            p  ON p.id  = ssl.prospect_id
  JOIN organizations        o  ON o.id  = ssl.org_id
 WHERE ssl.status IN ('sent', 'completed', 'replied')
   AND ssl.fired_at >= now() - INTERVAL '7 days'
 GROUP BY o.name, p.email, p.company_name
HAVING COUNT(*) > 3
 ORDER BY touches_7d DESC
 LIMIT 200;
