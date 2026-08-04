-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_106_whatsapp_group_minimization.sql
--
-- Stops storing metadata about groups nobody asked us to capture, and deletes
-- what has already been stored.
--
-- THE PROBLEM
--   Cataloguing every group the connected number belongs to made a 306-row
--   table of somebody's personal life: alumni groups, residents' associations,
--   birthday threads, a 1,898-member community. None of it is CRM data. All of
--   it was retained indefinitely, in a multi-tenant database, subject to
--   whatever obligations attach to holding personal data about people who have
--   never heard of GoWarmCRM.
--
--   That was a bad trade for a diagnostic convenience. The list is only needed
--   while someone has the triage screen open; there is no reason it should
--   outlive the browser tab.
--
-- THE NEW RULE
--   Postgres stores a group ONLY when a human has switched capture on for it,
--   or when it is bound to a project. Everything else is fetched live from the
--   worker, held in API memory with a short TTL, and forgotten.
--
--   Concretely: whatsapp_session_groups becomes a table of DECISIONS, not a
--   catalogue of what exists.
--
-- WHAT THIS DELETES
--   Every whatsapp_session_groups row that is not watched and not bound, and
--   the group-membership rows hanging off them. Captured MESSAGES are untouched
--   — a group that was watched keeps its row and its history.
--
-- IRREVERSIBLE. Run the audit query at the bottom first if you want to see the
-- scale before committing.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. WHAT WOULD GO (read this in the output before trusting the deletes)
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_groups   integer;
  v_members  integer;
  v_keep     integer;
  v_orphaned integer;
BEGIN
  SELECT count(*) INTO v_groups
    FROM public.whatsapp_session_groups
   WHERE is_watched = false AND binding_status <> 'bound';

  SELECT count(*) INTO v_keep
    FROM public.whatsapp_session_groups
   WHERE is_watched = true OR binding_status = 'bound';

  SELECT count(*) INTO v_members
    FROM public.whatsapp_session_group_members gm
    JOIN public.whatsapp_session_groups g ON g.id = gm.session_group_id
   WHERE g.is_watched = false AND g.binding_status <> 'bound';

  -- Threads created for groups we are about to forget. These only exist if a
  -- message was ever stored, which under allowlist mode should be none.
  SELECT count(*) INTO v_orphaned
    FROM public.whatsapp_threads t
   WHERE t.source = 'session'
     AND EXISTS (
       SELECT 1 FROM public.whatsapp_session_groups g
        WHERE g.thread_id = t.id
          AND g.is_watched = false AND g.binding_status <> 'bound'
     )
     AND NOT EXISTS (SELECT 1 FROM public.whatsapp_messages m WHERE m.thread_id = t.id);

  RAISE NOTICE '── WhatsApp group minimisation ─────────────────────';
  RAISE NOTICE '  groups to DELETE        : %', v_groups;
  RAISE NOTICE '  groups to KEEP          : % (watched or bound)', v_keep;
  RAISE NOTICE '  membership rows to DELETE: %', v_members;
  RAISE NOTICE '  empty threads to DELETE : %', v_orphaned;
  RAISE NOTICE '────────────────────────────────────────────────────';
END $$;


-- ─────────────────────────────────────────────────────────────────────────
-- 2. DELETE
--
-- Order matters: members and threads reference groups.
-- ─────────────────────────────────────────────────────────────────────────

DELETE FROM public.whatsapp_session_group_members gm
 USING public.whatsapp_session_groups g
 WHERE gm.session_group_id = g.id
   AND g.is_watched = false
   AND g.binding_status <> 'bound';

-- Threads for forgotten groups, but ONLY when no message was ever stored
-- against them. A thread holding messages is evidence and is never deleted
-- here — if a group was captured then un-watched, its history stays.
DELETE FROM public.whatsapp_threads t
 WHERE t.source = 'session'
   AND EXISTS (
     SELECT 1 FROM public.whatsapp_session_groups g
      WHERE g.thread_id = t.id
        AND g.is_watched = false AND g.binding_status <> 'bound'
   )
   AND NOT EXISTS (SELECT 1 FROM public.whatsapp_messages m WHERE m.thread_id = t.id);

DELETE FROM public.whatsapp_session_groups
 WHERE is_watched = false AND binding_status <> 'bound';

-- Pending capture requests for groups that no longer have a row.
DELETE FROM public.whatsapp_capture_requests r
 WHERE NOT EXISTS (
   SELECT 1 FROM public.whatsapp_session_groups g WHERE g.id = r.session_group_id
 );


-- ─────────────────────────────────────────────────────────────────────────
-- 3. MAKE THE INTENT EXPLICIT
--
-- The application no longer writes unwatched groups (see
-- whatsappSession.service.upsertSessionGroup). This comment is the contract:
-- anyone tempted to "just catalogue everything for the UI" should read it
-- before re-introducing the problem.
-- ─────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE public.whatsapp_session_groups IS
  'Groups a human has DECIDED about — watched, or bound to a project. NOT a catalogue of every group the number belongs to. The full list is fetched live from the worker and held in API memory with a short TTL; it is never persisted. Cataloguing everything created a 306-row table of one person''s alumni groups, residents'' associations and birthday threads, retained indefinitely, about people with no relationship to this product.';

COMMENT ON TABLE public.whatsapp_session_group_members IS
  'Org users known to be in a DECIDED group. Rows for undecided groups are not written — membership in someone''s family chat is not ours to record.';

-- A watched group must be one somebody chose. Enforced so the invariant
-- survives a future code path that forgets it.
ALTER TABLE public.whatsapp_session_groups
  DROP CONSTRAINT IF EXISTS wa_session_groups_decided_chk;
ALTER TABLE public.whatsapp_session_groups
  ADD  CONSTRAINT wa_session_groups_decided_chk
  CHECK (is_watched = true OR binding_status IN ('bound', 'ignored', 'unbound'));

COMMIT;


-- ═══════════════════════════════════════════════════════════════════════════
-- AUDIT — run separately to confirm the result
--
--   SELECT binding_status, is_watched, count(*)
--     FROM whatsapp_session_groups GROUP BY 1,2 ORDER BY 1,2;
--
--   SELECT count(*) AS remaining_member_rows FROM whatsapp_session_group_members;
--
--   -- Messages are unaffected; this should be unchanged from before the purge:
--   SELECT capture_source, count(*) FROM whatsapp_messages GROUP BY 1;
-- ═══════════════════════════════════════════════════════════════════════════
