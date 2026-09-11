-- =====================================================================
-- 2026_142_daily_work_move_requests.sql
--
-- Moving daily work onto a project plan, with approval.
--
-- Someone logs work against an item that is not on any project task — tagged
-- to a project, or not tagged at all. It does not appear anywhere on the plan,
-- because a project only shows work linked to its own tasks (2026_136). This
-- migration adds what is needed to ask for that work to join the plan, have the
-- project's manager decide, and move it.
--
-- Nothing here changes any read or any existing write. Until the service writes
-- these tables, applying this migration is invisible in the product, the same
-- as 2026_133 and 2026_136: schema first, verified, then the module.
--
-- ── THE SHAPE ────────────────────────────────────────────────────────
--
--   daily_work_move_requests   one per attempt to move one item to one project
--   daily_work_move_batches    the entries in a request are approved in
--                              batches: batch 1 is what was asked for, and
--                              each later addition is its own batch with its
--                              own approvals, so adding entries never resets
--                              a decision already made
--   daily_work_move_approvals  one row per project that must decide, per
--                              batch: the target, plus every OTHER timeboxed
--                              project the moving work is tagged to
--   daily_work_move_entries    what moves, what happened to it, and a snapshot
--                              of the entry as it was before the move
--
-- Plus three changes to existing tables:
--
--   daily_work_items           'moved' joins the ASSIGNED status vocabulary
--   project_play_instances     added_by_move_request_id, scope_added_at
--   user_module_access         source, source_move_request_id
--
-- ── WHY BATCHES ARE A TABLE AND NOT A COLUMN ─────────────────────────
--
-- A batch has a lifecycle of its own — pending, approved, rejected, withdrawn,
-- and executed — and the rules differ by batch: a rejection on batch 1 ends
-- the request, a rejection on a later batch drops only that batch's entries.
-- Stored as a bare number on the entry and approval rows, "is batch 2 still
-- waiting" would be re-derived from approval rows every time, and the first
-- query that derived it differently would disagree with the one that moved the
-- entries.
--
-- The approval and entry rows reference (batch_id, request_id) as a composite
-- foreign key, so a row cannot point at a batch belonging to another request.
--
-- ── ONE OPEN REQUEST PER ITEM, ENFORCED HERE ─────────────────────────
--
-- "Open" is wider than status = 'pending'. Once batch 1 has moved the request
-- is 'approved', but a later batch can still be waiting — and while it is, a
-- second request on the same item would be deciding about the same entries.
-- is_open carries that, and uq_dwmr_one_open_per_item is the guarantee.
--
-- It is a stored flag, which this codebase is rightly wary of. The alternative
-- is a service-side check under a row lock, which is a convention; this is a
-- unique index. chk_dwmr_open_shape pins it to status wherever status alone
-- decides it, so the only thing the service maintains by hand is "an approved
-- request still has a pending batch", and it does that in the same transaction
-- that changes the batch.
--
-- ── FOREIGN KEYS TO users: NEVER NO ACTION ───────────────────────────
--
-- superAdmin.routes.js deletes users, and its own audit notes that every FK to
-- users(id) with no ON DELETE action is a column it must remember to clear by
-- hand — 24 of 67 had been missed, and each one made deleting a user fail. So
-- every user reference here is either an attribution (ON DELETE SET NULL: the
-- record survives, the name goes) or the owner (ON DELETE CASCADE, following
-- daily_work_items.owner_user_id, which already cascades). None is NO ACTION,
-- and the harness asserts that.
--
-- A consequence worth stating: no CHECK here pairs a user column with a
-- timestamp ("decided_by is set iff decided_at is set"). SET NULL on the user
-- column would violate such a CHECK, and the user delete would fail on it.
-- Shape checks use the timestamps only.
--
-- ── WHAT THIS DOES NOT TOUCH ─────────────────────────────────────────
--
-- daily_work_entries, play_evidence and play_notes are unchanged — no columns,
-- no constraints, no triggers. Moving an entry is an UPDATE of columns it
-- already has; merging copies evidence and notes as new rows, which the
-- BEFORE UPDATE immutability triggers do not govern. chk_dwi_anchor_kind,
-- chk_dwi_linked_is_assigned, uq_dwi_owner_play and both close-item triggers
-- from 2026_136 are untouched. baseline_source is untouched — added scope is
-- its own column, because baseline_source records the LATEST event that set a
-- baseline and the first rebaseline would overwrite 'added'.
--
-- No RLS, matching every daily work and project table since 2026_131.
--
-- Idempotent: safe to re-run. Every statement guards on existence.
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Prerequisites.
--
-- The whole design sits on the task link (2026_136) and the tracking mode
-- (2026_133). Applied to a database missing either, this would build tables
-- whose rules cannot be expressed, which is worse than failing.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'daily_work_items'
       AND column_name = 'play_instance_id'
  ) THEN
    RAISE EXCEPTION 'daily_work_items.play_instance_id is missing — apply 2026_136 first';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sales_handovers'
       AND column_name = 'tracking_mode'
  ) THEN
    RAISE EXCEPTION 'sales_handovers.tracking_mode is missing — apply 2026_133 first';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 1. Requests.
