-- ═══════════════════════════════════════════════════════════════════════════
-- teardown_impl_from_org.sql
--
-- Removes ONLY the implementation demo data (the 6 projects + delivery playbook
-- + email/WhatsApp comms) from an existing org. The org itself, its users, and
-- its real app-seeded playbooks (Sales, Handovers, Prospecting) are untouched.
--
-- Marker-scoped: it only deletes rows tagged by the seed
-- (external_crm_type='demo_seed' / external_refs demo_seed / the
-- 'Implementation Delivery (Demo)' playbook). Idempotent.
--
--  >>> Set v_org_id to your org. Default: 117.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_org_id integer := 117;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org_id) THEN
    RAISE NOTICE 'Org % not found — nothing to remove.', v_org_id;
    RETURN;
  END IF;

  DELETE FROM whatsapp_messages
    WHERE org_id = v_org_id AND thread_id IN
      (SELECT id FROM whatsapp_threads WHERE org_id = v_org_id AND wa_group_id LIKE 'demo-impl-%');
  DELETE FROM whatsapp_thread_participants
    WHERE org_id = v_org_id AND thread_id IN
      (SELECT id FROM whatsapp_threads WHERE org_id = v_org_id AND wa_group_id LIKE 'demo-impl-%');
  DELETE FROM whatsapp_threads WHERE org_id = v_org_id AND wa_group_id LIKE 'demo-impl-%';

  DELETE FROM emails WHERE org_id = v_org_id AND conversation_id LIKE 'deliv-%';

  DELETE FROM sales_handover_plays
    WHERE org_id = v_org_id AND handover_id IN
      (SELECT id FROM sales_handovers WHERE org_id = v_org_id AND deal_id IN
        (SELECT id FROM deals WHERE org_id = v_org_id AND external_crm_type = 'demo_seed'));
  DELETE FROM sales_handover_commitments
    WHERE org_id = v_org_id AND handover_id IN
      (SELECT id FROM sales_handovers WHERE org_id = v_org_id AND deal_id IN
        (SELECT id FROM deals WHERE org_id = v_org_id AND external_crm_type = 'demo_seed'));
  DELETE FROM project_contacts
    WHERE org_id = v_org_id AND context_type = 'handover' AND context_id IN
      (SELECT id FROM sales_handovers WHERE org_id = v_org_id AND deal_id IN
        (SELECT id FROM deals WHERE org_id = v_org_id AND external_crm_type = 'demo_seed'));
  DELETE FROM sales_handovers
    WHERE org_id = v_org_id AND deal_id IN
      (SELECT id FROM deals WHERE org_id = v_org_id AND external_crm_type = 'demo_seed');

  DELETE FROM deal_play_instances
    WHERE org_id = v_org_id AND deal_id IN
      (SELECT id FROM deals WHERE org_id = v_org_id AND external_crm_type = 'demo_seed');
  DELETE FROM deal_contacts
    WHERE deal_id IN (SELECT id FROM deals WHERE org_id = v_org_id AND external_crm_type = 'demo_seed');
  DELETE FROM deals WHERE org_id = v_org_id AND external_crm_type = 'demo_seed';

  DELETE FROM contacts WHERE org_id = v_org_id AND external_refs @> '{"demo_seed":"impl_showcase_v1"}'::jsonb;
  DELETE FROM accounts WHERE org_id = v_org_id AND external_refs @> '{"demo_seed":"impl_showcase_v1"}'::jsonb;

  DELETE FROM playbook_plays
    WHERE org_id = v_org_id AND playbook_id IN
      (SELECT id FROM playbooks WHERE org_id = v_org_id AND name = 'Implementation Delivery (Demo)');
  DELETE FROM playbooks WHERE org_id = v_org_id AND name = 'Implementation Delivery (Demo)';

  -- Demo pool users (deal_team_members cascade with the demo deals already deleted).
  -- The Project Manager + Procurement roles are kept — they're a deliberate catalog addition.
  DELETE FROM org_users WHERE org_id = v_org_id
    AND user_id IN (SELECT id FROM users WHERE org_id = v_org_id AND email LIKE '%@impl-demo.team');
  DELETE FROM users WHERE org_id = v_org_id AND email LIKE '%@impl-demo.team';

  RAISE NOTICE 'Removed implementation demo data from org %. Org, users, and real playbooks kept.', v_org_id;
END $$;

COMMIT;
