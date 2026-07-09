-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_47_sequence_experiments.sql
--
-- Experiment identity for step-level A/B (builds on 2026_46).
--
-- WHY
--   2026_46 keyed arms by variant_key alone. Conclude a test, rewrite arms A and
--   B, start a second test on the same step, and:
--     a) both tests' rows carry variant_key 'A'/'B' and are indistinguishable
--        forever; and
--     b) an in-flight enrollment stamped 'B' by test 1 starts reading test 2's
--        arm B copy MID-CADENCE, because the overlay matched on variant_key only.
--   (b) is a correctness bug, not a reporting inconvenience. This migration fixes
--   both by scoping every arm — and every enrollment — to an experiment.
--
-- CONSEQUENCES
--   * The overlay now matches (experiment_id, sequence_step_id, variant_key).
--     An enrollment keeps ITS experiment's copy for life, whether that experiment
--     is still running, paused, or concluded. Treatment never switches under a
--     prospect mid-cadence.
--   * The `>= 2 active arms` guard disappears from the overlay. It is now only
--     an ASSIGNMENT concern: a half-built experiment has one arm, activeArms()
--     returns [], no enrollment is ever stamped with its id, so its orphan arm
--     row can never reach a send. Simpler and strictly safer.
--   * Assignment hashes on (experiment_id, prospect_id), NOT (sequence_id, ...).
--     A second test therefore RESHUFFLES prospects. Under the old key, a prospect
--     who hashed into arm A would land in arm A of every successive test on that
--     sequence forever — a silent bias across sequential experiments. Stickiness
--     within one experiment is preserved, which is all that re-enrolment needs.
--
-- Manual override (gap 1) needs no schema: sequence_enrollments.variant_key is
-- already writable. See ExperimentAssigner.assignVariant({ variantKeyOverride }).
--
-- Safe to run on a database where 2026_46 landed but no variant has been created:
-- every backfill below is then a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. The experiment ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sequence_experiments (
  id                  serial PRIMARY KEY,
  org_id              integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  sequence_id         integer NOT NULL REFERENCES public.sequences(id) ON DELETE CASCADE,
  name                text,
  hypothesis          text,
  status              text NOT NULL DEFAULT 'running',
  started_at          timestamptz NOT NULL DEFAULT now(),
  concluded_at        timestamptz,
  winning_variant_key text,
  conclusion_note     text,
  created_by          integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_sexp_status  CHECK (status IN ('running', 'concluded', 'abandoned')),
  CONSTRAINT chk_sexp_winner  CHECK (winning_variant_key IS NULL OR winning_variant_key ~ '^[A-Z]$'),
  CONSTRAINT chk_sexp_closed  CHECK (
    (status = 'running'  AND concluded_at IS NULL) OR
    (status <> 'running' AND concluded_at IS NOT NULL)
  )
);

-- At most one running experiment per sequence. Arms are sequence-wide, so two
-- concurrent experiments on one sequence would fight over the same arm keys.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sexp_one_running
  ON public.sequence_experiments (sequence_id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_sexp_sequence
  ON public.sequence_experiments (sequence_id, status);

COMMENT ON TABLE public.sequence_experiments IS
  'One A/B experiment over one sequence. At most one running at a time (uq_sexp_one_running). Concluding does NOT delete arms: in-flight enrollments keep reading their experiment''s copy until they finish, because switching treatment mid-cadence would corrupt both the prospect experience and the result.';
COMMENT ON COLUMN public.sequence_experiments.winning_variant_key IS
  'Set at conclude time. Purely a record — promoting the winner into sequence_steps is a separate, explicit action (POST /:id/experiments/:expId/conclude with promoteWinner: true).';

-- ── 2. Arms belong to an experiment ──────────────────────────────────────────

ALTER TABLE public.sequence_step_variants
  ADD COLUMN IF NOT EXISTS experiment_id integer REFERENCES public.sequence_experiments(id) ON DELETE CASCADE;

-- Backfill: adopt any pre-2026_47 arms into one experiment per sequence.
-- No-op when 2026_46 shipped but nobody created a variant yet.
INSERT INTO public.sequence_experiments (org_id, sequence_id, name, status, started_at)
SELECT DISTINCT ss.org_id, ss.sequence_id, 'Adopted from 2026_46', 'running', now()
  FROM public.sequence_step_variants sv
  JOIN public.sequence_steps ss ON ss.id = sv.sequence_step_id
 WHERE sv.experiment_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.sequence_experiments e
      WHERE e.sequence_id = ss.sequence_id AND e.status = 'running'
   );