--
-- placement and play_instance_id are the OUTCOME of batch 1, written when it
-- moves. What the target approver chose before that lives on their approval
-- row (section 3), because other approvals may still be outstanding and the
-- task named may change or close in the meantime.
--
-- play_instance_id is ON DELETE NO ACTION, for the reason 2026_136 gives for
-- daily_work_items.play_instance_id: an organization delete cascades to both
-- sides in one statement, and RESTRICT could abort it depending on cascade
-- order. In ordinary use the task cannot be deleted anyway — the move creates
-- a linked item, and that link already refuses the delete.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_work_move_requests (
  id                    serial PRIMARY KEY,
  org_id                integer NOT NULL
                          REFERENCES public.organizations(id) ON DELETE CASCADE,
  item_id               integer NOT NULL
                          REFERENCES public.daily_work_items(id) ON DELETE CASCADE,
  owner_user_id         integer NOT NULL
                          REFERENCES public.users(id) ON DELETE CASCADE,
  requested_by          integer
                          REFERENCES public.users(id) ON DELETE SET NULL,
  target_handover_id    integer NOT NULL
                          REFERENCES public.sales_handovers(id) ON DELETE CASCADE,
  note                  text,

  status                text NOT NULL DEFAULT 'pending',
  is_open               boolean NOT NULL DEFAULT true,

  placement             text,
  play_instance_id      integer
                          REFERENCES public.project_play_instances(id),   -- NO ACTION
  decided_at            timestamptz,
  executed_at           timestamptz,

  -- Recurring items only. After the move the owner is asked on My day whether
  -- to retire the item or keep it; 'pending' is that question waiting.
  recurring_decision    text,
  recurring_decided_by  integer REFERENCES public.users(id) ON DELETE SET NULL,
  recurring_decided_at  timestamptz,

  withdrawn_by          integer REFERENCES public.users(id) ON DELETE SET NULL,
  withdrawn_at          timestamptz,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_dwmr_status
    CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text,
                               'rejected'::text, 'withdrawn'::text])),
  CONSTRAINT chk_dwmr_placement
    CHECK (placement IS NULL
        OR placement = ANY (ARRAY['existing_task'::text, 'new_task'::text])),
  CONSTRAINT chk_dwmr_recurring_decision
    CHECK (recurring_decision IS NULL
        OR recurring_decision = ANY (ARRAY['pending'::text, 'retired'::text, 'kept'::text])),

  -- Nothing has moved while a request is pending; everything about the move is
  -- recorded once it is approved. Two separate constraints so a violation says
  -- which direction was wrong.
  CONSTRAINT chk_dwmr_pending_shape
    CHECK (status <> 'pending'
        OR (placement IS NULL AND play_instance_id IS NULL AND executed_at IS NULL)),
  CONSTRAINT chk_dwmr_approved_shape
    CHECK (status <> 'approved'
        OR (placement IS NOT NULL AND play_instance_id IS NOT NULL
            AND decided_at IS NOT NULL AND executed_at IS NOT NULL)),

  -- is_open follows status wherever status alone decides it. Only 'approved'
  -- is left to the service: open while a later batch waits, closed otherwise.
  CONSTRAINT chk_dwmr_open_shape
    CHECK ((status = 'pending' AND is_open)
        OR (status = ANY (ARRAY['rejected'::text, 'withdrawn'::text]) AND NOT is_open)
        OR status = 'approved'),

  CONSTRAINT chk_dwmr_rejected_shape
    CHECK (status <> 'rejected' OR decided_at IS NOT NULL),
  CONSTRAINT chk_dwmr_withdrawn_shape
    CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CONSTRAINT chk_dwmr_recurring_decided_shape
    CHECK ((recurring_decision = ANY (ARRAY['retired'::text, 'kept'::text]))
         = (recurring_decided_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dwmr_one_open_per_item
  ON public.daily_work_move_requests (item_id) WHERE is_open;

-- "What is waiting on this project" and "what has this person asked for".
CREATE INDEX IF NOT EXISTS idx_dwmr_target_open
  ON public.daily_work_move_requests (org_id, target_handover_id) WHERE is_open;
CREATE INDEX IF NOT EXISTS idx_dwmr_owner
  ON public.daily_work_move_requests (org_id, owner_user_id, created_at DESC);
-- The My day question, asked on every load of My day, answered by a handful of
-- rows at most.
CREATE INDEX IF NOT EXISTS idx_dwmr_recurring_pending
  ON public.daily_work_move_requests (org_id, owner_user_id)
  WHERE recurring_decision = 'pending';

COMMENT ON TABLE public.daily_work_move_requests IS
  'A request to move one daily work item onto a task in one project or '
  'initiative, decided by that project''s manager and by the manager of any '
  'other timeboxed project the moving work is tagged to. As of 2026_142.';

COMMENT ON COLUMN public.daily_work_move_requests.is_open IS
  'True while anything about the request is undecided: batch 1 pending, or a '
  'later batch pending after batch 1 moved. uq_dwmr_one_open_per_item keys on '
  'it. Pinned to status by chk_dwmr_open_shape except for approved requests, '
  'which the service closes when their last pending batch is decided.';

-- ---------------------------------------------------------------------
-- 2. Batches.
--
-- UNIQUE (id, request_id) looks redundant beside the primary key. It is the
-- target of the composite foreign keys in sections 3 and 4, which is what stops
-- an approval or an entry row pointing at a batch of a different request.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_work_move_batches (
  id           serial PRIMARY KEY,
  org_id       integer NOT NULL
                 REFERENCES public.organizations(id) ON DELETE CASCADE,
  request_id   integer NOT NULL
                 REFERENCES public.daily_work_move_requests(id) ON DELETE CASCADE,
  batch_no     integer NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  added_by     integer REFERENCES public.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  executed_at  timestamptz,

  CONSTRAINT uq_dwmb_request_batch_no UNIQUE (request_id, batch_no),
  CONSTRAINT uq_dwmb_id_request UNIQUE (id, request_id),

  CONSTRAINT chk_dwmb_batch_no CHECK (batch_no >= 1),
  CONSTRAINT chk_dwmb_status
    CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text,
                               'rejected'::text, 'withdrawn'::text])),
  CONSTRAINT chk_dwmb_decided_shape
    CHECK ((status = 'pending') = (decided_at IS NULL)),
  -- A batch moves only after it is approved, and an approved batch is moved in
  -- the same transaction that approves it — so the two travel together.
  CONSTRAINT chk_dwmb_executed_shape
    CHECK ((status = 'approved') = (executed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_dwmb_pending
  ON public.daily_work_move_batches (request_id) WHERE status = 'pending';

-- ---------------------------------------------------------------------
-- 3. Approvals — who approved what.
--
-- One row per project per batch. role 'target' is the project the work is
-- moving to; 'source' is any other timeboxed project the item or a selected
-- entry is tagged to. Account- and campaign-tagged work creates no source row.
--
-- The target approver's choice of placement is recorded here, on the batch 1
-- row, because it is made before the other approvals are in:
--
--   placement 'existing_task'  existing_play_instance_id names the task
--   placement 'new_task'       new_task holds the task to create
--                              (title, stage, due date, gate, dependencies)
--
-- existing_play_instance_id is ON DELETE SET NULL and deliberately NOT tied to
-- placement by a CHECK. Before the move there is no linked item yet, so an
-- ad-hoc task named here can still be deleted from the project. A CHECK would
-- turn that ordinary delete into a raw constraint error in the Projects UI —
-- the failure 2026_136 designed its own foreign key to avoid. The service
-- re-validates the task when the batch executes.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_work_move_approvals (
  id                         serial PRIMARY KEY,
  org_id                     integer NOT NULL
                               REFERENCES public.organizations(id) ON DELETE CASCADE,
  request_id                 integer NOT NULL,
  batch_id                   integer NOT NULL,
  handover_id                integer NOT NULL
                               REFERENCES public.sales_handovers(id) ON DELETE CASCADE,
  role                       text NOT NULL,
  decision                   text NOT NULL DEFAULT 'pending',
  decided_by                 integer REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at                 timestamptz,
  reason                     text,

  placement                  text,
  existing_play_instance_id  integer
                               REFERENCES public.project_play_instances(id) ON DELETE SET NULL,
  new_task                   jsonb,

  created_at                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_dwma_batch FOREIGN KEY (batch_id, request_id)
    REFERENCES public.daily_work_move_batches (id, request_id) ON DELETE CASCADE,
  CONSTRAINT uq_dwma_batch_handover UNIQUE (batch_id, handover_id),

  CONSTRAINT chk_dwma_role
    CHECK (role = ANY (ARRAY['target'::text, 'source'::text])),
  CONSTRAINT chk_dwma_decision
    CHECK (decision = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])),
  CONSTRAINT chk_dwma_decided_shape
    CHECK ((decision = 'pending') = (decided_at IS NULL)),
  -- A rejection ends a request or drops a batch. The person whose work it was
  -- is owed the reason, and "who rejected what, and why" is the audit trail.
  CONSTRAINT chk_dwma_rejection_reason
    CHECK (decision <> 'rejected' OR (reason IS NOT NULL AND btrim(reason) <> '')),
  CONSTRAINT chk_dwma_placement
    CHECK (placement IS NULL
        OR (role = 'target'
            AND placement = ANY (ARRAY['existing_task'::text, 'new_task'::text]))),
  CONSTRAINT chk_dwma_new_task_shape
    CHECK (new_task IS NULL OR placement = 'new_task')
);

