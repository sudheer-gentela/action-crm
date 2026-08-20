-- =====================================================================
-- 2026_121_play_evidence_delete_with_task.sql
--
-- Lets a task be deleted again. Its evidence goes with it — and ONLY its
-- evidence.
--
-- THE BUG
--   Two rules were added together in 2026_111 and contradict each other:
--
--     play_evidence_instance_fkey   ... ON DELETE CASCADE
--     trg_play_evidence_immutable   RAISE EXCEPTION on TG_OP = 'DELETE'
--
--   A cascade is executed as a literal DELETE against the child table:
--
--     DELETE FROM ONLY "public"."play_evidence"
--      WHERE $1 OPERATOR(pg_catalog.=) "project_play_instance_id"
--
--   which fires the row trigger, which raises, which aborts the whole
--   transaction — including the parent delete. The trigger cannot tell a
--   cascade apart from someone typing DELETE.
--
--   So the trigger does not merely override the cascade. It makes the
--   PARENT undeletable, all the way up the chain:
--
--     organizations → sales_handovers → project_play_instances → play_evidence
--
--   Every link is ON DELETE CASCADE, so today all three of these fail
--   whenever any evidence exists underneath:
--
--     handover.service.removePlay()          — DELETE /sales/:id/plays/:instanceId
--     DELETE FROM sales_handovers            — removing a project
--     superAdmin.routes.js:490               — removing an org
--
--   No data was ever corrupted: each failure is an aborted transaction,
--   so nothing is half-deleted. The damage is that legitimate deletes
--   are impossible.
--
-- THE DECISION
--   Evidence is deleted along with the task it supports. Evidence exists
--   to prove that ONE task was done; with that task gone it proves
--   nothing, and keeping it would leave rows pointing at an id that no
--   longer resolves.
--
--   Revocation is untouched and is still the right way to withdraw
--   evidence from a task that continues to exist. What changes is only
--   that the task's own removal is no longer blocked by it.
--
-- ONLY THE DELETED TASK'S EVIDENCE
--   The same WhatsApp message may legitimately be evidence on several
--   tasks — one photo of a poured slab can close both "Foundation pour"
--   and "Slab inspection". Those are SEPARATE play_evidence rows, one per
--   task; uq_play_evidence_live is keyed on
--   (project_play_instance_id, whatsapp_message_id), which is what
--   permits the second row to exist.
--
--   The cascade predicate is `WHERE project_play_instance_id = <deleted
--   task>`, so it can only ever reach the row belonging to the task being
--   deleted. The sibling task keeps its own row.
--
--   The underlying whatsapp_messages row is likewise untouched: evidence
--   is the CHILD in play_evidence_message_fkey, and deleting a child
--   never affects its parent. Deleting a task deletes a citation, not
--   the thing cited.
--
-- WHY THE TRIGGER BECOMES UPDATE-ONLY RATHER THAN LOSING ITS DELETE ARM
--   Deleting only the `IF TG_OP = 'DELETE'` branch would leave the
--   function falling through to `NEW.revoked_at`, and in a DELETE trigger
--   NEW is unassigned — plpgsql raises "record new is not assigned yet".
--   The immutability guarantee that matters (a written row is never
--   edited; the only permitted update is a revocation) lives entirely in
--   the UPDATE path, so the trigger is re-created as BEFORE UPDATE.
--
--   A TG_OP guard is kept inside the function as well, so that re-adding
--   DELETE to the trigger later degrades to a no-op instead of an error.
--
-- Run AFTER 2026_120.
--   psql "$DATABASE_URL" -f 2026_121_play_evidence_delete_with_task.sql
--
-- NOTE: boq_progress carries the identical contradiction and blocks the
--   same org-delete path. It is fixed separately in 2026_122 so each can
--   be taken on its own; run both to unblock org deletion.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.play_evidence_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Belt and braces. The trigger below is BEFORE UPDATE only, so this
  -- branch is unreachable today; it exists so that re-attaching DELETE to
  -- the trigger cannot resurrect the cascade deadlock.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  -- THE SAME TRAP AGAIN, ONE TABLE OVER — PARTIALLY.
  --   play_evidence_message_fkey is ON DELETE SET NULL, and Postgres
  --   performs that as an UPDATE on this table. So deleting a WhatsApp
  --   message that had been accepted as evidence fired this trigger and
  --   was rejected — "is immutable; the only permitted update is a
  --   revocation" — the same shape of failure as the DELETE arm above.
  --
  --   This branch stops the TRIGGER from being the thing that refuses a
  --   referential action, which is the right layering: a trigger guarding
  --   user edits should not stand in front of the FK's own semantics.
  --
  --   IT DOES NOT MAKE THE MESSAGE DELETABLE, and deliberately so. The
  --   row must still satisfy play_evidence_whatsapp_shape_chk:
  --
  --     CHECK (channel <> 'whatsapp' OR whatsapp_message_id IS NOT NULL)
  --
  --   so a whatsapp-channel evidence row cannot lose its message id, and
  --   the delete is now refused by that CHECK with a message that names
  --   the real constraint instead of by an immutability rule that had
  --   nothing to do with it.
  --
  --   Whether a cited message SHOULD be deletable is an open product
  --   question, not something to settle inside a trigger: either the FK
  --   becomes ON DELETE RESTRICT (making "you cannot delete a message
  --   that is evidence — revoke the evidence first" explicit), or the
  --   CHECK relaxes so the snapshot alone carries the proof. Nothing
  --   deletes whatsapp_messages today, so neither is urgent; a retention
  --   sweep or an erasure request would force the choice.
  --
  --   Narrowly scoped either way — the ONLY change permitted here is the
  --   message id going from set to NULL, so it cannot launder an edit.
  IF OLD.whatsapp_message_id IS NOT NULL
     AND NEW.whatsapp_message_id IS NULL
     AND NEW.id                       IS NOT DISTINCT FROM OLD.id
     AND NEW.org_id                   IS NOT DISTINCT FROM OLD.org_id
     AND NEW.project_play_instance_id IS NOT DISTINCT FROM OLD.project_play_instance_id
     AND NEW.channel                  IS NOT DISTINCT FROM OLD.channel
     AND NEW.snapshot_body            IS NOT DISTINCT FROM OLD.snapshot_body
     AND NEW.snapshot_sender          IS NOT DISTINCT FROM OLD.snapshot_sender
     AND NEW.snapshot_sent_at         IS NOT DISTINCT FROM OLD.snapshot_sent_at
     AND NEW.snapshot_thread_id       IS NOT DISTINCT FROM OLD.snapshot_thread_id
     AND NEW.note                     IS NOT DISTINCT FROM OLD.note
     AND NEW.accepted_by              IS NOT DISTINCT FROM OLD.accepted_by
     AND NEW.accepted_at              IS NOT DISTINCT FROM OLD.accepted_at
     AND NEW.revoked_at               IS NOT DISTINCT FROM OLD.revoked_at
     AND NEW.revoked_by               IS NOT DISTINCT FROM OLD.revoked_by
     AND NEW.revoke_reason            IS NOT DISTINCT FROM OLD.revoke_reason
  THEN
    RETURN NEW;
  END IF;

  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'play_evidence % is already revoked and cannot be changed', OLD.id;
  END IF;

  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'play_evidence % is immutable; the only permitted update is a revocation', OLD.id;
  END IF;

  -- Every substantive field must be carried through unchanged.
  IF NEW.id                       IS DISTINCT FROM OLD.id
     OR NEW.org_id                IS DISTINCT FROM OLD.org_id
     OR NEW.project_play_instance_id IS DISTINCT FROM OLD.project_play_instance_id
     OR NEW.channel               IS DISTINCT FROM OLD.channel
     OR NEW.whatsapp_message_id   IS DISTINCT FROM OLD.whatsapp_message_id
     OR NEW.snapshot_body         IS DISTINCT FROM OLD.snapshot_body
     OR NEW.snapshot_sender       IS DISTINCT FROM OLD.snapshot_sender
     OR NEW.snapshot_sent_at      IS DISTINCT FROM OLD.snapshot_sent_at
     OR NEW.snapshot_thread_id    IS DISTINCT FROM OLD.snapshot_thread_id
     OR NEW.note                  IS DISTINCT FROM OLD.note
     OR NEW.accepted_by           IS DISTINCT FROM OLD.accepted_by
     OR NEW.accepted_at           IS DISTINCT FROM OLD.accepted_at
  THEN
    RAISE EXCEPTION 'play_evidence % is immutable; only the revocation fields may be set', OLD.id;
  END IF;

  RETURN NEW;
END $$;

-- BEFORE DELETE OR UPDATE → BEFORE UPDATE.
DROP TRIGGER IF EXISTS trg_play_evidence_immutable ON public.play_evidence;
CREATE TRIGGER trg_play_evidence_immutable
  BEFORE UPDATE ON public.play_evidence
  FOR EACH ROW EXECUTE FUNCTION public.play_evidence_immutable();

COMMENT ON CONSTRAINT play_evidence_instance_fkey ON public.play_evidence IS
  'ON DELETE CASCADE, and now actually reachable (2026_121). Scoped to the '
  'deleted task: the same message accepted as evidence on another task is a '
  'separate row with a different project_play_instance_id and is not touched. '
  'The whatsapp_messages row is never affected — evidence is a citation, not '
  'the thing cited.';

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────

\echo ''
\echo '=== Trigger is now UPDATE-only ==='
SELECT tgname,
       (tgtype & 4) > 0  AS fires_on_insert,
       (tgtype & 8) > 0  AS fires_on_delete,
       (tgtype & 16) > 0 AS fires_on_update
  FROM pg_trigger
 WHERE tgrelid = 'public.play_evidence'::regclass AND NOT tgisinternal;

\echo ''
\echo '=== Evidence that would have blocked a delete, by project ==='
SELECT h.id AS handover_id,
       COALESCE(h.name, 'deal ' || h.deal_id::text) AS project,
       count(*) AS evidence_rows
  FROM public.play_evidence e
  JOIN public.project_play_instances p ON p.id = e.project_play_instance_id
  JOIN public.sales_handovers h        ON h.id = p.handover_id
 GROUP BY h.id, h.name, h.deal_id
 ORDER BY evidence_rows DESC
 LIMIT 20;

\echo ''
\echo '=== Messages cited as evidence on more than one task ==='
\echo '(each row below keeps its own evidence when a sibling task is deleted)'
SELECT whatsapp_message_id,
       count(DISTINCT project_play_instance_id) AS tasks_citing_it
  FROM public.play_evidence
 WHERE whatsapp_message_id IS NOT NULL
 GROUP BY whatsapp_message_id
HAVING count(DISTINCT project_play_instance_id) > 1
 ORDER BY tasks_citing_it DESC
 LIMIT 20;
