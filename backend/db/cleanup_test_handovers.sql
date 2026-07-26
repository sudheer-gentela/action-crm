-- ═══════════════════════════════════════════════════════════════════════════
-- cleanup_test_handovers.sql
--
-- One-off data cleanup. NOT a schema migration — deliberately unnumbered.
--
-- Removes test handovers and every artefact derived from them, so the Phase A
-- exit test runs against a clean slate rather than against instances whose
-- lineage is already broken.
--
-- ── Why cleaning beats backfilling ──────────────────────────────────────────
--
-- The 20 live handover instances reference 12 gates while the current
-- handover_s2i playbook defines 1. They were created from a playbook version
-- whose plays were later hard-deleted (the hole 2026_72 now closes). There is no
-- reliable mapping from those orphaned play_ids back to current plays, so a
-- backfill would be guesswork dressed up as data. A9's backfill is worth writing
-- for FUTURE unlinked instances; it is not worth pointing at these.
--
-- ── Ordering ────────────────────────────────────────────────────────────────
--
-- Deleting sales_handovers CASCADEs to sales_handover_commitments,
-- sales_handover_plays and sales_handover_stakeholders, and SET NULLs
-- meetings.handover_id and whatsapp_threads.handover_id.
--
-- It does NOT reach deal_play_instances — those are only linked via
-- sales_handover_plays.play_instance_id. So instances must be deleted explicitly,
-- and BEFORE the handovers, or the link rows vanish and we lose the ability to
-- identify which instances were handover-derived.
--
-- deal_play_assignees CASCADEs from deal_play_instances, so it needs no
-- explicit step.
--
-- actions are NOT cascaded from anything here. Any action created from a
-- handover play must be deleted explicitly or it becomes an orphan in the rep's
-- queue pointing at an instance that no longer exists.
--
-- ── Safety ──────────────────────────────────────────────────────────────────
--
-- Everything is scoped through sales_handovers, so nothing outside the handover
-- module can be touched. Run §1 first and read the counts. If any number looks
-- larger than "my test data", stop — the WHERE clause in §0 needs narrowing.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- §0. SCOPE. Everything below reads from this list.
--
--     As written this selects ALL handovers, which is correct only if every
--     handover you have is test data. If some are real, narrow it — e.g.
--       AND id IN (1,2)
--       AND created_at < '2026-07-01'
--       AND org_id = 1            -- the legacy/seed org
-- ───────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _doomed_handovers AS
SELECT id, org_id, deal_id
  FROM sales_handovers
 WHERE true;          -- <<< NARROW THIS IF ANY HANDOVER IS REAL


CREATE TEMP TABLE _doomed_instances AS
SELECT DISTINCT dpi.id, dpi.action_id
  FROM deal_play_instances dpi
  JOIN sales_handover_plays shp ON shp.play_instance_id = dpi.id
  JOIN _doomed_handovers dh     ON dh.id = shp.handover_id;


-- ───────────────────────────────────────────────────────────────────────────
-- §1. PRE-FLIGHT — run these, read them, then decide whether to continue.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT 'handovers'    AS what, count(*) FROM _doomed_handovers
-- UNION ALL SELECT 'play instances',  count(*) FROM _doomed_instances
-- UNION ALL SELECT 'linked actions',  count(*) FROM _doomed_instances WHERE action_id IS NOT NULL
-- UNION ALL SELECT 'assignees',       count(*) FROM deal_play_assignees
--            WHERE instance_id IN (SELECT id FROM _doomed_instances)
-- UNION ALL SELECT 'commitments',     count(*) FROM sales_handover_commitments
--            WHERE handover_id IN (SELECT id FROM _doomed_handovers)
-- UNION ALL SELECT 'stakeholders',    count(*) FROM sales_handover_stakeholders
--            WHERE handover_id IN (SELECT id FROM _doomed_handovers)
-- UNION ALL SELECT 'meetings (unlinked, kept)', count(*) FROM meetings
--            WHERE handover_id IN (SELECT id FROM _doomed_handovers)
-- UNION ALL SELECT 'whatsapp threads (unlinked, kept)', count(*) FROM whatsapp_threads
--            WHERE handover_id IN (SELECT id FROM _doomed_handovers);
--
--     Sanity check on which org this is hitting:
-- SELECT org_id, count(*) FROM _doomed_handovers GROUP BY 1;