UPDATE public.sequence_step_variants sv
   SET experiment_id = e.id
  FROM public.sequence_steps ss
  JOIN public.sequence_experiments e
    ON e.sequence_id = ss.sequence_id AND e.status = 'running'
 WHERE ss.id = sv.sequence_step_id
   AND sv.experiment_id IS NULL;

ALTER TABLE public.sequence_step_variants
  ALTER COLUMN experiment_id SET NOT NULL;

-- Arm keys are unique WITHIN an experiment, not within a step for all time.
DROP INDEX IF EXISTS uq_ssv_step_key;
CREATE UNIQUE INDEX uq_ssv_exp_step_key
  ON public.sequence_step_variants (experiment_id, sequence_step_id, variant_key);

DROP INDEX IF EXISTS idx_ssv_step_active;
-- Overlay hot path: (experiment, step, arm). Deliberately NOT filtered on
-- status — a paused or concluded arm must still resolve for the enrollments
-- already stamped with it.
CREATE INDEX IF NOT EXISTS idx_ssv_exp_step
  ON public.sequence_step_variants (experiment_id, sequence_step_id);

-- Arms may also be 'concluded' now: retained for in-flight enrollments, but
-- invisible to activeArms() so no new enrollment lands in them.
ALTER TABLE public.sequence_step_variants
  DROP CONSTRAINT IF EXISTS chk_ssv_status;
ALTER TABLE public.sequence_step_variants
  ADD CONSTRAINT chk_ssv_status CHECK (status IN ('active', 'paused', 'concluded'));

COMMENT ON COLUMN public.sequence_step_variants.experiment_id IS
  'Scopes the arm. The send-time overlay matches (experiment_id, sequence_step_id, variant_key) — never variant_key alone, or a second test would rewrite the copy of enrollments still in flight from the first.';

-- ── 3. Enrollments remember which experiment they belong to ──────────────────

ALTER TABLE public.sequence_enrollments
  ADD COLUMN IF NOT EXISTS experiment_id integer REFERENCES public.sequence_experiments(id) ON DELETE SET NULL;

-- Backfill: any enrollment already carrying an arm belongs to the adopted
-- experiment for its sequence.
UPDATE public.sequence_enrollments se
   SET experiment_id = e.id
  FROM public.sequence_experiments e
 WHERE e.sequence_id = se.sequence_id
   AND e.status = 'running'
   AND se.variant_key IS NOT NULL
   AND se.experiment_id IS NULL;

-- An arm without an experiment can no longer resolve to any copy, so forbid it.
ALTER TABLE public.sequence_enrollments
  DROP CONSTRAINT IF EXISTS chk_se_arm_has_experiment;
ALTER TABLE public.sequence_enrollments
  ADD CONSTRAINT chk_se_arm_has_experiment
  CHECK ((variant_key IS NULL) = (experiment_id IS NULL));

CREATE INDEX IF NOT EXISTS idx_se_experiment
  ON public.sequence_enrollments (experiment_id)
  WHERE experiment_id IS NOT NULL;

COMMENT ON COLUMN public.sequence_enrollments.experiment_id IS
  'The experiment this enrollment was randomised into. Together with variant_key it resolves the arm copy for life. NULL iff variant_key is NULL (chk_se_arm_has_experiment).';

COMMIT;
