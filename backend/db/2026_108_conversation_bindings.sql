-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_108_conversation_bindings.sql
--
-- DROP-IN LOCATION: backend/db/2026_108_conversation_bindings.sql
--
-- How a conversation is ORGANISED, separately from what any one message is
-- about.
--
-- A thread whose organising principle is a PROJECT (the Acme group, the cutover
-- crew) attributes perfectly today: bind it, messages inherit. A thread
-- organised around WHO IS IN IT — the Cloudsmith vendor group, the internal
-- delivery group — cannot be expressed at all. It gets bound to one project and
-- silently misfiles everything about the others, or stays unbound and captures
-- nothing usable.
--
-- Since a misfiled message is worse than an unfiled one (nobody audits the
-- project they did not expect it in), everything built on these two tables is
-- designed to stay SILENT rather than guess.
--
-- STANDALONE TABLES rather than columns on whatsapp_threads, because Slack and
-- Teams inbound arrive within two quarters and every later phase reads this.
-- Rollback is therefore total: drop both tables and nothing existing has been
-- altered or transformed.
--
-- NUMBERING: 107 = whatsapp_session_media. This is 108.
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── conversation_bindings ───────────────────────────────────────────────────
--
-- thread_ref is the CHANNEL'S OWN external identifier as text — WhatsApp group
-- JID, Slack channel id (C123...), Teams conversation id, email
-- conversation_id. Deliberately NOT a polymorphic integer FK into four thread
-- tables: that cannot be enforced by the database, and it breaks whenever a
-- channel re-ingests and reassigns local ids. External ids are the thing that
-- stays stable.

CREATE TABLE IF NOT EXISTS public.conversation_bindings (
  id               serial PRIMARY KEY,
  org_id           integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  channel          text    NOT NULL,
  thread_ref       text    NOT NULL,
  binding_mode     text    NOT NULL,
  handover_id      integer REFERENCES public.sales_handovers(id) ON DELETE SET NULL,
  bound_account_id integer REFERENCES public.accounts(id)        ON DELETE SET NULL,
  bound_by         integer REFERENCES public.users(id)           ON DELETE SET NULL,
  bound_at         timestamp with time zone NOT NULL DEFAULT now(),
  updated_at       timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT conv_bindings_channel_chk
    CHECK (channel IN ('whatsapp','slack','teams','gchat','email')),
  CONSTRAINT conv_bindings_mode_chk
    CHECK (binding_mode IN ('project','account','pool')),

  -- project mode names a project; account mode names an account; pool names
  -- neither and carries its projects in the candidates table.
  CONSTRAINT conv_bindings_shape_chk CHECK (
        (binding_mode = 'project' AND handover_id IS NOT NULL AND bound_account_id IS NULL)
     OR (binding_mode = 'account' AND bound_account_id IS NOT NULL AND handover_id IS NULL)
     OR (binding_mode = 'pool'    AND handover_id IS NULL AND bound_account_id IS NULL)
  ),

  CONSTRAINT uq_conv_binding UNIQUE (org_id, channel, thread_ref)
);

CREATE INDEX IF NOT EXISTS idx_conv_bindings_account
  ON public.conversation_bindings (org_id, bound_account_id)
  WHERE bound_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conv_bindings_handover
  ON public.conversation_bindings (org_id, handover_id)
  WHERE handover_id IS NOT NULL;

COMMENT ON TABLE public.conversation_bindings IS
  'How a conversation is organised: around a project, around an account (a vendor group), or as a pool of projects (an internal group). ABSENCE of a row means legacy behaviour — the channel''s own thread project, if any — NOT pool. Keyed on the channel''s external thread id so the same machinery serves WhatsApp, Slack, Teams and email.';

COMMENT ON COLUMN public.conversation_bindings.thread_ref IS
  'The channel''s own external thread id as text: WhatsApp group JID (whatsapp_threads.wa_group_id) or phone for a direct thread, Slack channel id, Teams conversation id, email conversation_id. Never a local integer id.';

COMMENT ON COLUMN public.conversation_bindings.binding_mode IS
  'project = fixed project, messages inherit it (today''s behaviour). account = organised around a vendor/partner account; the project is per message and the candidate set is DERIVED. pool = an internal group discussing several projects; candidates are DECLARED by a human at bind time. For account and pool the attribution chain runs reply-context only and then stops — an entity-scoped message lands unassigned rather than guessed.';

-- ── candidate sets ──────────────────────────────────────────────────────────
--
-- Materialised, not derived at read time. Costs a sync when a vendor
-- relationship changes (Phase 2), and buys three things: the set is auditable
-- after the fact ("why did this match P2 in March?"), pool threads need the
-- table anyway since they have nothing to derive from, and the project-close
-- nudge becomes an index lookup instead of a scan.

