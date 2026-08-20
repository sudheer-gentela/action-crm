-- =====================================================================
-- 2026_124_evidence_and_note_attachments.sql
--
-- Files as evidence, files on notes, and media that survives retention.
--
-- THREE GAPS, ONE MIGRATION
--
--   1. EVIDENCE COULD ONLY EVER BE A WHATSAPP MESSAGE.
--      play_evidence.channel has permitted 'whatsapp' | 'email' | 'file' |
--      'manual' since 2026_111, but addPlayEvidence() opens with
--
--          if (!messageId) throw 'A WhatsApp message is required as evidence.'
--
--      so 'file' was aspirational. A foreman with a photo on his phone had
--      no way to attach it unless he first sent it to a WhatsApp group we
--      happened to be capturing.
--
--   2. WHATSAPP MEDIA WAS NEVER SNAPSHOTTED.
--      Accepting a photo message as evidence recorded snapshot_body (the
--      caption) and nothing about the picture. whatsapp_messages carries
--      media_expires_at and media_removed_at precisely because media is
--      reaped on a retention schedule — so proof-of-completion quietly
--      decays into a caption. The snapshot columns exist to stop exactly
--      this and simply did not cover media.
--
--   3. NOTES WERE TEXT-ONLY.
--      2026_120 gave a task running commentary. "The slab cracked here"
--      wants a photo attached to it.
--
-- WHERE THE BYTES GO: NOT HERE
--   Every one of the 21 bytea columns in this schema is an encrypted
--   secret (org_credentials.key_ciphertext and friends). There is no
--   precedent for file CONTENT in Postgres and this migration does not
--   create one. Uploads go to the org's Google Drive or OneDrive through
--   the existing projectFiles.uploadLocalFile() path, and what lands here
--   is a storage_files reference plus a snapshot of the file's identity.
--
--   Consequence, accepted deliberately: a project with no mapped upload
--   folder cannot take file evidence, and the API says so in those words.
--   Falling back to a blob table would put site photos into every nightly
--   backup and every restore.
--
-- SNAPSHOT COLUMNS ARE NOT REDUNDANCY
--   storage_file_id is the live link — it keeps the file openable, and it
--   goes NULL if the row is ever removed. snapshot_file_name /
--   snapshot_mime_type / snapshot_file_size / snapshot_web_url record what
--   the approver actually accepted. Same reasoning as the WhatsApp
--   snapshot: the link answers "can I open it", the snapshot answers "what
--   was signed off", and those diverge over time.
--
-- Run AFTER 2026_123.
--   psql "$DATABASE_URL" -f 2026_124_evidence_and_note_attachments.sql
-- =====================================================================

BEGIN;

-- ── 1. File evidence + media snapshots on play_evidence ──────────────

ALTER TABLE public.play_evidence
  ADD COLUMN IF NOT EXISTS storage_file_id     integer
    REFERENCES public.storage_files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS snapshot_file_name  text,
  ADD COLUMN IF NOT EXISTS snapshot_mime_type  text,
  ADD COLUMN IF NOT EXISTS snapshot_file_size  bigint,
  ADD COLUMN IF NOT EXISTS snapshot_web_url    text;

COMMENT ON COLUMN public.play_evidence.storage_file_id IS
  'The uploaded file accepted as evidence (channel = ''file''), or — for '
  'channel = ''whatsapp'' — the stored copy of that message''s media. Live link '
  'only: NULL once the storage_files row is gone. The snapshot_* columns carry '
  'what was actually accepted.';

COMMENT ON COLUMN public.play_evidence.snapshot_web_url IS
  'Provider URL as it stood at acceptance. Kept alongside storage_file_id '
  'because a file can be moved or unshared in Drive/OneDrive afterwards, and '
  'the audit record should still say what was approved.';

-- ── 2. Per-channel shape ─────────────────────────────────────────────
--
-- play_evidence_whatsapp_shape_chk said only "a whatsapp row cites a
-- message". Now that 'file' is real it needs the mirror rule, or a file
-- row with no file would be accepted as proof of nothing.
--
-- 'email' and 'manual' stay unconstrained: they are carried by note /
-- snapshot_body and predate this.
ALTER TABLE public.play_evidence
  DROP CONSTRAINT IF EXISTS play_evidence_whatsapp_shape_chk;

