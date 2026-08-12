-- ─────────────────────────────────────────────────────────────────────────────
-- phase1_fixture.sql
--
-- A synthetic org with everything Phase 1 touches, so the acceptance list can
-- be run without any live or sample data.
--
-- ISOLATION: everything hangs off ONE organizations row. organizations is the
-- ON DELETE CASCADE root for every table involved, so teardown is a single
-- DELETE — there is no scattering of rows to hunt down afterwards.
--
-- SAFETY: refuses to run if an org named 'PHASE1_FIXTURE' already exists with
-- rows a previous run left behind. Run phase1_teardown.sql first.
--
-- IDs are captured into a temp table rather than hard-coded, so this is safe to
-- run against a database that already has data in it.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DROP TABLE IF EXISTS fixture_ids;
CREATE TEMP TABLE fixture_ids (k text PRIMARY KEY, v integer);

-- ── org, user ───────────────────────────────────────────────────────────────
WITH o AS (
  INSERT INTO organizations (name, slug) VALUES ('PHASE1_FIXTURE', 'phase1-fixture') RETURNING id
) INSERT INTO fixture_ids SELECT 'org', id FROM o;

WITH u AS (
  INSERT INTO users (org_id, email, first_name, last_name, role, password_hash)
  SELECT v, 'phase1.fixture@example.invalid', 'Fixture', 'User', 'admin', 'x'
    FROM fixture_ids WHERE k = 'org'
  RETURNING id
) INSERT INTO fixture_ids SELECT 'user', id FROM u;

-- ── accounts: one approved vendor, one plain account ────────────────────────
WITH a AS (
  INSERT INTO accounts (org_id, name, domain)
  SELECT v, 'Cloudsmith (fixture)', 'cloudsmith.invalid' FROM fixture_ids WHERE k = 'org'
  RETURNING id
) INSERT INTO fixture_ids SELECT 'vendor_account', id FROM a;

WITH a AS (
  INSERT INTO accounts (org_id, name, domain)
  SELECT v, 'Meridian (fixture)', 'meridian.invalid' FROM fixture_ids WHERE k = 'org'
  RETURNING id
) INSERT INTO fixture_ids SELECT 'customer_account', id FROM a;

-- Not a vendor. Exists so the NOT_A_VENDOR path has something to fail against.
WITH a AS (
  INSERT INTO accounts (org_id, name)
  SELECT v, 'Random Co (fixture)' FROM fixture_ids WHERE k = 'org'
  RETURNING id
) INSERT INTO fixture_ids SELECT 'plain_account', id FROM a;

INSERT INTO account_relationships (org_id, account_id, relationship, status, approved_by, approved_at)
SELECT (SELECT v FROM fixture_ids WHERE k='org'),
       (SELECT v FROM fixture_ids WHERE k='vendor_account'),
       'vendor', 'active',
       (SELECT v FROM fixture_ids WHERE k='user'), now();

-- ── three projects ──────────────────────────────────────────────────────────
WITH h AS (
  INSERT INTO sales_handovers (org_id, name, status, account_id, project_kind, created_by)
  SELECT v, 'P1 Migration (fixture)', 'in_progress',
         (SELECT v FROM fixture_ids WHERE k='customer_account'), 'customer',
         (SELECT v FROM fixture_ids WHERE k='user')
    FROM fixture_ids WHERE k = 'org'
  RETURNING id
) INSERT INTO fixture_ids SELECT 'p1', id FROM h;

WITH h AS (
  INSERT INTO sales_handovers (org_id, name, status, account_id, project_kind, created_by)
  SELECT v, 'P2 Cutover (fixture)', 'in_progress',
         (SELECT v FROM fixture_ids WHERE k='customer_account'), 'customer',
         (SELECT v FROM fixture_ids WHERE k='user')
    FROM fixture_ids WHERE k = 'org'
  RETURNING id
) INSERT INTO fixture_ids SELECT 'p2', id FROM h;

