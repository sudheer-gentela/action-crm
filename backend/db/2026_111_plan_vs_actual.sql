-- =====================================================================
-- 2026_111_plan_vs_actual.sql   —   Phase B
--
--   B1  baseline_due_date + baseline_source on project_play_instances
--   B2  play_due_date_revisions   (audit trail for every date change)
--   B3  play_evidence             (immutable, soft-revocable proof)
--   B4  project_members.can_rebaseline
--
-- WHY A BASELINE
--   due_date is mutable — updatePlay lets an authorised user move it. Without
--   a frozen original, variance silently reads zero on a project that ran
--   months over: the plan moves with the slippage. baseline_due_date is
--   written once and never updated, so "vs baseline" means total slip and
--   "vs current due" means forecast accuracy. They are different questions.
--
-- WHY A REVISION LOG
--   One play moved once by 30 days and one moved six times by 5 days have
--   identical baseline variance and are completely different situations.
--   Revision count is often the more revealing number, and it cannot be
--   reconstructed after the fact.
--
-- WHY EVIDENCE IS IMMUTABLE
--   Proof that can be quietly edited is not proof. Rows are physically
--   immutable via trigger; a mistake is corrected by REVOKING (which is
--   itself recorded), never by rewriting. A system with no correction path
--   gets worked around, so revocation is deliberately provided.
--
-- Run AFTER 2026_109 and 2026_110.
--   psql "$DATABASE_URL" -f 2026_111_plan_vs_actual.sql
-- =====================================================================

\set ON_ERROR_STOP on
SET statement_timeout = '600s';

BEGIN;

-- Guard: this migration assumes the project play split has landed.
DO $$
BEGIN
  IF to_regclass('public.project_play_instances') IS NULL THEN
    RAISE EXCEPTION 'HARD STOP: project_play_instances does not exist. Run 2026_109 first.';
  END IF;
END $$;

-- =====================================================================
-- B1. Baseline
-- =====================================================================
ALTER TABLE public.project_play_instances
  ADD COLUMN IF NOT EXISTS baseline_due_date date;

-- 'original' — captured at instantiation, trustworthy.
-- 'inferred' — back-filled from the current due_date by this migration. The
--              real original was never recorded, so any variance measured
--              against it understates the slip. The report must say so rather
--              than imply a precision it does not have.
-- 'rebaselined' — deliberately reset by an authorised user; the revision log
--              holds what it was before and why.
ALTER TABLE public.project_play_instances
  ADD COLUMN IF NOT EXISTS baseline_source text;

ALTER TABLE public.project_play_instances
  DROP CONSTRAINT IF EXISTS project_play_instances_baseline_source_chk;
ALTER TABLE public.project_play_instances
  ADD CONSTRAINT project_play_instances_baseline_source_chk
  CHECK (baseline_source IS NULL
         OR baseline_source IN ('original', 'inferred', 'rebaselined'));

-- Back-fill. Only rows that actually have a due date get a baseline: giving an
-- unscheduled play a baseline of NULL-turned-something would invent a plan
-- that never existed.
UPDATE public.project_play_instances
   SET baseline_due_date = due_date,
       baseline_source   = 'inferred'
 WHERE baseline_due_date IS NULL
   AND due_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ppi_baseline
  ON public.project_play_instances (handover_id, baseline_due_date)
  WHERE baseline_due_date IS NOT NULL;

