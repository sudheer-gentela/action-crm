-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_105_whatsapp_group_membership.sql
--
-- Records which GoWarmCRM USERS belong to each catalogued group — including
-- groups whose messages are NOT being captured.
--
-- THE PROBLEM
--   syncGroupMetadata returns early when a group has no thread, which is every
--   unwatched group. So for the 300-odd groups a number belongs to but does not
--   capture, we know the name and the participant COUNT and nothing else.
--
--   That makes the most common support question unanswerable. A rep searches
--   for a message they can see on their phone, finds nothing, and we can only
--   say "no results" — when the real answer is "that group isn't being
--   captured; here's a button to request it". A bare empty result is what makes
--   people give up on a feature like this.
--
-- WHY NOT JUST STORE THE FULL ROSTER
--   Because the roster of an uncaptured group is somebody's family chat. The
--   pilot number belonged to 306 groups, nearly all personal. Storing every
--   participant's phone number to answer a search question would collect far
--   more personal data than the feature needs, from people who have no
--   relationship with GoWarmCRM at all.
--
--   So we store ONLY the intersection: participants whose number matches a
--   VERIFIED user in this org. Everyone else is matched, discarded, and never
--   written. A family group yields zero rows. The Acme project group yields one
--   row per colleague in it.
--
-- IDEMPOTENT: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.whatsapp_session_group_members (
  id                serial PRIMARY KEY,
  session_group_id  integer NOT NULL REFERENCES public.whatsapp_session_groups(id) ON DELETE CASCADE,
  org_id            integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id           integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- Membership window, so search can be time-bounded the same way
  -- whatsapp_thread_participants is: someone added last week must not reach
  -- three months of prior history.
  first_seen_at     timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at      timestamp with time zone NOT NULL DEFAULT now(),
  left_at           timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_group_members
  ON public.whatsapp_session_group_members (session_group_id, user_id);

CREATE INDEX IF NOT EXISTS idx_wa_group_members_user
  ON public.whatsapp_session_group_members (org_id, user_id)
  WHERE left_at IS NULL;

COMMENT ON TABLE public.whatsapp_session_group_members IS
  'Which GoWarmCRM users are in each catalogued group, including uncaptured ones. Deliberately holds ONLY users of this org — non-user participants of uncaptured groups are matched in memory and discarded, never stored. Exists so a search that finds nothing can explain why.';

ALTER TABLE public.whatsapp_session_group_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wa_group_members_org_isolation ON public.whatsapp_session_group_members;
CREATE POLICY wa_group_members_org_isolation ON public.whatsapp_session_group_members
  USING (org_id = current_setting('app.current_org_id', true)::integer);


-- ─────────────────────────────────────────────────────────────────────────
-- CAPTURE REQUESTS
--
-- The other half of the answer. Telling someone "this group isn't captured" is
-- only useful if the next step is one click rather than a Slack message to
-- whoever administers the integration.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_capture_requests (
  id                serial PRIMARY KEY,
  org_id            integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  session_group_id  integer NOT NULL REFERENCES public.whatsapp_session_groups(id) ON DELETE CASCADE,

  requested_by      integer NOT NULL REFERENCES public.users(id),
  reason            text,
  suggested_handover_id integer REFERENCES public.sales_handovers(id) ON DELETE SET NULL,

  status            text NOT NULL DEFAULT 'pending',
  decided_by        integer REFERENCES public.users(id),
  decided_at        timestamp with time zone,
  decision_note     text,

  created_at        timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT wa_capture_requests_status_chk
    CHECK (status IN ('pending', 'approved', 'declined'))
);

-- One open request per group: a second person asking for the same group should
-- join the existing request, not create a duplicate for an admin to wade through.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_capture_requests_open
  ON public.whatsapp_capture_requests (session_group_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_wa_capture_requests_org
  ON public.whatsapp_capture_requests (org_id, status, created_at DESC);

COMMENT ON TABLE public.whatsapp_capture_requests IS
  'A user asking for a group they are in to start being captured. Approval stays with an admin because switching capture on is a data-retention decision, not a convenience one.';

ALTER TABLE public.whatsapp_capture_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wa_capture_requests_org_isolation ON public.whatsapp_capture_requests;
CREATE POLICY wa_capture_requests_org_isolation ON public.whatsapp_capture_requests
  USING (org_id = current_setting('app.current_org_id', true)::integer);

COMMIT;
