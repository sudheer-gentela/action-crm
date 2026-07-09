-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_48_capacity_model.sql
--
-- Phase 0 of the capacity-model rework. Three independent changes:
--
--   1. sequence_step_logs.sender_account_id — sender attribution, stamped at
--      CLAIM time. Prerequisite for per-(campaign, sender) fair-share ordering
--      in SequenceStepFirer (Phase 3). Attribution exists today only via
--      sequence_step_logs.email_id -> emails.sender_account_id, which (a) is
--      NULL for rows still 'scheduled'/'sending', so in-flight claims are
--      invisible to a fairness counter, and (b) costs a 3-way join in the
--      firer's hot path.
--
--   2. chk_se_active_has_due — an ACTIVE enrollment must have a next_step_due.
--      The firer selects `WHERE se.status='active' AND se.next_step_due IS NOT
--      NULL`, so an active row with a NULL due time is inert: it can never
--      fire, and nothing repairs it (the repair loop itself requires
--      next_step_due IS NOT NULL and channel IN ('linkedin','task','call')).
--      bulk-activate produced exactly these rows when scheduleBatchSlots
--      returned fewer slots than candidates.
--
--   3. Per-rep LinkedIn connection cap seed. Storage is
--      user_preferences.preferences.outreach.linkedinConnectionCap — no DDL
--      needed (preferences is jsonb). This migration only documents the key
--      and provides the optional backfill. user_linkedin_seats was considered
--      and rejected: seat rows exist only once the Chrome extension has seen
--      the rep, but manual LinkedIn steps need no seat, so a rep with no seat
--      would have no way to override the org default.
--
-- NOT dropped here: prospecting_campaigns.share_weight and
-- chk_pc_share_weight. The weighted-split code is removed in this release but
-- the column stays one more release so the change is reversible. Drop in a
-- follow-up once the new model has run in production.
--
-- Idempotent. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Sender attribution on step logs ──────────────────────────────────────

