-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_92_project_files.sql
--
-- Lets a document belong to a project (sales_handovers), either by being tagged
-- individually or by living under a Drive/OneDrive folder mapped to that
-- project.
--
-- EXTENDS storage_files rather than introducing a files table of its own. Deals,
-- contacts and actions already reference storage_files; a second table would
-- mean two places that understand what a file is and two places that understand
-- Drive vs OneDrive. Every column added here is nullable, so existing rows are
-- unaffected and every existing query keeps its current result.
--
-- PRECEDENCE — the rule this migration exists to enforce:
--   A manually tagged file wins over its folder's mapping, and a file appears in
--   exactly ONE project.
--
--   handover_id holds the EFFECTIVE project. tag_source says how it got there
--   ('manual' | 'folder'). Because membership is one column on one row rather
--   than a union of two queries, "exactly one project" is a uniqueness property
--   the database can hold — see uq_storage_files_project_ref below — instead of
--   an invariant every read has to remember to preserve. The earlier draft
--   resolved membership at read time and a manually moved file surfaced in both
--   the new project and the folder's project; that is now a constraint
--   violation rather than a wrong answer.
--
--   Precedence on the write side is a single guard: folder resolution never
--   touches a row whose tag_source = 'manual'.
--
-- RECURSION — folder mappings cover subfolders.
--   folder_id is the immediate parent. folder_path is the ancestor chain,
--   nearest parent first, walked once when the row is created. Resolution is
--   then `pf.folder_id = ANY(sf.folder_path)` — pure SQL, no provider calls,
--   and it still resolves correctly for files added BEFORE the mapping existed.
--   The alternative (expanding a mapping into every descendant folder id at map
--   time) silently misses subfolders created in Drive afterwards, which is the
--   kind of gap nobody notices until a document is missing from a project.
--
-- NOT DONE HERE: mapping a folder does not bulk-import its contents. Files are
--   browsed on demand and added deliberately. The mapping decides which project
--   a file lands in when it is added, not that it gets added.
--
-- Safe to run more than once.
-- NUMBERING: 91 = seed_internal_playbook. This is 92.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── storage_files: project membership, provenance, and suppression ───────────

ALTER TABLE public.storage_files
  ADD COLUMN IF NOT EXISTS folder_id   text,
  ADD COLUMN IF NOT EXISTS folder_path text[],
  ADD COLUMN IF NOT EXISTS handover_id integer,
  ADD COLUMN IF NOT EXISTS tag_source  text,
  ADD COLUMN IF NOT EXISTS tagged_by   integer,
  ADD COLUMN IF NOT EXISTS tagged_at   timestamp with time zone,
  ADD COLUMN IF NOT EXISTS hidden_at   timestamp with time zone,
  ADD COLUMN IF NOT EXISTS hidden_by   integer;

-- ON DELETE SET NULL matches meetings.handover_id and whatsapp_threads
-- .handover_id. A file reference outlives the project it was filed under; the
-- row still means "Alice imported this from Drive on the 3rd".
ALTER TABLE public.storage_files
  DROP CONSTRAINT IF EXISTS storage_files_handover_id_fkey;
ALTER TABLE public.storage_files
  ADD CONSTRAINT storage_files_handover_id_fkey
  FOREIGN KEY (handover_id) REFERENCES public.sales_handovers(id) ON DELETE SET NULL;

ALTER TABLE public.storage_files
  DROP CONSTRAINT IF EXISTS storage_files_tagged_by_fkey;
