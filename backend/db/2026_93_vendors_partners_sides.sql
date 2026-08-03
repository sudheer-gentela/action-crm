-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_93_vendors_partners_sides.sql
--
-- Vendors and partners on a project, an internal customer who signs a project
-- off, and a configurable role list for external people.
--
-- FOUR SEPARATE IDEAS, deliberately kept separate:
--
--   1. account_relationships — WHAT an org is to us (vendor / partner /
--      reseller). Multi-valued. Distinct from accounts.account_type, which is
--      WHERE an org sits in the sales lifecycle (none|target|customer|churned),
--      is single-valued, and drives automation: 'customer' fires the churn
--      play, 'target' the warm-intro play.
--
--      These must not be merged. A Salesforce SI is very commonly BOTH a
--      customer and a partner, and an SI you subcontract to on one project is
--      your customer on another. Folding 'vendor' into account_type would make
--      that unrepresentable AND would silently stop the churn play for an
--      account that genuinely is a customer.
--
--   2. side — which side of the table a person sits on, PER PROJECT. Not a
--      property of their account: the same firm is a vendor on one project and
--      the customer on the next, with the same people. Derivation from the
--      account cannot express that; a column can.
--
--      Users only ever appear in project_members. Contacts only ever appear in
--      project_contacts. Nothing here lets an employee become a customer
--      contact — 2026_79 established "every project person is a real contact"
--      for external people, and the internal side keeps its own table.
--
--   3. contact_roles — configurable roles for EXTERNAL people, a sibling to
--      org_roles rather than an extension of it.
--
--      org_roles is not a label table in practice. The deal_roles view is an
--      unfiltered SELECT over it, and PlayRouteResolver / PlaybookPlayService /
--      ContractActionsGenerator route work to a role and then resolve an
--      assignee among USERS. Adding "Vendor Technical Lead" there would put it
--      in every deal-role picker and let a playbook route a play to a role that
--      can have no assignee. An org role can be assigned work; a customer role
--      cannot. Different things, different tables.
--
--   4. Project sign-off — an internal customer accepts the project as done.
--      Today canClose() only checks the deliverable rollup and the transition
--      requires the creator or service owner, so the project manager signs off
--      their own project. Hard vs soft gate is configured per org in
--      organizations.settings->'project_access' (no migration needed there).
--
-- NOT changed: contacts.role_type. That is the buying-committee dimension
-- (economic buyer, champion) which travels with the person across every deal,
-- and is read by deal health and targeting. It answers a different question
-- from "what do they do on this project" and merging the two would lose it.
--
-- Safe to run more than once.
-- NUMBERING: 92 = project_files. This is 93.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. account_relationships ─────────────────────────────────────────────────
--
-- A table rather than accounts.relationships text[] because finance approves
-- each relationship once, org-wide, and approval carries who and when. An array
-- cannot hold that.