-- Internal project: no account at all. Pool candidates must accept these.
WITH h AS (
  INSERT INTO sales_handovers (org_id, name, status, project_kind, created_by)
  SELECT v, 'P3 Internal (fixture)', 'in_progress', 'internal',
         (SELECT v FROM fixture_ids WHERE k='user')
    FROM fixture_ids WHERE k = 'org'
  RETURNING id
) INSERT INTO fixture_ids SELECT 'p3', id FROM h;

-- Completed: must be EXCLUDED from derived candidates.
WITH h AS (
  INSERT INTO sales_handovers (org_id, name, status, account_id, project_kind, created_by)
  SELECT v, 'P4 Done (fixture)', 'completed',
         (SELECT v FROM fixture_ids WHERE k='customer_account'), 'customer',
         (SELECT v FROM fixture_ids WHERE k='user')
    FROM fixture_ids WHERE k = 'org'
  RETURNING id
) INSERT INTO fixture_ids SELECT 'p4', id FROM h;

-- ── vendor contacts on projects — the ONLY account→project link that exists ─
WITH c AS (
  INSERT INTO contacts (org_id, account_id, first_name, last_name, email)
  SELECT (SELECT v FROM fixture_ids WHERE k='org'),
         (SELECT v FROM fixture_ids WHERE k='vendor_account'),
         'Vera', 'Vendor', 'vera@cloudsmith.invalid'
  RETURNING id
) INSERT INTO fixture_ids SELECT 'vendor_contact', id FROM c;

-- P1 and P2: vendor side → both should be derived candidates.
INSERT INTO project_contacts (org_id, context_type, context_id, contact_id, side, role)
SELECT (SELECT v FROM fixture_ids WHERE k='org'), 'handover',
       (SELECT v FROM fixture_ids WHERE k='p1'),
       (SELECT v FROM fixture_ids WHERE k='vendor_contact'), 'vendor', 'engagement_lead';
INSERT INTO project_contacts (org_id, context_type, context_id, contact_id, side, role)
SELECT (SELECT v FROM fixture_ids WHERE k='org'), 'handover',
       (SELECT v FROM fixture_ids WHERE k='p2'),
       (SELECT v FROM fixture_ids WHERE k='vendor_contact'), 'vendor', 'engagement_lead';

-- P4 is completed → must NOT be a candidate even though the vendor is on it.
INSERT INTO project_contacts (org_id, context_type, context_id, contact_id, side, role)
SELECT (SELECT v FROM fixture_ids WHERE k='org'), 'handover',
       (SELECT v FROM fixture_ids WHERE k='p4'),
       (SELECT v FROM fixture_ids WHERE k='vendor_contact'), 'vendor', 'engagement_lead';

-- Same firm on the CUSTOMER side of P3 → must NOT be a candidate (side filter).
WITH c AS (
  INSERT INTO contacts (org_id, account_id, first_name, last_name, email)
  SELECT (SELECT v FROM fixture_ids WHERE k='org'),
         (SELECT v FROM fixture_ids WHERE k='vendor_account'),
         'Carl', 'Customerside', 'carl@cloudsmith.invalid'
  RETURNING id
) INSERT INTO fixture_ids SELECT 'vendor_as_customer_contact', id FROM c;

INSERT INTO project_contacts (org_id, context_type, context_id, contact_id, side, role)
SELECT (SELECT v FROM fixture_ids WHERE k='org'), 'handover',
       (SELECT v FROM fixture_ids WHERE k='p3'),
       (SELECT v FROM fixture_ids WHERE k='vendor_as_customer_contact'), 'customer', 'other';

-- ── project membership ──────────────────────────────────────────────────────
--
-- Needed for the human-filing checks. canFile requires an APPROVED
-- project_members row (or project-manage authority), and filing an unassigned
-- message by hand is the fallback the whole conservative attribution chain
-- leans on — so the fixture has to be able to exercise it.

INSERT INTO project_members (org_id, context_type, context_id, user_id, status, side)
SELECT (SELECT v FROM fixture_ids WHERE k='org'), 'handover', h.v,
       (SELECT v FROM fixture_ids WHERE k='user'), 'approved', 'delivery'
  FROM fixture_ids h
 WHERE h.k IN ('p1','p2','p3','p4');