ALTER TABLE public.storage_files
  ADD CONSTRAINT storage_files_tagged_by_fkey
  FOREIGN KEY (tagged_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.storage_files
  DROP CONSTRAINT IF EXISTS storage_files_hidden_by_fkey;
ALTER TABLE public.storage_files
  ADD CONSTRAINT storage_files_hidden_by_fkey
  FOREIGN KEY (hidden_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.storage_files
  DROP CONSTRAINT IF EXISTS storage_files_tag_source_chk;
ALTER TABLE public.storage_files
  ADD CONSTRAINT storage_files_tag_source_chk
  CHECK (tag_source IS NULL OR tag_source IN ('manual', 'folder'));

-- Deliberately NOT a paired CHECK (handover_id IS NULL) = (tag_source IS NULL).
-- The FK above is ON DELETE SET NULL, so deleting a project would nul handover_id
-- and immediately violate such a check, turning a teardown script into a hard
-- failure. Reads always filter on handover_id, so a leftover tag_source on an
-- unfiled row is inert. The service layer clears the tuple together.

-- Hiding is a suppression, not an unlink: handover_id, tag_source, tagged_by and
-- tagged_at all survive it. A hidden row must therefore still say who hid it.
ALTER TABLE public.storage_files
  DROP CONSTRAINT IF EXISTS storage_files_hidden_shape_chk;
ALTER TABLE public.storage_files
  ADD CONSTRAINT storage_files_hidden_shape_chk
  CHECK ((hidden_at IS NULL AND hidden_by IS NULL)
      OR (hidden_at IS NOT NULL AND hidden_by IS NOT NULL));

-- ── The constraint that makes the old bug impossible ─────────────────────────
--
-- Within an org, a given provider file carries a project link on at most one
-- row. Partial on handover_id IS NOT NULL, so it constrains project rows only:
-- deal rows and contact rows for the same file are untouched, and the same file
-- can still be a deal file AND a project file as two separate link rows.
--
-- This is what uq_storage_file_deal cannot do — its key includes deal_id, and
-- NULLs are distinct in a UNIQUE constraint, so it stops nothing once deal_id
-- is NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_files_project_ref
  ON public.storage_files (org_id, provider, provider_file_id)
  WHERE handover_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_storage_files_handover
  ON public.storage_files (handover_id)
  WHERE handover_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_storage_files_folder
  ON public.storage_files (org_id, provider, folder_id)
  WHERE folder_id IS NOT NULL;

-- Resolution joins on `pf.folder_id = ANY(sf.folder_path)`; without GIN that is
-- a sequential scan of every file row in the org on each mapping change.
CREATE INDEX IF NOT EXISTS idx_storage_files_folder_path
  ON public.storage_files USING gin (folder_path);

COMMENT ON COLUMN public.storage_files.folder_id IS
  'Provider id of the immediate parent folder. Populated at import from metadata the providers already fetch (Drive "parents", Graph "parentReference"). Backfilled by POST /storage/imported/:recordId/folder-url for pre-existing rows.';
COMMENT ON COLUMN public.storage_files.folder_path IS
  'Ancestor folder ids, nearest parent first. Lets a folder mapping cover subfolders without a provider call at read time, and resolves for files added before the mapping existed.';
COMMENT ON COLUMN public.storage_files.handover_id IS
  'The one project this file belongs to. Effective value, whether it was tagged directly or inherited from a mapped folder — see tag_source.';
COMMENT ON COLUMN public.storage_files.tag_source IS
  'manual = someone tagged this file to this project and it outranks any folder mapping. folder = inherited from project_folders and may be re-resolved.';
COMMENT ON COLUMN public.storage_files.hidden_at IS
  'Suppressed from the project team view. Distinct from untagging: the link and its provenance are kept, so hiding is reversible and auditable.';

-- ── project_folders: which folders belong to which project ───────────────────
--
-- A mapping table, not a file store. It answers one question — "which project
-- owns this folder" — and holds no file data, no provider tokens and no
-- provider-shaped logic. Drive vs OneDrive stays in the providers.
--
-- handover_id directly rather than context_type/context_id: matches
-- project_tab_viewers, and matches storage_files.handover_id above. If a
-- Services module later needs the same mapping it can widen this the way
-- project_contacts did.
CREATE TABLE IF NOT EXISTS public.project_folders (
  id           serial PRIMARY KEY,
  org_id       integer     NOT NULL REFERENCES public.organizations(id)   ON DELETE CASCADE,
  handover_id  integer     NOT NULL REFERENCES public.sales_handovers(id) ON DELETE CASCADE,
  provider     varchar(50) NOT NULL,
  folder_id    text        NOT NULL,
  folder_name  text,
  created_by   integer     REFERENCES public.users(id) ON DELETE SET NULL,
  created_at   timestamp with time zone NOT NULL DEFAULT now(),

  -- One folder maps to one project, org-wide. Two projects claiming the same
  -- folder would make a file's project ambiguous, which is the thing this whole
  -- change is meant to rule out.
  CONSTRAINT uq_project_folders_folder UNIQUE (org_id, provider, folder_id)
);

CREATE INDEX IF NOT EXISTS idx_project_folders_handover
  ON public.project_folders (handover_id);

COMMENT ON TABLE public.project_folders IS
  'Maps a cloud storage folder to a project. Covers subfolders: resolution matches the folder id anywhere in storage_files.folder_path. Mapping a folder does not import its contents — it decides which project a file lands in when someone adds it.';

COMMIT;