ALTER TABLE public.play_evidence
  ADD CONSTRAINT play_evidence_source_shape_chk CHECK (
        (channel <> 'whatsapp' OR whatsapp_message_id IS NOT NULL)
    AND (channel <> 'file'     OR storage_file_id     IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_play_evidence_storage_file
  ON public.play_evidence (storage_file_id)
  WHERE storage_file_id IS NOT NULL;

-- ── 3. Attachments on notes ──────────────────────────────────────────
--
-- A join table rather than a column on play_notes: "the slab cracked
-- here" is three photos from three angles, not one.
--
-- No revocation or soft delete of its own. A note is withdrawn as a
-- whole (play_notes.deleted_at) and its attachments go with it — an
-- attachment has no meaning apart from the sentence it illustrates.

CREATE TABLE IF NOT EXISTS public.play_note_attachments (
  id              serial PRIMARY KEY,
  org_id          integer NOT NULL
                    REFERENCES public.organizations(id) ON DELETE CASCADE,
  play_note_id    integer NOT NULL
                    REFERENCES public.play_notes(id) ON DELETE CASCADE,
  storage_file_id integer
                    REFERENCES public.storage_files(id) ON DELETE SET NULL,
  file_name       text NOT NULL,
  mime_type       text,
  file_size       bigint,
  web_url         text,
  uploaded_by     integer REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT play_note_attachments_name_not_blank_chk
    CHECK (btrim(file_name) <> '')
);

COMMENT ON TABLE public.play_note_attachments IS
  'Files attached to one note on a project checklist task. Content lives in the '
  'org''s Drive/OneDrive via storage_files; this row holds the reference plus a '
  'snapshot of the file''s identity so a withdrawn or moved file still reads as '
  'what was attached. Cascades with its note.';

CREATE INDEX IF NOT EXISTS idx_play_note_attachments_note
  ON public.play_note_attachments (play_note_id, created_at);

CREATE INDEX IF NOT EXISTS idx_play_note_attachments_org
  ON public.play_note_attachments (org_id);

-- ── 4. The immutability trigger learns about the new link ────────────
--
-- storage_file_id is ON DELETE SET NULL, and Postgres performs that as an
-- UPDATE — the same referential action that 2026_121 had to teach this
-- function about for whatsapp_message_id. Without this branch, deleting a
-- storage_files row that had been accepted as evidence would be refused by
-- an immutability rule that has nothing to do with it, and the file would
-- become undeletable.
--
-- Narrowly scoped exactly as before: the ONLY permitted change is a live
-- link going from set to NULL, with every other column carried through.
-- The snapshot survives, so the evidence still reads as what was accepted.

CREATE OR REPLACE FUNCTION public.play_evidence_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Unreachable while the trigger is UPDATE-only (2026_121); kept so that
  -- re-attaching DELETE cannot resurrect the cascade deadlock.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  -- Referential detach: a cited WhatsApp message or an accepted file is
  -- going away and its FK is SET NULL. Permitted for the link columns
  -- only, and only in the set -> NULL direction, so this cannot be used
  -- to launder an edit. See 2026_121 for the full reasoning.
  IF ( (OLD.whatsapp_message_id IS NOT NULL AND NEW.whatsapp_message_id IS NULL
        AND NEW.storage_file_id IS NOT DISTINCT FROM OLD.storage_file_id)
    OR (OLD.storage_file_id     IS NOT NULL AND NEW.storage_file_id     IS NULL
        AND NEW.whatsapp_message_id IS NOT DISTINCT FROM OLD.whatsapp_message_id) )
     AND NEW.id                       IS NOT DISTINCT FROM OLD.id
     AND NEW.org_id                   IS NOT DISTINCT FROM OLD.org_id
     AND NEW.project_play_instance_id IS NOT DISTINCT FROM OLD.project_play_instance_id
     AND NEW.channel                  IS NOT DISTINCT FROM OLD.channel
     AND NEW.snapshot_body            IS NOT DISTINCT FROM OLD.snapshot_body
     AND NEW.snapshot_sender          IS NOT DISTINCT FROM OLD.snapshot_sender
     AND NEW.snapshot_sent_at         IS NOT DISTINCT FROM OLD.snapshot_sent_at
     AND NEW.snapshot_thread_id       IS NOT DISTINCT FROM OLD.snapshot_thread_id
     AND NEW.snapshot_file_name       IS NOT DISTINCT FROM OLD.snapshot_file_name
     AND NEW.snapshot_mime_type       IS NOT DISTINCT FROM OLD.snapshot_mime_type
     AND NEW.snapshot_file_size       IS NOT DISTINCT FROM OLD.snapshot_file_size
     AND NEW.snapshot_web_url         IS NOT DISTINCT FROM OLD.snapshot_web_url
     AND NEW.note                     IS NOT DISTINCT FROM OLD.note
     AND NEW.accepted_by              IS NOT DISTINCT FROM OLD.accepted_by
     AND NEW.accepted_at              IS NOT DISTINCT FROM OLD.accepted_at
     AND NEW.revoked_at               IS NOT DISTINCT FROM OLD.revoked_at
     AND NEW.revoked_by               IS NOT DISTINCT FROM OLD.revoked_by
     AND NEW.revoke_reason            IS NOT DISTINCT FROM OLD.revoke_reason
  THEN
    RETURN NEW;
  END IF;

  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'play_evidence % is already revoked and cannot be changed', OLD.id;
  END IF;

  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'play_evidence % is immutable; the only permitted update is a revocation', OLD.id;
  END IF;

  IF NEW.id                       IS DISTINCT FROM OLD.id
     OR NEW.org_id                IS DISTINCT FROM OLD.org_id
     OR NEW.project_play_instance_id IS DISTINCT FROM OLD.project_play_instance_id
     OR NEW.channel               IS DISTINCT FROM OLD.channel
     OR NEW.whatsapp_message_id   IS DISTINCT FROM OLD.whatsapp_message_id
     OR NEW.storage_file_id       IS DISTINCT FROM OLD.storage_file_id
     OR NEW.snapshot_body         IS DISTINCT FROM OLD.snapshot_body
     OR NEW.snapshot_sender       IS DISTINCT FROM OLD.snapshot_sender
     OR NEW.snapshot_sent_at      IS DISTINCT FROM OLD.snapshot_sent_at
     OR NEW.snapshot_thread_id    IS DISTINCT FROM OLD.snapshot_thread_id
     OR NEW.snapshot_file_name    IS DISTINCT FROM OLD.snapshot_file_name
     OR NEW.snapshot_mime_type    IS DISTINCT FROM OLD.snapshot_mime_type
     OR NEW.snapshot_file_size    IS DISTINCT FROM OLD.snapshot_file_size
     OR NEW.snapshot_web_url      IS DISTINCT FROM OLD.snapshot_web_url
     OR NEW.note                  IS DISTINCT FROM OLD.note
     OR NEW.accepted_by           IS DISTINCT FROM OLD.accepted_by
     OR NEW.accepted_at           IS DISTINCT FROM OLD.accepted_at
  THEN
    RAISE EXCEPTION 'play_evidence % is immutable; only the revocation fields may be set', OLD.id;
  END IF;

  RETURN NEW;
END $$;

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────

\echo ''
\echo '=== New play_evidence columns ==='
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'play_evidence'
   AND column_name IN ('storage_file_id','snapshot_file_name','snapshot_mime_type',
                       'snapshot_file_size','snapshot_web_url')
 ORDER BY column_name;

\echo ''
\echo '=== Shape constraint now covers both sources ==='
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'public.play_evidence'::regclass AND contype = 'c'
 ORDER BY conname;

\echo ''
\echo '=== play_note_attachments ==='
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name = 'play_note_attachments' ORDER BY ordinal_position;

\echo ''
\echo '=== Projects that can take file evidence today ==='
\echo '(a project needs a mapped folder flagged is_upload_target)'
SELECT count(*) FILTER (WHERE pf.id IS NOT NULL) AS projects_with_upload_folder,
       count(*)                                  AS projects_total
  FROM public.sales_handovers h
  LEFT JOIN public.project_folders pf
         ON pf.handover_id = h.id AND pf.is_upload_target;

\echo ''
\echo '=== Existing whatsapp evidence with media that predates snapshotting ==='
SELECT count(*) AS accepted_photos_without_a_snapshot
  FROM public.play_evidence e
  JOIN public.whatsapp_messages m ON m.id = e.whatsapp_message_id
 WHERE e.storage_file_id IS NULL
   AND m.storage_file_id IS NOT NULL;
