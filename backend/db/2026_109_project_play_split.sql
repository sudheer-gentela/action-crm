-- =====================================================================
-- 2026_109_project_play_split.sql
--
-- Phase A1 + A2 + A3 of the project/deal playbook split.
--
--   A1  create project_play_instances + project_play_assignees
--   A2  migrate project-linked rows out of deal_play_instances,
--       PRESERVING INSTANCE IDS
--   A3  add actions.handover_id so a project's actions can point at the
--       project instead of borrowing its deal's id
--
-- WHY
--   deal_play_instances is shared by deals and projects. Two consequences:
--     1. Project-only columns (baselines, WBS parent, BoQ links) would
--        land on deals, which do not want them.
--     2. Projects are linked through sales_handover_plays, not the
--        handover_id column — every project row in this database has
--        handover_id NULL. Two link mechanisms for one relationship.
--   Separately, actions has no handover_id, so PlayCompletionService
--   resolves a project's actions and roles against its DEAL. An internal
--   project has deal_id NULL, so that path cannot work at all for them.
--
-- IDS ARE PRESERVED
--   deal_play_instances.action_id points at actions, and the frontend
--   holds playInstanceId in component state. Re-numbering would break
--   both. The migration copies ids verbatim and then advances the new
--   sequence past the maximum.
--
-- ROLLBACK
--   Nothing is dropped. sales_handover_plays and the migrated rows in
--   deal_play_instances are LEFT IN PLACE, so reverting is a code
--   rollback plus DROP of the two new tables. The old rows are cleaned up
--   in a later migration once this has proven itself.
--
-- RUN
--   psql "$DATABASE_URL" -f 2026_109_project_play_split.sql
-- =====================================================================

\set ON_ERROR_STOP on
SET statement_timeout = '600s';

BEGIN;

-- ---------------------------------------------------------------------
-- Pre-flight: capture the "before" picture so the verification at the
-- end can prove deal rows were untouched.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE _pre AS
SELECT
  (SELECT count(*) FROM deal_play_instances)                            AS dpi_total,
  (SELECT count(*) FROM deal_play_instances WHERE deal_id IS NOT NULL)  AS dpi_deal_rows,
  (SELECT count(*) FROM sales_handover_plays)                           AS shp_links,
  (SELECT count(DISTINCT shp.play_instance_id) FROM sales_handover_plays shp) AS shp_distinct,
  (SELECT count(*) FROM deal_play_assignees a
     JOIN sales_handover_plays s ON s.play_instance_id = a.instance_id)  AS project_assignees,
  -- Content checksum of rows that belong ONLY to deals — i.e. not linked to
  -- any project. A plain row count would not catch a value being altered,
  -- and "deals are untouched" is the whole promise of this split.
  (SELECT md5(string_agg(t.rec, '|' ORDER BY t.rec))
     FROM (SELECT dpi::text AS rec
             FROM deal_play_instances dpi
            WHERE dpi.id NOT IN (SELECT play_instance_id FROM sales_handover_plays)
              AND dpi.deal_id IS NOT NULL) t)                            AS deal_only_checksum,
  (SELECT count(*) FROM deal_play_instances dpi
    WHERE dpi.id NOT IN (SELECT play_instance_id FROM sales_handover_plays)
      AND dpi.deal_id IS NOT NULL)                                       AS deal_only_rows;

-- =====================================================================
-- A1. New tables
-- =====================================================================

