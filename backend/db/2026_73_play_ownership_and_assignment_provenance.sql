-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_73_play_ownership_and_assignment_provenance.sql   (A7)
--
-- NUMBERING: 71 = sequence_threaded_replies, 72 = soft_delete_plays. This is 73.
--
-- Establishes the ownership model:
--
--   * a play has AT MOST ONE owner role, plus any number of co-owner roles
--   * the action goes to the owner role's holder, resolved by PlayRouteResolver
--     (project team → org team queue → project owner)
--   * co-owner roles are REASSIGNMENT TARGETS, not additional assignees
--   * every assignment records HOW it was resolved, so an unfilled role is
--     visible instead of looking like a deliberate choice
--
-- ── Problem 1: ownership_type is vestigial ──────────────────────────────────
--
-- Every write path stores 'co_owner': playbook-plays.routes.js:213 hardcodes it,
-- :345 defaults to it, the frontend only ever sends co-owner role ids, and the
-- column default is 'co_owner'. Meanwhile three readers test for a value that is
-- never stored, and each silently falls through to "first role in the list":
--
--   PlayCompletionService.js:303        ownership_type === 'primary'
--   supportService.js:196               ownership_type === 'primary'
--   prospectingActions.service.js:139   ownership_type === 'owner'
--
-- With no ORDER BY, that fallback is not even deterministic. Same silent-wrong-
-- answer class as B6 and B18: no error, just the wrong person.
--
-- This migration settles the vocabulary on 'owner' | 'co_owner' and makes the
-- one-owner rule a database guarantee rather than a convention.
--
-- ── Problem 2: assignment provenance is not recorded ────────────────────────
--
-- An action assigned to the project owner because nobody holds the required role
-- is indistinguishable from one deliberately assigned to the project owner.
-- actions.assignment_source records which resolver tier produced the assignee,
-- and actions.intended_role_id records the role that SHOULD have owned it. A
-- play whose role is unfilled is then a query, not a guess.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- §0. PRE-FLIGHT.
--
--   Query 1: current ownership_type spread. Expect 'co_owner' only.
--   Query 2: plays with more than one role — these are the ones where §2 has to
--            choose an owner, so eyeball them.
--   Query 3: handover_s2i's role coverage. Expect 0 roles on 16 plays, which is
--            why every handover play currently falls to the deal owner.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT ownership_type, count(*) FROM playbook_play_roles GROUP BY 1;
--
-- SELECT ppr.play_id, pp.title, count(*) AS role_count,
--        array_agg(dr.name ORDER BY ppr.role_id) AS roles
--   FROM playbook_play_roles ppr
--   JOIN playbook_plays pp ON pp.id = ppr.play_id
--   LEFT JOIN org_roles dr ON dr.id = ppr.role_id
--  GROUP BY 1,2 HAVING count(*) > 1 ORDER BY 3 DESC;
--
-- SELECT pp.id, pp.title, count(ppr.id) AS roles
--   FROM playbook_plays pp
--   LEFT JOIN playbook_play_roles ppr ON ppr.play_id = pp.id
--   JOIN playbooks pb ON pb.id = pp.playbook_id
--  WHERE pb.key = 'handover_s2i' AND pp.is_active
--  GROUP BY 1,2 ORDER BY pp.sort_order;


-- ───────────────────────────────────────────────────────────────────────────
-- §1. Vocabulary. Fold the never-written 'primary' onto 'owner' so the dead
--     reader branches become live rather than being deleted.
-- ───────────────────────────────────────────────────────────────────────────
UPDATE playbook_play_roles SET ownership_type = 'owner' WHERE ownership_type = 'primary';

ALTER TABLE playbook_play_roles DROP CONSTRAINT IF EXISTS playbook_play_roles_ownership_type_check;
ALTER TABLE playbook_play_roles
  ADD CONSTRAINT playbook_play_roles_ownership_type_check
  CHECK (ownership_type IN ('owner', 'co_owner'));


-- ───────────────────────────────────────────────────────────────────────────
-- §2. Every play that has roles must have exactly one owner.
--
--     Existing data is entirely 'co_owner', so each such play needs one promoted.
--     We promote the LOWEST role_id — deterministic and reviewable, but it is a
--     guess about intent. Re-run §0 query 2 afterwards and correct any play where
--     the wrong role was promoted; that is a normal builder edit, not a migration.
-- ───────────────────────────────────────────────────────────────────────────
WITH promote AS (
  SELECT DISTINCT ON (play_id) id
    FROM playbook_play_roles
   WHERE play_id NOT IN (SELECT play_id FROM playbook_play_roles WHERE ownership_type = 'owner')
   ORDER BY play_id, role_id ASC
)
UPDATE playbook_play_roles SET ownership_type = 'owner'
 WHERE id IN (SELECT id FROM promote);

