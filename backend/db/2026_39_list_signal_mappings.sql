-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_39_list_signal_mappings.sql
--
-- Signal-Based Campaigns — Phase 6: Motion-1 (Apollo/ZoomInfo list ingest).
-- A reusable COLUMN → SIGNAL mapping template. A rep imports the same list
-- shape repeatedly (an Apollo export always has the same columns), so the
-- mapping of "which column means which signal, tested how" is saved once and
-- reused — org-shared, like the signal catalog and target profiles (D10).
--
--   source_kind : which directory this maps ('apollo' | 'zoominfo' | 'csv' |
--                 'other') — free-text label for the rep, not load-bearing.
--   mappings    : jsonb array. Each entry maps ONE list column to ONE signal:
--       {
--         "column":     "Latest Funding Date",   -- header in the export
--         "signal_key": "raised_recently",        -- catalog signal to write
--         "entity":     "account",                -- 'account' | 'prospect'
--         "value_type": "date",                   -- how to coerce the cell
--                       -- 'date'|'number'|'boolean'|'string'|'set'
--         "confidence": "high"                    -- optional; default 'high'
--                                                 -- (list = vendor-stated)
--       }
--     The ingest adapter reads a row's cell for `column`, coerces per
--     `value_type`, and writes a source='list' signal on the row's resolved
--     entity id. Shape-only validated (like cleanTargeting) — a mapping may
--     reference a signal before it's catalogued.
--
-- Contact (email/phone) is NOT a signal — it's written to the prospect record
-- by the existing bulk-import path. This table is only about the QUALIFIERS
-- the list carries (§4: "qualifiers are ingested from the list, not
-- re-derived; contact comes from the directory").
--
-- No RLS (matches the signal_defs / target_profiles family): explicit org_id
-- scoping in every query. Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS list_signal_mappings (
  id          serial       PRIMARY KEY,
  org_id      integer      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        varchar(255) NOT NULL,
  source_kind varchar(30)  NOT NULL DEFAULT 'csv',
  mappings    jsonb        NOT NULL DEFAULT '[]'::jsonb,
  created_by  integer      REFERENCES users(id) ON DELETE SET NULL,
  active      boolean      NOT NULL DEFAULT true,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE list_signal_mappings IS
  'Reusable column→signal mapping templates for Motion-1 list ingest (P6). '
  'mappings is a jsonb array of {column, signal_key, entity, value_type, confidence?}. '
  'Org-shared (D10); created_by ⇒ rep-added. Shape-only validated.';

-- Name unique within the org (the library listing key).
CREATE UNIQUE INDEX IF NOT EXISTS uq_list_signal_mappings_org_name
  ON list_signal_mappings (org_id, lower(name))
  WHERE active;

CREATE INDEX IF NOT EXISTS idx_list_signal_mappings_org_active
  ON list_signal_mappings (org_id, active);

DROP TRIGGER IF EXISTS trg_list_signal_mappings_updated_at ON list_signal_mappings;
CREATE TRIGGER trg_list_signal_mappings_updated_at
  BEFORE UPDATE ON list_signal_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
