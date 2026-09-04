-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_137_project_member_can_manage.sql
--
-- Per-member project authority, so a project team can actually run its own
-- project.
--
-- THE PROBLEM. projectMembers.canManageProject() recognises exactly three
-- people: an org admin/owner, sales_handovers.assigned_service_owner_id, and
-- sales_handovers.created_by. project_members — the table that holds the whole
-- internal project team, with a request/approve lifecycle and a per-member
-- can_rebaseline flag already on it — was not consulted at all. So a project
-- manager who is a MEMBER rather than the named service owner could not
-- approve a task submission, change a member's role, set the review watchers,
-- or edit project files.
--
-- WHY A BOOLEAN AND NOT A ROLE KEY. The obvious alternative was to let certain
-- org_roles keys confer authority. org_roles is (id, org_id, name, key,
-- is_system, is_active, sort_order) — a user-editable LABEL list with no
-- permission semantics anywhere in it. Making a renameable label grant approval
-- rights means an org admin tidying up role names silently changes who can sign
-- work off. A boolean says what it means and cannot be renamed into something
-- else.
--
-- It also matches the precedent one column to the left: can_rebaseline is
-- already a per-member boolean read directly by handover.service.canRebaseline.
-- This is the same shape for the same kind of decision.
--
-- DEFAULT FALSE, so this migration changes nobody's rights. Every existing
-- member keeps exactly the authority they had this morning; the flag has to be
-- granted deliberately, one person at a time.
--
-- WHO MAY GRANT IT. Enforced in the service, not here: only someone who can
-- already manage the project, and only onto a member whose row is 'approved'
-- and not exited. That makes the grant chain closed — you can only hand this to
-- someone already on the team, which is the boundary that keeps a project-
-- scoped flag from becoming a route into the org.
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.project_members
  ADD COLUMN IF NOT EXISTS can_manage boolean NOT NULL DEFAULT false;

-- The lookup this column exists for is
--   "is user U an approved, non-exited member of project P with can_manage?"
-- and it runs on every canManageProject() call, which is on the hot path for
-- the checklist, the review queue, project files and the member routes.
--
-- Partial on can_manage rather than a plain index on it: the overwhelming
-- majority of rows are false and will stay false, so indexing them buys
-- nothing and costs on every membership write.
--
-- exited_at is not in the predicate because it cannot disagree —
-- project_members_exit_shape_chk (2026_88) constrains a non-NULL exited_at to
-- status IN ('declined','left'), so status = 'approved' already implies
-- exited_at IS NULL. The service still writes the condition out for the reader.
CREATE INDEX IF NOT EXISTS idx_project_members_can_manage
  ON public.project_members (context_type, context_id, user_id)
  WHERE can_manage = true AND status = 'approved';

COMMENT ON COLUMN public.project_members.can_manage IS
  'Grants this member the same per-project authority as the service owner: approve task reviews, change member roles, set review watchers, manage project files. Scoped to this project only — it confers nothing anywhere else in the org. Only meaningful while status = ''approved''.';

COMMIT;