CREATE TABLE IF NOT EXISTS public.conversation_project_candidates (
  id           serial PRIMARY KEY,
  org_id       integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  binding_id   integer NOT NULL REFERENCES public.conversation_bindings(id) ON DELETE CASCADE,
  handover_id  integer NOT NULL REFERENCES public.sales_handovers(id) ON DELETE CASCADE,
  source       text    NOT NULL DEFAULT 'declared',
  declared_by  integer REFERENCES public.users(id) ON DELETE SET NULL,
  declared_at  timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT conv_candidates_source_chk CHECK (source IN ('declared','derived')),
  CONSTRAINT uq_conv_candidate UNIQUE (binding_id, handover_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_candidates_binding
  ON public.conversation_project_candidates (org_id, binding_id);
CREATE INDEX IF NOT EXISTS idx_conv_candidates_handover
  ON public.conversation_project_candidates (org_id, handover_id);

COMMENT ON TABLE public.conversation_project_candidates IS
  'The two-to-five projects a message in an entity-scoped thread could plausibly be about. Narrowing from every active project in the org is what makes deterministic mention matching (Phase 4) a primary mechanism rather than a marginal precision play. Phase 1 WRITES this table and reads it nowhere — nothing attributes off it until Phase 3.';

COMMENT ON COLUMN public.conversation_project_candidates.source IS
  'derived = computed from the account''s vendor/partner relationship at bind time (account mode). declared = named by a human (pool mode). Kept because a stale derived set and a deliberate human one need different remedies.';

-- ── binding_status now covers three shapes, not one ─────────────────────────
--
-- 'bound' is left meaning EXACTLY what it means today — bound to a project —
-- and two values are added beside it. Nothing is rewritten, so every existing
-- query that reads `= 'bound'` keeps returning the same rows it returned
-- yesterday, and the rollback at the foot of this file stays total.
--
-- The alternative (rename 'bound' → 'bound_project' for symmetry) would need a
-- data rewrite plus a matching edit in five places including two earlier
-- migrations' audit queries, and would make rollback partial. Not worth the
-- symmetry. If the asymmetry grates later it is a one-line UPDATE.

ALTER TABLE public.whatsapp_session_groups
  DROP CONSTRAINT IF EXISTS whatsapp_session_groups_binding_status_chk;
ALTER TABLE public.whatsapp_session_groups
  ADD  CONSTRAINT whatsapp_session_groups_binding_status_chk
  CHECK (binding_status IN ('unbound', 'bound', 'bound_account', 'bound_pool', 'ignored'));

-- 2026_106's decided-check enumerates the same vocabulary and would reject the
-- two new values on an unwatched row. Re-stated rather than dropped: the
-- invariant it protects (a watched group is one somebody chose) still holds.
ALTER TABLE public.whatsapp_session_groups
  DROP CONSTRAINT IF EXISTS wa_session_groups_decided_chk;
ALTER TABLE public.whatsapp_session_groups
  ADD  CONSTRAINT wa_session_groups_decided_chk
  CHECK (is_watched = true
      OR binding_status IN ('unbound', 'bound', 'bound_account', 'bound_pool', 'ignored'));

COMMENT ON COLUMN public.whatsapp_session_groups.binding_status IS
  'unbound = captured but nobody has said how this group is organised (shows in triage). bound = bound to ONE project; the thread carries its handover_id and messages inherit it. bound_account = organised around a vendor/partner account; thread handover_id deliberately NULL. bound_pool = an internal group covering several declared projects; likewise NULL. ignored = a human said this group is not project traffic. The three bound_* shapes are spelled out in the column rather than left to be inferred from conversation_bindings, so retagging and reporting stay a status read.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Match the org-scoped policy shape used by 2026_101/104/105 so these are not
-- the one hole in the tenant boundary.

ALTER TABLE public.conversation_bindings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_project_candidates   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_bindings_org_isolation ON public.conversation_bindings;
CREATE POLICY conversation_bindings_org_isolation ON public.conversation_bindings
  USING (org_id = current_setting('app.current_org_id', true)::integer);

DROP POLICY IF EXISTS conversation_candidates_org_isolation ON public.conversation_project_candidates;
CREATE POLICY conversation_candidates_org_isolation ON public.conversation_project_candidates
  USING (org_id = current_setting('app.current_org_id', true)::integer);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (total — nothing existing was altered or transformed):
--
--   BEGIN;
--   DROP TABLE IF EXISTS public.conversation_project_candidates;
--   DROP TABLE IF EXISTS public.conversation_bindings;
--   -- Only needed if any bound_account / bound_pool rows were written:
--   UPDATE public.whatsapp_session_groups
--      SET binding_status = 'unbound'
--    WHERE binding_status IN ('bound_account', 'bound_pool');
--   COMMIT;
--
-- The widened CHECK constraints and the COMMENT are supersets of what came
-- before and can be left in place — no existing row can violate them.
-- ─────────────────────────────────────────────────────────────────────────────