-- The approver's queue: everything waiting on the projects they manage.
CREATE INDEX IF NOT EXISTS idx_dwma_pending_by_project
  ON public.daily_work_move_approvals (org_id, handover_id) WHERE decision = 'pending';
CREATE INDEX IF NOT EXISTS idx_dwma_request
  ON public.daily_work_move_approvals (request_id, batch_id);

-- ---------------------------------------------------------------------
-- 4. Entries — what moves, and the record of it.
--
-- outcome:
--   pending            waiting for its batch to be decided
--   moved              re-pointed onto the linked item and re-tagged
--   merged             that date already had an entry on the task; the text
--                      was appended to it (needs_edit until the owner marks
--                      it done)
--   left_out_too_long  a merge would exceed 2000 characters; stays on the old
--                      item, pending, and merges automatically once it fits
--   excluded           unticked by an approver, or its batch was rejected or
--                      withdrawn
--
-- entry_id is ON DELETE SET NULL because a merge DELETES the source entry —
-- its text now lives in the task's entry. The snap_* columns are then the only
-- record of what the entry said, which tagged it carried, and which item it
-- was on. They are written when the entry joins the request and are never
-- updated afterwards.
--
-- uq_dwme_entry_outstanding: an entry can be outstanding in one place only.
-- Without it, an entry left out of an approved request could be selected again
-- by a new request on the same (kept, recurring) item while the first one is
-- still waiting to auto-merge it — two requests each believing they own the
-- entry's next move.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_work_move_entries (
  id                        serial PRIMARY KEY,
  org_id                    integer NOT NULL
                              REFERENCES public.organizations(id) ON DELETE CASCADE,
  request_id                integer NOT NULL,
  batch_id                  integer NOT NULL,
  entry_id                  integer
                              REFERENCES public.daily_work_entries(id) ON DELETE SET NULL,

  selected                  boolean NOT NULL DEFAULT true,
  unticked_by               integer REFERENCES public.users(id) ON DELETE SET NULL,
  unticked_at               timestamptz,
  -- Which approval unticked it: the target project, or a source project
  -- unticking an entry tagged to itself.
  unticked_for_handover_id  integer
                              REFERENCES public.sales_handovers(id) ON DELETE SET NULL,

  outcome                   text NOT NULL DEFAULT 'pending',
  target_entry_id           integer
                              REFERENCES public.daily_work_entries(id) ON DELETE SET NULL,
  left_out_reason           text,
  moved_at                  timestamptz,
  needs_edit                boolean NOT NULL DEFAULT false,
  needs_edit_cleared_by     integer REFERENCES public.users(id) ON DELETE SET NULL,
  needs_edit_cleared_at     timestamptz,

  -- Maps of evidence and note ids copied onto the task's entry by a merge,
  -- [{ "from": <old id>, "to": <new id> }]. The originals are deleted with the
  -- source entry, so these are how a copied row is traced back.
  copied_evidence           jsonb,
  copied_notes              jsonb,

  snap_item_id              integer NOT NULL,
  snap_entry_date           date NOT NULL,
  snap_description          text NOT NULL,
  snap_next_steps           text,
  snap_day_stage            text NOT NULL,
  snap_activity_type_key    text,
  snap_anchor_kind          text,
  snap_anchor_id            integer,
  snap_account_id           integer,

  created_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_dwme_batch FOREIGN KEY (batch_id, request_id)
    REFERENCES public.daily_work_move_batches (id, request_id) ON DELETE CASCADE,

  CONSTRAINT chk_dwme_outcome
    CHECK (outcome = ANY (ARRAY['pending'::text, 'moved'::text, 'merged'::text,
                                'left_out_too_long'::text, 'excluded'::text])),
  -- Unticked means it cannot have moved. It is either still pending (the batch
  -- has not executed) or excluded (it has).
  CONSTRAINT chk_dwme_unticked_outcome
    CHECK (selected OR outcome = ANY (ARRAY['pending'::text, 'excluded'::text])),
  CONSTRAINT chk_dwme_unticked_shape
    CHECK (selected = (unticked_at IS NULL)),
  CONSTRAINT chk_dwme_moved_shape
    CHECK ((outcome = ANY (ARRAY['moved'::text, 'merged'::text])) = (moved_at IS NOT NULL)),
  CONSTRAINT chk_dwme_left_out_reason
    CHECK (outcome <> 'left_out_too_long'
        OR (left_out_reason IS NOT NULL AND btrim(left_out_reason) <> '')),
  -- The flag belongs to a merge and nothing else, and is either raised or
  -- cleared — never both.
  CONSTRAINT chk_dwme_needs_edit_shape
    CHECK ((NOT needs_edit AND needs_edit_cleared_at IS NULL)
        OR (outcome = 'merged' AND NOT (needs_edit AND needs_edit_cleared_at IS NOT NULL))),
  CONSTRAINT chk_dwme_copies_shape
    CHECK ((copied_evidence IS NULL AND copied_notes IS NULL) OR outcome = 'merged')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dwme_entry_outstanding
  ON public.daily_work_move_entries (entry_id)
  WHERE outcome = ANY (ARRAY['pending'::text, 'left_out_too_long'::text]);