-- ───────────────────────────────────────────────────────────────────────────
-- §2. Actions created from these instances.
--     First, so nothing is left pointing at a deleted instance.
-- ───────────────────────────────────────────────────────────────────────────
DELETE FROM actions
 WHERE id IN (SELECT action_id FROM _doomed_instances WHERE action_id IS NOT NULL);


-- ───────────────────────────────────────────────────────────────────────────
-- §3. Play instances. CASCADEs to deal_play_assignees and sales_handover_plays.
-- ───────────────────────────────────────────────────────────────────────────
DELETE FROM deal_play_instances
 WHERE id IN (SELECT id FROM _doomed_instances);


-- ───────────────────────────────────────────────────────────────────────────
-- §4. The handovers. CASCADEs to commitments, remaining plays, stakeholders.
--     SET NULLs meetings.handover_id and whatsapp_threads.handover_id — those
--     rows survive deliberately; a meeting is real history even if the handover
--     it was attached to was a test.
-- ───────────────────────────────────────────────────────────────────────────
DELETE FROM sales_handovers
 WHERE id IN (SELECT id FROM _doomed_handovers);


-- ───────────────────────────────────────────────────────────────────────────
-- §5. Orphaned handover-shaped instances not reachable via sales_handover_plays.
--
--     Diagnostics showed 29 unlinked instances against 20 handover-linked ones,
--     so ~9 were never linked at all. This catches instances whose play_id no
--     longer resolves to a live play — i.e. lineage already severed.
--
--     COMMENTED OUT BY DEFAULT: on a deal-heavy org this could match sales plays
--     you want to keep. Run the SELECT first, and only then the DELETE.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT dpi.id, dpi.deal_id, dpi.play_id, dpi.status, dpi.created_at
--   FROM deal_play_instances dpi
--   LEFT JOIN playbook_plays pp ON pp.id = dpi.play_id
--  WHERE dpi.play_id IS NOT NULL AND pp.id IS NULL
--  ORDER BY dpi.created_at;
--
-- DELETE FROM deal_play_instances dpi
--  USING (SELECT dpi2.id FROM deal_play_instances dpi2
--          LEFT JOIN playbook_plays pp ON pp.id = dpi2.play_id
--         WHERE dpi2.play_id IS NOT NULL AND pp.id IS NULL) orphan
--  WHERE dpi.id = orphan.id;


-- ───────────────────────────────────────────────────────────────────────────
-- §6. VERIFY before COMMIT. All should be 0.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT count(*) AS handovers_left        FROM sales_handovers;
-- SELECT count(*) AS handover_plays_left   FROM sales_handover_plays;
-- SELECT count(*) AS orphan_assignees      FROM deal_play_assignees dpa
--   LEFT JOIN deal_play_instances dpi ON dpi.id = dpa.instance_id
--  WHERE dpi.id IS NULL;
-- SELECT count(*) AS actions_pointing_nowhere FROM actions a
--  WHERE a.playbook_play_id IS NOT NULL
--    AND NOT EXISTS (SELECT 1 FROM playbook_plays pp WHERE pp.id = a.playbook_play_id);

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────
-- AFTER COMMIT — the Phase A exit test, now on a clean slate:
--
--   1. Confirm handover_s2i has role assignments (A7). Until playbook_play_roles
--      rows exist for its plays, every play resolves through tier 3 to the deal
--      owner. That is acceptable as an interim but it is NOT the exit criterion.
--   2. Create a handover on a won deal.
--   3. Expect: one deal_play_instances row per active play, each with action_id
--      populated, each action owned by the tier-1/tier-2 resolved user, status
--      'not_started' (or 'blocked' where dependencies are unmet).
--   4. Confirm the actions appear in the unified Actions view.
--
--   SELECT dpi.id, pp.title, dpi.status, dpi.action_id, a.user_id, u.first_name
--     FROM deal_play_instances dpi
--     JOIN sales_handover_plays shp ON shp.play_instance_id = dpi.id
--     LEFT JOIN playbook_plays pp ON pp.id = dpi.play_id
--     LEFT JOIN actions a ON a.id = dpi.action_id
--     LEFT JOIN users u  ON u.id = a.user_id
--    ORDER BY dpi.id;
--
--   Every row must have action_id NOT NULL. That is Phase A's exit criterion.
-- ───────────────────────────────────────────────────────────────────────────
