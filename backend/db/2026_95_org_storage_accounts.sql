-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_95_org_storage_accounts.sql
--
-- Storing WhatsApp attachments in the customer's OWN cloud storage.
--
-- WHY THIS EXISTS AT ALL
--   WhatsApp media is the one case where GoWarm would hold the only copy. Meta
--   expires media in roughly 30 days and the download URL in minutes, so the
--   reference model that works for Drive and OneDrive files does not work here:
--   if the bytes are not captured at ingest they are gone permanently.
--
--   Rather than build byte storage, the media is written into the customer's own
--   Drive or OneDrive, into the folder already mapped to the project. It then
--   becomes an ordinary storage_files row and inherits everything project files
--   already do — tagging, precedence, hiding — with no copy held by us and no
--   second permission system, because the file inherits the mapped folder's
--   sharing.
--
-- WHY A SEPARATE ACCOUNT, AND WHY IT DIFFERS BY PROVIDER
--   Verified against both APIs before writing this:
--
--   Google — in My Drive the UPLOADER owns the file even when it lands in
--     someone else's folder. A "service account's folder" protects nothing.
--     Only a SHARED DRIVE transfers ownership to the drive, so Google needs no
--     storage account: map a Shared Drive folder and ownership is already safe.
--
--   OneDrive — items belong to the DRIVE they are stored in, not the uploader.
--     So a durable account's folder genuinely does protect the files, and a
--     service account (or an admin account that will not be deleted) is the
--     answer. Confirmed by test: Files.ReadWrite writes into a folder in its own
--     OneDrive, and a colleague the folder is shared with sees the result.
--
--   Same decision, opposite mechanisms — which is why this table is optional
--   per org and per provider rather than required.
--
-- WHOSE CREDENTIAL UPLOADS
--   The webhook has no signed-in user. Using the mapping creator's token would
--   mean capture stops silently the day they leave — and unlike a missing
--   reference, missing WhatsApp media cannot be recovered. So the credential
--   belongs to the org, not a person. Shape follows
--   prospecting_sender_accounts, which already solves exactly this: an OAuth
--   credential that is not the logged-in user's, kept alive by its own health
--   monitoring.
--
-- Safe to run more than once.
-- NUMBERING: 94 = email_project_tagging. This is 95.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. The org's storage account ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.org_storage_accounts (
  id              serial PRIMARY KEY,
  org_id          integer     NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider        varchar(50) NOT NULL,
  email           varchar(255),
  label           text,

  access_token    text NOT NULL,
  refresh_token   text,
  expires_at      timestamp with time zone,
  account_data    jsonb NOT NULL DEFAULT '{}'::jsonb,

  is_active       boolean NOT NULL DEFAULT true,

  -- Set when a refresh fails for a reason that is not transient. Capture stops,
  -- already-stored files are unaffected, and an admin is prompted to reconnect.
  -- Recorded rather than inferred, because "it silently stopped working" is the
  -- failure mode this whole table exists to avoid.
  last_error      text,
  last_error_at   timestamp with time zone,
  last_used_at    timestamp with time zone,

  connected_by    integer REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  updated_at      timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT org_storage_accounts_provider_chk
    CHECK (provider IN ('googledrive', 'onedrive')),

  -- One storage account per provider per org. Two would make "which account
  -- uploads this" ambiguous at the exact moment there is nobody to ask.
  CONSTRAINT uq_org_storage_accounts UNIQUE (org_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_org_storage_accounts_active
  ON public.org_storage_accounts (org_id, provider) WHERE is_active;

COMMENT ON TABLE public.org_storage_accounts IS
  'An org-level cloud storage credential used to write WhatsApp attachments into the customer''s own storage. Not a per-user token: the webhook has no signed-in user, and a personal token would stop capture the day that person left. Optional — Google orgs using a Shared Drive do not need one, because a Shared Drive already owns its files.';
COMMENT ON COLUMN public.org_storage_accounts.email IS
  'The connected account, shown in Settings so an admin can see WHICH account is wired up. The common mistake is connecting while signed in as yourself instead of the service account.';

-- ── 2. Which mapped folder receives uploads ──────────────────────────────────
--
-- A project can map several folders. Without this, "where does an inbound
-- attachment go" has no answer.

ALTER TABLE public.project_folders
  ADD COLUMN IF NOT EXISTS is_upload_target boolean NOT NULL DEFAULT false;

-- At most one target per project. A partial unique index rather than a CHECK,
-- because the constraint is across rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_folders_upload_target
  ON public.project_folders (handover_id) WHERE is_upload_target;

COMMENT ON COLUMN public.project_folders.is_upload_target IS
  'Inbound attachments for this project are written here. Files inherit this folder''s existing sharing, which is what makes the project team able to see them without GoWarm managing permissions.';

-- ── 3. Link a WhatsApp message to the file it produced ───────────────────────
--
-- media_url / media_mime_type / media_sha256 have existed since the table was
-- created and are written by nothing — the ingest stores the literal string
-- '[document]' and drops the attachment. Rather than start populating those,
-- point at storage_files: the attachment becomes an ordinary project file and
-- inherits tagging, precedence and hiding for free.

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS storage_file_id integer,
  ADD COLUMN IF NOT EXISTS media_status    text,
  ADD COLUMN IF NOT EXISTS media_error     text;

ALTER TABLE public.whatsapp_messages
  DROP CONSTRAINT IF EXISTS whatsapp_messages_storage_file_id_fkey;
ALTER TABLE public.whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_storage_file_id_fkey
  FOREIGN KEY (storage_file_id) REFERENCES public.storage_files(id) ON DELETE SET NULL;

ALTER TABLE public.whatsapp_messages
  DROP CONSTRAINT IF EXISTS whatsapp_messages_media_status_chk;
ALTER TABLE public.whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_media_status_chk
  CHECK (media_status IS NULL
      OR media_status IN ('pending', 'stored', 'failed', 'expired', 'skipped'));

-- 'failed' rows are the retry queue; 'expired' means Meta no longer has it and
-- retrying is pointless. Distinguishing them matters because one is actionable
-- and the other is a permanent loss somebody should be told about.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_media_pending
  ON public.whatsapp_messages (org_id, media_status)
  WHERE media_status IN ('pending', 'failed');

COMMENT ON COLUMN public.whatsapp_messages.media_status IS
  'pending = accepted, not yet fetched. stored = in the customer''s storage, see storage_file_id. failed = retryable. expired = Meta no longer has it, permanent loss. skipped = no storage configured for the org.';

COMMIT;
