-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_107_whatsapp_session_media.sql
--
-- Session-captured attachments. Everything the media pipeline needs to work on
-- a message that never went through the Cloud API.
--
-- WHY THIS EXISTS
--   whatsappMedia.service fetches by wa_media_id from graph.facebook.com with
--   the Cloud API token. A session-captured message has no wa_media_id — the
--   Baileys socket never talks to Graph — so captureMessage returned
--   'skipped: no attachment' and every group attachment was silently dropped.
--
--   Baileys hands us a different set of coordinates: mediaKey, directPath and
--   the two SHA-256 digests. Those are what the WhatsApp CDN and the AES
--   decryption need. They are stored here so a fetch can be RETRIED after a
--   worker restart — without them, one missed download is permanent.
--
-- THE mediaKey IS A DECRYPTION KEY, AND IT IS NOW AT REST
--   Say it plainly rather than discover it in an audit. session_media_ref
--   holds the symmetric key for the ciphertext sitting on WhatsApp's CDN.
--   Anyone with this column and the directPath can decrypt the attachment for
--   as long as the CDN keeps it.
--
--   It is stored anyway, because the alternative is worse: the key would live
--   only in worker memory, and a deploy or a crash between capture and upload
--   would lose the file with no way to ask for it again (see below — we do not
--   ask). The mitigation is lifetime, not secrecy: the row is cleared the
--   moment the bytes are safely in the customer's storage, and cleared again
--   when the media expires. See clear_session_media_ref() at the end.
--
-- EXPIRY IS SHORTER HERE, AND LESS CERTAIN
--   Meta documents ~30 days for Cloud API media. WhatsApp's CDN retention for
--   companion-device media is not documented at all; observed behaviour is
--   roughly two weeks, and the usual recovery move — asking the sending device
--   to re-upload via updateMediaMessage — is deliberately not available to us,
--   because a bot that requests re-uploads is transmitting, not observing.
--
--   So: a separate, shorter, per-session retention window, defaulting to 14
--   days. An estimate that is too short costs a needless 'expired' mark on
--   something still fetchable; too long parks dead rows in the retry queue
--   forever. Short is the cheaper mistake.
--
-- Safe to run more than once.
-- REQUIRES: 2026_95, 2026_96, 2026_97 (media columns) and 2026_101 (sessions).
-- NUMBERING: 106 = whatsapp_group_minimization. This is 107.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 0. Preflight ─────────────────────────────────────────────────────────────
--
-- Two separate checks with two separate messages. "column does not exist"
-- followed by four "current transaction is aborted" lines says what broke but
-- not which file to run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'whatsapp_messages'
       AND column_name = 'wa_media_id'
  ) THEN
    RAISE EXCEPTION
      'Migration 2026_97_media_autocapture.sql has not been applied.'
      USING HINT = 'psql $DATABASE_URL -f backend/db/2026_97_media_autocapture.sql';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'whatsapp_session_groups'
  ) THEN
    RAISE EXCEPTION
      'Migration 2026_101_whatsapp_session_capture.sql has not been applied.'
      USING HINT = 'psql $DATABASE_URL -f backend/db/2026_101_whatsapp_session_capture.sql';
  END IF;
END $$;

-- ── 1. Which transport this attachment came in on ───────────────────────────
--
-- Not derivable from wa_media_id being null: a Cloud API text message also has
-- no media id. The pipeline has to distinguish "no attachment" from "an
-- attachment we fetch a different way", and those were the same value before.
--
-- capture_source (2026_101) already records how the MESSAGE arrived. This is
-- about the MEDIA specifically, and they can legitimately differ — a message
-- moved between threads keeps its original media provenance.

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS media_source text;

ALTER TABLE public.whatsapp_messages
  DROP CONSTRAINT IF EXISTS whatsapp_messages_media_source_chk;
ALTER TABLE public.whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_media_source_chk
  CHECK (media_source IS NULL OR media_source IN ('cloud_api', 'session'));

COMMENT ON COLUMN public.whatsapp_messages.media_source IS
  'cloud_api = fetch by wa_media_id from graph.facebook.com with the WABA token. session = fetch by mediaKey/directPath from the WhatsApp CDN, which only the Baileys worker can do. NULL = no attachment on this message.';

-- Backfill: every existing row with a media id came in over the Cloud API.
UPDATE public.whatsapp_messages
   SET media_source = 'cloud_api'
 WHERE wa_media_id IS NOT NULL AND media_source IS NULL;

-- ── 2. The session fetch coordinates ─────────────────────────────────────────
--
-- One jsonb rather than six columns. These five fields are a single opaque
-- descriptor handed to Baileys' downloadContentFromMessage as a unit — nothing
-- queries mediaKey independently, and splitting them would invite exactly the
-- partial-write bug (a directPath with a stale mediaKey) that decrypts to
-- garbage and reports success.
--
-- Shape:
--   { mediaType, mediaKey, directPath, fileEncSha256, fileSha256, url?,
--     fileLength?, mimetype?, fileName?, capturedAt }
--   mediaKey / fileEncSha256 / fileSha256 are base64 — jsonb has no bytea.

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS session_media_ref jsonb,
  ADD COLUMN IF NOT EXISTS media_file_size   bigint;

