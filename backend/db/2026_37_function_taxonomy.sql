-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_37_function_taxonomy.sql
--
-- Signal-Based Campaigns — Phase 2: the org-configurable FUNCTION TAXONOMY
-- (design §3, D7/D8).
--
-- One table, org_functions, holding an org's DELTAS over the code-level
-- system defaults — the same merge-over-SYSTEM_DEFAULTS pattern as
-- org_action_config.network_jobchange (2026_35), but row-keyed because
-- functions are an extensible list, not a fixed config bag:
--
--   * SYSTEM defaults (Sales, Finance, Procurement, Product, Marketing, HR)
--     live in services/FunctionTaxonomyService.js, NOT in this table. Zero
--     rows here ⇒ the org sees the six defaults untouched.
--   * A row whose key MATCHES a default = a partial override (rename the
--     label, swap a placeholder, or active=false to hide the function).
--   * A row with a NEW key = an org-added function ("Legal" → GC / legal
--     team / paralegals / CLM), and every screen supports it (§3).
--
--   placeholders : jsonb, PARTIAL by design — only the placeholder keys the
--     admin changed are stored; the resolver merges the rest from the system
--     default per key. Shape per key ('leader'|'head'|'team'|'hire'|'tool'):
--       { "label": "CFO", "keywords": ["cfo", "chief financial officer"] }
--     `label` renders in resolved signal text ("New {leader} hired" →
--     "New CFO hired"); `keywords` drive title matching (which role a
--     captured person plays for this function). FULL leader titles go in
--     keywords — never a bare ambiguous acronym — to avoid the CPO collision
--     (Chief Procurement / Product / People Officer, §3).
--
-- DECOUPLED (D8) from CLASSIFIER_FUNCTION_VALUES in prospectingConfigSchema,
-- which stays load-bearing for FitGate/ICP. The taxonomy feeds
-- ProspectClassifier.classifyTitle only through EXPLICIT config rules built
-- by FunctionTaxonomyService.buildClassifierRules() — no shared enum.
--
-- No RLS (matches the entity_custom_fields / signal_defs family): explicit
-- org_id scoping in every query. Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS org_functions (
  id           serial       PRIMARY KEY,
  org_id       integer      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key          varchar(100) NOT NULL,
  label        varchar(255),
  placeholders jsonb        NOT NULL DEFAULT '{}'::jsonb,
  active       boolean      NOT NULL DEFAULT true,
  created_by   integer      REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE org_functions IS
  'Org deltas over the code-level system function taxonomy (FunctionTaxonomyService.SYSTEM_FUNCTIONS). '
  'Row key matching a system key = partial override; new key = org-added function. '
  'placeholders is a PARTIAL map {leader|head|team|hire|tool → {label, keywords[]}} merged over the default.';

-- One delta row per function key per org.
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_functions_org_key
  ON org_functions (org_id, key);

-- Listing: "all deltas for this org" (the merge input).
CREATE INDEX IF NOT EXISTS idx_org_functions_org
  ON org_functions (org_id);

-- set_updated_at() already exists in prod (2026_05_prospecting_campaigns.sql).
DROP TRIGGER IF EXISTS trg_org_functions_updated_at ON org_functions;
CREATE TRIGGER trg_org_functions_updated_at
  BEFORE UPDATE ON org_functions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