-- Mirror of deal_play_instances with these deliberate differences:
--   • deal_id            REMOVED  — a project play never belongs to a deal
--   • handover_id        NOT NULL — single, mandatory link. No second
--                        mechanism, no NULL-vs-join ambiguity.
--   • parent_instance_id ADDED    — reserved for WBS nesting (phase →
--                        work package → task). Nullable and unused today;
--                        adding it now avoids a second rewrite of this
--                        table later.
--   • baseline columns are NOT added here — that is Phase B.
CREATE TABLE public.project_play_instances (
    id                  integer NOT NULL,
    handover_id         integer NOT NULL,
    org_id              integer NOT NULL,
    play_id             integer,
    stage_key           text NOT NULL,
    title               text NOT NULL,
    description         text,
    channel             text,
    priority            text DEFAULT 'medium'::text,
    execution_type      text DEFAULT 'parallel'::text NOT NULL,
    is_gate             boolean DEFAULT false NOT NULL,
    due_date            date,
    sort_order          integer DEFAULT 0 NOT NULL,
    status              text DEFAULT 'not_started'::text NOT NULL,
    is_manual           boolean DEFAULT false NOT NULL,
    overridden_by       integer,
    completed_at        timestamp with time zone,
    completed_by        integer,
    action_id           integer,
    created_at          timestamp with time zone DEFAULT now() NOT NULL,
    updated_at          timestamp with time zone DEFAULT now() NOT NULL,
    playbook_id         integer,
    due_anchor          character varying(20) DEFAULT 'created'::character varying NOT NULL,
    completion_note     text,
    completion_evidence jsonb,
    owner_user_id       integer,
    parent_instance_id  integer,
    CONSTRAINT project_play_instances_status_check
      CHECK ((status = ANY (ARRAY['not_started'::text, 'in_progress'::text,
             'blocked'::text, 'snoozed'::text, 'completed'::text,
             'skipped'::text, 'cancelled'::text]))),
    -- A play cannot be its own parent. Deeper cycles are prevented in the
    -- service layer; this catches the trivial case cheaply.
    CONSTRAINT project_play_instances_parent_not_self
      CHECK (parent_instance_id IS NULL OR parent_instance_id <> id)
);

CREATE SEQUENCE public.project_play_instances_id_seq
  AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.project_play_instances_id_seq
  OWNED BY public.project_play_instances.id;
ALTER TABLE ONLY public.project_play_instances
  ALTER COLUMN id SET DEFAULT nextval('public.project_play_instances_id_seq'::regclass);