CREATE INDEX IF NOT EXISTS idx_dwme_request_batch
  ON public.daily_work_move_entries (request_id, batch_id);

-- Every save to an entry asks "is this entry part of a pending merge, or the
-- target of one" — the auto-merge check and the flagged-edit exception both
-- start here. Partial, because almost no entry ever is.
CREATE INDEX IF NOT EXISTS idx_dwme_target_open
  ON public.daily_work_move_entries (target_entry_id)
  WHERE needs_edit OR outcome = 'left_out_too_long';

-- ---------------------------------------------------------------------
-- 5. 'moved' — an assigned item whose work has gone to a project task.
--
-- ASSIGNED ONLY. A recurring item is never 'moved': after its work moves the
-- owner decides whether to retire it or keep it, using the lifecycle recurring
-- items already have.
--
-- Guarded on the constraint text, same pattern as 2026_132 section 4, so a
-- re-run is a no-op and a database where the constraint is missing fails
-- loudly rather than being given a fresh one with an unknown history.
--
-- Nothing is migrated: no existing row can hold 'moved'.
-- ---------------------------------------------------------------------
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conname = 'chk_dwi_status_by_kind'
     AND conrelid = 'public.daily_work_items'::regclass;

  IF def IS NULL THEN
    RAISE EXCEPTION 'chk_dwi_status_by_kind is missing — apply 2026_131 and 2026_132 first';
  END IF;

  IF position('yet_to_start' in def) = 0 THEN
    RAISE EXCEPTION 'chk_dwi_status_by_kind still uses not_started — apply 2026_132 first';
  END IF;

  IF position('moved' in def) = 0 THEN
    ALTER TABLE public.daily_work_items DROP CONSTRAINT chk_dwi_status_by_kind;
    ALTER TABLE public.daily_work_items
      ADD CONSTRAINT chk_dwi_status_by_kind CHECK (
        (kind = 'assigned'  AND status IN ('yet_to_start', 'in_progress', 'in_review',
                                           'completed', 'dropped', 'moved'))
        OR
        (kind = 'recurring' AND status IN ('active', 'retired'))
      );
  ELSE
    RAISE NOTICE 'chk_dwi_status_by_kind already permits moved — nothing to do';
  END IF;
