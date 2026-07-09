-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_46_sequence_ab_testing.sql
--
-- Step-level A/B variants for email + linkedin sequence steps.
--
-- Model
--   * A step is "varied" iff it has >= 2 ACTIVE rows in sequence_step_variants.
--     0 rows  -> base sequence_steps templates are used (today's behaviour).
--     1 row   -> treated as NOT varied; base templates still win. (Transient
--               state while the rep is building the test.)
--   * Arms are named by a single uppercase letter ('A','B',...). The arm set is
--     sequence-wide: a prospect assigned 'B' gets 'B' copy on EVERY varied step.
--     That makes a multi-step experiment a test of the ARM, not of one step —
--     which is exactly why ab_max_varied_steps defaults to 1.
--   * Assignment is a pure function of (sequence_id, prospect_id) — see
--     services/ExperimentAssigner.js. It MUST stay pure: bulk-activate runs the
--     personalisation dispatcher BEFORE the enrollment row exists
--     (prospecting-campaigns.routes.js:3583 vs :3634), so the arm has to be
--     resolvable with no enrollment to read it from.
--   * enrollments.variant_key stores the resolved arm for audit + to pin the arm
--     if weights are changed mid-flight.
--
-- Channel scope: email + linkedin only. call/task steps carry task_note, which
-- is never sent to anyone — varying it tests rep behaviour with no compliance
-- tracking and a self-reported outcome. The column exists below for model
-- uniformity; nothing writes it in v1. Enforced at the route layer.
--
-- Reversible: every live sequence has zero variant rows after this runs, so the
-- resolver falls through to base templates and behaviour is unchanged.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Variant content ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sequence_step_variants (
  id                 serial PRIMARY KEY,
  org_id             integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  sequence_step_id   integer NOT NULL REFERENCES public.sequence_steps(id) ON DELETE CASCADE,
  variant_key        text    NOT NULL,
  subject_template   text,
  body_template      text,
  task_note          text,
  personalize_config jsonb,
  weight             integer NOT NULL DEFAULT 50,
  status             text    NOT NULL DEFAULT 'active',
  created_by         integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ssv_key    CHECK (variant_key ~ '^[A-Z]$'),
  CONSTRAINT chk_ssv_weight CHECK (weight >= 0 AND weight <= 100),
  CONSTRAINT chk_ssv_status CHECK (status IN ('active', 'paused'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ssv_step_key
  ON public.sequence_step_variants (sequence_step_id, variant_key);

-- Resolver hot path: overlay lookup for one enrollment's arm across a sequence.
CREATE INDEX IF NOT EXISTS idx_ssv_step_active
  ON public.sequence_step_variants (sequence_step_id)
  WHERE status = 'active';

COMMENT ON TABLE public.sequence_step_variants IS
  'Step-level A/B copy. A step is varied iff it has >=2 active rows here. Arm keys are sequence-wide: an enrollment assigned B gets B copy on every varied step. Precedence at send: personalised_steps -> steps_snapshot -> variant -> base sequence_steps.';
COMMENT ON COLUMN public.sequence_step_variants.weight IS
  'Relative split weight, 0-100. Read from the LOWEST step_order varied step only — all varied steps in a sequence must declare the same arm set (enforced in routes/sequence-variants.routes.js).';
COMMENT ON COLUMN public.sequence_step_variants.task_note IS
  'Present for model uniformity. Never written in v1 — call/task steps are not variable (task_note is an instruction to a rep, not content sent to a prospect).';

-- ── 2. Sticky assignment on the enrollment ───────────────────────────────────

ALTER TABLE public.sequence_enrollments
  ADD COLUMN IF NOT EXISTS variant_key text;

ALTER TABLE public.sequence_enrollments
  DROP CONSTRAINT IF EXISTS chk_se_variant_key;
ALTER TABLE public.sequence_enrollments
  ADD CONSTRAINT chk_se_variant_key CHECK (variant_key IS NULL OR variant_key ~ '^[A-Z]$');

COMMENT ON COLUMN public.sequence_enrollments.variant_key IS
  'A/B arm, sticky for the life of the enrollment. NULL = not in a test (or enrolled before the sequence had variants). Assigned by ExperimentAssigner as a pure hash of (sequence_id, prospect_id) — never Math.random().';

-- ── 3. Per-experiment cap on how many steps may be varied ────────────────────
-- Org default lives in settings->prospecting_config->ab_max_varied_steps (see
-- ExperimentAssigner.maxVariedSteps, mirroring the sequence_edit_propagation
-- read at EnrollmentStepResolver.js:137). Per-sequence override below.

ALTER TABLE public.sequences
  ADD COLUMN IF NOT EXISTS ab_max_varied_steps integer;

ALTER TABLE public.sequences
  DROP CONSTRAINT IF EXISTS chk_seq_ab_max_varied;
ALTER TABLE public.sequences
  ADD CONSTRAINT chk_seq_ab_max_varied
  CHECK (ab_max_varied_steps IS NULL OR (ab_max_varied_steps >= 1 AND ab_max_varied_steps <= 10));

COMMENT ON COLUMN public.sequences.ab_max_varied_steps IS
  'Per-sequence override for the max number of steps that may carry active variants. NULL = fall back to org settings->prospecting_config->>ab_max_varied_steps, which itself defaults to 1. Raising this above 1 means a reply is no longer attributable to a single step — you are testing the whole arm.';

-- ── 4. Metric grain gains the variant dimension ──────────────────────────────
-- Only familyStepLogs + the engagement CTE in MetricSnapshotService can populate
-- it (they already JOIN sequence_enrollments). familyActivities / familyMeetings
-- carry the '-' sentinel: connections_accepted, calls_logged and meetings_booked
-- are prospect-grain and have no enrollment to attribute to. Per-arm LinkedIn
-- accept rate comes from the dedicated experiment report, not this table.

ALTER TABLE public.prospecting_metric_daily
  ADD COLUMN IF NOT EXISTS variant_key text NOT NULL DEFAULT '-';

COMMENT ON COLUMN public.prospecting_metric_daily.variant_key IS
  '''-'' = unattributed (no enrollment join, or enrollment not in a test). Never NULL — sentinel keeps the unique grain sound, matching campaign_id=0 / fit_band=''unknown''.';

DROP INDEX IF EXISTS uq_pmd_grain;
CREATE UNIQUE INDEX uq_pmd_grain
  ON public.prospecting_metric_daily
  (org_id, metric_date, campaign_id, sequence_id, sequence_step_id,
   channel, sender_account_id, owner_id, fit_band, variant_key);

COMMIT;