ALTER TABLE public.sequence_step_logs
  ADD COLUMN IF NOT EXISTS sender_account_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ssl_sender_account'
  ) THEN
    ALTER TABLE public.sequence_step_logs
      ADD CONSTRAINT fk_ssl_sender_account
      FOREIGN KEY (sender_account_id)
      REFERENCES public.prospecting_sender_accounts(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Fair-share counter reads: "sends today for (campaign, sender)". campaign_id
-- lives on prospects, so the log side is keyed by sender + time.
CREATE INDEX IF NOT EXISTS idx_ssl_sender_fired
  ON public.sequence_step_logs (sender_account_id, fired_at)
  WHERE sender_account_id IS NOT NULL;

-- ── 1b. Effective step intent on the log row ────────────────────────────────
--
-- sequence_steps.step_intent is the AUTHORED intent and is frequently NULL --
-- the builder's "Auto" default. The firer resolves the EFFECTIVE intent at fire
-- time via resolveEffectiveLinkedinIntent(), which infers connection_request
-- from step position + engagement history. That inference needs the full step
-- list and engagement history, so it cannot be replayed cheaply over history.
--
-- Persist the resolved intent on the log so "how many connection requests has
-- this rep sent today" is one indexed count instead of an N-row re-inference.
ALTER TABLE public.sequence_step_logs
  ADD COLUMN IF NOT EXISTS step_intent text;

-- Backfill only where the AUTHORED intent was explicit. Rows left NULL are
-- simply absent from the counter; the cap under-counts for at most one day,
-- then self-heals as new rows are stamped.
UPDATE public.sequence_step_logs l
   SET step_intent = ss.step_intent
  FROM public.sequence_steps ss
 WHERE ss.id = l.sequence_step_id
   AND l.step_intent IS NULL
   AND ss.step_intent IS NOT NULL;

-- LinkedIn connection-request counter reads: "requests released today".
-- Scoped per rep by joining sequence_enrollments.enrolled_by. Partial --
-- connection requests are a small slice of the table.
-- fired_at is NULL on 'draft' and 'scheduled' rows, so the counter anchors on
-- COALESCE(fired_at, scheduled_send_at) -- the moment the request was RELEASED
-- into the rep's day. Index the same expression or the partial index is unused.
CREATE INDEX IF NOT EXISTS idx_ssl_li_connreq_released
  ON public.sequence_step_logs (org_id, (COALESCE(fired_at, scheduled_send_at)))
  WHERE channel = 'linkedin' AND step_intent = 'connection_request';

-- Fair-share counter reads: email sends today per (campaign, sender). The
-- campaign side comes from prospects.campaign_id, so index prospect + time.
CREATE INDEX IF NOT EXISTS idx_ssl_email_fired
  ON public.sequence_step_logs (prospect_id, fired_at)
  WHERE channel = 'email' AND status IN ('sending', 'sent');

-- Backfill historical rows from the emails table. Only 'sent' rows can be
-- attributed; scheduled/sending rows predating this column stay NULL and are
-- simply absent from the fairness counter (they resolve on their next claim).
UPDATE public.sequence_step_logs l
   SET sender_account_id = e.sender_account_id
  FROM public.emails e
 WHERE l.email_id = e.id
   AND l.sender_account_id IS NULL
   AND e.sender_account_id IS NOT NULL;

-- ── 2. Active enrollments must be schedulable ───────────────────────────────
--
-- NOT VALID so the migration cannot fail the deploy on legacy rows. Existing
-- violators are the inert enrollments described above. Find them first:
--
--   SELECT e.id, p.campaign_id, e.sequence_id, e.enrolled_at
--     FROM sequence_enrollments e
--     JOIN prospects p ON p.id = e.prospect_id
--    WHERE e.status = 'active' AND e.next_step_due IS NULL;
--
-- Then either delete them (they were never executable) or stamp a due time,
-- and only afterwards run:
--
--   ALTER TABLE public.sequence_enrollments
--     VALIDATE CONSTRAINT chk_se_active_has_due;
--
-- NOT VALID still enforces the check on all INSERTs and UPDATEs from the
-- moment it is added — it only skips the scan of existing rows.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_se_active_has_due'
  ) THEN
    ALTER TABLE public.sequence_enrollments
      ADD CONSTRAINT chk_se_active_has_due
      CHECK (status <> 'active' OR next_step_due IS NOT NULL)
      NOT VALID;
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- POST-DEPLOY CHECKS (run manually, not part of the transaction)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- (a) Inert-enrollment count. Must be 0 before VALIDATE CONSTRAINT.
--
--   SELECT COUNT(*) FROM sequence_enrollments
--    WHERE status = 'active' AND next_step_due IS NULL;
--
-- (b) Shared-mailbox exposure. Any row here means two reps have connected the
--     SAME physical mailbox as separate sender rows with independent
--     emails_sent_today counters — today that mailbox sends 2x its stated
--     daily limit. Phase 1 makes the limit a property of the address, which
--     REDUCES effective capacity for these orgs. Correct, but it will read as
--     a regression to them. Know who they are before shipping Phase 1.
--
--   SELECT org_id, lower(email) AS mailbox, COUNT(*) AS rows,
--          SUM(COALESCE(daily_limit, 50)) AS combined_stated_limit
--     FROM prospecting_sender_accounts
--    WHERE client_id IS NULL AND is_active = true
--    GROUP BY 1, 2
--   HAVING COUNT(*) > 1;
--
-- (c) Optional: seed a per-rep LinkedIn connection cap. Resolution order is
--     user pref -> org config.linkedinReleaseCap -> 25. Leaving it unset is
--     fine; the org default applies.
--
--   INSERT INTO user_preferences (user_id, org_id, preferences)
--   VALUES (17, 112, '{"outreach":{"linkedinConnectionCap":20}}'::jsonb)
--   ON CONFLICT (user_id, org_id) DO UPDATE
--     SET preferences = jsonb_set(
--           user_preferences.preferences,
--           '{outreach,linkedinConnectionCap}',
--           '20'::jsonb,
--           true
--         ),
--         updated_at = CURRENT_TIMESTAMP;
--
-- (d) Sanity: campaign 10's capacity should now be non-zero regardless of
--     share_weight, because the weighted branch is gone.
