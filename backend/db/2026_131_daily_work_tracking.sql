-- =====================================================================
-- 2026_131_daily_work_tracking.sql
--
-- Daily work tracking. Replaces a shared spreadsheet whose grain was one
-- row per person per day, with the task existing only as a free-text
-- string re-authored each morning.
--
-- ── THE SHAPE ────────────────────────────────────────────────────────
--
--   daily_work_items      a DURABLE piece of work, of two kinds:
--                           'recurring' — open-ended activity, never
--                                         completes, member-created
--                           'assigned'  — finite deliverable, completes
--                                         once, manager-created
--   daily_work_entries    one row per item per LOCAL date — what the
--                         person did on that item that day
--
-- Storage grain is per item per day. The familiar person-per-day view is
-- DERIVED at read by grouping on (user_id, entry_date). It is never
-- stored: a materialised rollup lets the summary and the entries
-- diverge, which is two answers to one question.
--
-- ── WHY THERE IS NO GENERATOR ────────────────────────────────────────
--
-- Nothing creates entries on a schedule. The compliance metric is
--
--     distinct entry_date  ÷  working days in window
--
-- and the denominator comes from daily_work_schedules and the holiday
-- calendar, NOT from rows. A day with no entry is therefore an absence:
-- there is nothing to expire, no terminal state for a missed day, and no
-- backlog that can accumulate.
--
-- That is deliberate and load-bearing. One rep in this org carries 583
-- overdue prospecting actions, grown 389 -> 541 -> 583, static for 19
-- days, with read_at NULL on every digest. That is what generated daily
-- work looks like at rest. A table that only gains rows when a human
-- writes one cannot reach that state.
--
-- ── WHAT THIS DOES NOT TOUCH ─────────────────────────────────────────
--
-- Nothing hangs off sales_handovers. project_play_instances,
-- project_stages, handover_deliverable_rollup, baseline freeze and
-- plan-vs-actual are all untouched, and no daily work appears in any
-- project rollup or closeability check.
--
-- The ~11 `NOT IN ('completed','skipped','cancelled')` predicates across
-- the services are NOT widened, because no new status is introduced on
-- project_play_instances.
--
-- ── ROW LEVEL SECURITY ───────────────────────────────────────────────
--
-- Deliberately not enabled. RLS covers 52 of the tables in this schema;
-- the Projects module tables (play_notes, play_evidence,
-- project_play_watchers, project_play_status_transitions) all scope in
-- the application layer with an explicit org_id predicate instead. These
-- tables follow the module they sit beside. Mixing the two strategies in
-- one module is how a query ends up relying on a policy that is not
-- there.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Activity types — the controlled vocabulary.
--
-- This is the layer the spreadsheet lacks entirely, and the reason its
-- Project/Client column is unusable: anything anyone can type into
-- becomes 'LinkedIn', 'Linkedin outreach' and 'LI connects' inside a
-- month, and no rollup survives that.
--
-- Members do NOT get write access. They get an 'Other' escape hatch with
-- a free-text note that never blocks them, and the manager promotes or
-- merges from a queue of status='candidate' rows.
--
-- merged_into_key exists from day one on purpose. Two people will add
-- near-duplicates in week one. Merge is cheap at ten rows and painful at
-- ten thousand entries pointing at both.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_activity_types (
  id              serial PRIMARY KEY,
  org_id          integer NOT NULL
                    REFERENCES public.organizations(id) ON DELETE CASCADE,
  key             text NOT NULL,
  label           text NOT NULL,
  is_system       boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'active',
  -- Set only when status = 'merged'. Points at the surviving key.
  merged_into_key text,
  sort_order      integer NOT NULL DEFAULT 100,
  created_by      integer REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  updated_at      timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (org_id, key),
  CONSTRAINT chk_dat_status
    CHECK (status = ANY (ARRAY['active'::text, 'candidate'::text, 'merged'::text])),
  -- A merged row without a destination is a dangling key: entries still
  -- point at it and nothing says where they should go.
  CONSTRAINT chk_dat_merge_shape
    CHECK ((status = 'merged' AND merged_into_key IS NOT NULL)
        OR (status <> 'merged' AND merged_into_key IS NULL))
);

