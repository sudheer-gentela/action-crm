-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_72_soft_delete_plays.sql   (A5b / B17 / D29)
--
-- NUMBERING: 71 is taken by 2026_71_sequence_threaded_replies.sql from the
-- threaded-replies workstream. This is 72; the plan's action-context migration
-- and the rest of the 72-77 sequence shift up by one accordingly.
--
-- Playbook plays become soft-deleted. Hard deletion of a play that has live
-- instances is refused by the database rather than silently destroying lineage.
--
-- ── Why ─────────────────────────────────────────────────────────────────────
--
-- Two hard-delete paths existed (PlaybookBuilderService.deletePlay and
-- DELETE /playbook-plays/:playId). Deleting a play severed every live instance
-- derived from it, with no warning and no audit. That is why all 20 live handover
-- instances no longer join to playbook_plays, and why they carry 12 gates while
-- the current handover_s2i playbook defines 1 — the instances came from a
-- playbook version whose plays were later deleted.
--
-- Lost lineage breaks _areDependenciesComplete (which resolves depends_on against
-- play ids), playbook versioning, and the Phase D extraction candidate list.
--
-- ── FK inventory — CORRECTED ────────────────────────────────────────────────
--
-- The original A5b draft assumed all these were ON DELETE SET NULL. Verified
-- against the regenerated schema.sql, they are not. EIGHT FKs reference
-- playbook_plays; five change, three are deliberately left alone:
--
--   deal_play_instances_play_id_fkey       SET NULL  → RESTRICT  (core B17)
--   case_plays_play_id_fkey                CASCADE   → RESTRICT  (worse than
--       assumed: deleting a play DELETED the case play rows outright)
--   contract_play_instances_play_id_fkey   SET NULL  → RESTRICT
--   contract_plays_play_id_fkey            CASCADE   → RESTRICT  (omitted from
--       the original draft entirely; same delete-the-rows hazard)
--   actions_playbook_play_id_fkey          SET NULL  → RESTRICT  (omitted from
--       the original draft. A5 starts populating actions.playbook_play_id, so
--       from now on this is the PRIMARY lineage path from work back to its
--       definition — and therefore the next B17 vector if left as SET NULL.)
--
-- Deliberately NOT changed (three exceptions, all intentional):
--
--   prospecting_actions_play_id_fkey       SET NULL  → left as-is
--       Per D19 prospecting is a separate world with thousands of rows against
--       the plays' tens. RESTRICT here would mean a single historical prospecting
--       action could permanently block a play from ever being cleaned up, and
--       prospecting_actions is not the lineage surface Phase D reads. Documented
--       asymmetry, not an oversight.
--
--   playbook_play_roles_play_id_fkey       CASCADE   -> left as-is
--       A pure detail table: role assignments belong to the play and have no
--       meaning without it. CASCADE is correct semantics here, not a hazard.
--
--   playbook_plays_unlocks_play_id_fkey    SET NULL  -> left as-is
--       Self-reference on unlocks_play_id. If the unlocked play is removed the
--       gate simply stops unlocking anything, which is the sane degradation.
--       RESTRICT would make any gated play undeletable via its gater.
--
-- ── Safety ──────────────────────────────────────────────────────────────────
--
-- Adding RESTRICT cannot fail on existing data — it constrains future deletes
-- only. Postgres does not validate a FK's ON DELETE action against current rows.
-- Soft-deleted plays stop being instantiated for free, because activateStage and
-- activateStageForPlaybook already filter is_active = TRUE.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- §0. PRE-FLIGHT — verify the constraint names and current actions on YOUR db
--     before trusting the DROPs below. If a name differs, edit it here.
--
--     Expect eight rows; five become RESTRICT, three stay as-is.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT conname,
--        conrelid::regclass AS child_table,
--        CASE confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
--                         WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
--                         WHEN 'd' THEN 'SET DEFAULT' END AS on_delete
--   FROM pg_constraint
--  WHERE confrelid = 'playbook_plays'::regclass AND contype = 'f'
--  ORDER BY conrelid::regclass::text;
--
--     Also worth seeing what would now be protected:
-- SELECT 'deal_play_instances' t, count(*) FROM deal_play_instances WHERE play_id IS NOT NULL
-- UNION ALL SELECT 'actions', count(*) FROM actions WHERE playbook_play_id IS NOT NULL
-- UNION ALL SELECT 'case_plays', count(*) FROM case_plays WHERE play_id IS NOT NULL
-- UNION ALL SELECT 'contract_play_instances', count(*) FROM contract_play_instances WHERE play_id IS NOT NULL
-- UNION ALL SELECT 'contract_plays', count(*) FROM contract_plays WHERE play_id IS NOT NULL;


