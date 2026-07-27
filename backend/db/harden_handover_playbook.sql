-- ═══════════════════════════════════════════════════════════════════════════
-- harden_handover_playbook.sql
--
-- Hardens the ALREADY-SEEDED handover playbook on an org:
--   1. gate_enforcement  advisory → strict   (gates now BLOCK, not just flag)
--   2. adds the missing gate on the go-live stage
--      ("Confirm go-live date with customer" → is_gate = true)
--
-- The source seeder (orgSeed.service.js) is patched separately so every FUTURE
-- org gets this by default; this script fixes orgs already created.
--
--  >>> Set v_org_id to your org. Default: 117. Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_org_id integer := 117;
  v_hpb    integer;
  v_gated  integer;
BEGIN
  SELECT id INTO v_hpb FROM playbooks
   WHERE org_id = v_org_id AND type = 'handovers'
   ORDER BY is_default DESC, id
   LIMIT 1;

  IF v_hpb IS NULL THEN
    RAISE EXCEPTION 'No handover playbook on org % — nothing to harden.', v_org_id;
  END IF;

  -- 1) Strict gate enforcement
  UPDATE playbooks
     SET gate_enforcement = 'strict', updated_at = now()
   WHERE id = v_hpb AND gate_enforcement IS DISTINCT FROM 'strict';

  -- 2) Gate the go-live confirmation play
  UPDATE playbook_plays
     SET is_gate = TRUE
   WHERE playbook_id = v_hpb
     AND org_id = v_org_id
     AND stage_key = 'confirm_golive_commercial'
     AND title = 'Confirm go-live date with customer'
     AND is_gate = FALSE;

  SELECT count(*) INTO v_gated
    FROM playbook_plays
   WHERE playbook_id = v_hpb AND is_gate = TRUE;

  RAISE NOTICE 'Handover playbook % on org %: enforcement now strict, % gate plays total.',
    v_hpb, v_org_id, v_gated;
END $$;

COMMIT;