COMMENT ON TABLE public.daily_activity_types IS
  'Org-configurable activity vocabulary for daily work tracking. Modelled on '
  'team_dimensions: system entries are seeded per org, renameable and '
  'deactivatable but never deleted. As of 2026_131.';

-- ---------------------------------------------------------------------
-- 2. Holiday calendars.
--
-- NAMED and assignable per person, not one list per org. The team is
-- expected to span regions, and a single org-wide list cannot be
-- retrofitted into per-region ones without recomputing every historical
-- denominator.
--
-- Holidays are DATES, not instants. entry_date is already a local date,
-- so 15 August applies to whoever's calendar contains it regardless of
-- where they are. No timezone conversion anywhere in this table.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.holiday_calendars (
  id         serial PRIMARY KEY,
  org_id     integer NOT NULL
               REFERENCES public.organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT true,
  created_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

-- At most one default per org. A second default would make "which
-- calendar does an unassigned person get" ambiguous, and the answer
-- would depend on row order.
CREATE UNIQUE INDEX IF NOT EXISTS uq_holiday_calendars_one_default
  ON public.holiday_calendars (org_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS public.holiday_calendar_dates (
  id           serial PRIMARY KEY,
  org_id       integer NOT NULL
                 REFERENCES public.organizations(id) ON DELETE CASCADE,
  calendar_id  integer NOT NULL
                 REFERENCES public.holiday_calendars(id) ON DELETE CASCADE,
  holiday_date date NOT NULL,
  label        text,
  created_at   timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (calendar_id, holiday_date)
);

CREATE INDEX IF NOT EXISTS idx_hcd_calendar_date
  ON public.holiday_calendar_dates (calendar_id, holiday_date);

-- ---------------------------------------------------------------------
-- 3. Per-person working days.
--
-- EFFECTIVE-DATED, and this is not optional. Absent days have no row, so
-- the denominator must be reconstructible from the schedule as it stood
-- at the time. Without effective_from, moving someone to a four-day week
-- in November silently recomputes every prior month's completion rate —
-- and a compliance number that changes retroactively is one nobody
-- trusts again.
--
-- weekday_mask is a 7-bit integer, bit 0 = Monday through bit 6 = Sunday
-- (ISO order, matching the org calendar's weekStartDay = 1 default).
-- Mon-Fri is 31 (0b0011111).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_work_schedules (
  id                  serial PRIMARY KEY,
  org_id              integer NOT NULL
                        REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id             integer NOT NULL
                        REFERENCES public.users(id) ON DELETE CASCADE,
  weekday_mask        smallint NOT NULL DEFAULT 31,
  holiday_calendar_id integer REFERENCES public.holiday_calendars(id) ON DELETE SET NULL,
  effective_from      date NOT NULL,
  created_by          integer REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, effective_from),
  -- 0 would mean "never works", which is a deactivation, not a schedule.
  CONSTRAINT chk_dws_weekday_mask CHECK (weekday_mask > 0 AND weekday_mask <= 127)
);

CREATE INDEX IF NOT EXISTS idx_dws_user_effective
  ON public.daily_work_schedules (org_id, user_id, effective_from DESC);

COMMENT ON COLUMN public.daily_work_schedules.weekday_mask IS
  '7-bit mask, bit 0 = Monday .. bit 6 = Sunday. Mon-Fri = 31. As of 2026_131.';

-- ---------------------------------------------------------------------
-- 4. Approved single-day removals from the denominator.
--
-- One day at a time, with manager approval. This replaces the pause
-- WINDOW originally proposed on a recurring definition: with no
-- generator there is nothing to pause, only a day to exclude.
--
-- approved_by NULL means requested and not yet granted, and an
-- unapproved exception must not shrink anyone's denominator — the
-- metric reads approved rows only.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_work_exceptions (
  id             serial PRIMARY KEY,
  org_id         integer NOT NULL
                   REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id        integer NOT NULL
                   REFERENCES public.users(id) ON DELETE CASCADE,
  exception_date date NOT NULL,
  reason         text NOT NULL,
  requested_by   integer REFERENCES public.users(id) ON DELETE SET NULL,
  approved_by    integer REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at    timestamp with time zone,
  created_at     timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, exception_date),
  CONSTRAINT chk_dwe_reason_not_blank CHECK (btrim(reason) <> ''),
  CONSTRAINT chk_dwe_approval_shape
    CHECK ((approved_by IS NULL AND approved_at IS NULL)
        OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_dwe_user_date
  ON public.daily_work_exceptions (org_id, user_id, exception_date);

-- ---------------------------------------------------------------------
-- 5. The durable work item.
--
-- status is conditional on kind, enforced rather than documented. A
-- recurring activity has no completion state — 'LinkedIn outreach' is
-- never Complete, only complete for today — so its lifecycle is
-- active/retired and the day's stage lives on the entry instead.
--
-- anchor_kind/anchor_id is a soft polymorphic reference, following
-- account_teams.dimension: stored as plain text so the vocabulary can
-- grow without cascading FK changes. Nullable together, because sales
-- and marketing legitimately have no project or client.
--
-- department_team_id is a SNAPSHOT of the owner's primary team at
-- creation, overridable. Not a live join: someone moving from Marketing
-- to Delivery in November must not drag October's work with them.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_work_items (
  id                 serial PRIMARY KEY,
  org_id             integer NOT NULL
                       REFERENCES public.organizations(id) ON DELETE CASCADE,
  owner_user_id      integer NOT NULL
                       REFERENCES public.users(id) ON DELETE CASCADE,
  kind               text NOT NULL,
  title              text NOT NULL,
  activity_type_key  text,
  anchor_kind        text,
  anchor_id          integer,
  status             text NOT NULL,
  department_team_id integer REFERENCES public.teams(id) ON DELETE SET NULL,
  created_by         integer REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_by        integer REFERENCES public.users(id) ON DELETE SET NULL,
  opened_on          date NOT NULL DEFAULT CURRENT_DATE,
  closed_at          timestamp with time zone,
  created_at         timestamp with time zone NOT NULL DEFAULT now(),
  updated_at         timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT chk_dwi_kind CHECK (kind = ANY (ARRAY['recurring'::text, 'assigned'::text])),
  CONSTRAINT chk_dwi_title_not_blank CHECK (btrim(title) <> ''),

  -- The central invariant of the design.
  CONSTRAINT chk_dwi_status_by_kind CHECK (
    (kind = 'assigned'  AND status = ANY (ARRAY['not_started'::text, 'in_progress'::text,
                                                'in_review'::text, 'completed'::text,
                                                'dropped'::text]))
    OR
    (kind = 'recurring' AND status = ANY (ARRAY['active'::text, 'retired'::text]))
  ),

  -- Both or neither. A kind with no id is a label pretending to be a
  -- reference, which is the free-text failure this replaces.
  CONSTRAINT chk_dwi_anchor_shape
    CHECK ((anchor_kind IS NULL AND anchor_id IS NULL)
        OR (anchor_kind IS NOT NULL AND anchor_id IS NOT NULL)),
  CONSTRAINT chk_dwi_anchor_kind
    CHECK (anchor_kind IS NULL
        OR anchor_kind = ANY (ARRAY['handover'::text, 'account'::text, 'campaign'::text]))
);

CREATE INDEX IF NOT EXISTS idx_dwi_owner_open
  ON public.daily_work_items (org_id, owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_dwi_anchor
  ON public.daily_work_items (org_id, anchor_kind, anchor_id)
  WHERE anchor_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dwi_activity
  ON public.daily_work_items (org_id, activity_type_key);

COMMENT ON COLUMN public.daily_work_items.anchor_kind IS
  'Soft polymorphic reference: handover | account | campaign. Text rather than '
  'an FK so the vocabulary can grow without cascading changes, per the '
  'account_teams.dimension precedent. As of 2026_131.';

-- ---------------------------------------------------------------------
-- 6. The daily entry.
--
-- entry_date is the person's LOCAL date, resolved once by the service
-- (users.timezone -> org calendar -> UTC) and stored. A date, not a
-- timestamp, deliberately: "which day was this" must not be re-derivable
-- to a different answer later by a timezone change.
--
-- Every contextual field is SNAPSHOTTED rather than joined. See the note
-- on department_team_id above; the same reasoning applies to the
-- activity type and anchor.
--
-- Length: 2000 hard here, 1000 soft in the UI with a live counter.
-- The database is not the constraint (text is unbounded); the person-day
-- CONCATENATION is. Four items at 2000 characters is 8000 in one view,
-- which no manager reads. Observed descriptions run a few hundred.
--
-- The service must never truncate silently on save. Losing the tail of a
-- paste is how people abandon a tool. Show the counter, refuse the save,
-- let them trim.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_work_entries (
  id                 serial PRIMARY KEY,
  org_id             integer NOT NULL
                       REFERENCES public.organizations(id) ON DELETE CASCADE,
  item_id            integer NOT NULL
                       REFERENCES public.daily_work_items(id) ON DELETE CASCADE,
  user_id            integer NOT NULL
                       REFERENCES public.users(id) ON DELETE CASCADE,
  entry_date         date NOT NULL,
  description        text NOT NULL,
  next_steps         text,
  day_stage          text NOT NULL,
  department_team_id integer REFERENCES public.teams(id) ON DELETE SET NULL,
  activity_type_key  text,
  anchor_kind        text,
  anchor_id          integer,
  -- Pilot instrumentation: did this continue an existing item, or open a
  -- new one? Item identity is a judgement call, and after two weeks this
  -- turns "it depends" into a number.
  is_continuation    boolean NOT NULL DEFAULT false,
  created_at         timestamp with time zone NOT NULL DEFAULT now(),
  updated_at         timestamp with time zone NOT NULL DEFAULT now(),
  last_edited_by     integer REFERENCES public.users(id) ON DELETE SET NULL,

  UNIQUE (org_id, item_id, entry_date),

  -- The single hard gate. The spreadsheet already contains rows filed
  -- with an empty description, which is indistinguishable from not
  -- filing at all. Mirrors play_notes_body_not_blank_chk.
  CONSTRAINT chk_dwen_description_not_blank CHECK (btrim(description) <> ''),
  CONSTRAINT chk_dwen_description_len CHECK (length(description) <= 2000),
  CONSTRAINT chk_dwen_next_steps_len CHECK (next_steps IS NULL OR length(next_steps) <= 2000),

  CONSTRAINT chk_dwen_day_stage CHECK (day_stage = ANY (ARRAY[
    'yet_to_start'::text, 'in_progress'::text, 'in_review'::text,
    'completed'::text, 'dropped'::text])),

  CONSTRAINT chk_dwen_anchor_shape
    CHECK ((anchor_kind IS NULL AND anchor_id IS NULL)
        OR (anchor_kind IS NOT NULL AND anchor_id IS NOT NULL))
);

-- The compliance query: distinct entry_date per user over a window.
CREATE INDEX IF NOT EXISTS idx_dwen_user_date
  ON public.daily_work_entries (org_id, user_id, entry_date DESC);
-- The person-day view, and the item history view.
CREATE INDEX IF NOT EXISTS idx_dwen_item_date
  ON public.daily_work_entries (item_id, entry_date DESC);
-- Activity volume rollups.
CREATE INDEX IF NOT EXISTS idx_dwen_activity_date
  ON public.daily_work_entries (org_id, activity_type_key, entry_date);

COMMENT ON COLUMN public.daily_work_entries.entry_date IS
  'The OWNER''s local date, resolved at write from users.timezone -> org '
  'calendar -> UTC. Stored as a date so the day cannot be re-derived '
  'differently later. As of 2026_131.';

-- ---------------------------------------------------------------------
-- 7. Widen evidence and notes to accept a daily entry as parent.
--
-- This is the only part of this migration that touches existing tables,
-- and the only part that can break something already working.
--
-- Reusing these two rather than rebuilding gets file evidence,
-- Drive/OneDrive attachments, Teams and WhatsApp evidence, revocation
-- with a reason, and the immutability triggers — all already tested.
--
-- Evidence is per ENTRY, never per day. The same artifact across three
-- entries is three rows sharing one storage_file_id: stored once,
-- accepted three times. Revoking Monday's proof must not silently revoke
-- Wednesday's.
--
-- 19 existing call sites across handover.service.js,
-- playReview.service.js, planVariance.service.js and
-- superAdmin.routes.js all filter on a supplied
-- project_play_instance_id, so widening cannot change their behaviour.
-- ---------------------------------------------------------------------
ALTER TABLE public.play_evidence
  ADD COLUMN IF NOT EXISTS daily_work_entry_id integer
    REFERENCES public.daily_work_entries(id) ON DELETE CASCADE;

ALTER TABLE public.play_evidence
  ALTER COLUMN project_play_instance_id DROP NOT NULL;

ALTER TABLE public.play_evidence
  DROP CONSTRAINT IF EXISTS play_evidence_parent_shape_chk;
ALTER TABLE public.play_evidence
  ADD CONSTRAINT play_evidence_parent_shape_chk
  CHECK (num_nonnulls(project_play_instance_id, daily_work_entry_id) = 1);

CREATE INDEX IF NOT EXISTS idx_play_evidence_daily_entry
  ON public.play_evidence (daily_work_entry_id)
  WHERE daily_work_entry_id IS NOT NULL;

ALTER TABLE public.play_notes
  ADD COLUMN IF NOT EXISTS daily_work_entry_id integer
    REFERENCES public.daily_work_entries(id) ON DELETE CASCADE;

ALTER TABLE public.play_notes
  ALTER COLUMN project_play_instance_id DROP NOT NULL;

ALTER TABLE public.play_notes
  DROP CONSTRAINT IF EXISTS play_notes_parent_shape_chk;
ALTER TABLE public.play_notes
  ADD CONSTRAINT play_notes_parent_shape_chk
  CHECK (num_nonnulls(project_play_instance_id, daily_work_entry_id) = 1);

CREATE INDEX IF NOT EXISTS idx_play_notes_daily_entry
  ON public.play_notes (daily_work_entry_id)
  WHERE daily_work_entry_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 8. Teach the immutability triggers about the new column.
--
-- BOTH trigger functions enumerate every column by name. A new column
-- they do not list is a column they do not guard: an UPDATE changing
-- ONLY daily_work_entry_id would satisfy every IS NOT DISTINCT FROM in
-- the referential-detach branch and be waved through, letting evidence
-- be silently re-pointed from one day's entry to another. Adding the
-- column without this section is a real hole, not a tidiness issue.
--
-- ALSO FIXED HERE: msteams_message_id appears nowhere in the existing
-- play_evidence_immutable(). It was added after the trigger was written
-- (2026_126 era), so Teams evidence links are unguarded on production
-- TODAY — the same class of bug, already live. Included deliberately so
-- it is not a surprise in the diff.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.play_evidence_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  -- Unreachable while the trigger is UPDATE-only (2026_121); kept so that
  -- re-attaching DELETE cannot resurrect the cascade deadlock.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  -- Referential detach: a cited WhatsApp message, Teams message or an
  -- accepted file is going away and its FK is SET NULL. Permitted for the
  -- link columns only, and only in the set -> NULL direction, so this
  -- cannot be used to launder an edit. See 2026_121 for the full reasoning.
  IF ( (OLD.whatsapp_message_id IS NOT NULL AND NEW.whatsapp_message_id IS NULL
        AND NEW.storage_file_id     IS NOT DISTINCT FROM OLD.storage_file_id
        AND NEW.msteams_message_id  IS NOT DISTINCT FROM OLD.msteams_message_id)
    OR (OLD.storage_file_id     IS NOT NULL AND NEW.storage_file_id     IS NULL
        AND NEW.whatsapp_message_id IS NOT DISTINCT FROM OLD.whatsapp_message_id
        AND NEW.msteams_message_id  IS NOT DISTINCT FROM OLD.msteams_message_id)
    OR (OLD.msteams_message_id  IS NOT NULL AND NEW.msteams_message_id  IS NULL
        AND NEW.whatsapp_message_id IS NOT DISTINCT FROM OLD.whatsapp_message_id
        AND NEW.storage_file_id     IS NOT DISTINCT FROM OLD.storage_file_id) )
     AND NEW.id                       IS NOT DISTINCT FROM OLD.id
     AND NEW.org_id                   IS NOT DISTINCT FROM OLD.org_id
     AND NEW.project_play_instance_id IS NOT DISTINCT FROM OLD.project_play_instance_id
     AND NEW.daily_work_entry_id      IS NOT DISTINCT FROM OLD.daily_work_entry_id
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

  IF NEW.id                          IS DISTINCT FROM OLD.id
     OR NEW.org_id                   IS DISTINCT FROM OLD.org_id
     OR NEW.project_play_instance_id IS DISTINCT FROM OLD.project_play_instance_id
     OR NEW.daily_work_entry_id      IS DISTINCT FROM OLD.daily_work_entry_id
     OR NEW.channel                  IS DISTINCT FROM OLD.channel
     OR NEW.whatsapp_message_id      IS DISTINCT FROM OLD.whatsapp_message_id
     OR NEW.msteams_message_id       IS DISTINCT FROM OLD.msteams_message_id
     OR NEW.storage_file_id          IS DISTINCT FROM OLD.storage_file_id
     OR NEW.snapshot_body            IS DISTINCT FROM OLD.snapshot_body
     OR NEW.snapshot_sender          IS DISTINCT FROM OLD.snapshot_sender
     OR NEW.snapshot_sent_at         IS DISTINCT FROM OLD.snapshot_sent_at
     OR NEW.snapshot_thread_id       IS DISTINCT FROM OLD.snapshot_thread_id
     OR NEW.snapshot_file_name       IS DISTINCT FROM OLD.snapshot_file_name
     OR NEW.snapshot_mime_type       IS DISTINCT FROM OLD.snapshot_mime_type
     OR NEW.snapshot_file_size       IS DISTINCT FROM OLD.snapshot_file_size
     OR NEW.snapshot_web_url         IS DISTINCT FROM OLD.snapshot_web_url
     OR NEW.note                     IS DISTINCT FROM OLD.note
     OR NEW.accepted_by              IS DISTINCT FROM OLD.accepted_by
     OR NEW.accepted_at              IS DISTINCT FROM OLD.accepted_at
  THEN
    RAISE EXCEPTION 'play_evidence % is immutable; only the revocation fields may be set', OLD.id;
  END IF;

  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.play_notes_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'play_note % is already deleted and cannot be changed', OLD.id;
  END IF;

  IF NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION 'play_note % is append-only; the only permitted update is a deletion. Post a correcting note instead.', OLD.id;
  END IF;

  IF NEW.id                          IS DISTINCT FROM OLD.id
     OR NEW.org_id                   IS DISTINCT FROM OLD.org_id
     OR NEW.project_play_instance_id IS DISTINCT FROM OLD.project_play_instance_id
     OR NEW.daily_work_entry_id      IS DISTINCT FROM OLD.daily_work_entry_id
     OR NEW.author_id                IS DISTINCT FROM OLD.author_id
     OR NEW.body                     IS DISTINCT FROM OLD.body
     OR NEW.note_type                IS DISTINCT FROM OLD.note_type
     OR NEW.is_internal              IS DISTINCT FROM OLD.is_internal
     OR NEW.created_at               IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'play_note % is immutable; only deleted_at and deleted_by may be set', OLD.id;
  END IF;

  RETURN NEW;
END $fn$;

COMMIT;

-- =====================================================================
-- VERIFY (run after COMMIT; all should come back clean)
-- =====================================================================
--
-- 1. Every pre-existing evidence and note row still has exactly one
--    parent. Both must return 0.
--
--   SELECT count(*) FROM play_evidence
--    WHERE num_nonnulls(project_play_instance_id, daily_work_entry_id) <> 1;
--
--   SELECT count(*) FROM play_notes
--    WHERE num_nonnulls(project_play_instance_id, daily_work_entry_id) <> 1;
--
-- 2. The triggers are still attached to the replaced functions.
--    Expect 2 rows.
--
--   SELECT tgname, tgrelid::regclass FROM pg_trigger
--    WHERE tgname IN ('trg_play_evidence_immutable', 'trg_play_notes_append_only');
--
-- 3. The seven new tables exist. Expect 7.
--
--   SELECT count(*) FROM information_schema.tables
--    WHERE table_schema = 'public' AND table_name IN (
--      'daily_activity_types', 'holiday_calendars', 'holiday_calendar_dates',
--      'daily_work_schedules', 'daily_work_exceptions', 'daily_work_items',
--      'daily_work_entries');
--
-- 4. Behavioural checks — run scripts/verify_daily_work_schema.js, which
--    proves the parent CHECK rejects both-null and both-set, that the
--    kind/status invariant holds, and that the widened triggers still
--    refuse an edit to daily_work_entry_id.
-- =====================================================================
