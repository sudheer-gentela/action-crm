-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_64_handover_deliverable_tracking.sql
--
-- Sales → Implementation Handover: make deliverables trackable to closure.
--
-- FIXES THREE DEFECTS
--   1. sales_handover_commitments.due_date is queried by
--      handover.service.buildHandoverContext() (the `overdueCommitments` CTE)
--      and drives HandoverRulesEngine's `handover_commitment_overdue` rule,
--      but the column was never created. Every nightly sweep therefore throws
--      42703 (undefined_column) on the FIRST handover it touches and aborts
--      the whole org's sweep. The referenced `migration_phase2.sql` does not
--      exist in db/. This migration is that missing migration.
--   2. Commitments had no lifecycle. A commitment could be INSERTed or
--      DELETEd, never worked. "Tracked to closure" was not representable:
--      the only way to clear a commitment was to destroy the evidence it ever
--      existed. `status` + `closed_at`/`closed_by`/`closure_note` fix that.
--   3. sales_handovers.status topped out at 'in_progress' with an empty
--      transition list, so a handover could never reach a terminal state.
--      Adds 'completed' and 'cancelled'.
--
-- DESIGN NOTES
--   • Deliberate distinction between met / waived / breached. All three are
--     terminal, but they mean very different things in a QBR and in a renewal
--     conversation. Today both outcomes collapse into DELETE, which is why
--     nobody can answer "did we do what sales promised?" after the fact.
--     `waived` and `breached` require a closure_note (enforced below).
--   • `due_anchor` on playbook_plays lets an implementation play be scheduled
--     BACKWARD from go-live ("UAT sign-off = go_live - 14") instead of forward
--     from kickoff. due_offset_days becomes signed for these rows; the old
--     CHECK-free integer column already permits negatives, so no type change.
--   • The go-live reschedule trigger keeps go_live-anchored play instances
--     honest when the date slips. Silent date rot after a go-live slip is the
--     single most common way implementation tracking stops being believed.
--   • org_id is denormalised onto nothing new here — the tables already carry
--     it (house pattern). Indexes below all lead with org_id or handover_id
--     to stay aligned with existing access paths.
--
-- IDEMPOTENT: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. COMMITMENTS → tracked deliverables
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.sales_handover_commitments
  ADD COLUMN IF NOT EXISTS due_date      date,
  ADD COLUMN IF NOT EXISTS owner_user_id integer REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS status        character varying(20) NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS closed_at     timestamp with time zone,
  ADD COLUMN IF NOT EXISTS closed_by     integer REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS closure_note  text,
  ADD COLUMN IF NOT EXISTS updated_at    timestamp with time zone DEFAULT now() NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_handover_commitments_status_check'
  ) THEN
    ALTER TABLE public.sales_handover_commitments
      ADD CONSTRAINT sales_handover_commitments_status_check
      CHECK (status IN ('open', 'in_progress', 'met', 'waived', 'breached'));
  END IF;

  -- A commitment that was waived or breached MUST carry an explanation.
  -- 'met' does not: completion is self-explanatory, and forcing a note there
  -- would just train people to type "done".
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_handover_commitments_closure_note_check'
  ) THEN
    ALTER TABLE public.sales_handover_commitments
      ADD CONSTRAINT sales_handover_commitments_closure_note_check
      CHECK (
        status NOT IN ('waived', 'breached')
        OR (closure_note IS NOT NULL AND length(btrim(closure_note)) > 0)
      );
  END IF;

  -- Terminal statuses must be stamped; non-terminal must not be.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_handover_commitments_closed_at_check'
  ) THEN
    ALTER TABLE public.sales_handover_commitments
      ADD CONSTRAINT sales_handover_commitments_closed_at_check
      CHECK (
        (status IN ('met', 'waived', 'breached') AND closed_at IS NOT NULL)
        OR (status IN ('open', 'in_progress')    AND closed_at IS NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN public.sales_handover_commitments.due_date IS
  'Date the commitment was promised for. Drives HandoverRulesEngine.handover_commitment_overdue. NULL = no date agreed (allowed; the rule simply skips it).';
COMMENT ON COLUMN public.sales_handover_commitments.status IS
  'open | in_progress | met | waived | breached. The last three are terminal. waived = customer released us from it; breached = we did not deliver. Both require closure_note.';
COMMENT ON COLUMN public.sales_handover_commitments.owner_user_id IS
  'Who owes this. Usually the assigned_service_owner post-acknowledgement, but a commitment can be owned by the sales rep (e.g. a pricing concession they must formalise).';

-- Overdue lookup: the nightly sweep hits this once per active handover.
CREATE INDEX IF NOT EXISTS idx_shc_handover_open_due
  ON public.sales_handover_commitments (handover_id, due_date)
  WHERE status IN ('open', 'in_progress') AND due_date IS NOT NULL;

-- Org-wide "what is overdue across all handovers" for the rollup view.
CREATE INDEX IF NOT EXISTS idx_shc_org_open_due
  ON public.sales_handover_commitments (org_id, due_date)
  WHERE status IN ('open', 'in_progress');

-- Keep updated_at honest.
CREATE OR REPLACE FUNCTION public.touch_sales_handover_commitments()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_shc ON public.sales_handover_commitments;
CREATE TRIGGER trg_touch_shc
  BEFORE UPDATE ON public.sales_handover_commitments
  FOR EACH ROW EXECUTE FUNCTION public.touch_sales_handover_commitments();


-- ─────────────────────────────────────────────────────────────────────────
-- 2. HANDOVER TERMINAL STATES
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.sales_handovers
  ADD COLUMN IF NOT EXISTS completed_at   timestamp with time zone,
  ADD COLUMN IF NOT EXISTS completed_by   integer REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS cancelled_at   timestamp with time zone,
  ADD COLUMN IF NOT EXISTS cancelled_by   integer REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS closure_summary text;

ALTER TABLE public.sales_handovers
  DROP CONSTRAINT IF EXISTS sales_handovers_status_check;

ALTER TABLE public.sales_handovers
  ADD CONSTRAINT sales_handovers_status_check
  CHECK (status IN ('draft', 'submitted', 'acknowledged', 'in_progress', 'completed', 'cancelled'));

COMMENT ON COLUMN public.sales_handovers.closure_summary IS
  'Free-text wrap-up captured at completion or cancellation. Required for cancelled (enforced in service layer, not DB, so an admin backfill is not blocked).';


-- ─────────────────────────────────────────────────────────────────────────
-- 3. BACKWARD-PLANNED DELIVERABLE TIMELINES
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.playbook_plays
  ADD COLUMN IF NOT EXISTS due_anchor character varying(20) NOT NULL DEFAULT 'created';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'playbook_plays_due_anchor_check'
  ) THEN
    ALTER TABLE public.playbook_plays
      ADD CONSTRAINT playbook_plays_due_anchor_check
      CHECK (due_anchor IN ('created', 'go_live'));
  END IF;
END $$;

COMMENT ON COLUMN public.playbook_plays.due_anchor IS
  'What due_offset_days is measured from. created = instantiation date (default, preserves existing behaviour for every sales play). go_live = sales_handovers.go_live_date, where due_offset_days is normally NEGATIVE (e.g. -14 for "UAT sign-off two weeks before go-live").';

-- Mirror the anchor onto the instance so a reschedule knows which rows to move
-- without joining back through playbook_plays (which may have been versioned
-- or archived since instantiation).
ALTER TABLE public.deal_play_instances
  ADD COLUMN IF NOT EXISTS due_anchor character varying(20) NOT NULL DEFAULT 'created';

CREATE INDEX IF NOT EXISTS idx_dpi_go_live_anchored
  ON public.deal_play_instances (deal_id)
  WHERE due_anchor = 'go_live' AND status NOT IN ('completed', 'skipped');


-- ─────────────────────────────────────────────────────────────────────────
-- 4. GO-LIVE SLIP → RESCHEDULE ANCHORED DELIVERABLES
--
-- When go_live_date moves, every open go_live-anchored play instance for that
-- deal shifts by the same delta. Completed and skipped plays are left alone:
-- history is not rewritten.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reschedule_go_live_anchored_plays()
RETURNS trigger AS $$
DECLARE
  delta_days integer;
BEGIN
  IF NEW.go_live_date IS NULL OR OLD.go_live_date IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.go_live_date = OLD.go_live_date THEN
    RETURN NEW;
  END IF;

  delta_days := NEW.go_live_date - OLD.go_live_date;

  UPDATE public.deal_play_instances dpi
     SET due_date   = dpi.due_date + delta_days,
         updated_at = now()
   WHERE dpi.org_id     = NEW.org_id
     AND dpi.due_anchor = 'go_live'
     AND dpi.due_date IS NOT NULL
     AND dpi.status NOT IN ('completed', 'skipped')
     AND dpi.id IN (
       SELECT shp.play_instance_id
         FROM public.sales_handover_plays shp
        WHERE shp.handover_id = NEW.id
     );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reschedule_go_live ON public.sales_handovers;
CREATE TRIGGER trg_reschedule_go_live
  AFTER UPDATE OF go_live_date ON public.sales_handovers
  FOR EACH ROW EXECUTE FUNCTION public.reschedule_go_live_anchored_plays();


-- ─────────────────────────────────────────────────────────────────────────
-- 5. ROLLUP VIEW — one row per handover, everything the list needs
--
-- Feeds the handover list "3 of 9 deliverables complete · 2 overdue ·
-- go-live in 12 days" chip without N+1 queries from the frontend.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.handover_deliverable_rollup AS
SELECT
  h.id                                             AS handover_id,
  h.org_id,
  h.status,
  h.go_live_date,
  (h.go_live_date - CURRENT_DATE)                  AS days_to_go_live,

  COUNT(DISTINCT dpi.id)                           AS plays_total,
  COUNT(DISTINCT dpi.id) FILTER (
    WHERE dpi.status IN ('completed', 'skipped'))  AS plays_done,
  COUNT(DISTINCT dpi.id) FILTER (
    WHERE dpi.status NOT IN ('completed', 'skipped')
      AND dpi.due_date < CURRENT_DATE)             AS plays_overdue,
  COUNT(DISTINCT dpi.id) FILTER (
    WHERE dpi.is_gate
      AND dpi.status NOT IN ('completed', 'skipped')) AS gates_open,

  COUNT(DISTINCT c.id)                             AS commitments_total,
  COUNT(DISTINCT c.id) FILTER (
    WHERE c.status IN ('met', 'waived', 'breached')) AS commitments_closed,
  COUNT(DISTINCT c.id) FILTER (
    WHERE c.status IN ('open', 'in_progress')
      AND c.due_date < CURRENT_DATE)               AS commitments_overdue,
  COUNT(DISTINCT c.id) FILTER (
    WHERE c.status = 'breached')                   AS commitments_breached,

  -- Closure eligibility, computed once, in one place. The service layer's
  -- canClose() reads this rather than reimplementing the predicate.
  (COUNT(DISTINCT dpi.id) FILTER (
     WHERE dpi.is_gate AND dpi.status NOT IN ('completed', 'skipped')) = 0
   AND COUNT(DISTINCT c.id) FILTER (
     WHERE c.status IN ('open', 'in_progress')) = 0)  AS is_closeable

FROM public.sales_handovers h
LEFT JOIN public.sales_handover_plays shp       ON shp.handover_id = h.id
LEFT JOIN public.deal_play_instances dpi        ON dpi.id = shp.play_instance_id
LEFT JOIN public.sales_handover_commitments c   ON c.handover_id = h.id
GROUP BY h.id, h.org_id, h.status, h.go_live_date;

COMMENT ON VIEW public.handover_deliverable_rollup IS
  'Per-handover deliverable aggregate: play + commitment counts, overdue counts, and is_closeable. Read by handover.service.list() and canClose().';

COMMIT;