-- ── whatsapp session ────────────────────────────────────────────────────────
WITH s AS (
  INSERT INTO whatsapp_sessions (org_id, label, status, capture_enabled, capture_mode, wa_phone)
  SELECT v, 'fixture session', 'connected', true, 'allowlist', '910000000000'
    FROM fixture_ids WHERE k = 'org'
  RETURNING id
) INSERT INTO fixture_ids SELECT 'session', id FROM s;

-- ── four groups, each with a thread ─────────────────────────────────────────
--   g_project  legacy project group        — regression baseline
--   g_vendor   becomes the Cloudsmith group
--   g_pool     becomes the internal group
--   g_unwatched  watched=false             — must produce no message rows

DO $fixture$
DECLARE
  o int; s int; t int; g int;
  spec record;
BEGIN
  SELECT v INTO o FROM fixture_ids WHERE k='org';
  SELECT v INTO s FROM fixture_ids WHERE k='session';

  FOR spec IN
    SELECT * FROM (VALUES
      ('g_project',   'Acme Migration – All (fixture)', true),
      ('g_vendor',    'Cloudsmith <> Meridian (fixture)', true),
      ('g_pool',      'Meridian Delivery (fixture)', true),
      ('g_unwatched', 'Society Chatter (fixture)', false)
    ) AS x(key, subject, watched)
  LOOP
    INSERT INTO whatsapp_threads (org_id, kind, source, wa_group_id, group_subject, status, opt_in_source)
    VALUES (o, 'group', 'session', spec.key || '@g.us', spec.subject, 'active', 'session_capture')
    RETURNING id INTO t;

    INSERT INTO whatsapp_session_groups
      (session_id, org_id, group_jid, subject, thread_id, is_watched, discovered_via, binding_status)
    VALUES (s, o, spec.key || '@g.us', spec.subject, t, spec.watched, 'snapshot', 'unbound')
    RETURNING id INTO g;

    INSERT INTO fixture_ids VALUES (spec.key || '_thread', t), (spec.key, g);
  END LOOP;
END
$fixture$;

-- ── message history ─────────────────────────────────────────────────────────
--
-- Every group gets 5 unattributed messages, which is what a real group looks
-- like the moment before somebody binds it. The vendor group's five are the
-- rows acceptance check 2 asserts stay untouched.

INSERT INTO whatsapp_messages
  (org_id, thread_id, wa_message_id, direction, message_type, body,
   from_phone, status, sent_at, capture_source)
SELECT (SELECT v FROM fixture_ids WHERE k='org'),
       f.v,
       f.k || '_msg_' || i,
       'inbound', 'text', 'fixture message ' || i,
       '919999999' || i, 'received', now() - (i || ' hours')::interval,
       'session'
  FROM fixture_ids f
 CROSS JOIN generate_series(1,5) i
 WHERE f.k IN ('g_project_thread','g_vendor_thread','g_pool_thread');

-- One ALREADY-ATTRIBUTED message in the vendor group. The force-downgrade check
-- asserts this one keeps its handover_id when the thread project is cleared.
INSERT INTO whatsapp_messages
  (org_id, thread_id, wa_message_id, direction, message_type, body,
   from_phone, status, sent_at, capture_source, handover_id, handover_source)
SELECT (SELECT v FROM fixture_ids WHERE k='org'),
       (SELECT v FROM fixture_ids WHERE k='g_vendor_thread'),
       'g_vendor_msg_attributed', 'inbound', 'text', 'already filed, must not be retracted',
       '919999999', 'received', now() - interval '6 hours', 'session',
       (SELECT v FROM fixture_ids WHERE k='p1'), 'manual';

-- Persist the id map: temp tables die with the session, and the harness needs
-- these in a second connection.
DROP TABLE IF EXISTS phase1_fixture_ids;
CREATE TABLE phase1_fixture_ids AS SELECT * FROM fixture_ids;

COMMIT;

SELECT k, v FROM phase1_fixture_ids ORDER BY k;