ALTER TABLE ONLY public.project_play_instances
  ADD CONSTRAINT project_play_instances_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.project_play_instances
  ADD CONSTRAINT project_play_instances_handover_fkey
  FOREIGN KEY (handover_id) REFERENCES public.sales_handovers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.project_play_instances
  ADD CONSTRAINT project_play_instances_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.project_play_instances
  ADD CONSTRAINT project_play_instances_play_id_fkey
  FOREIGN KEY (play_id) REFERENCES public.playbook_plays(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.project_play_instances
  ADD CONSTRAINT project_play_instances_playbook_id_fkey
  FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.project_play_instances
  ADD CONSTRAINT project_play_instances_action_id_fkey
  FOREIGN KEY (action_id) REFERENCES public.actions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.project_play_instances
  ADD CONSTRAINT project_play_instances_completed_by_fkey
  FOREIGN KEY (completed_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.project_play_instances
  ADD CONSTRAINT project_play_instances_overridden_by_fkey
  FOREIGN KEY (overridden_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.project_play_instances
  ADD CONSTRAINT project_play_instances_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES public.users(id);
-- Self-reference for WBS nesting. CASCADE: deleting a phase removes the
-- work packages beneath it, which is the intended semantic.
ALTER TABLE ONLY public.project_play_instances
  ADD CONSTRAINT project_play_instances_parent_fkey
  FOREIGN KEY (parent_instance_id) REFERENCES public.project_play_instances(id) ON DELETE CASCADE;

-- Indexes mirror the deal-side set, re-keyed on handover_id. The unique
-- index is the important one: it is what stops a playbook being
-- instantiated twice onto the same project.
CREATE UNIQUE INDEX idx_ppi_unique       ON public.project_play_instances (handover_id, play_id) WHERE (play_id IS NOT NULL);
CREATE INDEX idx_ppi_handover_stage      ON public.project_play_instances (handover_id, stage_key);
CREATE INDEX idx_ppi_handover_status     ON public.project_play_instances (handover_id, status);
CREATE INDEX idx_ppi_org                 ON public.project_play_instances (org_id);
CREATE INDEX idx_ppi_action              ON public.project_play_instances (action_id) WHERE (action_id IS NOT NULL);
CREATE INDEX idx_ppi_owner_user          ON public.project_play_instances (owner_user_id) WHERE (owner_user_id IS NOT NULL);
CREATE INDEX idx_ppi_playbook_id         ON public.project_play_instances (playbook_id) WHERE (playbook_id IS NOT NULL);
CREATE INDEX idx_ppi_parent              ON public.project_play_instances (parent_instance_id) WHERE (parent_instance_id IS NOT NULL);
-- Supports the corrected display ordering: stage, then plan order, then date.
CREATE INDEX idx_ppi_display_order       ON public.project_play_instances (handover_id, stage_key, sort_order);
-- go_live-anchored plays awaiting a date, re-keyed off the project.
CREATE INDEX idx_ppi_go_live_anchored    ON public.project_play_instances (handover_id)
  WHERE ((due_anchor)::text = 'go_live'::text AND status <> ALL (ARRAY['completed'::text, 'skipped'::text]));

CREATE TABLE public.project_play_assignees (
    id          integer NOT NULL,
    instance_id integer NOT NULL,
    user_id     integer NOT NULL,
    role_id     integer,
    assigned_by integer,
    created_at  timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.project_play_assignees_id_seq
  AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.project_play_assignees_id_seq
  OWNED BY public.project_play_assignees.id;
ALTER TABLE ONLY public.project_play_assignees
  ALTER COLUMN id SET DEFAULT nextval('public.project_play_assignees_id_seq'::regclass);

ALTER TABLE ONLY public.project_play_assignees
  ADD CONSTRAINT project_play_assignees_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.project_play_assignees
  ADD CONSTRAINT project_play_assignees_instance_id_fkey
  FOREIGN KEY (instance_id) REFERENCES public.project_play_instances(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.project_play_assignees
  ADD CONSTRAINT project_play_assignees_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE INDEX idx_ppa_instance ON public.project_play_assignees (instance_id);
CREATE INDEX idx_ppa_user     ON public.project_play_assignees (user_id);

-- =====================================================================
-- A3. actions.handover_id
--
-- Without this a project's actions are written against its deal, and
-- PlayCompletionService resolves roles against the deal owner. An
-- internal project has no deal, so that path is unreachable for it.
-- Nullable: existing deal/contract/case actions are unaffected.
-- =====================================================================
ALTER TABLE public.actions ADD COLUMN IF NOT EXISTS handover_id integer;

ALTER TABLE ONLY public.actions
  ADD CONSTRAINT actions_handover_id_fkey
  FOREIGN KEY (handover_id) REFERENCES public.sales_handovers(id) ON DELETE CASCADE;

CREATE INDEX idx_actions_handover ON public.actions (handover_id, status)
  WHERE (handover_id IS NOT NULL);

-- =====================================================================
-- A2. Migrate project-linked rows, preserving ids
--
-- sales_handover_plays is the authority: every project row in this
-- database has deal_play_instances.handover_id NULL and is reachable
-- only through the link table.
--
-- DISTINCT ON guards against a play instance linked to two handovers.
-- That should be impossible, but the link table has no unique constraint
-- on play_instance_id, so a duplicate would silently fan out the copy.
-- The assertion after this checks the count came out as expected.
-- =====================================================================
INSERT INTO public.project_play_instances (
    id, handover_id, org_id, play_id, stage_key, title, description,
    channel, priority, execution_type, is_gate, due_date, sort_order,
    status, is_manual, overridden_by, completed_at, completed_by,
    action_id, created_at, updated_at, playbook_id, due_anchor,
    completion_note, completion_evidence, owner_user_id, parent_instance_id)
SELECT DISTINCT ON (dpi.id)
    dpi.id, shp.handover_id, dpi.org_id, dpi.play_id, dpi.stage_key,
    dpi.title, dpi.description, dpi.channel, dpi.priority,
    dpi.execution_type, dpi.is_gate, dpi.due_date, dpi.sort_order,
    dpi.status, dpi.is_manual, dpi.overridden_by, dpi.completed_at,
    dpi.completed_by, dpi.action_id, dpi.created_at, dpi.updated_at,
    dpi.playbook_id, dpi.due_anchor, dpi.completion_note,
    dpi.completion_evidence, dpi.owner_user_id,
    NULL::integer                                   -- parent: flat today
FROM public.sales_handover_plays shp
JOIN public.deal_play_instances dpi ON dpi.id = shp.play_instance_id
ORDER BY dpi.id, shp.handover_id;

-- Advance the sequence past every migrated id, or the first insert after
-- this migration collides with a preserved id.
SELECT setval('public.project_play_instances_id_seq',
              GREATEST((SELECT COALESCE(max(id), 0) FROM public.project_play_instances), 1),
              true);

-- Assignees follow their instances. Ids are NOT preserved here: nothing
-- references deal_play_assignees.id, so there is no linkage to protect.
INSERT INTO public.project_play_assignees (instance_id, user_id, role_id, assigned_by, created_at)
SELECT a.instance_id, a.user_id, a.role_id, a.assigned_by, a.created_at
FROM public.deal_play_assignees a
WHERE a.instance_id IN (SELECT id FROM public.project_play_instances);

-- Point migrated actions at their project. Actions previously carried
-- only the deal id; for projects derived from a deal both are now set,
-- and the service layer will prefer handover_id.
UPDATE public.actions act
   SET handover_id = ppi.handover_id
  FROM public.project_play_instances ppi
 WHERE ppi.action_id = act.id
   AND act.handover_id IS DISTINCT FROM ppi.handover_id;

-- =====================================================================
-- Verification. Any failure aborts the whole migration.
-- =====================================================================
DO $$
DECLARE p record; migrated int; expected int; deal_now int; assignees int; deal_sum text;
BEGIN
  SELECT * INTO p FROM _pre;

  SELECT count(*) INTO migrated FROM public.project_play_instances;
  expected := p.shp_distinct;
  IF migrated <> expected THEN
    RAISE EXCEPTION 'HARD STOP: migrated % instance(s), expected % (distinct links in sales_handover_plays).',
      migrated, expected;
  END IF;

  -- The whole point of the split: deals must be untouched. Compare the
  -- CONTENT of deal-only rows, not just how many there are.
  SELECT count(*) INTO deal_now FROM public.deal_play_instances WHERE deal_id IS NOT NULL;
  IF deal_now <> p.dpi_deal_rows THEN
    RAISE EXCEPTION 'HARD STOP: rows with deal_id changed from % to %. Nothing should have been deleted.',
      p.dpi_deal_rows, deal_now;
  END IF;

  SELECT md5(string_agg(t.rec, '|' ORDER BY t.rec)) INTO deal_sum
    FROM (SELECT dpi::text AS rec
            FROM public.deal_play_instances dpi
           WHERE dpi.id NOT IN (SELECT play_instance_id FROM public.sales_handover_plays)
             AND dpi.deal_id IS NOT NULL) t;
  IF deal_sum IS DISTINCT FROM p.deal_only_checksum THEN
    RAISE EXCEPTION 'HARD STOP: deal-only play rows were modified. % rows checksummed. '
      'Deals must be byte-identical after this migration.', p.deal_only_rows;
  END IF;

  SELECT count(*) INTO assignees FROM public.project_play_assignees;
  IF assignees <> p.project_assignees THEN
    RAISE EXCEPTION 'HARD STOP: copied % assignee(s), expected %.', assignees, p.project_assignees;
  END IF;

  -- Every migrated row must resolve to a real project in the same org.
  PERFORM 1 FROM public.project_play_instances ppi
    LEFT JOIN public.sales_handovers h
           ON h.id = ppi.handover_id AND h.org_id = ppi.org_id
   WHERE h.id IS NULL;
  IF FOUND THEN
    RAISE EXCEPTION 'HARD STOP: migrated rows reference a missing or cross-org project.';
  END IF;

  -- The sequence must be clear of every preserved id.
  IF (SELECT last_value FROM public.project_play_instances_id_seq)
     < (SELECT COALESCE(max(id), 0) FROM public.project_play_instances) THEN
    RAISE EXCEPTION 'HARD STOP: sequence is behind max(id); the next insert would collide.';
  END IF;
END $$;

COMMIT;

\echo ''
\echo '=== Migration summary ==='
SELECT
  (SELECT count(*) FROM project_play_instances)                              AS project_plays,
  (SELECT count(*) FROM project_play_assignees)                              AS project_assignees,
  (SELECT count(*) FROM deal_play_instances dpi WHERE dpi.deal_id IS NOT NULL
     AND dpi.id NOT IN (SELECT play_instance_id FROM sales_handover_plays)) AS deal_only_plays,
  (SELECT count(*) FROM actions WHERE handover_id IS NOT NULL)               AS actions_linked_to_project,
  (SELECT last_value FROM project_play_instances_id_seq)                     AS next_id_after;

\echo ''
\echo '=== Status distribution (should mirror the source) ==='
SELECT status, count(*) FROM project_play_instances GROUP BY status ORDER BY count(*) DESC;

\echo ''
\echo 'Old rows in deal_play_instances and sales_handover_plays were left in'
\echo 'place deliberately. They are the rollback path. Drop them in a later'
\echo 'migration once the repointed code has run in production.'