-- =====================================================================
-- B2. Date revisions
--
-- Shape follows the house pattern (sales_handover_commitment_events,
-- deal_stage_history): org-scoped, from/to, actor, timestamp.
--
-- Nullable FK per module with a source_module discriminator, mirroring how
-- `actions` carries deal_id / contract_id / case_id. That way CLM and Service
-- can adopt the same table later by adding their own column and instance
-- baseline, rather than needing a second audit table.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.play_due_date_revisions (
    id                       integer NOT NULL,
    org_id                   integer NOT NULL,
    source_module            text    NOT NULL,
    project_play_instance_id integer,
    deal_play_instance_id    integer,
    contract_play_instance_id integer,
    from_due_date            date,
    to_due_date              date,
    reason                   text,
    -- true = the baseline was deliberately reset (an approved replan).
    -- false = an ordinary slip; the baseline stands and variance grows.
    is_rebaseline            boolean NOT NULL DEFAULT false,
    -- what the baseline was before a rebaseline, so the original commitment
    -- is never lost even after it stops being the active baseline.
    previous_baseline_date   date,
    revised_by               integer NOT NULL,
    revised_at               timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT play_due_date_revisions_module_chk
      CHECK (source_module IN ('project', 'deal', 'contract')),
    -- Exactly one instance FK set — the same shape guard used across `actions`.
    CONSTRAINT play_due_date_revisions_one_entity_chk CHECK (
      (CASE WHEN project_play_instance_id  IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN deal_play_instance_id     IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN contract_play_instance_id IS NOT NULL THEN 1 ELSE 0 END) = 1
    ),
    -- A rebaseline without a stated reason is indistinguishable from covering
    -- a slip. Required here rather than only in the service layer.
    CONSTRAINT play_due_date_revisions_rebaseline_reason_chk
      CHECK (is_rebaseline = false OR (reason IS NOT NULL AND btrim(reason) <> ''))
);

CREATE SEQUENCE IF NOT EXISTS public.play_due_date_revisions_id_seq
  AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.play_due_date_revisions_id_seq
  OWNED BY public.play_due_date_revisions.id;
