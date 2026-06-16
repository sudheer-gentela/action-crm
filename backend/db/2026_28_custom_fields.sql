-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_28_custom_fields.sql
--
-- Custom Fields by Entity & Campaign — Phase A foundation.
-- (Design: custom_fields_design_handoff.md, decisions D2/D3/D4/D7/D8.)
--
-- Adds an org-level definition registry (custom_field_defs) and extends the
-- existing value store (entity_custom_fields) with a campaign dimension and a
-- link back to its definition. The value store stays the single home for
-- BOTH durable (entity-level) and campaign-scoped values — distinguished by
-- whether campaign_id IS NULL.
--
--   Definitions (custom_field_defs):
--     campaign_id NULL  → org-level field, available everywhere
--     campaign_id SET   → campaign-only field (D6)
--     target_entity     → 'account' | 'prospect' (also the promote destination, D3)
--
--   Values (entity_custom_fields):
--     campaign_id NULL  → durable value living on the prospect/account (D4)
--     campaign_id SET   → campaign-scoped value, local until promoted
--     promote           → write the campaign_id IS NULL twin on the same entity
--     field_def_id      → FK to its definition (nullable: legacy + CRM rows
--                         predate defs; Phase F backfills)
--     source            → 'manual' | 'csv' | 'ai_research' | 'crm_sync'
--                         (free-text varchar, no CHECK — values documented only)
--
-- UNIQUENESS / DUPE PREVENTION (D7):
--   A plain UNIQUE that includes campaign_id would NOT stop two campaign_id=NULL
--   rows, because SQL treats each NULL as distinct. We therefore enforce
--   uniqueness with TWO PARTIAL unique indexes per table — one for the NULL
--   (durable / org-level) plane and one for the non-NULL (campaign) plane.
--
-- Notes:
--   * entity_custom_fields has NO row-level security in prod (unlike many
--     tables); it is scoped by explicit org_id columns. custom_field_defs
--     follows the same precedent — explicit org_id scoping, no RLS policy.
--   * No data is destroyed. The legacy full UNIQUE constraint is replaced by
--     an equivalent partial unique index on the durable plane; existing rows
--     (all campaign_id=NULL after the add) keep the same guarantee.
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Definition registry ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custom_field_defs (
  id               serial       PRIMARY KEY,
  org_id           integer      NOT NULL REFERENCES organizations(id)         ON DELETE CASCADE,
  campaign_id      integer               REFERENCES prospecting_campaigns(id) ON DELETE CASCADE,
  target_entity    varchar(20)  NOT NULL,
  field_key        varchar(100) NOT NULL,
  label            varchar(200),
  field_type       varchar(20)  NOT NULL DEFAULT 'text',
  picklist_options jsonb        NOT NULL DEFAULT '[]'::jsonb,
  display_order    integer      NOT NULL DEFAULT 0,
  active           boolean      NOT NULL DEFAULT true,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT custom_field_defs_target_entity_check
    CHECK (target_entity IN ('account', 'prospect', 'contact', 'deal')),
  CONSTRAINT custom_field_defs_field_type_check
    CHECK (field_type IN ('text', 'number', 'date', 'boolean', 'picklist'))
);

-- Field key unique within its scope (two planes, D7).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cfd_org_target_key
  ON custom_field_defs (org_id, target_entity, field_key)
  WHERE campaign_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cfd_org_campaign_target_key
  ON custom_field_defs (org_id, campaign_id, target_entity, field_key)
  WHERE campaign_id IS NOT NULL;

-- Listing: "all defs for this org" and "all defs for this campaign".
CREATE INDEX IF NOT EXISTS idx_cfd_org_campaign
  ON custom_field_defs (org_id, campaign_id);

-- Reuse the existing updated_at trigger fn (already in prod from entity_custom_fields).
DROP TRIGGER IF EXISTS trg_cfd_updated_at ON custom_field_defs;
CREATE TRIGGER trg_cfd_updated_at
  BEFORE UPDATE ON custom_field_defs
  FOR EACH ROW EXECUTE FUNCTION update_entity_custom_fields_updated_at();

-- ── 2. Extend the value store ───────────────────────────────────────────────
ALTER TABLE entity_custom_fields
  ADD COLUMN IF NOT EXISTS campaign_id  integer REFERENCES prospecting_campaigns(id) ON DELETE CASCADE;

ALTER TABLE entity_custom_fields
  ADD COLUMN IF NOT EXISTS field_def_id integer REFERENCES custom_field_defs(id)     ON DELETE SET NULL;

COMMENT ON COLUMN entity_custom_fields.campaign_id IS
  'NULL = durable value on the entity; SET = campaign-scoped value (promote = write the NULL twin).';
COMMENT ON COLUMN entity_custom_fields.field_def_id IS
  'FK to custom_field_defs. Nullable: legacy/CRM rows predate defs; Phase F backfills.';
COMMENT ON COLUMN entity_custom_fields.source IS
  'Origin of the value: manual | csv | ai_research | crm_sync.';

-- ── 3. Replace the legacy full UNIQUE with two partial unique indexes (D7) ───
ALTER TABLE entity_custom_fields
  DROP CONSTRAINT IF EXISTS entity_custom_fields_org_id_entity_type_entity_id_field_key_key;

-- Durable plane: one value per (org, entity, field) when not campaign-scoped.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ecf_entity_field_durable
  ON entity_custom_fields (org_id, entity_type, entity_id, field_key)
  WHERE campaign_id IS NULL;

-- Campaign plane: one value per (org, entity, field, campaign).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ecf_entity_field_campaign
  ON entity_custom_fields (org_id, entity_type, entity_id, field_key, campaign_id)
  WHERE campaign_id IS NOT NULL;

-- Campaign-view reads: fetch a prospect/account's values within a campaign.
CREATE INDEX IF NOT EXISTS idx_ecf_org_entity_campaign
  ON entity_custom_fields (org_id, entity_type, entity_id, campaign_id);

COMMIT;