END $$;

COMMENT ON COLUMN public.daily_work_items.status IS
  'assigned: yet_to_start | in_progress | in_review | completed | dropped | moved. '
  'recurring: active | retired. moved (2026_142) = this item''s work was moved '
  'onto a project task by an approved move request; the item is closed and its '
  'remaining entries are history. Any read that lists CLOSED statuses by name '
  'must include moved, or a moved item reads as open.';

-- ---------------------------------------------------------------------
-- 6. Added scope on a project task.
--
-- Two facts, two columns:
--
--   added_by_move_request_id  this task was created by a move request. Set on
--                             every task a request creates.
--   scope_added_at            it was added AFTER the plan was frozen. Set only
--                             when sales_handovers.baseline_frozen_at was not
--                             null at approval. A task added to a draft plan is
--                             part of the plan, not an addition to it.
--
-- NOT a baseline_source value. baseline_source holds the most recent event
-- that set the baseline, and updatePlay writes 'rebaselined' over it — the
-- first rebaseline of an added task would erase the fact that it was added.
--
-- No CHECK ties the two together. The request column is ON DELETE SET NULL
-- (requests cascade away with their item, and items with their owner), and a
-- CHECK requiring it whenever scope_added_at is set would make that delete fail
-- on a project table. The fact that scope was added outlives the request.
--
-- copyProject names its columns explicitly, so a copied plan does not inherit
-- either marker.
-- ---------------------------------------------------------------------
ALTER TABLE public.project_play_instances
  ADD COLUMN IF NOT EXISTS added_by_move_request_id integer;