ALTER TABLE ONLY public.play_due_date_revisions
  ALTER COLUMN id SET DEFAULT nextval('public.play_due_date_revisions_id_seq'::regclass);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_due_date_revisions_pkey') THEN
    ALTER TABLE ONLY public.play_due_date_revisions ADD CONSTRAINT play_due_date_revisions_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_due_date_revisions_org_fkey') THEN
    ALTER TABLE ONLY public.play_due_date_revisions ADD CONSTRAINT play_due_date_revisions_org_fkey
      FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_due_date_revisions_project_fkey') THEN
    ALTER TABLE ONLY public.play_due_date_revisions ADD CONSTRAINT play_due_date_revisions_project_fkey
      FOREIGN KEY (project_play_instance_id) REFERENCES public.project_play_instances(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_due_date_revisions_deal_fkey') THEN
    ALTER TABLE ONLY public.play_due_date_revisions ADD CONSTRAINT play_due_date_revisions_deal_fkey
      FOREIGN KEY (deal_play_instance_id) REFERENCES public.deal_play_instances(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_due_date_revisions_contract_fkey') THEN
    ALTER TABLE ONLY public.play_due_date_revisions ADD CONSTRAINT play_due_date_revisions_contract_fkey
      FOREIGN KEY (contract_play_instance_id) REFERENCES public.contract_play_instances(id) ON DELETE CASCADE;
  END IF;
  -- revised_by has NO on-delete action deliberately: superAdmin's deletion
  -- sweep nulls it, and an audit row must survive the user who wrote it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_due_date_revisions_user_fkey') THEN
    ALTER TABLE ONLY public.play_due_date_revisions ADD CONSTRAINT play_due_date_revisions_user_fkey
      FOREIGN KEY (revised_by) REFERENCES public.users(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pddr_project
  ON public.play_due_date_revisions (project_play_instance_id, revised_at)
  WHERE project_play_instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pddr_org ON public.play_due_date_revisions (org_id, revised_at);

-- =====================================================================
-- B3. Evidence
--
-- Points at a WhatsApp message AND snapshots its content at accept time.
-- Both, not either:
--   • the FK keeps live linkage (open the thread, see the message in context)
--   • the snapshot preserves what the approver actually saw
--
-- The snapshot is not belt-and-braces. Conversation bindings exist precisely
-- because messages get RE-FILED between projects, so a message accepted as
-- proof for project A can later belong to project B. The FK would then point
-- somewhere misleading while the snapshot still records the evidence as it
-- stood when someone signed off on it.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.play_evidence (
    id                       integer NOT NULL,
    org_id                   integer NOT NULL,
    project_play_instance_id integer NOT NULL,
    channel                  text    NOT NULL DEFAULT 'whatsapp',
    whatsapp_message_id      integer,
    -- snapshot, captured once at accept time and never updated
    snapshot_body            text,
    snapshot_sender          text,
    snapshot_sent_at         timestamp with time zone,
    snapshot_thread_id       integer,
    note                     text,
    accepted_by              integer NOT NULL,
    accepted_at              timestamp with time zone NOT NULL DEFAULT now(),
    -- soft revocation: rows are never deleted, so "this was withdrawn, by whom
    -- and why" stays answerable
    revoked_at               timestamp with time zone,
    revoked_by               integer,
    revoke_reason            text,
    CONSTRAINT play_evidence_channel_chk
      CHECK (channel IN ('whatsapp', 'email', 'file', 'manual')),
    CONSTRAINT play_evidence_whatsapp_shape_chk
      CHECK (channel <> 'whatsapp' OR whatsapp_message_id IS NOT NULL),
    -- revocation is all-or-nothing: a revoked row must say who and when
    CONSTRAINT play_evidence_revoke_shape_chk CHECK (
      (revoked_at IS NULL AND revoked_by IS NULL)
      OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL
          AND revoke_reason IS NOT NULL AND btrim(revoke_reason) <> '')
    )
);

CREATE SEQUENCE IF NOT EXISTS public.play_evidence_id_seq
  AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.play_evidence_id_seq OWNED BY public.play_evidence.id;
ALTER TABLE ONLY public.play_evidence
  ALTER COLUMN id SET DEFAULT nextval('public.play_evidence_id_seq'::regclass);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_evidence_pkey') THEN
    ALTER TABLE ONLY public.play_evidence ADD CONSTRAINT play_evidence_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_evidence_org_fkey') THEN
    ALTER TABLE ONLY public.play_evidence ADD CONSTRAINT play_evidence_org_fkey
      FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_evidence_instance_fkey') THEN
    ALTER TABLE ONLY public.play_evidence ADD CONSTRAINT play_evidence_instance_fkey
      FOREIGN KEY (project_play_instance_id) REFERENCES public.project_play_instances(id) ON DELETE CASCADE;
  END IF;
  -- ON DELETE SET NULL, not CASCADE: if the message row is ever removed the
  -- evidence must survive on its snapshot rather than vanish.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_evidence_message_fkey') THEN
    ALTER TABLE ONLY public.play_evidence ADD CONSTRAINT play_evidence_message_fkey
      FOREIGN KEY (whatsapp_message_id) REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_evidence_accepted_by_fkey') THEN
    ALTER TABLE ONLY public.play_evidence ADD CONSTRAINT play_evidence_accepted_by_fkey
      FOREIGN KEY (accepted_by) REFERENCES public.users(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_evidence_revoked_by_fkey') THEN
    ALTER TABLE ONLY public.play_evidence ADD CONSTRAINT play_evidence_revoked_by_fkey
      FOREIGN KEY (revoked_by) REFERENCES public.users(id);
  END IF;
END $$;

-- One live acceptance per (play, message). A revoked row does not block
-- re-accepting the same message later, which is why the index is partial.
CREATE UNIQUE INDEX IF NOT EXISTS uq_play_evidence_live
  ON public.play_evidence (project_play_instance_id, whatsapp_message_id)
  WHERE (revoked_at IS NULL AND whatsapp_message_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_play_evidence_instance
  ON public.play_evidence (project_play_instance_id) WHERE revoked_at IS NULL;

-- ── Immutability ─────────────────────────────────────────────────────
-- Enforced by trigger rather than by revoking table privileges, because the
-- application connects as the table owner on Railway and a GRANT-based rule
-- would simply not apply to it.
--
-- The ONLY permitted update is a revocation transition: an un-revoked row
-- gaining revoked_at / revoked_by / revoke_reason. Everything else, including
-- re-revoking or editing a revocation, raises.
CREATE OR REPLACE FUNCTION public.play_evidence_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'play_evidence is append-only: revoke it instead of deleting (id %)', OLD.id;
  END IF;

  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'play_evidence % is already revoked and cannot be changed', OLD.id;
  END IF;

  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'play_evidence % is immutable; the only permitted update is a revocation', OLD.id;
  END IF;

  -- Every substantive field must be carried through unchanged.
  IF NEW.id                       IS DISTINCT FROM OLD.id
     OR NEW.org_id                IS DISTINCT FROM OLD.org_id
     OR NEW.project_play_instance_id IS DISTINCT FROM OLD.project_play_instance_id
     OR NEW.channel               IS DISTINCT FROM OLD.channel
     OR NEW.whatsapp_message_id   IS DISTINCT FROM OLD.whatsapp_message_id
     OR NEW.snapshot_body         IS DISTINCT FROM OLD.snapshot_body
     OR NEW.snapshot_sender       IS DISTINCT FROM OLD.snapshot_sender
     OR NEW.snapshot_sent_at      IS DISTINCT FROM OLD.snapshot_sent_at
     OR NEW.snapshot_thread_id    IS DISTINCT FROM OLD.snapshot_thread_id
     OR NEW.note                  IS DISTINCT FROM OLD.note
     OR NEW.accepted_by           IS DISTINCT FROM OLD.accepted_by
     OR NEW.accepted_at           IS DISTINCT FROM OLD.accepted_at
  THEN
    RAISE EXCEPTION 'play_evidence % is immutable; only the revocation fields may be set', OLD.id;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_play_evidence_immutable ON public.play_evidence;
CREATE TRIGGER trg_play_evidence_immutable
  BEFORE UPDATE OR DELETE ON public.play_evidence
  FOR EACH ROW EXECUTE FUNCTION public.play_evidence_immutable();

-- =====================================================================
-- B4. Re-baseline grant
--
-- Per-project rather than org-wide: someone running one delivery should not
-- gain the right to reset baselines everywhere. The service layer also allows
-- the project owner / creator and org admins via canManageProject().
-- =====================================================================
ALTER TABLE public.project_members
  ADD COLUMN IF NOT EXISTS can_rebaseline boolean NOT NULL DEFAULT false;

COMMIT;

\echo ''
\echo '=== B1. Baseline back-fill ==='
SELECT baseline_source, count(*) AS plays,
       count(*) FILTER (WHERE baseline_due_date IS NOT NULL) AS with_baseline
  FROM public.project_play_instances
 GROUP BY baseline_source ORDER BY 2 DESC;

\echo ''
\echo '=== Measurable set for the variance report ==='
SELECT count(*)                                                       AS total_plays,
       count(*) FILTER (WHERE baseline_due_date IS NOT NULL)          AS has_baseline,
       count(*) FILTER (WHERE completed_at IS NOT NULL)               AS completed,
       count(*) FILTER (WHERE baseline_due_date IS NOT NULL
                          AND completed_at IS NOT NULL)               AS measurable
  FROM public.project_play_instances;

\echo ''
\echo '=== New objects ==='
SELECT tablename FROM pg_tables
 WHERE schemaname = 'public' AND tablename IN ('play_due_date_revisions','play_evidence')
 ORDER BY 1;
SELECT tgname AS trigger_name FROM pg_trigger WHERE tgname = 'trg_play_evidence_immutable';

\echo ''
\echo 'NOTE: every back-filled baseline is marked inferred. The true original'
\echo 'due dates were never recorded, so variance against them understates the'
\echo 'real slip. The report surfaces this rather than implying false precision.'
