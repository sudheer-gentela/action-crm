-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_58_sales_resolver_policy.sql
--
-- Background Sales-Navigator URL resolver — persistence for (a) the governed
-- policy and (b) the full resolve handle on each prospect.
--
-- CONTEXT. Prospects bulk-added from a Sales-Nav list carry a sales_profile_id
-- (2026_57) but no public /in/ URL. The active resolver drains that backlog by
-- issuing its OWN salesApiProfiles fetch (from the rep's open Sales-Nav tab) to
-- obtain flagshipProfileUrl, then writes it via the existing UPDATE-ONLY
-- /prospects/resolve-sales-url. This migration stores what that fetch needs and
-- the org policy that governs it. It adds NO new behaviour on its own — the
-- resolver is opt-in (org enabled defaults FALSE) and lives in the extension.
--
-- (1) THE FULL RESOLVE TRIPLE + CAPTURING IDENTITY on prospects.
--   The salesApiProfiles call is keyed by the fs_salesProfile triple
--   (profileId, authType, authToken). 2026_57 stored only profileId (the stable
--   dedup key). The resolver additionally needs authType + authToken to build
--   the request URL. Validated durable across logout/login on the SAME account
--   (profileId ACwAAABf…, NAME_SEARCH, lORL unchanged post-relogin), so a stored
--   queue is safe to drain over days.
--   We ALSO tag each row with the LinkedIn identity that captured it
--   (sales_captured_identity, from salesApiPrimaryIdentity). A token minted under
--   account A's session may 403 if replayed under account B (different session
--   cookie) even when the string matches — so the resolver only works items whose
--   capturing identity equals the account currently logged in, and requeues on a
--   mismatch/403. Durability handles the common case; the tag handles the
--   two-logins-under-one-GoWarm-user case.
--   All nullable/additive: /in/, manual, and email prospects never set them.
--
-- (2) ORG POLICY as a JSONB column on org_action_config (house pattern, cf.
--   linkedin_automation / network_jobchange). The org value is the HARD CEILING;
--   per-user prefs (stored in user_preferences.preferences->'sales_resolver')
--   may only make it MORE conservative. Effective policy = element-wise min()
--   computed in services/salesResolverPolicy.js. Shape (all keys optional; the
--   policy module supplies defaults):
--     {
--       "enabled": false,               -- opt-in; master off switch (ceiling)
--       "max_per_user_per_day": 100,    -- per-user daily cap ceiling
--       "min_gap_seconds": 45,          -- floor on the gap between resolves
--       "quiet_hours": {"start":"22:00","end":"07:00"},  -- local; paused inside
--       "require_presence": true        -- only resolve when the rep is active
--     }
--   DEFAULT '{}' → the policy module treats an empty object as "use built-in
--   defaults", and enabled defaults FALSE, so the resolver is inert until an
--   admin explicitly turns it on.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; constant/empty defaults are metadata-only
-- on PG11+ (no table rewrite). Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- (1) resolve triple + capturing identity ------------------------------------
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS sales_auth_type          text,
  ADD COLUMN IF NOT EXISTS sales_auth_token         text,
  ADD COLUMN IF NOT EXISTS sales_captured_identity  text;

COMMENT ON COLUMN prospects.sales_auth_type IS
  'Sales-Nav fs_salesProfile authType (e.g. NAME_SEARCH), 2nd element of the '
  'resolve triple. With sales_profile_id + sales_auth_token, lets the background '
  'resolver rebuild the salesApiProfiles request URL. Nullable/additive.';
COMMENT ON COLUMN prospects.sales_auth_token IS
  'Sales-Nav fs_salesProfile authToken (e.g. lORL), 3rd element of the triple. '
  'Validated durable across same-account logout/login. Nullable/additive.';
COMMENT ON COLUMN prospects.sales_captured_identity IS
  'The LinkedIn identity (from salesApiPrimaryIdentity) whose session captured '
  'this row. The resolver only replays the triple under the SAME logged-in '
  'account; a mismatch is skipped (avoids cross-session 403). Nullable/additive.';

-- (2) org policy (hard ceiling) ----------------------------------------------
ALTER TABLE org_action_config
  ADD COLUMN IF NOT EXISTS sales_resolver jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN org_action_config.sales_resolver IS
  'Background Sales-Nav URL resolver ORG policy (hard ceiling). Keys (all '
  'optional; services/salesResolverPolicy.js supplies defaults): enabled '
  '(default false, opt-in), max_per_user_per_day (default 100), min_gap_seconds '
  '(default 45), quiet_hours {start,end} local (default 22:00–07:00), '
  'require_presence (default true). Per-user prefs in '
  'user_preferences.preferences->''sales_resolver'' may only tighten these; '
  'effective policy = element-wise min(user, org).';

COMMIT;

-- ── Verification (run manually after applying) ───────────────────────────────
--   \d prospects            -- sales_auth_type / sales_auth_token / sales_captured_identity present
--   \d org_action_config    -- sales_resolver jsonb, default {}
--   SELECT count(*) FROM prospects
--     WHERE sales_profile_id IS NOT NULL AND linkedin_url IS NULL;   -- backlog size
--
-- Rollback (manual, if ever needed):
--   ALTER TABLE prospects DROP COLUMN IF EXISTS sales_auth_type,
--     DROP COLUMN IF EXISTS sales_auth_token, DROP COLUMN IF EXISTS sales_captured_identity;
--   ALTER TABLE org_action_config DROP COLUMN IF EXISTS sales_resolver;