ALTER TABLE public.project_play_instances
  ADD COLUMN IF NOT EXISTS scope_added_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_ppi_added_by_move_request'
       AND conrelid = 'public.project_play_instances'::regclass
  ) THEN
    ALTER TABLE public.project_play_instances
      ADD CONSTRAINT fk_ppi_added_by_move_request
      FOREIGN KEY (added_by_move_request_id)
      REFERENCES public.daily_work_move_requests(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Plan vs actual counts added scope per project.
CREATE INDEX IF NOT EXISTS idx_ppi_scope_added
  ON public.project_play_instances (handover_id)
  WHERE scope_added_at IS NOT NULL;

COMMENT ON COLUMN public.project_play_instances.scope_added_at IS
  'When this task was added to an already-frozen plan by an approved daily work '
  'move request. NULL for everything in the original or provisional plan. '
  'Independent of baseline_source, which a rebaseline overwrites. As of 2026_142.';

-- ---------------------------------------------------------------------
-- 7. Where a module grant came from.
--
-- An approver without Daily Work access is granted it when a request needs
-- them, and org admins are shown that it was granted for a move request.
-- granted_by alone cannot say why.
--
-- NULL means what every existing row means: granted by an admin. The CHECK
-- lists the one automatic source so a typo in the service fails here rather
-- than showing an admin an unexplained label.
--
-- IMPORTANT for the service layer: moduleAccess.setUserModules deletes every
-- grant for the user and reinserts. It must carry source over for keys that
-- stay granted, or saving the Org Admin panel erases it.
-- ---------------------------------------------------------------------
ALTER TABLE public.user_module_access
  ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.user_module_access
  ADD COLUMN IF NOT EXISTS source_move_request_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_uma_source'
       AND conrelid = 'public.user_module_access'::regclass
  ) THEN
    ALTER TABLE public.user_module_access
      ADD CONSTRAINT chk_uma_source
      CHECK (source IS NULL OR source = 'move_request_approver');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_uma_source_move_request'
       AND conrelid = 'public.user_module_access'::regclass
  ) THEN
    ALTER TABLE public.user_module_access
      ADD CONSTRAINT fk_uma_source_move_request
      FOREIGN KEY (source_move_request_id)
      REFERENCES public.daily_work_move_requests(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 8. Prove the fence held before committing.
--
-- If a later edit to this file widens the anchor vocabulary or lets a
-- recurring item be moved, fail here rather than in review.
-- ---------------------------------------------------------------------
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint WHERE conname = 'chk_dwi_anchor_kind';
  IF def IS NULL OR position('play' in def) > 0 THEN
    RAISE EXCEPTION 'chk_dwi_anchor_kind changed — 2026_142 must not touch the anchor vocabulary';
  END IF;

  -- The recurring branch is everything after the word 'recurring' in the
  -- rendered constraint; 'moved' must not appear in it.
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint WHERE conname = 'chk_dwi_status_by_kind';
  IF position('recurring' in def) = 0
     OR position('moved' in substring(def from position('recurring' in def))) > 0 THEN
    RAISE EXCEPTION 'chk_dwi_status_by_kind lets a recurring item be moved: %', def;
  END IF;
END $$;

COMMIT;

-- =====================================================================
-- VERIFY
--
-- Run scripts/verify_move_requests_142.js after applying. It asserts every
-- constraint and index by name, every foreign key's delete action, that no new
-- reference to users(id) is NO ACTION, and the behaviour: one open request per
-- item, the status/is_open shapes, batches that cannot cross requests, an
-- entry that cannot be outstanding twice, 'moved' for assigned items only,
-- and that deleting a requester or an owner does not fail.
--
-- =====================================================================
-- Deploy notes — what breaks if a piece is missing
--
-- 1. Without uq_dwmr_one_open_per_item, two requests on one item can both be
--    approved, and the second tries to move entries the first already moved.
--
-- 2. Without the composite batch foreign keys, an approval for request A can
--    be recorded against a batch of request B, and B executes on A's decision.
--
-- 3. Without uq_dwme_entry_outstanding, a left-out entry waiting to auto-merge
--    can be claimed by a second request and moved twice.
--
-- 4. Without 'moved' in chk_dwi_status_by_kind, executing a move fails on the
--    last statement and rolls back the whole approval.
--
-- 5. Code that lists CLOSED item statuses by name must learn 'moved' in the
--    same deploy as the service that writes it, or moved items reappear on My
--    day and count in reminders. Known today: dailyWork.service getDay,
--    DailyWorkView openRows, dailyWorkNotify runReminders. Reads that list the
--    OPEN statuses (getAssignedItems, getStalledAssigned,
--    countAssignedOutside) are already correct.
--
-- 6. moduleAccess.setUserModules must preserve user_module_access.source, or
--    the first Org Admin save wipes the "granted for a move request" label.
-- =====================================================================
