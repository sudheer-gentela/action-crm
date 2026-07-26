-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_76_go_live_first_set.sql
--
-- Enhance reschedule_go_live_anchored_plays() to schedule go_live-anchored play
-- instances the FIRST time a handover's go_live_date is set (NULL -> date).
--
-- Background
-- ----------
-- 2026_64 added this trigger, but it only *shifts existing due dates by a delta*
-- and bails whenever OLD.go_live_date IS NULL. Handovers are created with
-- go_live_date NULL (the rep fills it in later), so the first-time set never
-- fired. Combined with PlaybookPlayService now instantiating go_live-anchored
-- plays with due_date NULL + due_anchor='go_live', those plays would otherwise
-- stay unscheduled forever.
--
-- This migration is a trigger-function redefinition ONLY. No data is migrated
-- or backfilled, and it is idempotent (safe to re-run).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reschedule_go_live_anchored_plays()
RETURNS trigger AS $$
DECLARE
  delta_days integer;
BEGIN
  -- Go-live cleared or still unset: leave existing dates untouched.
  IF NEW.go_live_date IS NULL THEN
    RETURN NEW;
  END IF;

  -- First-time set (NULL -> date): schedule anchored instances from scratch,
  -- using each play's signed offset (e.g. -14 => go_live minus 14 days). A delta
  -- shift cannot work from a NULL baseline, so compute the absolute date here.
  IF OLD.go_live_date IS NULL THEN
    UPDATE public.deal_play_instances dpi
       SET due_date   = NEW.go_live_date + COALESCE(pp.due_offset_days, 0),
           updated_at = now()
      FROM public.playbook_plays pp
     WHERE pp.id          = dpi.play_id
       AND dpi.org_id     = NEW.org_id
       AND dpi.due_anchor = 'go_live'
       AND dpi.status NOT IN ('completed', 'skipped')
       AND dpi.id IN (
         SELECT shp.play_instance_id
           FROM public.sales_handover_plays shp
          WHERE shp.handover_id = NEW.id
       );
    RETURN NEW;
  END IF;

  -- No effective change.
  IF NEW.go_live_date = OLD.go_live_date THEN
    RETURN NEW;
  END IF;

  -- Subsequent move (date -> date): shift already-scheduled dates by the delta,
  -- preserving any per-instance adjustments. (Unchanged from 2026_64.)
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

-- Trigger binding is unchanged (still AFTER UPDATE OF go_live_date), but
-- re-assert it idempotently so this migration is self-contained.
DROP TRIGGER IF EXISTS trg_reschedule_go_live ON public.sales_handovers;
CREATE TRIGGER trg_reschedule_go_live
  AFTER UPDATE OF go_live_date ON public.sales_handovers
  FOR EACH ROW EXECUTE FUNCTION public.reschedule_go_live_anchored_plays();
