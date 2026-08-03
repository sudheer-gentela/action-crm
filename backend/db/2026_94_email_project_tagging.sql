-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_94_email_project_tagging.sql
--
-- Lets an email conversation belong to a project, and lets every message on
-- that conversation — past and future — inherit the link.
--
-- SHAPE MIRRORS PROJECT FILES (2026_92), deliberately. Three tagging models
-- were diverging: storage_files had handover_id + tag_source + precedence,
-- whatsapp_threads had handover_id alone, emails had nothing. Rather than
-- invent a third vocabulary, email adopts the file one:
--
--     project_folders : storage_files    ::    email_threads : emails
--
--   email_threads  — the MAPPING. "This conversation belongs to project X."
--                    One row per conversation, like one row per mapped folder.
--   emails.handover_id + tag_source — the EFFECTIVE link on each message,
--                    exactly like storage_files.
--
--   tag_source now means HOW the link was made, never WHAT it links to:
--     auto   — the sync matched it to a deal during ingest (existing behaviour)
--     manual — a person tagged this specific message
--     thread — inherited because its conversation is tagged
--
--   Precedence is the same single guard as files: a thread mapping never
--   overwrites a row whose tag_source = 'manual'.
--
-- WHY THREAD-LEVEL AND NOT PER-MESSAGE:
--   emails_external_id_unique is on external_id alone, and Graph issues a
--   distinct message id per mailbox. So one conversation in three colleagues'
--   mailboxes is three rows. Tagging one row would tag one person's copy and
--   leave the others untagged — the thing that made per-message tagging useless
--   for a team. conversation_id is shared across mailboxes by both Graph and
--   Gmail, so it is the only key that identifies "the conversation" rather than
--   "my copy of it".
--
-- VISIBILITY: tagging publishes every mailbox copy of that conversation to the
--   project's members. That is the intent, not a side effect — reads are
--   org + project scoped rather than user scoped.
--
-- 'team' IS RETIRED. It was in the CHECK and written by nothing in the
--   codebase. Any stray row is folded into 'manual', which is what it would
--   have meant.
--
-- Safe to run more than once.
-- NUMBERING: 93 = vendors_partners_sides. This is 94.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Retire 'team' before narrowing the constraint ─────────────────────────
-- Nothing writes it, so this is expected to touch zero rows — but the CHECK
-- swap below would fail on a live table if even one existed.

UPDATE public.emails SET tag_source = 'manual' WHERE tag_source = 'team';

-- ── 2. The project link on each message ──────────────────────────────────────

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS handover_id integer,
  ADD COLUMN IF NOT EXISTS hidden_at   timestamp with time zone,
  ADD COLUMN IF NOT EXISTS hidden_by   integer;

-- ON DELETE SET NULL, matching meetings.handover_id, whatsapp_threads
-- .handover_id and storage_files.handover_id. An email outlives the project it
-- was filed under.
ALTER TABLE public.emails
  DROP CONSTRAINT IF EXISTS emails_handover_id_fkey;
ALTER TABLE public.emails
  ADD CONSTRAINT emails_handover_id_fkey
  FOREIGN KEY (handover_id) REFERENCES public.sales_handovers(id) ON DELETE SET NULL;

ALTER TABLE public.emails
  DROP CONSTRAINT IF EXISTS emails_hidden_by_fkey;
ALTER TABLE public.emails
  ADD CONSTRAINT emails_hidden_by_fkey
  FOREIGN KEY (hidden_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.emails
  DROP CONSTRAINT IF EXISTS emails_tag_source_check;
ALTER TABLE public.emails
  ADD CONSTRAINT emails_tag_source_check
  CHECK (tag_source IS NULL OR tag_source IN ('auto', 'manual', 'thread'));

-- Hiding keeps the link and its provenance; it must still say who hid it.
ALTER TABLE public.emails
  DROP CONSTRAINT IF EXISTS emails_hidden_shape_chk;
ALTER TABLE public.emails
  ADD CONSTRAINT emails_hidden_shape_chk
  CHECK ((hidden_at IS NULL AND hidden_by IS NULL)
      OR (hidden_at IS NOT NULL AND hidden_by IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_emails_handover
  ON public.emails (handover_id) WHERE handover_id IS NOT NULL;

-- Every thread operation — tag, untag, and the ingest-time inheritance lookup —
-- keys on this pair. Without it, tagging a conversation is a sequential scan of
-- the org's mail.
CREATE INDEX IF NOT EXISTS idx_emails_conversation
  ON public.emails (org_id, conversation_id) WHERE conversation_id IS NOT NULL;

COMMENT ON COLUMN public.emails.handover_id IS
  'The one project this message belongs to. Effective value, whether tagged directly or inherited from its conversation — see tag_source.';
COMMENT ON COLUMN public.emails.hidden_at IS
  'Suppressed from the project view. Distinct from untagging: the link and its provenance are kept, so it is reversible and auditable.';

-- ── 3. email_threads: which conversation belongs to which project ────────────
--
-- The mapping table, and the answer to "can one email belong to two projects?"
-- — no. UNIQUE (org_id, conversation_id) means a conversation resolves to
-- exactly one project, so no join table is needed and no message can be claimed
-- twice by inheritance.

CREATE TABLE IF NOT EXISTS public.email_threads (
  id              serial PRIMARY KEY,
  org_id          integer NOT NULL REFERENCES public.organizations(id)   ON DELETE CASCADE,
  conversation_id character varying(500) NOT NULL,
  handover_id     integer NOT NULL REFERENCES public.sales_handovers(id) ON DELETE CASCADE,
  subject         text,
  tagged_by       integer REFERENCES public.users(id) ON DELETE SET NULL,
  tagged_at       timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT uq_email_threads UNIQUE (org_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_email_threads_handover
  ON public.email_threads (handover_id);

COMMENT ON TABLE public.email_threads IS
  'Maps an email conversation to a project. One conversation, one project — so a message cannot be inherited into two. Messages arriving later on a mapped conversation are stamped at ingest with tag_source = ''thread''. Tagging a conversation does not move mail; it publishes every mailbox copy to the project team.';
COMMENT ON COLUMN public.email_threads.subject IS
  'Subject at the time of tagging, kept so the project can list its threads without joining to a message that may since have been deleted from a mailbox.';

COMMIT;
