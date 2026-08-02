-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_91_seed_internal_project_playbook.sql
--
-- Seeds a starter playbook for INTERNAL projects.
--
-- Existing playbooks are handover-shaped: their first stage is closed_won and
-- their plays talk about commercial terms and introducing the delivery team to
-- the customer. Correct for a won deal, wrong for "migrate the billing system".
--
-- Four stages, deliberately generic — kickoff, plan, deliver, close. Every play
-- is worded for work with no customer on the other side. Treat it as a starting
-- point to edit in the Playbook Builder, not a finished process.
--
-- is_default is FALSE: that flag is what initiate() looks up to find the
-- handover_s2i playbook for a won deal. Marking this one default would hijack
-- customer handovers.
--
-- No fire_conditions on any play. Those are evaluated against deal fields, and
-- a project with no deal skips any play carrying them.
--
-- Runs for EVERY org that does not already have one. Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

INSERT INTO public.playbooks (org_id, name, description, type, entity_type, is_default, is_active)
SELECT o.id,
       'Internal Project',
       'Starter checklist for projects run inside the organisation — no customer, no deal. Edit to fit how your team actually works.',
       'internal_project',
       'implementation',
       FALSE,
       TRUE
  FROM public.organizations o
 WHERE NOT EXISTS (
   SELECT 1 FROM public.playbooks p
    WHERE p.org_id = o.id AND p.type = 'internal_project'
 );

INSERT INTO public.playbook_stages (playbook_id, org_id, key, name, sort_order)
SELECT p.id, p.org_id, s.stage_key, s.name, s.sort_order
  FROM public.playbooks p
  CROSS JOIN (VALUES
      ('kickoff', 'Kickoff',  1),
      ('plan',    'Plan',     2),
      ('deliver', 'Deliver',  3),
      ('close',   'Close',    4)
  ) AS s(stage_key, name, sort_order)
 WHERE p.type = 'internal_project'
   AND NOT EXISTS (
     SELECT 1 FROM public.playbook_stages ps
      WHERE ps.playbook_id = p.id AND ps.key = s.stage_key
   );

INSERT INTO public.playbook_plays
  (playbook_id, org_id, stage_key, title, description, execution_type, is_gate,
   sort_order, is_active, due_anchor, due_offset_days)
SELECT p.id, p.org_id, v.stage_key, v.title, v.description, 'parallel', v.is_gate,
       v.sort_order, TRUE, v.due_anchor, v.due_offset_days
  FROM public.playbooks p
  CROSS JOIN (VALUES
      -- Kickoff: agree what this is and who is on it, before work starts.
      ('kickoff', 'Define the problem and the outcome',
       'One paragraph: what is wrong today, and what does done look like. If this cannot be written, the project is not ready to start.',
       TRUE,  1, 'created', 3),
      ('kickoff', 'Name the project manager and the team',
       'Who is accountable, and who is doing the work. Add them under Project team and roles.',
       FALSE, 2, 'created', 3),
      ('kickoff', 'Agree the target date',
       'Set the go-live date on the project. A project with no date does not get prioritised against anything.',
       FALSE, 3, 'created', 5),

      -- Plan: the smallest amount of planning that makes delivery predictable.
      ('plan', 'Break the work into deliverables',
       'List what has to be produced. Add each as a next step or commitment so progress is visible.',
       FALSE, 1, 'created', 10),
      ('plan', 'Confirm budget and any spend approvals',
       'Record the budget on the project. Flag anything needing sign-off before it becomes a blocker.',
       FALSE, 2, 'created', 10),
      ('plan', 'Log the known risks',
       'Add them under Commitments and risks with an owner and a date. A risk with no owner is a note, not a risk.',
       FALSE, 3, 'created', 12),

      -- Deliver: keep it visible while it runs.
      ('deliver', 'Set the check-in rhythm',
       'Weekly or fortnightly. Put it in the calendar rather than relying on someone remembering.',
       FALSE, 1, 'go_live', -30),
      ('deliver', 'Review progress against the target date',
       'If the date is going to move, say so now. Late notice is what makes a slipped date expensive.',
       FALSE, 2, 'go_live', -14),

      -- Close: capture what happened, and stop the project cleanly.
      ('close', 'Confirm the outcome was achieved',
       'Against the problem written at kickoff, not against the tasks completed.',
       TRUE,  1, 'go_live', 0),
      ('close', 'Write down what to do differently',
       'Two or three lines in the closure summary. This is the only part of the project the next team will read.',
       FALSE, 2, 'go_live', 7),
      ('close', 'Close open actions and hand over anything ongoing',
       'Anything still running after the project closes needs a named owner outside the project.',
       FALSE, 3, 'go_live', 7)
  ) AS v(stage_key, title, description, is_gate, sort_order, due_anchor, due_offset_days)
 WHERE p.type = 'internal_project'
   AND NOT EXISTS (
     SELECT 1 FROM public.playbook_plays pp
      WHERE pp.playbook_id = p.id AND pp.stage_key = v.stage_key AND pp.title = v.title
   );

COMMIT;
