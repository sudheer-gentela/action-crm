-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_86_push_subscriptions.sql
--
-- Web push subscriptions, plus the 'push' channel on notification_deliveries.
--
-- One row per browser-and-device. A single user legitimately has several: work
-- laptop Chrome, phone PWA, tablet. The endpoint URL is the natural key — the
-- push service issues it and it is globally unique — so re-subscribing from the
-- same browser updates the existing row rather than accumulating duplicates.
--
-- Subscriptions expire. A push service returns 404 or 410 for an endpoint that
-- is dead, and webPush.service.js deletes the row when that happens. failure_count
-- covers the softer case: transient 5xx that never resolves. Nothing here needs a
-- cron job to stay clean.
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id             serial PRIMARY KEY,
  org_id         integer NOT NULL,
  user_id        integer NOT NULL,
  endpoint       text NOT NULL,
  p256dh         text NOT NULL,
  auth           text NOT NULL,
  user_agent     text,
  failure_count  integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  CONSTRAINT uq_push_subscriptions_endpoint UNIQUE (endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user
  ON public.push_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_push_subs_org
  ON public.push_subscriptions (org_id);

-- ── Extend the delivery-log channel constraint ──────────────────────────────
-- notification_deliveries currently allows in_app | email | slack | teams.
-- Push deliveries are logged the same way as every other channel, so the
-- CHECK has to admit the new value. Dropping and recreating is the only way to
-- widen a CHECK in Postgres.

ALTER TABLE public.notification_deliveries
  DROP CONSTRAINT IF EXISTS chk_notif_delivery_channel;

ALTER TABLE public.notification_deliveries
  ADD CONSTRAINT chk_notif_delivery_channel
  CHECK (channel IN ('in_app','email','slack','teams','push'));

COMMIT;