COMMENT ON COLUMN public.whatsapp_messages.session_media_ref IS
  'Baileys media descriptor: mediaType, mediaKey (base64 — a DECRYPTION KEY), directPath, fileEncSha256, fileSha256. Held only until the bytes reach the customer''s storage, then cleared. Never populated for Cloud API media.';
COMMENT ON COLUMN public.whatsapp_messages.media_file_size IS
  'Declared size from the sender, before download. Lets the size gate reject an oversized attachment without spending bandwidth on it.';

-- The worker's fetch queue: session media still worth downloading. Narrow and
-- partial, because this is polled on every heartbeat.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_session_media_pending
  ON public.whatsapp_messages (media_expires_at NULLS LAST, id)
  WHERE media_source = 'session' AND media_status IN ('pending', 'failed');

-- The sweep, for session rows. The 2026_97 index is partial on
-- wa_media_id IS NOT NULL and therefore cannot serve these at all.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_session_media_expiry
  ON public.whatsapp_messages (media_expires_at)
  WHERE media_source = 'session' AND media_status IN ('pending', 'failed');

-- ── 3. Per-session media settings ────────────────────────────────────────────
--
-- capture_media (2026_101) is the on/off switch and already exists. These are
-- the two numbers that need to differ per session:
--
--   media_max_bytes      A worker holds a live Signal socket. A 90 MB video
--                        decrypted into its heap is a real risk to the socket,
--                        which is the expensive thing to lose — far more
--                        expensive than one skipped video. 25 MB covers
--                        essentially every document and photo that matters to
--                        an implementation project.
--
--   media_retention_days How long we believe the CDN will keep it. See the
--                        header. Not a fact; an estimate we can retune per
--                        session when observation says otherwise.

ALTER TABLE public.whatsapp_sessions
  ADD COLUMN IF NOT EXISTS media_max_bytes      bigint  NOT NULL DEFAULT 26214400,
  ADD COLUMN IF NOT EXISTS media_retention_days integer NOT NULL DEFAULT 14;

ALTER TABLE public.whatsapp_sessions
  DROP CONSTRAINT IF EXISTS whatsapp_sessions_media_chk;
ALTER TABLE public.whatsapp_sessions
  ADD CONSTRAINT whatsapp_sessions_media_chk CHECK (
    media_max_bytes      BETWEEN 1048576 AND 104857600 AND
    media_retention_days BETWEEN 1 AND 30
  );

COMMENT ON COLUMN public.whatsapp_sessions.media_max_bytes IS
  'Largest session attachment the worker will download. Default 25 MB. Above it the message is marked skipped with the size in the reason, so the loss is visible and a human can raise the cap and retry rather than wonder where the file went.';
COMMENT ON COLUMN public.whatsapp_sessions.media_retention_days IS
  'Assumed WhatsApp CDN retention for companion-device media, in days. Default 14. Only an estimate: WhatsApp does not document it, and updateMediaMessage — the re-upload request that would remove the guesswork — is deliberately never called, because it makes the session transmit.';

-- ── 4. Per-group media policy ────────────────────────────────────────────────
--
-- Watching a group is a decision about TEXT. Whether its attachments are also
-- written into the customer's Drive is a second, larger decision — one group
-- may be a document-heavy implementation channel and the next a scheduling
-- chat where the photos are lunch.
--
-- 'inherit' is the default so nothing changes behaviour on migration: the
-- session switch and the project's media_capture_mode still decide. A PM
-- overrides one group at a time from triage.

ALTER TABLE public.whatsapp_session_groups
  ADD COLUMN IF NOT EXISTS media_policy    text NOT NULL DEFAULT 'inherit',
  ADD COLUMN IF NOT EXISTS media_policy_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS media_policy_at timestamp with time zone;

ALTER TABLE public.whatsapp_session_groups
  DROP CONSTRAINT IF EXISTS whatsapp_session_groups_media_policy_chk;
ALTER TABLE public.whatsapp_session_groups
  ADD CONSTRAINT whatsapp_session_groups_media_policy_chk
  CHECK (media_policy IN ('inherit', 'all', 'documents', 'none'));

COMMENT ON COLUMN public.whatsapp_session_groups.media_policy IS
  'inherit (default) = follow the session switch and the project''s media_capture_mode. all = capture every attachment. documents = capture documents only; photos, video, audio and stickers are marked skipped, not lost quietly. none = capture no attachments from this group.';
COMMENT ON COLUMN public.whatsapp_session_groups.media_policy_by IS
  'Who set the override. A group whose attachments are not being captured should be answerable to a person, not to a default.';

