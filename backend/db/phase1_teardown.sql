-- ─────────────────────────────────────────────────────────────────────────────
-- phase1_teardown.sql
--
-- Removes everything phase1_fixture.sql created.
--
-- NOT a bare DELETE on organizations. Several tables reference organizations
-- WITHOUT ON DELETE CASCADE — accounts is one — so the single-statement teardown
-- the fixture header originally promised fails with a foreign key violation and
-- leaves the fixture half-removed. Order matters, so it is written out.
--
-- Scoped entirely to the org named 'PHASE1_FIXTURE'. If that org does not exist
-- this is a no-op. It cannot touch a real org's rows.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $teardown$
DECLARE o int;
BEGIN
  SELECT id INTO o FROM organizations WHERE name = 'PHASE1_FIXTURE';
  IF o IS NULL THEN
    RAISE NOTICE 'No PHASE1_FIXTURE org — nothing to remove.';
    RETURN;
  END IF;

  -- Children first, deepest first.
  DELETE FROM conversation_project_candidates WHERE org_id = o;
  DELETE FROM conversation_bindings           WHERE org_id = o;

  DELETE FROM whatsapp_messages               WHERE org_id = o;
  DELETE FROM whatsapp_thread_participants    WHERE org_id = o;
  DELETE FROM whatsapp_session_groups         WHERE org_id = o;
  DELETE FROM whatsapp_threads                WHERE org_id = o;
  DELETE FROM whatsapp_sessions               WHERE org_id = o;

  DELETE FROM project_contacts                WHERE org_id = o;
  DELETE FROM project_members                 WHERE org_id = o;
  DELETE FROM account_relationships           WHERE org_id = o;
  DELETE FROM sales_handovers                 WHERE org_id = o;
  DELETE FROM contacts                        WHERE org_id = o;
  DELETE FROM accounts                        WHERE org_id = o;
  DELETE FROM users                           WHERE org_id = o;
  DELETE FROM organizations                   WHERE id     = o;

  RAISE NOTICE 'Fixture org % removed.', o;
END
$teardown$;

DROP TABLE IF EXISTS phase1_fixture_ids;

COMMIT;
