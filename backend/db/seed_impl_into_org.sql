-- ═══════════════════════════════════════════════════════════════════════════
-- seed_impl_into_org.sql   (DATA ONLY — seeds the 6 projects into an EXISTING org)
--
-- DEMO SEED — Sales → Implementation Handover showcase.
--
-- Populates 6 curated sports-infrastructure delivery projects that span every
-- lifecycle state (Yet-to-Start → Ready-to-Start → In-Progress → Completed),
-- both rain-severity blockers, and every project type. Each project is a
-- closed-won deal that has been handed over to implementation, so you can click
-- from the deal → its handover → deliverables → the WhatsApp delivery thread.
--
-- Two playbook layers, exactly as agreed:
--   • the org's 'handovers' playbook (app-seeded)  — GATES the transfer.
--   • "Implementation Delivery (Demo)"     — RUNS the project through stages:
--        mobilize → groundwork → installation → finishing → sign-off.
--
-- ZERO SCHEMA CHANGES. Rain exposure is modelled as an existing commitment of
-- type 'risk' (Medium) / 'red_flag' (High). Progress is the delivery
-- playbook's stage completion, surfaced through handover_deliverable_rollup.
-- WhatsApp is seeded as a SIMULATED thread (historical delivered messages, no
-- org_whatsapp_accounts row) so it renders without a live Meta WABA connected.
--
-- IDEMPOTENT: re-running deletes the prior demo rows (marker-scoped) and
-- rebuilds them. It never touches your real accounts, deals, or handovers.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  -- ─── CONFIG ──────────────────────────────────────────────────────────────
  -- Optionally hard-set your org id here; otherwise the busiest active,
  -- non-assessment org is auto-selected.
  v_org_id   integer := NULL;
  v_sales    integer;   -- sales rep (handover creator)
  v_impl     integer;   -- implementation / service owner
  v_hpb      integer;   -- the org's app-seeded handovers playbook id
  v_dpb      integer;   -- delivery playbook id

  -- (Unused now — handover plays come from the org's real playbook.)
  c_gates jsonb := '[
    {"t":"Assign implementation owner","g":true,"o":1},
    {"t":"Document customer stakeholders","g":true,"o":2},
    {"t":"Record commitments & deliverables","g":true,"o":3},
    {"t":"Flag risks & red flags","g":false,"o":4},
    {"t":"Confirm go-live date","g":true,"o":5}
  ]'::jsonb;

  -- Fixed delivery stage play set. D6 is go-live-anchored (backward-planned).
  c_delivery jsonb := '[
    {"s":"mobilize","t":"Site mobilization & material dispatch","g":false,"o":1,"anchor":"created","off":2},
    {"s":"mobilize","t":"Site readiness sign-off","g":true,"o":2,"anchor":"created","off":4},
    {"s":"groundwork","t":"Base & sub-base preparation","g":false,"o":3,"anchor":"created","off":12},
    {"s":"installation","t":"Primary surface installation","g":false,"o":4,"anchor":"created","off":24},
    {"s":"finishing","t":"Finishing, line-marking & snag rectification","g":false,"o":5,"anchor":"created","off":34},
    {"s":"signoff","t":"Customer walkthrough & sign-off","g":true,"o":6,"anchor":"go_live","off":-3}
  ]'::jsonb;

  -- Per-project configuration.
  --   ho_status     : sales_handovers.status
  --   gate_cleared  : are the handover gates done (transfer complete)?
  --   deliv_done    : how many of the 6 delivery plays are completed
  --   next_state    : status of the (deliv_done+1)-th delivery play
  --   rain          : none | risk (Medium) | red_flag (High)
  --   esc           : instantiate a weather-escalation play?
  c_projects jsonb := '[
    {
      "key":"sancta","account":"Sancta Maria School","domain":"sanctamaria.edu.in",
      "loc":"Hyderabad, Telangana","ptype":"Multi Courts",
      "deal":"Sancta Maria — Multi-Court Complex","value":2850000,
      "close_ago":10,"golive_in":60,
      "ho_status":"draft","gate_cleared":false,"deliv_done":0,"next_state":"not_started",
      "rain":"none","esc":false,
      "contact":{"first":"Reena","last":"Mathew","title":"Head of Sports","role":"decision_maker","phone":"919800000011"},
      "commitments":[
        {"d":"Confirm court dimensions & layout drawings before mobilization","type":"promise","due_in":7,"status":"open","owner":"sales"},
        {"d":"Mobilize to site within 2 weeks of advance receipt","type":"promise","due_in":14,"status":"open","owner":"impl"}
      ],
      "messages":[
        {"dir":"outbound","auto":false,"body":"Welcome aboard! We are the delivery team for your multi-court project. We will confirm drawings and share a mobilization date shortly.","ago_h":30}
      ]
    },
    {
      "key":"hakimpet","account":"Hakimpet Sports Authority","domain":"hakimpet.gov.in",
      "loc":"Hakimpet, Telangana","ptype":"Track",
      "deal":"Hakimpet — Athletics Track Resurfacing","value":4200000,
      "close_ago":20,"golive_in":45,
      "ho_status":"acknowledged","gate_cleared":true,"deliv_done":1,"next_state":"in_progress",
      "rain":"none","esc":false,
      "contact":{"first":"Suresh","last":"Rao","title":"Facilities Manager","role":"decision_maker","phone":"919800000021"},
      "commitments":[
        {"d":"Shockpad material delivered to site","type":"promise","due_in":-2,"status":"met","owner":"impl"},
        {"d":"Complete shockpad laying across full track","type":"promise","due_in":10,"status":"open","owner":"impl"}
      ],
      "messages":[
        {"dir":"outbound","auto":false,"body":"All material and machinery have reached site. We are ready to start the shockpad work tomorrow morning.","ago_h":26},
        {"dir":"inbound","auto":false,"body":"Great, gate access is arranged from 7 AM. Please share daily progress here.","ago_h":24}
      ]
    },
    {
      "key":"chengannur","account":"Chengannur Sports Trust","domain":"chengannursports.org",
      "loc":"Chengannur, Kerala","ptype":"Building",
      "deal":"Chengannur — Pavilion & Building Works","value":9600000,
      "close_ago":50,"golive_in":20,
      "ho_status":"in_progress","gate_cleared":true,"deliv_done":3,"next_state":"blocked",
      "rain":"red_flag","esc":true,
      "contact":{"first":"Anish","last":"Kurian","title":"Project Director","role":"decision_maker","phone":"919800000031"},
      "commitments":[
        {"d":"Civil & building works completed to structural spec","type":"promise","due_in":18,"status":"in_progress","owner":"impl"},
        {"d":"Monsoon exposure: outer-drain dewatering & concrete casting delayed by continuous rains","type":"red_flag","due_in":6,"status":"in_progress","owner":"impl"}
      ],
      "messages":[
        {"dir":"outbound","auto":false,"body":"Pavilion-2 slab back-filling and electrical chamber slab-cover casting are in progress.","ago_h":72},
        {"dir":"outbound","auto":true,"body":"Weather delay notice: continuous rains are affecting civil works. We are dewatering the outer drain and will rebaseline the go-live date this week.","ago_h":20},
        {"dir":"inbound","auto":false,"body":"Understood. Please prioritise drainage so we do not lose more days. Keep us posted on the revised date.","ago_h":18}
      ]
    },
    {
      "key":"donbosco","account":"DonBosco Mumbai","domain":"donboscomumbai.in",
      "loc":"Mumbai, Maharashtra","ptype":"Football",
      "deal":"DonBosco Mumbai — Football Turf Installation","value":7300000,
      "close_ago":55,"golive_in":15,
      "ho_status":"in_progress","gate_cleared":true,"deliv_done":3,"next_state":"in_progress",
      "rain":"risk","esc":true,
      "contact":{"first":"Father","last":"Peter","title":"Administrator","role":"decision_maker","phone":"919800000041"},
      "commitments":[
        {"d":"Turf stitching, gluing of white lines and silica spreading completed","type":"promise","due_in":10,"status":"in_progress","owner":"impl"},
        {"d":"Infill works slowed by intermittent rains","type":"risk","due_in":8,"status":"in_progress","owner":"impl"}
      ],
      "messages":[
        {"dir":"outbound","auto":false,"body":"Turf stitching and white-line gluing done. Silica spreading is in progress.","ago_h":60},
        {"dir":"outbound","auto":true,"body":"Weather note: infill work is slowed by intermittent rains. No change to go-live yet; we will flag early if that changes.","ago_h":22},
        {"dir":"inbound","auto":false,"body":"Thanks for the heads up. Let us know if the go-live is at risk.","ago_h":20}
      ]
    },
    {
      "key":"cpwd","account":"CPWD Ranchi","domain":"cpwd.gov.in",
      "loc":"Ranchi, Jharkhand","ptype":"Cricket",
      "deal":"CPWD Ranchi — Cricket Ground Surfacing","value":5400000,
      "close_ago":60,"golive_in":10,
      "ho_status":"in_progress","gate_cleared":true,"deliv_done":4,"next_state":"in_progress",
      "rain":"none","esc":false,
      "contact":{"first":"Manoj","last":"Verma","title":"Executive Engineer","role":"decision_maker","phone":"919800000051"},
      "commitments":[
        {"d":"Aggregate base laid and surface levelled to spec","type":"promise","due_in":-3,"status":"met","owner":"impl"},
        {"d":"Complete surface preparation and finishing before go-live","type":"promise","due_in":7,"status":"in_progress","owner":"impl"}
      ],
      "messages":[
        {"dir":"outbound","auto":false,"body":"Aggregate leveling completed. Moving to surface preparation and finishing this week.","ago_h":48},
        {"dir":"inbound","auto":false,"body":"Good progress. We will schedule the walkthrough once finishing is done.","ago_h":40}
      ]
    },
    {
      "key":"rairangpur","account":"Rairangpur Municipality","domain":"rairangpur.gov.in",
      "loc":"Rairangpur, Odisha","ptype":"Track",
      "deal":"Rairangpur — Natural Turf Track","value":3900000,
      "close_ago":120,"golive_in":-5,
      "ho_status":"completed","gate_cleared":true,"deliv_done":6,"next_state":null,
      "rain":"none","esc":false,
      "contact":{"first":"Bijay","last":"Sahoo","title":"Municipal Engineer","role":"decision_maker","phone":"919800000061"},
      "commitments":[
        {"d":"Natural grass turf cutting and laying completed","type":"promise","due_in":-30,"status":"met","owner":"impl"},
        {"d":"Line marking completed","type":"promise","due_in":-14,"status":"met","owner":"impl"},
        {"d":"Final walkthrough and maintenance handoff","type":"promise","due_in":-6,"status":"met","owner":"impl"}
      ],
      "messages":[
        {"dir":"outbound","auto":false,"body":"Turf laying and line marking are complete. Requesting a walkthrough for sign-off.","ago_h":180},
        {"dir":"inbound","auto":false,"body":"Walkthrough done, everything looks great. Project accepted. Thank you team!","ago_h":150}
      ]
    }
  ]'::jsonb;

  c_pool jsonb := '[
    {"email":"ravi.kumar@impl-demo.team","first":"Ravi","last":"Kumar"},
    {"email":"anil.reddy@impl-demo.team","first":"Anil","last":"Reddy"},
    {"email":"prakash.nair@impl-demo.team","first":"Prakash","last":"Nair"},
    {"email":"deepa.iyer@impl-demo.team","first":"Deepa","last":"Iyer"},
    {"email":"vikram.singh@impl-demo.team","first":"Vikram","last":"Singh"},
    {"email":"meera.joshi@impl-demo.team","first":"Meera","last":"Joshi"}
  ]'::jsonb;
  c_teams jsonb := '{
    "chengannur":{"pm":"deepa.iyer@impl-demo.team","impl":"anil.reddy@impl-demo.team"},
    "donbosco":{"pm":"vikram.singh@impl-demo.team","impl":"prakash.nair@impl-demo.team"},
    "cpwd":{"pm":"deepa.iyer@impl-demo.team","impl":"anil.reddy@impl-demo.team"},
    "hakimpet":{"pm":"vikram.singh@impl-demo.team","impl":"prakash.nair@impl-demo.team"},
    "rairangpur":{"pm":"deepa.iyer@impl-demo.team","impl":"anil.reddy@impl-demo.team"},
    "sancta":{"pm":"vikram.singh@impl-demo.team","impl":"prakash.nair@impl-demo.team"}
  }'::jsonb;
  pool      jsonb;
  v_role_ae integer; v_role_pm integer; v_role_impl integer; v_role_proc integer;
  v_u_ae integer; v_u_pm integer; v_u_impl integer; v_u_proc integer;
  proj      jsonb;
  gate      jsonb;
  play      record;
  dp        jsonb;
  com       jsonb;
  msg       jsonb;

  v_account   integer;
  v_contact   integer;
  v_ct_contact integer;
  v_com_id    integer;
  v_deal      integer;
  v_handover  integer;
  v_thread    integer;
  v_pi        integer;
  v_close     date;
  v_golive    date;
  v_role      text;
  v_owner     integer;
  v_status    text;
  v_completed boolean;
  v_due       date;
  v_ord       integer;
  v_ho_owner  integer;
  v_comp_at   timestamptz;
