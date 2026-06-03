-- 2026_16_prospecting_ownership_visibility.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Ownership + visibility model for the Prospecting module. First adopter:
-- sequences. The access RULES live in one place — services/AccessPolicy.js —
-- so other modules (campaigns, prospects, deals, CLM, service, handover) can
-- reuse the same core and only add their own owner/visibility/allow-edit
-- columns + a thin adapter.
--
-- Model (see AccessPolicy.js for the authoritative logic):
--   • owner       = the item's created_by.
--   • visibility  = 'shared' (in the org folder, visible to everyone) or
--                   'private' (visible only to the owner and — via the read
--                   scope — their manager / an admin). Default 'shared'.
--   • read scope  = self (member) / team (manager) / all (admin), resolved by
--                   ReportingScopeService. Shared items are visible to all;
--                   private items only to owners in the viewer's scope.
--   • edit        = owner always; admin always; a manager-of-owner only if the
--                   org-level manager_can_edit policy is ON, OR the specific
--                   item is flagged allow_manager_edit by its owner.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Sequence visibility. Default 'shared' → no backfill needed; existing
--    sequences stay in the org Library exactly as before.
ALTER TABLE sequences
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'shared';

-- Constrain to known values. Drop-then-add so the migration is re-runnable.
ALTER TABLE sequences DROP CONSTRAINT IF EXISTS sequences_visibility_chk;
ALTER TABLE sequences
  ADD CONSTRAINT sequences_visibility_chk CHECK (visibility IN ('shared', 'private'));

-- 2. Per-sequence manager-edit opt-in. When TRUE, the owner has allowed their
--    manager(s) to edit THIS sequence even when the org-wide manager_can_edit
--    policy is off. Default FALSE. This is the granular, on-the-ground control
--    reps actually use; the org-wide flag (#3) is the broad override. The edit
--    decision is (org manager_can_edit) OR (this flag) for a manager-of-owner.
ALTER TABLE sequences
  ADD COLUMN IF NOT EXISTS allow_manager_edit BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Org-level "managers may edit subordinates' items" switch.
--    Stored in the existing org_action_config.campaign_settings JSONB (the
--    per-org prospecting settings blob), read/written via
--    campaignSettings.service.js. Key: manager_can_edit (boolean).
--    ABSENT ⇒ FALSE — managers are view-only on subordinates' items unless the
--    org enables this OR the owner opts a specific sequence in (#2). No DDL
--    needed (JSONB key); documented here as the single record of the change.
