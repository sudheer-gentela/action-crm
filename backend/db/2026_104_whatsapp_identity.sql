-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_104_whatsapp_identity.sql
--
-- Makes users.whatsapp_phone a PERMISSION BOUNDARY rather than a profile field.
--
-- THE ENTITLEMENT MODEL
--   A user who is a participant of a WhatsApp group can already read every
--   message in it, on their phone, right now. Letting them retrieve the same
--   message inside GoWarmCRM grants nothing new. So group participation — not
--   a role someone assigned — is the correct authorisation for searching
--   captured messages. It is also tighter than a role, because it is scoped by
--   something externally verifiable.
--
-- WHY THIS NEEDS A MIGRATION
--   2026_65 added users.whatsapp_phone as free text with an opt-in timestamp.
--   That was fine when it only decided where to send a notification. It is NOT
--   fine now: if a user can type any number into their own profile, they can
--   type a colleague's and inherit that colleague's group access. The column
--   has quietly become a security boundary and must be treated as one.
--
--   Hence: who set it, when it was verified, and a uniqueness guarantee so two
--   users cannot claim the same number.
--
-- WHY NOT OTP YET
--   Verifying by sending a code requires an outbound WhatsApp message. The
--   session worker is deliberately read-only and must stay that way, and not
--   every org has Cloud API connected. Admin assignment is the honest v1: a
--   human who knows the team confirms the number. The schema anticipates
--   'otp' as a source so adding it later is not another migration.
--
-- IDEMPOTENT: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS whatsapp_phone_verified_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS whatsapp_phone_set_by      integer REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS whatsapp_phone_source      text;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_whatsapp_phone_source_chk;
ALTER TABLE public.users
  ADD  CONSTRAINT users_whatsapp_phone_source_chk
  CHECK (whatsapp_phone_source IS NULL
         OR whatsapp_phone_source IN ('admin', 'otp', 'self_claimed'));

COMMENT ON COLUMN public.users.whatsapp_phone IS
  'E.164 digits, no +. SECURITY BOUNDARY: this is what links a user to whatsapp_thread_participants rows and therefore decides which captured groups they may search. Must never be self-editable without verification — see whatsapp_phone_source.';
COMMENT ON COLUMN public.users.whatsapp_phone_source IS
  'admin = assigned by an org admin who knows the person. otp = proven by a code sent to the number. self_claimed = entered by the user and NOT yet verified; must not grant search access.';

-- Two users cannot hold the same number within an org: participant matching is
-- by phone, so a duplicate would silently hand one user the other's groups.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_whatsapp_phone_org
  ON public.users (org_id, whatsapp_phone)
  WHERE whatsapp_phone IS NOT NULL;

-- Anything already populated predates verification. Mark it rather than
-- silently trusting it, so the backfill decision is visible and reversible.
UPDATE public.users
   SET whatsapp_phone_source = 'self_claimed'
 WHERE whatsapp_phone IS NOT NULL AND whatsapp_phone_source IS NULL;


-- ─────────────────────────────────────────────────────────────────────────
-- PARTICIPANT LINKING
--
-- whatsapp_thread_participants.user_id already exists (2026_65) but nothing
-- ever populated it. That column is the join that turns "this phone was in the
-- group" into "this GoWarmCRM user was in the group".
-- ─────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_wa_participants_user
  ON public.whatsapp_thread_participants (org_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wa_participants_phone
  ON public.whatsapp_thread_participants (org_id, wa_phone);

-- Link existing participant rows to VERIFIED users only. Deliberately excludes
-- self_claimed: an unverified number must not grant access to anything.
UPDATE public.whatsapp_thread_participants p
   SET user_id = u.id,
       side    = 'internal'
  FROM public.users u
 WHERE p.user_id IS NULL
   AND u.org_id  = p.org_id
   AND u.whatsapp_phone = p.wa_phone
   AND u.whatsapp_phone_verified_at IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────
-- COMMUNICATIONS STEWARD
--
-- Handles only the residue: messages from groups where NO GoWarmCRM user is a
-- participant — a rep's personal number in a client group, someone who has
-- left, an unclaimed group. Everything a participant can self-serve should
-- never reach a steward.
--
-- Deliberately NOT a superuser. A steward may ROUTE an unassigned message to a
-- project; they may not READ messages already assigned to projects they are not
-- a member of, and they may not un-tag a message out of such a project. That
-- restriction is load-bearing: without it, "un-tag then read" is a clean
-- privilege-escalation path to every message in the org.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.communication_stewards (
  id          serial PRIMARY KEY,
  org_id      integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  granted_by  integer REFERENCES public.users(id),
  granted_at  timestamp with time zone NOT NULL DEFAULT now(),
  revoked_by  integer REFERENCES public.users(id),
  revoked_at  timestamp with time zone,
  note        text
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_comm_stewards_active
  ON public.communication_stewards (org_id, user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_comm_stewards_org
  ON public.communication_stewards (org_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE public.communication_stewards IS
  'Explicit grant to triage unassigned captured messages org-wide. NOT inherited from project membership — being on Project A says nothing about whether someone should see the org-wide unassigned pool. Org admins and the user who connected the session hold it implicitly and are not listed here.';

ALTER TABLE public.communication_stewards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS communication_stewards_org_isolation ON public.communication_stewards;
CREATE POLICY communication_stewards_org_isolation ON public.communication_stewards
  USING (org_id = current_setting('app.current_org_id', true)::integer);


-- ─────────────────────────────────────────────────────────────────────────
-- EXCLUSION
--
-- The safe disposal path. Un-tagging a mis-filed message back to the shared
-- unassigned pool can WIDEN exposure — if it was mis-filed precisely because it
-- was sensitive to another customer, moving it somewhere more people can see is
-- the wrong remedy. 'excluded' keeps it out of every project view and out of
-- search, retained only for audit.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS excluded_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS excluded_by integer REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS exclude_reason text;

CREATE INDEX IF NOT EXISTS idx_wa_messages_unassigned
  ON public.whatsapp_messages (org_id, created_at DESC)
  WHERE handover_id IS NULL AND excluded_at IS NULL;

COMMENT ON COLUMN public.whatsapp_messages.excluded_at IS
  'Marked as not CRM material. Hidden from project views and from search, retained for audit. Distinct from deletion: a mis-filed message was still SEEN by whoever had access, and erasing the row would erase the evidence of that.';

COMMIT;
