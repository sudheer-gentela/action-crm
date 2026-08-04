-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_102_whatsapp_session_config.sql
--
-- Per-session runtime configuration and liveness tracking.
--
-- WHY CONFIG LIVES IN THE DATABASE, NOT ENV VARS
--   The first cut read poll and flush intervals from process.env on the worker.
--   That means every tuning change is a Railway variable edit plus a redeploy —
--   and a redeploy tears down the WhatsApp socket, which is the one thing we are
--   trying to keep alive. Reading them per-session lets an admin change a
--   polling interval from the UI while the socket stays up.
--
-- WHY heartbeat_at IS SEPARATE FROM last_seen_at
--   last_seen_at moves when something HAPPENS — a message, a status change. A
--   socket that has silently died is indistinguishable from a quiet weekend by
--   that column alone. heartbeat_at is written on a timer regardless of
--   traffic, so staleness means the worker is genuinely not running rather
--   than nobody having messaged.
--
-- IDEMPOTENT: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.whatsapp_sessions
  -- Liveness, written on a timer by the worker.
  ADD COLUMN IF NOT EXISTS heartbeat_at            timestamp with time zone,

  -- How often the worker proves it is alive. Lower = faster detection of a
  -- dead socket, at the cost of one tiny request per interval.
  ADD COLUMN IF NOT EXISTS heartbeat_seconds       integer NOT NULL DEFAULT 60,

  -- How long the worker buffers captured messages before POSTing them. Higher
  -- batches better on a busy group; lower gets a message into the CRM sooner.
  ADD COLUMN IF NOT EXISTS flush_interval_ms       integer NOT NULL DEFAULT 2000,
  ADD COLUMN IF NOT EXISTS batch_max               integer NOT NULL DEFAULT 50,

  -- Watchdog: if the socket produces no event of any kind for this long while
  -- claiming to be connected, tear it down and reconnect. Baileys can hold a
  -- TCP connection that WhatsApp has actually abandoned; without this the
  -- session looks healthy forever and captures nothing.
  ADD COLUMN IF NOT EXISTS stale_socket_minutes    integer NOT NULL DEFAULT 20,

  -- Reconnect backoff ceiling.
  ADD COLUMN IF NOT EXISTS reconnect_max_seconds   integer NOT NULL DEFAULT 300,

  -- Operational counters, useful for spotting a session that reconnects
  -- constantly (a sign the number is being rate-limited or contested).
  ADD COLUMN IF NOT EXISTS reconnect_count         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reconnect_at       timestamp with time zone,

  -- The 14-day rule: WhatsApp logs out every companion device if the PRIMARY
  -- handset is not opened for 14 days. Nothing in the protocol tells us when
  -- that happened, so a human confirms it and we count from there.
  ADD COLUMN IF NOT EXISTS phone_confirmed_by      integer REFERENCES public.users(id);

ALTER TABLE public.whatsapp_sessions
  DROP CONSTRAINT IF EXISTS whatsapp_sessions_config_chk;
ALTER TABLE public.whatsapp_sessions
  ADD  CONSTRAINT whatsapp_sessions_config_chk CHECK (
    heartbeat_seconds     BETWEEN 15  AND 3600  AND
    flush_interval_ms     BETWEEN 250 AND 60000 AND
    batch_max             BETWEEN 1   AND 500   AND
    stale_socket_minutes  BETWEEN 5   AND 1440  AND
    reconnect_max_seconds BETWEEN 10  AND 3600
  );

COMMENT ON COLUMN public.whatsapp_sessions.heartbeat_at IS
  'Written on a timer whether or not messages arrive. Staleness here means the worker is not running; staleness in last_seen_at only means nobody messaged.';
COMMENT ON COLUMN public.whatsapp_sessions.stale_socket_minutes IS
  'Watchdog threshold. Baileys can hold a socket WhatsApp has abandoned — connection.update never fires, messages never arrive, and status stays "connected". This is what catches that.';
COMMENT ON COLUMN public.whatsapp_sessions.phone_last_seen_at IS
  'When the PRIMARY handset was last confirmed opened. Not detectable from the protocol — set by a human via the admin UI. WhatsApp unlinks all companion devices at 14 days.';

-- Surfaces sessions the supervisor should be worried about, without every
-- caller re-deriving the staleness arithmetic.
CREATE OR REPLACE VIEW public.whatsapp_session_health AS
SELECT
  s.id,
  s.org_id,
  s.wa_phone,
  s.status,
  s.heartbeat_at,
  EXTRACT(EPOCH FROM (now() - s.heartbeat_at)) / 60          AS heartbeat_stale_minutes,
  EXTRACT(EPOCH FROM (now() - s.phone_last_seen_at)) / 86400 AS phone_stale_days,
  s.reconnect_count,
  s.last_reconnect_at,
  -- Two independent ways to be unhealthy: the worker stopped proving it is
  -- alive, or WhatsApp ended the session outright.
  (s.status = 'connected'
     AND s.heartbeat_at IS NOT NULL
     AND s.heartbeat_at < now() - (s.heartbeat_seconds * 3 || ' seconds')::interval
  ) AS heartbeat_stale,
  (s.status = 'logged_out') AS needs_rescan
FROM public.whatsapp_sessions s
WHERE s.status <> 'disabled';

COMMIT;