-- At most one owner per play, enforced.
DROP INDEX IF EXISTS uq_play_roles_one_owner;
CREATE UNIQUE INDEX uq_play_roles_one_owner
  ON playbook_play_roles (play_id)
  WHERE ownership_type = 'owner';


-- ───────────────────────────────────────────────────────────────────────────
-- §3. Assignment provenance on actions.
--
--     intended_role_id  — the role that should own this work, copied from the
--                         play's owner role at creation. Survives the role being
--                         unfilled, which is the whole point.
--     assignment_source — which resolver tier produced the assignee:
--         role_holder     tier 1, a project-team member holding the role
--         team_queue      tier 2, org-level team for that role
--         project_owner   tier 3 fallback — NOBODY HOLDS THE ROLE
--         manual_override project owner deliberately assigned outside the role
--         reassigned      moved to a co-owner role holder after creation
--
--     NULL means pre-migration or not play-derived. ON DELETE SET NULL on the
--     role so 2026_72's RESTRICT posture is not extended to org_roles, which
--     admins legitimately retire.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE actions ADD COLUMN IF NOT EXISTS intended_role_id  integer;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS assignment_source text;

ALTER TABLE actions DROP CONSTRAINT IF EXISTS actions_intended_role_id_fkey;
ALTER TABLE actions
  ADD CONSTRAINT actions_intended_role_id_fkey
  FOREIGN KEY (intended_role_id) REFERENCES org_roles(id) ON DELETE SET NULL;

ALTER TABLE actions DROP CONSTRAINT IF EXISTS actions_assignment_source_check;
ALTER TABLE actions
  ADD CONSTRAINT actions_assignment_source_check
  CHECK (assignment_source IS NULL OR assignment_source IN
         ('role_holder', 'team_queue', 'project_owner', 'manual_override', 'reassigned'));

-- The "understaffed" query this exists to serve.
CREATE INDEX IF NOT EXISTS idx_actions_unfilled_role
  ON actions (org_id, intended_role_id)
  WHERE assignment_source = 'project_owner';

COMMENT ON COLUMN actions.intended_role_id IS
  'org_roles.id that should own this action per its play''s owner role. Retained '
  'even when unresolvable, so an unfilled role is queryable. NULL = not play-derived.';
COMMENT ON COLUMN actions.assignment_source IS
  'Which PlayRouteResolver tier produced user_id. project_owner means no holder '
  'of intended_role_id was found — surface this in the UI. As of 2026_73.';


-- ───────────────────────────────────────────────────────────────────────────
-- §4. VERIFY before COMMIT.
--
--   Query 1 expects zero rows — no play may have two owners.
--   Query 2 expects zero rows — no play with roles may lack an owner.
--   Query 3 expects only 'owner' and 'co_owner'.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT play_id, count(*) FROM playbook_play_roles
--  WHERE ownership_type = 'owner' GROUP BY 1 HAVING count(*) > 1;
--
-- SELECT DISTINCT play_id FROM playbook_play_roles
--  WHERE play_id NOT IN (SELECT play_id FROM playbook_play_roles WHERE ownership_type = 'owner');
--
-- SELECT ownership_type, count(*) FROM playbook_play_roles GROUP BY 1;

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────
-- NOT DONE HERE — the code that consumes this:
--
--  1. Readers unified onto 'owner'. PlayCompletionService:303 and
--     supportService:196 still test 'primary', which §1 has now made unreachable
--     from the data side; they must be changed to 'owner' or they keep relying on
--     the roles[0] fallback.
--  2. Writers: activateStage currently filters to co_owner ONLY, so after this
--     migration it would skip owner roles entirely. It must select the owner role
--     for assignment and treat co_owners as reassignment targets, and it must
--     populate intended_role_id / assignment_source.
--  3. Builder UI: designate which role is owner. Currently POST hardcodes
--     'co_owner' and the editor filters on it.
--  4. PATCH /actions/:id/assign — general reassignment with the three permission
--     tiers (assignee, manager via org_hierarchy.reports_to, project owner
--     override). Only a STRAP-specific endpoint exists today.
--  5. An API to set sales_handovers.assigned_service_owner_id. The column exists
--     but nothing outside a superadmin cleanup touches it — so "the project
--     owner" cannot currently be designated at all.
--
-- Item 2 is the one that BREAKS on deploy of this migration alone: promoting a
-- role to 'owner' removes it from activateStage's co_owner filter. Ship §1-§2
-- and the activateStage change together, or plays lose their assignees.
-- ───────────────────────────────────────────────────────────────────────────
