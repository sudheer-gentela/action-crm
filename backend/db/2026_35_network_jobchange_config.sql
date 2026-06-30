-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_35_network_jobchange_config.sql
--
-- Config bucket for network job-change behavior (Design & Execution Tracker
-- §G-P1), mirroring the org_action_config.linkedin_automation pattern exactly:
-- a single JSONB column holding a partial that NetworkJobChangeConfig merges
-- over SYSTEM_DEFAULTS. Per-user overrides live in the existing
-- user_preferences.preferences->'network_jobchange' bucket (no schema change).
--
-- Keys (all optional; defaults applied in code):
--   auto_promote_on_move : bool   (D2, default true)
--   notify_scope         : text   (D10, 'all' | 'champion_left', default 'all')
--   export_cadence       : text   (D5,  'on_demand'|'weekly'|'biweekly'|'monthly', default 'weekly')
--
-- Only auto_promote_on_move is consumed this slice; notify_scope/export_cadence
-- ship with the view-scope and nudge slices (no further migration needed — same
-- bucket).
--
-- Additive + nullable-with-default: metadata-only change in modern PostgreSQL
-- (no table rewrite). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE org_action_config
  ADD COLUMN IF NOT EXISTS network_jobchange jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN org_action_config.network_jobchange IS
  'Org-level network job-change config (partial, merged over SYSTEM_DEFAULTS by '
  'NetworkJobChangeConfig): auto_promote_on_move (D2), notify_scope (D10), '
  'export_cadence (D5). Per-user overrides in user_preferences.preferences->''network_jobchange''.';