-- ── 5. Removal audit ─────────────────────────────────────────────────────────
--
-- removeStoredMedia deletes the storage_files row and sets storage_file_id to
-- NULL. That is correct — a dangling pointer to a deleted file is worse than
-- none — but it destroys the only record of WHAT was removed. After the fact
-- the row says a file existed and is gone, and nothing else.
--
-- These columns snapshot the identity before it is dropped. media_reviewed_by
-- (2026_96) already records who and when; it does not distinguish Keep from
-- Remove and holds nothing about the file itself.
--
-- provider_file_id is kept deliberately: it is what a customer's own admin
-- needs to find the item in their Drive or OneDrive recycle bin. "Deleted" on
-- both providers means recoverable for ~30 days, and a removal made in error
-- is answerable for exactly that long — if we recorded the id.

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS media_removed_by          integer REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS media_removed_at          timestamp with time zone,
  ADD COLUMN IF NOT EXISTS media_removed_reason      text,
  ADD COLUMN IF NOT EXISTS media_removed_file_name   text,
  ADD COLUMN IF NOT EXISTS media_removed_provider    text,
  ADD COLUMN IF NOT EXISTS media_removed_file_ref    text,
  ADD COLUMN IF NOT EXISTS media_removed_from_provider boolean;

COMMENT ON COLUMN public.whatsapp_messages.media_removed_file_ref IS
  'The provider file id of the deleted file. Kept so a removal can be traced into the customer''s own recycle bin, where both Drive and OneDrive hold it for around 30 days. Without it an accidental removal is unrecoverable the moment the row is nulled.';
COMMENT ON COLUMN public.whatsapp_messages.media_removed_from_provider IS
  'true = we deleted it from the customer''s storage. false = we could not (already gone, permission lost, token revoked) and only the project link was dropped, so the file may still exist in their Drive. Two very different facts to report to whoever asks later.';

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_media_removed
  ON public.whatsapp_messages (org_id, media_removed_at DESC)
  WHERE media_removed_at IS NOT NULL;

-- ── 6. Drop the key once it is no longer needed ──────────────────────────────
--
-- A trigger rather than application code, because there are three paths that
-- reach a terminal media state (capture, removal, the expiry sweep) and a key
-- left behind by the one path somebody forgot is a key at rest forever.
--
-- 'stored' means the bytes are in the customer's storage and the CDN copy is
-- of no further use to us. 'expired' and 'removed' mean there is nothing to
-- fetch. 'skipped' and 'failed' KEEP the ref — that is the whole point of
-- storing it, so a retry after the gap is closed can still work.

CREATE OR REPLACE FUNCTION public.clear_session_media_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.session_media_ref IS NOT NULL
     AND NEW.media_status IN ('stored', 'expired', 'removed') THEN
    NEW.session_media_ref := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clear_session_media_ref ON public.whatsapp_messages;
CREATE TRIGGER trg_clear_session_media_ref
  BEFORE INSERT OR UPDATE OF media_status ON public.whatsapp_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.clear_session_media_ref();

COMMENT ON FUNCTION public.clear_session_media_ref() IS
  'Drops the mediaKey once the attachment is stored, expired or removed. The key only needs to outlive the download; keeping it afterwards is a decryption key at rest with no remaining purpose.';

-- Anything already terminal predates this trigger.
UPDATE public.whatsapp_messages
   SET session_media_ref = NULL
 WHERE session_media_ref IS NOT NULL
   AND media_status IN ('stored', 'expired', 'removed');

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY (read-only — safe to run against production)
-- ─────────────────────────────────────────────────────────────────────────────
--
--   -- New columns present?
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'whatsapp_messages'
--      AND column_name IN ('media_source','session_media_ref','media_file_size',
--                          'media_removed_by','media_removed_file_ref')
--    ORDER BY column_name;
--
--   -- Backfill sane? Every existing attachment should read cloud_api.
--   SELECT media_source, media_status, count(*)
--     FROM whatsapp_messages
--    WHERE wa_media_id IS NOT NULL OR session_media_ref IS NOT NULL
--    GROUP BY 1,2 ORDER BY 1,2;
--
--   -- No key left on a terminal row.
--   SELECT count(*) AS should_be_zero FROM whatsapp_messages
--    WHERE session_media_ref IS NOT NULL
--      AND media_status IN ('stored','expired','removed');
--
--   -- The stranded-media case this unblocks (message 226 and its kin):
--   -- skipped, and the project now HAS an upload target.
--   SELECT m.id, m.media_status, m.media_error
--     FROM whatsapp_messages m
--     JOIN whatsapp_threads t ON t.id = m.thread_id
--     JOIN project_folders pf
--       ON pf.handover_id = COALESCE(m.handover_id, t.handover_id)
--      AND pf.is_upload_target
--    WHERE m.media_status = 'skipped'
--    ORDER BY m.id;
-- ─────────────────────────────────────────────────────────────────────────────
