-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_54_client_escalation_overrides.sql
--
-- Agency module Phase 5 — client-aware escalations (per-client SLA overrides).
--
-- clients.escalation_overrides: an OPTIONAL, nullable JSONB holding a PARTIAL
-- escalation policy for a single client. It overrides the org-level policy in
-- org_action_config.prospecting_escalation (which itself merges over
-- ProspectingEscalationService.SYSTEM_DEFAULTS). The precedence, resolved in
-- application code, is:
--
--     client.escalation_overrides   (this column, per-client)
--        ▶ org_action_config.prospecting_escalation   (per-org)
--           ▶ SYSTEM_DEFAULTS   (code)
--
-- Scope of the override, DELIBERATELY narrow (see
-- ProspectingEscalationService.CLIENT_OVERRIDE_KEYS): only the escalation-tier
-- thresholds — tier1_hours / tier2_hours / tier3_hours. Everything else
-- (master enable, immediate-alert timing, digest hour, channels) stays
-- org-level: a client is not a place to reconfigure the whole subsystem, only
-- to tighten/loosen how fast its overdue actions climb the tier ladder. A
-- client may set any subset of the three; the MERGED (effective) tiers are
-- validated to stay strictly increasing, exactly like the org policy.
--
-- Storage shape (all keys optional):
--   { "tier1_hours": 12, "tier2_hours": 24, "tier3_hours": 48 }
--   NULL  = no override, this client uses the org policy verbatim (default).
--   '{}'  = also treated as "no override" by the merge (empty object).
--
-- Where it is READ:
--   • notificationService.findProspectingActionsForEscalation — the escalation
--     scan now computes each row's effective tier hours per-CLIENT via
--     COALESCE((cl.escalation_overrides->>'tierN_hours')::int, <org tierN>).
--     A prospect with no client (client_id NULL) LEFT-JOINs to no client row,
--     so every COALESCE falls through to the org value → BYTE-IDENTICAL to the
--     pre-Phase-5 behaviour for non-agency orgs and client-less prospects.
--   • routes/clients.routes.js GET/PUT /clients/:id/escalation-overrides.
--
-- One column, one migration, NO new table (per the Phase 5 handoff). ADD COLUMN
-- with no default is metadata-only (no table rewrite). Idempotent: IF NOT
-- EXISTS on the column; COMMENT ON is naturally re-runnable. Safe to re-run.
--
-- After deploying: re-dump schema.sql (pg_dump artifact — never hand-edit).
-- NOTE at authoring time schema.sql was already STALE — it predates
-- prospecting_campaigns.client_id (2026_52) and clients.require_client_sender
-- (2026_53). This migration does not fix that; a fresh pg_dump after applying
-- 2026_52..2026_54 will bring it current.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS escalation_overrides jsonb;

COMMENT ON COLUMN clients.escalation_overrides IS
  'Agency Phase 5 (2026_54): OPTIONAL partial escalation policy for this client. '
  'Overrides org_action_config.prospecting_escalation, which overrides '
  'ProspectingEscalationService.SYSTEM_DEFAULTS. Only the tier thresholds are '
  'overridable (tier1_hours/tier2_hours/tier3_hours); the merged tiers must stay '
  'strictly increasing. NULL or {} = no override (use org policy). Read by the '
  'escalation scan via COALESCE(escalation_overrides->>''tierN_hours'', org tierN) '
  'so client-less prospects are unaffected. See 2026_54_client_escalation_overrides.sql.';

COMMIT;

-- ── Verification (run manually after applying) ───────────────────────────────
--   \d clients                                   -- escalation_overrides present, nullable, no default
--   SELECT count(*) FROM clients WHERE escalation_overrides IS NOT NULL;  -- 0 right after
--
--   -- Dry-run an override and confirm the merge shape the app expects:
--   --   UPDATE clients SET escalation_overrides = '{"tier1_hours":12,"tier2_hours":24,"tier3_hours":48}'::jsonb
--   --    WHERE id = <cid> AND org_id = <org>;
--   --   SELECT id, escalation_overrides FROM clients WHERE id = <cid>;
--   -- The escalation scan will then use 12/24/48 for that client's prospects,
--   -- and the org policy tiers for everyone else, in the SAME query.
--
-- Rollback (manual, if ever needed):
--   ALTER TABLE clients DROP COLUMN IF EXISTS escalation_overrides;
--   (Dropping the column reverts every client to the org policy. No other
--    object depends on it.)
