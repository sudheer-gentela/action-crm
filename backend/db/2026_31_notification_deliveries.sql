-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_31_notification_deliveries.sql
--
-- Persistent audit of WHO was notified, WHEN, and via WHICH channel — the
-- in-app equivalent of the "results" object the marketing site's form handler
-- (api/submit.js) threw away after logging form-fills to a spreadsheet. Here it
-- lives in the app DB, queryable, instead of a sheet.
--
-- One row per delivery ATTEMPT. The same logical notification can produce
-- several rows (e.g. an in_app row AND an email row for the same alert).
-- Channels: 'in_app' | 'email' | 'slack' | 'teams'.
-- Status:   'sent'   | 'failed' | 'skipped' (skipped = transport not configured).
--
-- notification_id optionally links back to notifications.id (the in-app row);
-- left NULL for channels that have no notifications-table entry.
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.notification_deliveries (
  id              serial PRIMARY KEY,
  org_id          integer NOT NULL,
  user_id         integer,
  notification_id integer,
  channel         varchar(20) NOT NULL,
  recipient       text,
  subject         text,
  status          varchar(20) NOT NULL DEFAULT 'sent',
  reason          text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_notif_delivery_channel CHECK (channel IN ('in_app','email','slack','teams')),
  CONSTRAINT chk_notif_delivery_status  CHECK (status  IN ('sent','failed','skipped'))
);

CREATE INDEX IF NOT EXISTS idx_notif_deliveries_org_created
  ON public.notification_deliveries (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_deliveries_user_created
  ON public.notification_deliveries (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_deliveries_notification
  ON public.notification_deliveries (notification_id);

COMMENT ON TABLE public.notification_deliveries IS
  'Audit log of notification delivery attempts: who/when/channel/status. One row per attempt; multiple channels per logical notification.';

COMMIT;