CREATE TABLE IF NOT EXISTS public.account_relationships (
  id            serial PRIMARY KEY,
  org_id        integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  account_id    integer NOT NULL REFERENCES public.accounts(id)      ON DELETE CASCADE,
  relationship  text    NOT NULL,
  status        text    NOT NULL DEFAULT 'pending',
  approved_by   integer REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at   timestamp with time zone,
  ended_at      timestamp with time zone,
  notes         text,
  created_by    integer REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT account_relationships_kind_chk
    CHECK (relationship IN ('vendor', 'partner', 'reseller')),
  CONSTRAINT account_relationships_status_chk
    CHECK (status IN ('pending', 'active', 'rejected', 'ended')),

  -- An approved relationship must say who approved it and when. A pending one
  -- must not carry a stale approval from an earlier cycle.
  CONSTRAINT account_relationships_approval_shape_chk
    CHECK ((status = 'active'  AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
        OR (status <> 'active' AND (approved_at IS NULL OR approved_by IS NOT NULL))),

  CONSTRAINT uq_account_relationships UNIQUE (org_id, account_id, relationship)
);

CREATE INDEX IF NOT EXISTS idx_account_relationships_lookup
  ON public.account_relationships (org_id, relationship, status);

COMMENT ON TABLE public.account_relationships IS
  'What an org is to us — vendor, partner, reseller — separate from and additive to accounts.account_type, which is sales lifecycle. Multi-valued: an account can be a customer AND a partner AND a vendor. Approved once per relationship by a named approver, not per project.';

-- ── 2. contact_roles ─────────────────────────────────────────────────────────
-- Column shape mirrors org_roles exactly, plus `side`, so the CRUD screen and
-- routes are the same shape as the existing org-roles ones.

CREATE TABLE IF NOT EXISTS public.contact_roles (
  id          serial PRIMARY KEY,
  org_id      integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  side        text    NOT NULL,
  key         text    NOT NULL,
  name        text    NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT contact_roles_side_chk CHECK (side IN ('customer', 'vendor', 'partner')),
  CONSTRAINT uq_contact_roles UNIQUE (org_id, side, key)
);

CREATE INDEX IF NOT EXISTS idx_contact_roles_active
  ON public.contact_roles (org_id, side, sort_order) WHERE is_active;

COMMENT ON TABLE public.contact_roles IS
  'Configurable roles for EXTERNAL project people, per side. Sibling to org_roles, not an extension: org_roles is routable (plays resolve an assignee among users) and these are descriptive labels for people who are not users.';
COMMENT ON COLUMN public.contact_roles.is_system IS
  'Referenced by application logic, so it may be renamed but not deleted. go_live_approver gates project sign-off; other is the fallback default for project_contacts.role.';

-- Seed every existing org. ON CONFLICT DO NOTHING so a re-run never clobbers a
-- rename the customer has already made.
INSERT INTO public.contact_roles (org_id, side, key, name, is_system, sort_order)
SELECT o.id, v.side, v.key, v.name, v.is_system, v.sort_order
  FROM public.organizations o
 CROSS JOIN (VALUES
    -- The six that were previously hard-coded in project_contacts_role_chk.
    ('customer', 'implementation_lead', 'Implementation Lead',  false, 10),
    ('customer', 'day_to_day_admin',    'Day-to-day Admin',     false, 20),
    ('customer', 'go_live_approver',    'Go-live Approver',     true,  30),
    ('customer', 'exec_sponsor',        'Executive Sponsor',    false, 40),
    ('customer', 'technical_lead',      'Technical Lead',       false, 50),
    ('customer', 'other',               'Other',                true,  60),

    ('vendor',   'engagement_lead',     'Engagement Lead',      false, 10),
    ('vendor',   'technical_consultant','Technical Consultant', false, 20),
    ('vendor',   'account_manager',     'Account Manager',      false, 30),
    ('vendor',   'support_contact',     'Support Contact',      false, 40),
    ('vendor',   'other',               'Other',                true,  50),

    ('partner',  'partner_principal',   'Partner Principal',    false, 10),
    ('partner',  'solution_architect',  'Solution Architect',   false, 20),
    ('partner',  'delivery_lead',       'Delivery Lead',        false, 30),
    ('partner',  'commercial_contact',  'Commercial Contact',   false, 40),
    ('partner',  'other',               'Other',                true,  50)
 ) AS v(side, key, name, is_system, sort_order)
ON CONFLICT (org_id, side, key) DO NOTHING;

-- ── 3. side on the two people tables ─────────────────────────────────────────
--
-- Both defaults preserve exactly what today's rows mean, so there is no
-- backfill and no window where an existing project renders differently.

ALTER TABLE public.project_contacts
  ADD COLUMN IF NOT EXISTS side text NOT NULL DEFAULT 'customer';

ALTER TABLE public.project_contacts
  DROP CONSTRAINT IF EXISTS project_contacts_side_chk;
ALTER TABLE public.project_contacts
  ADD CONSTRAINT project_contacts_side_chk CHECK (side IN ('customer', 'vendor', 'partner'));

-- Roles are configurable now, so the fixed list has to go. Validation moves to
-- the service layer against contact_roles. No FK: contact_roles is keyed
-- (org_id, side, key) and a composite FK would make every insert depend on the
-- seed having run for that org, turning a provisioning gap into a hard failure
-- on a screen the user is already looking at.
ALTER TABLE public.project_contacts
  DROP CONSTRAINT IF EXISTS project_contacts_role_chk;

CREATE INDEX IF NOT EXISTS idx_project_contacts_side
  ON public.project_contacts (context_type, context_id, side);

ALTER TABLE public.project_members
  ADD COLUMN IF NOT EXISTS side text NOT NULL DEFAULT 'delivery';

ALTER TABLE public.project_members
  DROP CONSTRAINT IF EXISTS project_members_side_chk;
ALTER TABLE public.project_members
  ADD CONSTRAINT project_members_side_chk CHECK (side IN ('delivery', 'internal_customer'));

COMMENT ON COLUMN public.project_members.side IS
  'delivery = doing the work. internal_customer = the person the work is FOR, who accepts it as done. A column rather than a role name because closure sign-off keys off it, and a role label can be renamed in the config screen.';

CREATE INDEX IF NOT EXISTS idx_project_members_side
  ON public.project_members (context_type, context_id, side) WHERE status = 'approved';

-- ── 4. deal_contacts.role cleanup ────────────────────────────────────────────
--
-- Was varchar(50) with NO constraint at all, so it has been free text since it
-- was created. Normalise onto the same customer-side vocabulary as
-- project_contacts so deal and project contact roles finally agree.
--
-- Lower-case and underscore what is there; anything that does not land on a
-- known key becomes 'other' rather than being dropped, and NULLs become 'other'
-- too. Volume is low enough that this is a single pass.

UPDATE public.deal_contacts
   SET role = CASE
     WHEN role IS NULL OR btrim(role) = '' THEN 'other'
     WHEN lower(regexp_replace(btrim(role), '[^a-zA-Z0-9]+', '_', 'g')) IN
          ('implementation_lead','day_to_day_admin','go_live_approver',
           'exec_sponsor','technical_lead','other')
       THEN lower(regexp_replace(btrim(role), '[^a-zA-Z0-9]+', '_', 'g'))
     ELSE 'other'
   END
 WHERE role IS NULL
    OR role <> CASE
     WHEN role IS NULL OR btrim(role) = '' THEN 'other'
     WHEN lower(regexp_replace(btrim(role), '[^a-zA-Z0-9]+', '_', 'g')) IN
          ('implementation_lead','day_to_day_admin','go_live_approver',
           'exec_sponsor','technical_lead','other')
       THEN lower(regexp_replace(btrim(role), '[^a-zA-Z0-9]+', '_', 'g'))
     ELSE 'other'
   END;

ALTER TABLE public.deal_contacts ALTER COLUMN role SET DEFAULT 'other';

-- Left nullable on purpose: existing inserts that omit role now get 'other'
-- from the default, and nothing that currently writes NULL starts failing.
COMMENT ON COLUMN public.deal_contacts.role IS
  'Key into contact_roles where side = ''customer'', same vocabulary as project_contacts.role. Validated in the service layer.';

-- ── 5. Project sign-off ──────────────────────────────────────────────────────
--
-- Who accepted the project, not who closed the record. completed_by already
-- exists and means the latter.

ALTER TABLE public.sales_handovers
  ADD COLUMN IF NOT EXISTS signed_off_by   integer REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS signed_off_at   timestamp with time zone,
  ADD COLUMN IF NOT EXISTS signoff_note    text;

ALTER TABLE public.sales_handovers
  DROP CONSTRAINT IF EXISTS sales_handovers_signoff_shape_chk;
ALTER TABLE public.sales_handovers
  ADD CONSTRAINT sales_handovers_signoff_shape_chk
  CHECK ((signed_off_at IS NULL AND signed_off_by IS NULL)
      OR (signed_off_at IS NOT NULL AND signed_off_by IS NOT NULL));

COMMENT ON COLUMN public.sales_handovers.signed_off_by IS
  'The internal customer who accepted the project as done. Distinct from completed_by, which is whoever moved the record to completed. Whether sign-off BLOCKS completion is per-org config: settings->project_access->closure_signoff_mode (soft|hard).';

COMMIT;