-- ───────────────────────────────────────────────────────────────────────────
-- §1. deal_play_instances — the core B17 fix.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE deal_play_instances
  DROP CONSTRAINT IF EXISTS deal_play_instances_play_id_fkey;
ALTER TABLE deal_play_instances
  ADD CONSTRAINT deal_play_instances_play_id_fkey
  FOREIGN KEY (play_id) REFERENCES playbook_plays(id) ON DELETE RESTRICT;


-- ───────────────────────────────────────────────────────────────────────────
-- §2. actions.playbook_play_id — the lineage path A5 creates.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE actions
  DROP CONSTRAINT IF EXISTS actions_playbook_play_id_fkey;
ALTER TABLE actions
  ADD CONSTRAINT actions_playbook_play_id_fkey
  FOREIGN KEY (playbook_play_id) REFERENCES playbook_plays(id) ON DELETE RESTRICT;


-- ───────────────────────────────────────────────────────────────────────────
-- §3. case_plays — was CASCADE, i.e. actively destructive.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE case_plays
  DROP CONSTRAINT IF EXISTS case_plays_play_id_fkey;
ALTER TABLE case_plays
  ADD CONSTRAINT case_plays_play_id_fkey
  FOREIGN KEY (play_id) REFERENCES playbook_plays(id) ON DELETE RESTRICT;


-- ───────────────────────────────────────────────────────────────────────────
-- §4. contract_play_instances.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE contract_play_instances
  DROP CONSTRAINT IF EXISTS contract_play_instances_play_id_fkey;
ALTER TABLE contract_play_instances
  ADD CONSTRAINT contract_play_instances_play_id_fkey
  FOREIGN KEY (play_id) REFERENCES playbook_plays(id) ON DELETE RESTRICT;


-- ───────────────────────────────────────────────────────────────────────────
-- §5. contract_plays — was CASCADE. Omitted from the original draft.
--     Guarded in case the table is absent in some environment.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'contract_plays') THEN
    ALTER TABLE contract_plays DROP CONSTRAINT IF EXISTS contract_plays_play_id_fkey;
    ALTER TABLE contract_plays
      ADD CONSTRAINT contract_plays_play_id_fkey
      FOREIGN KEY (play_id) REFERENCES playbook_plays(id) ON DELETE RESTRICT;
  END IF;
END $$;


-- ───────────────────────────────────────────────────────────────────────────
-- §6. Document the deliberate exception.
-- ───────────────────────────────────────────────────────────────────────────
COMMENT ON CONSTRAINT prospecting_actions_play_id_fkey ON prospecting_actions IS
  'Deliberately ON DELETE SET NULL, unlike the other playbook_plays references '
  'which are RESTRICT as of 2026_72. Per D19 prospecting is volume-asymmetric '
  '(thousands vs tens) and is not the lineage surface playbook versioning or '
  'Phase D extraction reads. RESTRICT here would let one historical prospecting '
  'action block a play permanently.';


-- ───────────────────────────────────────────────────────────────────────────
-- §7. VERIFY before COMMIT.
--
--     Re-run §0 query 1. Expect RESTRICT on deal_play_instances, actions,
--     case_plays, contract_play_instances, contract_plays; SET NULL on
--     prospecting_actions only.
-- ───────────────────────────────────────────────────────────────────────────

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────
-- Post-deploy sanity check — should be REFUSED with a foreign-key violation:
--
--   DELETE FROM playbook_plays WHERE id = (
--     SELECT play_id FROM deal_play_instances WHERE play_id IS NOT NULL LIMIT 1);
--
-- Run it inside BEGIN ... ROLLBACK. An error is the pass condition.
-- ───────────────────────────────────────────────────────────────────────────
