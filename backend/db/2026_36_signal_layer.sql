-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_36_signal_layer.sql
--
-- Signal-Based Campaigns — Phase 1: the signal-layer spine.
-- (Design: signal-based-campaigns-design-and-execution-plan.md, D5/D6/D7/D10/D14.)
--
-- Two tables:
--
--   signal_defs (the org-shared Signal Catalog / registry, D10)
--     One row per signal DEFINITION. Reps only ever see/touch label, capability,
--     scope, function_tags, predicate_type; reliability + source_kind are
--     inferred and hidden (D9). Org-shared: every rep and admin in the org
--     reads/writes the same catalog; rep-created rows carry created_by and are
--     rendered as "rep-added" in the UI (P4).
--
--       capability     : 'filter' | 'prioritize' | 'both' — what roles the
--                        signal CAN play. Invisible rule #1 (cost-of-error):
--                        reliability='low' forces capability='prioritize'
--                        (enforced in SignalRegistryService, not by CHECK, so
--                        an admin upgrade path stays possible).
--       scope          : 'company' | 'target_role' — target_role resolves
--                        {leader}/{team}/{tool} per function (P2 resolver).
--       function_tags  : jsonb text[]; empty array = "Any" (D6, multi-tag).
--       predicate_type : 'set' | 'number' | 'recency' | 'geo' | 'boolean'.
--       reliability    : 'high' | 'medium' | 'low' — inferred from source_kind.
--       source_kind    : 'list' | 'enrich' | 'harvest' | 'dataset' |
--                        'rep_validate' — decides whether the signal is known
--                        up front or becomes a Work-stage GAP (invisible rule #2).
--       ttl_days       : freshness window; NULL = never stale. Past TTL a
--                        value reads as *unknown*, never false (D14).
--       default_hook   : optional why-now hook a Prioritize signal carries (§6).
--
--   entity_signals (the normalized signal VALUE store, D14)
--     One CURRENT row per (org, entity, key) — no transition log for now (D11).
--     `{ entity(account|prospect, id), key, value, source, observed_at,
--        confidence }` exactly as specced. `value` is jsonb: signals are
--     heterogeneous (bool / number / text / set / geo) and predicates evaluate
--     in code, so one typed column beats four sparse ones here.
--
--       source     : which ADAPTER wrote it — 'list' | 'enrichment' |
--                    'extension' | 'webhook' | 'rep' | 'dataset' | 'system'.
--                    (free-text varchar like entity_custom_fields.source; the
--                    canonical values are documented, not CHECKed, so new
--                    adapters don't need a migration.)
--       confidence : 'high' | 'medium' | 'low'.
--
--     Reconciliation (D14) is enforced in SignalService.writeSignal():
--       rep always wins; a rep-written row is never overwritten by a vendor;
--       among vendors, newer observed_at wins (stale never clobbers fresh).
--
-- signal_defs.key and entity_signals.key are joined loosely (by key, plus an
-- optional signal_def_id FK) so adapters can land raw facts before an admin
-- has formally catalogued them — mirrors the entity_custom_fields precedent
-- of nullable field_def_id.
--
-- No RLS (matches the entity_custom_fields family): explicit org_id scoping
-- in every query. Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Registry: the org-shared Signal Catalog ──────────────────────────────
CREATE TABLE IF NOT EXISTS signal_defs (
  id             serial       PRIMARY KEY,
  org_id         integer      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key            varchar(100) NOT NULL,
  label          varchar(255) NOT NULL,
  description    text,
  capability     varchar(20)  NOT NULL DEFAULT 'prioritize',
  scope          varchar(20)  NOT NULL DEFAULT 'company',
  function_tags  jsonb        NOT NULL DEFAULT '[]'::jsonb,
  predicate_type varchar(20)  NOT NULL DEFAULT 'boolean',
  reliability    varchar(10)  NOT NULL DEFAULT 'low',
  source_kind    varchar(20)  NOT NULL DEFAULT 'rep_validate',
  ttl_days       integer,
  default_hook   text,
  created_by     integer      REFERENCES users(id) ON DELETE SET NULL,
  active         boolean      NOT NULL DEFAULT true,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT signal_defs_capability_check
    CHECK (capability IN ('filter', 'prioritize', 'both')),
  CONSTRAINT signal_defs_scope_check
    CHECK (scope IN ('company', 'target_role')),
  CONSTRAINT signal_defs_predicate_type_check
    CHECK (predicate_type IN ('set', 'number', 'recency', 'geo', 'boolean')),
  CONSTRAINT signal_defs_reliability_check
    CHECK (reliability IN ('high', 'medium', 'low')),
  CONSTRAINT signal_defs_source_kind_check
    CHECK (source_kind IN ('list', 'enrich', 'harvest', 'dataset', 'rep_validate')),
  CONSTRAINT signal_defs_ttl_days_check
    CHECK (ttl_days IS NULL OR ttl_days > 0)
);

-- One definition per key per org (org-shared catalog, D10).
CREATE UNIQUE INDEX IF NOT EXISTS uq_signal_defs_org_key
  ON signal_defs (org_id, key);

-- Catalog listing: "all active defs for this org" (the P4 table).
CREATE INDEX IF NOT EXISTS idx_signal_defs_org_active
  ON signal_defs (org_id, active);

-- set_updated_at() already exists in prod (2026_05_prospecting_campaigns.sql).
DROP TRIGGER IF EXISTS trg_signal_defs_updated_at ON signal_defs;
CREATE TRIGGER trg_signal_defs_updated_at
  BEFORE UPDATE ON signal_defs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 2. Value store: normalized entity signals ───────────────────────────────
CREATE TABLE IF NOT EXISTS entity_signals (
  id            serial       PRIMARY KEY,
  org_id        integer      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type   varchar(20)  NOT NULL,
  entity_id     integer      NOT NULL,
  key           varchar(100) NOT NULL,
  signal_def_id integer      REFERENCES signal_defs(id) ON DELETE SET NULL,
  value         jsonb,
  source        varchar(30)  NOT NULL,
  observed_at   timestamptz  NOT NULL DEFAULT now(),
  confidence    varchar(10)  NOT NULL DEFAULT 'medium',
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT entity_signals_entity_type_check
    CHECK (entity_type IN ('account', 'prospect')),
  CONSTRAINT entity_signals_confidence_check
    CHECK (confidence IN ('high', 'medium', 'low'))
);

-- One CURRENT value per (org, entity, key) — upsert target (no history, D11).
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_signals_org_entity_key
  ON entity_signals (org_id, entity_type, entity_id, key);

-- Read path: "all signals for this entity".
CREATE INDEX IF NOT EXISTS idx_entity_signals_org_entity
  ON entity_signals (org_id, entity_type, entity_id);

-- Sweep path (P5 nightly re-eval / freshness): "all rows for this key,
-- oldest observed first".
CREATE INDEX IF NOT EXISTS idx_entity_signals_org_key_observed
  ON entity_signals (org_id, key, observed_at);

DROP TRIGGER IF EXISTS trg_entity_signals_updated_at ON entity_signals;
CREATE TRIGGER trg_entity_signals_updated_at
  BEFORE UPDATE ON entity_signals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
