-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_103_whatsapp_session_watchlist.sql
--
-- Separates DISCOVERY from CAPTURE.
--
-- WHY
--   The first pilot linked a real personal number and catalogued 306 groups.
--   Under the original model every one of those was captured until a human
--   marked it 'ignored' — so family, society and school chatter landed in
--   whatsapp_messages before anyone had a chance to say no. That is the wrong
--   default: it makes the safe outcome depend on someone reacting fast enough.
--
--   Discovery is cheap and harmless: the worker asks WhatsApp which groups the
--   number belongs to and stores names, JIDs and participant counts. Capture is
--   the part that stores what people said. They should not be the same switch.
--
-- THE MODEL
--   capture_mode = 'allowlist'  (default) — catalogue every group, but store
--                                messages ONLY from groups explicitly watched.
--   capture_mode = 'all'                  — store everything except groups
--                                explicitly ignored. The old behaviour, kept
--                                for a dedicated SIM where every group really
--                                is project traffic.
--
--   'allowlist' is the default because the failure mode of the wrong default
--   matters: forgetting to watch a group loses some history, forgetting to
--   ignore one captures a family conversation into a customer's CRM.
--
-- IDEMPOTENT: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.whatsapp_sessions
  ADD COLUMN IF NOT EXISTS capture_mode text NOT NULL DEFAULT 'allowlist';

ALTER TABLE public.whatsapp_sessions
  DROP CONSTRAINT IF EXISTS whatsapp_sessions_capture_mode_chk;
ALTER TABLE public.whatsapp_sessions
  ADD  CONSTRAINT whatsapp_sessions_capture_mode_chk
  CHECK (capture_mode IN ('allowlist', 'all'));

COMMENT ON COLUMN public.whatsapp_sessions.capture_mode IS
  'allowlist = store messages only from is_watched groups (default; safe on a number with unrelated groups). all = store everything except binding_status=''ignored'' (only sane on a dedicated SIM).';

ALTER TABLE public.whatsapp_session_groups
  ADD COLUMN IF NOT EXISTS is_watched   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS watched_by   integer REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS watched_at   timestamp with time zone,
  -- Set at discovery so the UI can say "seen in the initial catalogue" versus
  -- "this group has been active since you connected", which is the single most
  -- useful sort when there are hundreds of rows.
  ADD COLUMN IF NOT EXISTS discovered_via text NOT NULL DEFAULT 'message';

ALTER TABLE public.whatsapp_session_groups
  DROP CONSTRAINT IF EXISTS wa_session_groups_discovered_chk;
ALTER TABLE public.whatsapp_session_groups
  ADD  CONSTRAINT wa_session_groups_discovered_chk
  CHECK (discovered_via IN ('snapshot', 'message', 'metadata'));

COMMENT ON COLUMN public.whatsapp_session_groups.is_watched IS
  'Explicit opt-in to storing message content from this group. In allowlist mode this is the ONLY thing that permits capture — binding to a project does not imply it, because someone may want to review a group before its contents are retained.';

-- The hot path: every inbound message asks "may I store this?".
CREATE INDEX IF NOT EXISTS idx_wa_session_groups_watched
  ON public.whatsapp_session_groups (session_id, group_jid)
  INCLUDE (is_watched, binding_status);

-- Anything already bound to a project was a deliberate choice, so grandfather
-- it in rather than silently switching off capture on an upgrade.
UPDATE public.whatsapp_session_groups
   SET is_watched = true, watched_at = COALESCE(watched_at, bound_at, now())
 WHERE binding_status = 'bound' AND is_watched = false;

COMMIT;