BEGIN
  -- ─── Target an EXISTING org (created via Super Admin) ────────────────────
  --  >>> SET THESE to your org + an admin user in it. Defaults: org 117 / user 27.
  v_org_id := 117;
  v_sales  := 27;
  v_impl   := 27;

  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org_id) THEN
    RAISE EXCEPTION 'Org % does not exist.', v_org_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = v_sales AND org_id = v_org_id) THEN
    RAISE EXCEPTION 'User % is not a member of org %.', v_sales, v_org_id;
  END IF;

  RAISE NOTICE 'Seeding implementation demo into EXISTING org % (acting user %)', v_org_id, v_sales;

  RAISE NOTICE 'Seeding implementation showcase into org % (sales user %, impl user %)', v_org_id, v_sales, v_impl;

  -- ─── Idempotent cleanup (marker-scoped) ──────────────────────────────────
  DELETE FROM whatsapp_messages
    WHERE org_id = v_org_id
      AND thread_id IN (SELECT id FROM whatsapp_threads WHERE org_id = v_org_id AND wa_group_id LIKE 'demo-impl-%');
  DELETE FROM whatsapp_thread_participants
    WHERE org_id = v_org_id
      AND thread_id IN (SELECT id FROM whatsapp_threads WHERE org_id = v_org_id AND wa_group_id LIKE 'demo-impl-%');
  DELETE FROM whatsapp_threads WHERE org_id = v_org_id AND wa_group_id LIKE 'demo-impl-%';

  DELETE FROM sales_handover_plays
    WHERE org_id = v_org_id
      AND handover_id IN (SELECT id FROM sales_handovers WHERE org_id = v_org_id
                          AND deal_id IN (SELECT id FROM deals WHERE org_id = v_org_id AND external_crm_type = 'demo_seed'));
  DELETE FROM sales_handover_commitments
    WHERE org_id = v_org_id
      AND handover_id IN (SELECT id FROM sales_handovers WHERE org_id = v_org_id
                          AND deal_id IN (SELECT id FROM deals WHERE org_id = v_org_id AND external_crm_type = 'demo_seed'));
  DELETE FROM sales_handover_stakeholders
    WHERE org_id = v_org_id
      AND handover_id IN (SELECT id FROM sales_handovers WHERE org_id = v_org_id
                          AND deal_id IN (SELECT id FROM deals WHERE org_id = v_org_id AND external_crm_type = 'demo_seed'));
  DELETE FROM sales_handovers
    WHERE org_id = v_org_id AND deal_id IN (SELECT id FROM deals WHERE org_id = v_org_id AND external_crm_type = 'demo_seed');
  DELETE FROM deal_play_instances
    WHERE org_id = v_org_id AND deal_id IN (SELECT id FROM deals WHERE org_id = v_org_id AND external_crm_type = 'demo_seed');
  DELETE FROM deal_contacts
    WHERE deal_id IN (SELECT id FROM deals WHERE org_id = v_org_id AND external_crm_type = 'demo_seed');
  DELETE FROM deals WHERE org_id = v_org_id AND external_crm_type = 'demo_seed';
  DELETE FROM contacts WHERE org_id = v_org_id AND external_refs @> '{"demo_seed":"impl_showcase_v1"}'::jsonb;
  DELETE FROM accounts WHERE org_id = v_org_id AND external_refs @> '{"demo_seed":"impl_showcase_v1"}'::jsonb;
  DELETE FROM playbook_plays
    WHERE org_id = v_org_id AND playbook_id IN (SELECT id FROM playbooks WHERE org_id = v_org_id AND name = 'Implementation Delivery (Demo)');
  DELETE FROM playbooks WHERE org_id = v_org_id AND name = 'Implementation Delivery (Demo)';

  -- demo pool users (deal_team_members cascade with the demo deals deleted above)
  DELETE FROM org_users WHERE org_id = v_org_id
    AND user_id IN (SELECT id FROM users WHERE org_id = v_org_id AND email LIKE '%@impl-demo.team');
  DELETE FROM users WHERE org_id = v_org_id AND email LIKE '%@impl-demo.team';

  -- ─── Find the org's REAL handover playbook (app-seeded, type 'handovers') ─
  SELECT id INTO v_hpb FROM playbooks
   WHERE org_id = v_org_id AND type = 'handovers' AND is_default = TRUE
   ORDER BY id LIMIT 1;
  IF v_hpb IS NULL THEN
    SELECT id INTO v_hpb FROM playbooks
     WHERE org_id = v_org_id AND type = 'handovers' ORDER BY id LIMIT 1;
  END IF;
  IF v_hpb IS NULL THEN
    RAISE EXCEPTION 'No handover playbook on org % — seed it first (OrgAdmin -> Handovers -> Seed GoWarm Sample Playbook).', v_org_id;
  END IF;
  -- ─── Project-team roles + shared internal pool ───────────────────────────
  INSERT INTO org_roles (org_id, name, key, is_system, is_active, sort_order)
  SELECT v_org_id, x.name, x.key, FALSE, TRUE, x.ord
  FROM (VALUES ('Project Manager','project_manager',30),('Procurement','procurement',31)) AS x(name,key,ord)
  WHERE NOT EXISTS (SELECT 1 FROM org_roles r WHERE r.org_id = v_org_id AND r.key = x.key);

  SELECT id INTO v_role_ae   FROM org_roles WHERE org_id = v_org_id AND key = 'account_executive' LIMIT 1;
  SELECT id INTO v_role_impl FROM org_roles WHERE org_id = v_org_id AND key = 'implementation'    LIMIT 1;
  SELECT id INTO v_role_pm   FROM org_roles WHERE org_id = v_org_id AND key = 'project_manager'   LIMIT 1;
  SELECT id INTO v_role_proc FROM org_roles WHERE org_id = v_org_id AND key = 'procurement'       LIMIT 1;

  -- Shared internal pool (login password for all: TestOrg@2026). Marked by the
  -- @impl-demo.team domain so teardown can remove them.
  FOR pool IN SELECT * FROM jsonb_array_elements(c_pool) LOOP
    INSERT INTO users (email, password_hash, first_name, last_name, org_id)
    VALUES (pool->>'email', '$2b$10$L/nrjvmmVSp6YBgmwAr88.0tt9FVDkis3CEBm/wbp1dco2cJ7KH4O', pool->>'first', pool->>'last', v_org_id)
    ON CONFLICT (email) DO NOTHING;
    INSERT INTO org_users (org_id, user_id, role, is_active)
    SELECT v_org_id, u.id, 'member', TRUE FROM users u WHERE u.email = pool->>'email'
    ON CONFLICT DO NOTHING;
  END LOOP;

  v_u_ae   := (SELECT id FROM users WHERE email = 'ravi.kumar@impl-demo.team'  AND org_id = v_org_id);
  v_u_proc := (SELECT id FROM users WHERE email = 'meera.joshi@impl-demo.team' AND org_id = v_org_id);

  -- ─── Create the delivery-stage playbook ──────────────────────────────────
  INSERT INTO playbooks (org_id, name, type, description, is_default, gate_enforcement, entity_type, created_by)
  VALUES (v_org_id, 'Implementation Delivery (Demo)', 'delivery',
          'Runs a handed-over project through mobilize → groundwork → installation → finishing → sign-off.',
          FALSE, 'advisory', 'handover', v_sales)
  RETURNING id INTO v_dpb;

  FOR dp IN SELECT * FROM jsonb_array_elements(c_delivery) LOOP
    INSERT INTO playbook_plays (playbook_id, org_id, stage_key, title, description, channel,
                                sort_order, execution_type, is_gate, due_offset_days, due_anchor,
                                priority, is_active, trigger_mode)
    VALUES (v_dpb, v_org_id, dp->>'s', dp->>'t', dp->>'t', 'internal_task',
            (dp->>'o')::int * 10, 'sequential', (dp->>'g')::boolean,
            (dp->>'off')::int, dp->>'anchor', 'medium', TRUE, 'stage_change');
  END LOOP;
  -- On-demand weather-escalation play (fires when a delivery play is blocked).
  INSERT INTO playbook_plays (playbook_id, org_id, stage_key, title, description, channel,
                              sort_order, execution_type, is_gate, due_offset_days, priority,
                              is_active, trigger_mode, fire_conditions, suggested_action)
  VALUES (v_dpb, v_org_id, 'installation', 'Weather-delay escalation & customer notice',
          'Notify the customer of a weather delay and rebaseline the go-live date.', 'whatsapp',
          99, 'parallel', FALSE, 1, 'high', TRUE, 'on_demand',
          '[{"field":"blocker_severity","op":">=","value":"medium"}]'::jsonb,
          'Send the weather-delay WhatsApp notice and propose a revised go-live date.');

  -- ═════════════════════════════════════════════════════════════════════════
  -- Per-project build
  -- ═════════════════════════════════════════════════════════════════════════
  FOR proj IN SELECT * FROM jsonb_array_elements(c_projects) LOOP
    v_close  := CURRENT_DATE - (proj->>'close_ago')::int;
    v_golive := CURRENT_DATE + (proj->>'golive_in')::int;

    -- Account
    INSERT INTO accounts (name, domain, industry, location, org_id, account_type, external_refs, owner_id)
    VALUES (proj->>'account', proj->>'domain', 'Sports Infrastructure', proj->>'loc',
            v_org_id, 'customer', jsonb_build_object('demo_seed','impl_showcase_v1','project_type', proj->>'ptype'), v_sales)
    RETURNING id INTO v_account;

    -- Primary customer contact
    INSERT INTO contacts (account_id, first_name, last_name, title, role_type, phone, org_id, external_refs, user_id)
    VALUES (v_account, proj#>>'{contact,first}', proj#>>'{contact,last}', proj#>>'{contact,title}',
            proj#>>'{contact,role}', proj#>>'{contact,phone}', v_org_id,
            '{"demo_seed":"impl_showcase_v1"}'::jsonb, v_sales)
    RETURNING id INTO v_contact;

    -- Closed-won deal
    INSERT INTO deals (account_id, owner_id, user_id, name, value, stage, health, probability,
                       expected_close_date, close_date, closed_at, org_id,
                       external_crm_type, external_crm_deal_id)
    VALUES (v_account, v_sales, v_sales, proj->>'deal', (proj->>'value')::numeric, 'closed_won',
            'healthy', 100, v_close, v_close, v_close::timestamp, v_org_id,
            'demo_seed', 'impl_showcase:' || (proj->>'key'))
    RETURNING id INTO v_deal;

    INSERT INTO deal_contacts (deal_id, contact_id, role, is_primary)
    VALUES (v_deal, v_contact, proj#>>'{contact,role}', TRUE);

    -- This project's PM + implementer from the shared pool; AE + procurement are shared.
    v_u_pm   := (SELECT id FROM users WHERE org_id = v_org_id AND email = c_teams->(proj->>'key')->>'pm');
    v_u_impl := (SELECT id FROM users WHERE org_id = v_org_id AND email = c_teams->(proj->>'key')->>'impl');

    -- Internal project team on the deal (drives play RACI via deal_team_members).
    INSERT INTO deal_team_members (deal_id, org_id, user_id, role_id, added_by) VALUES
      (v_deal, v_org_id, v_u_ae,   v_role_ae,   v_sales),
      (v_deal, v_org_id, v_u_pm,   v_role_pm,   v_sales),
      (v_deal, v_org_id, v_u_impl, v_role_impl, v_sales),
      (v_deal, v_org_id, v_u_proc, v_role_proc, v_sales);

    -- Handover
    v_ho_owner := CASE WHEN (proj->>'gate_cleared')::boolean THEN v_u_pm ELSE NULL END;
    INSERT INTO sales_handovers (org_id, deal_id, account_id, assigned_service_owner_id, status,
                                 go_live_date, contract_value, commercial_terms_summary, playbook_id,
                                 created_by, submitted_at, acknowledged_at,
                                 completed_at, completed_by, closure_summary)
    VALUES (
      v_org_id, v_deal, v_account, v_ho_owner, proj->>'ho_status',
      v_golive, (proj->>'value')::numeric,
      CASE WHEN (proj->>'gate_cleared')::boolean
           THEN 'Fixed-scope civil + surfacing contract. Payment 40/40/20 against milestones.'
           ELSE NULL END,
      v_hpb, v_sales,
      CASE WHEN (proj->>'gate_cleared')::boolean THEN v_close::timestamptz + interval '1 day' ELSE NULL END,
      CASE WHEN (proj->>'gate_cleared')::boolean THEN v_close::timestamptz + interval '2 day' ELSE NULL END,
      CASE WHEN proj->>'ho_status' = 'completed' THEN v_golive::timestamptz ELSE NULL END,
      CASE WHEN proj->>'ho_status' = 'completed' THEN v_u_pm ELSE NULL END,
      CASE WHEN proj->>'ho_status' = 'completed'
           THEN 'Delivered and accepted at walkthrough. All commitments met.' ELSE NULL END
    )
    RETURNING id INTO v_handover;

    -- Customer stakeholders — CUSTOMER-SIDE ONLY. The internal delivery team
    -- lives in deal_team_members; stakeholders are the customer's people.
    INSERT INTO sales_handover_stakeholders (handover_id, org_id, contact_id, name, handover_role, is_primary_contact)
    VALUES (v_handover, v_org_id, v_contact,
            (proj#>>'{contact,first}') || ' ' || (proj#>>'{contact,last}'), 'go_live_approver', TRUE);

    IF TRUE THEN
      -- Build the customer team: create the contacts on the account, add as stakeholders.
      -- Seeded for every project (the customer team is known from the sale).
      FOR com IN SELECT * FROM jsonb_array_elements('[
        {"first":"Priya","last":"Menon","role":"day_to_day_admin","title":"Operations Lead"},
        {"first":"Arjun","last":"Nair","role":"implementation_lead","title":"Project Lead"},
        {"first":"Kavya","last":"Rao","role":"technical_lead","title":"Technical Lead"}
      ]'::jsonb) LOOP
        INSERT INTO contacts (account_id, first_name, last_name, title, role_type, org_id, external_refs, user_id)
        VALUES (v_account, com->>'first', com->>'last', com->>'title', 'user', v_org_id,
                '{"demo_seed":"impl_showcase_v1"}'::jsonb, v_sales)
        RETURNING id INTO v_ct_contact;

        INSERT INTO sales_handover_stakeholders (handover_id, org_id, contact_id, name, handover_role)
        VALUES (v_handover, v_org_id, v_ct_contact,
                (com->>'first') || ' ' || (com->>'last'), com->>'role');
      END LOOP;
    END IF;

    -- Commitments / deliverables
    FOR com IN SELECT * FROM jsonb_array_elements(proj->'commitments') LOOP
      v_owner  := CASE WHEN com->>'owner' = 'impl' THEN v_u_impl ELSE v_u_ae END;
      v_status := com->>'status';
      v_due    := CURRENT_DATE + (com->>'due_in')::int;
      INSERT INTO sales_handover_commitments (handover_id, org_id, description, commitment_type,
                                              due_date, owner_user_id, status, created_by,
                                              closed_at, closed_by, closure_note)
      VALUES (
        v_handover, v_org_id, com->>'d', com->>'type', v_due, v_owner, v_status, v_sales,
        CASE WHEN v_status IN ('met','waived','breached')
             THEN v_due::timestamptz + ((length(com->>'d') % 4) || ' days')::interval
             ELSE NULL END,
        CASE WHEN v_status IN ('met','waived','breached') THEN v_u_impl ELSE NULL END,
        CASE WHEN v_status = 'met' THEN 'Completed and verified on site.' ELSE NULL END
      )
      RETURNING id INTO v_com_id;

      -- Activity log: what happened on this deliverable
      INSERT INTO sales_handover_commitment_events
        (commitment_id, org_id, event_type, detail, created_by, created_at)
      VALUES (v_com_id, v_org_id, 'created', 'Deliverable logged during handover.', v_sales, v_close::timestamptz);
      IF v_status IN ('met','waived','breached') THEN
        INSERT INTO sales_handover_commitment_events
          (commitment_id, org_id, event_type, detail, from_status, to_status, created_by, created_at)
        VALUES (v_com_id, v_org_id, 'status_change', NULL, 'open', 'in_progress', v_u_impl, v_close::timestamptz + interval '3 days');
        INSERT INTO sales_handover_commitment_events
          (commitment_id, org_id, event_type, detail, from_status, to_status, created_by, created_at)
        VALUES (v_com_id, v_org_id, 'closed',
                CASE WHEN v_status='met' THEN 'Completed and verified on site.' ELSE 'Closed ('||v_status||').' END,
                'in_progress', v_status, v_u_impl,
                v_due::timestamptz + ((length(com->>'d') % 4) || ' days')::interval);
      ELSIF v_status = 'in_progress' THEN
        INSERT INTO sales_handover_commitment_events
          (commitment_id, org_id, event_type, detail, from_status, to_status, created_by, created_at)
        VALUES (v_com_id, v_org_id, 'status_change', 'Work started on site.', 'open', 'in_progress', v_u_impl, v_close::timestamptz + interval '2 days');
      END IF;
    END LOOP;

    -- Handover play instances — instantiate the org's REAL handover playbook plays
    v_ord := 0;
    FOR play IN
      SELECT id, stage_key, title, description, channel, execution_type, is_gate,
             priority, due_offset_days, due_anchor, sort_order
      FROM playbook_plays
      WHERE playbook_id = v_hpb AND org_id = v_org_id AND COALESCE(is_active, TRUE)
      ORDER BY sort_order, id
    LOOP
      v_ord := v_ord + 1;
      IF (proj->>'gate_cleared')::boolean THEN
        v_status := 'completed';
      ELSIF v_ord = 1 THEN
        v_status := 'in_progress';
      ELSE
        v_status := 'not_started';
      END IF;
      v_completed := (v_status = 'completed');
      v_comp_at   := CASE WHEN v_completed THEN v_close::timestamptz + interval '1 day' ELSE NULL END;
      v_due := CASE WHEN play.due_anchor = 'go_live'
                    THEN v_golive + COALESCE(play.due_offset_days, 0)
                    ELSE v_close + COALESCE(play.due_offset_days, v_ord) END;

      INSERT INTO deal_play_instances (deal_id, org_id, play_id, playbook_id, stage_key, title, description,
                                       channel, priority, execution_type, is_gate, due_date,
                                       sort_order, status, due_anchor, completed_at, completed_by)
      VALUES (v_deal, v_org_id, play.id, v_hpb, play.stage_key, play.title, play.description,
              play.channel, COALESCE(play.priority,'high'), COALESCE(play.execution_type,'parallel'),
              COALESCE(play.is_gate, FALSE), v_due, COALESCE(play.sort_order, v_ord*10),
              v_status, COALESCE(play.due_anchor,'created'), v_comp_at,
              CASE WHEN v_completed THEN v_sales END)
      RETURNING id INTO v_pi;

      INSERT INTO sales_handover_plays (handover_id, play_instance_id, org_id, completed_at)
      VALUES (v_handover, v_pi, v_org_id, v_comp_at);
      IF v_completed THEN
        UPDATE deal_play_instances
           SET completion_note = 'Closed out and confirmed with the customer.',
               completion_evidence = jsonb_build_object(
                 'type', CASE WHEN v_ord % 2 = 0 THEN 'email' ELSE 'whatsapp' END,
                 'snippet', CASE WHEN v_ord % 2 = 0
                            THEN 'Customer confirmed sign-off on this item by email.'
                            ELSE 'Customer acknowledged completion on WhatsApp.' END)
         WHERE id = v_pi;
      END IF;
    END LOOP;

    -- DELIVERY play instances (from the delivery playbook)
    FOR dp IN SELECT * FROM jsonb_array_elements(c_delivery) LOOP
      v_ord := (dp->>'o')::int;
      IF NOT (proj->>'gate_cleared')::boolean THEN
        v_status := 'not_started';                          -- not transferred yet
      ELSIF v_ord <= (proj->>'deliv_done')::int THEN
        v_status := 'completed';
      ELSIF v_ord = (proj->>'deliv_done')::int + 1 THEN
        v_status := COALESCE(proj->>'next_state', 'not_started');
      ELSE
        v_status := 'not_started';
      END IF;
      v_completed := (v_status = 'completed');

      IF dp->>'anchor' = 'go_live' THEN
        v_due := v_golive + (dp->>'off')::int;
      ELSE
        v_due := v_close + (dp->>'off')::int;
      END IF;
      v_comp_at := CASE WHEN v_completed THEN (v_close + (dp->>'off')::int)::timestamptz ELSE NULL END;

      INSERT INTO deal_play_instances (deal_id, org_id, playbook_id, stage_key, title, description,
                                       channel, priority, execution_type, is_gate, due_date,
                                       sort_order, status, due_anchor, completed_at, completed_by)
      VALUES (v_deal, v_org_id, v_dpb, dp->>'s', dp->>'t', dp->>'t', 'internal_task',
              'medium', 'sequential', (dp->>'g')::boolean, v_due,
              100 + v_ord * 10, v_status, dp->>'anchor', v_comp_at, CASE WHEN v_completed THEN v_impl END)
      RETURNING id INTO v_pi;

      INSERT INTO sales_handover_plays (handover_id, play_instance_id, org_id, completed_at)
      VALUES (v_handover, v_pi, v_org_id, v_comp_at);
      IF v_completed THEN
        UPDATE deal_play_instances
           SET completion_note = 'Closed out and confirmed with the customer.',
               completion_evidence = jsonb_build_object(
                 'type', CASE WHEN v_ord % 2 = 0 THEN 'email' ELSE 'whatsapp' END,
                 'snippet', CASE WHEN v_ord % 2 = 0
                            THEN 'Customer confirmed sign-off on this item by email.'
                            ELSE 'Customer acknowledged completion on WhatsApp.' END)
         WHERE id = v_pi;
      END IF;
    END LOOP;

    -- Weather-escalation instance for rain-affected projects
    IF (proj->>'esc')::boolean THEN
      INSERT INTO deal_play_instances (deal_id, org_id, playbook_id, stage_key, title, description,
                                       channel, priority, execution_type, is_gate, due_date,
                                       sort_order, status, due_anchor)
      VALUES (v_deal, v_org_id, v_dpb, 'installation', 'Weather-delay escalation & customer notice',
              'Notify the customer of a weather delay and rebaseline the go-live date.',
              'whatsapp', 'high', 'parallel', FALSE, CURRENT_DATE + 1, 199, 'in_progress', 'created')
      RETURNING id INTO v_pi;
      INSERT INTO sales_handover_plays (handover_id, play_instance_id, org_id)
      VALUES (v_handover, v_pi, v_org_id);
    END IF;

    -- ─── WhatsApp delivery thread (simulated group) ────────────────────────
    INSERT INTO whatsapp_threads (org_id, kind, wa_group_id, group_subject, handover_id, deal_id,
                                  account_id, contact_id, opt_in_at, opt_in_source, status, created_by)
    VALUES (v_org_id, 'group', 'demo-impl-' || (proj->>'key'),
            (proj->>'account') || ' — Delivery', v_handover, v_deal, v_account, v_contact,
            v_close::timestamptz, 'handover_kickoff', 'active', v_sales)
    RETURNING id INTO v_thread;

    INSERT INTO whatsapp_thread_participants (thread_id, org_id, wa_phone, display_name, contact_id, side, joined_at)
    VALUES (v_thread, v_org_id, proj#>>'{contact,phone}',
            (proj#>>'{contact,first}') || ' ' || (proj#>>'{contact,last}'), v_contact, 'customer', v_close::timestamptz);
    INSERT INTO whatsapp_thread_participants (thread_id, org_id, wa_phone, display_name, user_id, side, joined_at)
    VALUES (v_thread, v_org_id, '919700000000', 'Delivery Team', v_impl, 'internal', v_close::timestamptz);

    FOR msg IN SELECT * FROM jsonb_array_elements(proj->'messages') LOOP
      IF msg->>'dir' = 'inbound' THEN
        INSERT INTO whatsapp_messages (org_id, thread_id, direction, message_type, body, status,
                                       from_phone, from_name, sent_at, delivered_at, read_at)
        VALUES (v_org_id, v_thread, 'inbound', 'text', msg->>'body', 'received',
                proj#>>'{contact,phone}', (proj#>>'{contact,first}') || ' ' || (proj#>>'{contact,last}'),
                now() - ((msg->>'ago_h')::int || ' hours')::interval,
                now() - ((msg->>'ago_h')::int || ' hours')::interval,
                now() - ((msg->>'ago_h')::int || ' hours')::interval);
      ELSE
        INSERT INTO whatsapp_messages (org_id, thread_id, direction, message_type, body, status,
                                       sent_by_user_id, is_automated, sent_at, delivered_at, read_at)
        VALUES (v_org_id, v_thread, 'outbound', 'text', msg->>'body', 'read',
                v_impl, (msg->>'auto')::boolean,
                now() - ((msg->>'ago_h')::int || ' hours')::interval,
                now() - ((msg->>'ago_h')::int || ' hours')::interval + interval '3 seconds',
                now() - ((msg->>'ago_h')::int || ' hours')::interval + interval '2 minutes');
      END IF;
    END LOOP;

    -- Email as the working comms proxy: the same conversation, as real emails on the deal.
    FOR msg IN SELECT * FROM jsonb_array_elements(proj->'messages') LOOP
      IF msg->>'dir' = 'inbound' THEN
        INSERT INTO emails (org_id, deal_id, contact_id, direction, subject, body,
                            from_address, to_address, sent_at, created_at, conversation_id, provider)
        VALUES (v_org_id, v_deal, v_contact, 'received',
                'Re: ' || (proj->>'account') || ' — delivery update', msg->>'body',
                lower(proj#>>'{contact,first}') || '.' || lower(proj#>>'{contact,last}') || '@' || (proj->>'domain'),
                'delivery@impl-test.local',
                now() - ((msg->>'ago_h')::int || ' hours')::interval,
                now() - ((msg->>'ago_h')::int || ' hours')::interval,
                'deliv-' || (proj->>'key'), 'outlook');
      ELSE
        INSERT INTO emails (org_id, user_id, deal_id, contact_id, direction, subject, body,
                            from_address, to_address, sent_at, opened_at, created_at, conversation_id, provider)
        VALUES (v_org_id, v_impl, v_deal, v_contact, 'sent',
                (proj->>'account') || ' — delivery update', msg->>'body',
                'delivery@impl-test.local',
                lower(proj#>>'{contact,first}') || '.' || lower(proj#>>'{contact,last}') || '@' || (proj->>'domain'),
                now() - ((msg->>'ago_h')::int || ' hours')::interval,
                now() - ((msg->>'ago_h')::int || ' hours')::interval + interval '2 hours',
                now() - ((msg->>'ago_h')::int || ' hours')::interval,
                'deliv-' || (proj->>'key'), 'outlook');
      END IF;
    END LOOP;

  END LOOP;

  RAISE NOTICE 'Implementation showcase seed complete.';
END $$;

COMMIT;

-- ─── Verification: the resulting portfolio, one row per project ─────────────
SELECT
  a.name                                   AS customer,
  d.name                                   AS project,
  h.status                                 AS handover_status,
  r.go_live_date,
  r.days_to_go_live,
  r.plays_done || '/' || r.plays_total     AS plays,
  r.plays_overdue                          AS overdue,
  r.gates_open,
  r.commitments_closed || '/' || r.commitments_total AS commitments,
  r.commitments_breached                   AS breached,
  r.is_closeable
FROM sales_handovers h
JOIN deals    d ON d.id = h.deal_id
JOIN accounts a ON a.id = h.account_id
JOIN handover_deliverable_rollup r ON r.handover_id = h.id
WHERE d.external_crm_type = 'demo_seed'
ORDER BY d.close_date;
