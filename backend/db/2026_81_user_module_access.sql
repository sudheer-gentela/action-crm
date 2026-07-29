-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_81_user_module_access.sql
--
-- Per-user module access. Effective access to a module now requires BOTH:
--   • the org has it (settings.modules[key] allowed && enabled), AND
--   • the user has an explicit grant here.
--
-- No code bypass for admins — the gate is uniform. Admins/owners are simply
-- GRANTED every org-enabled module (backfill below + a sync on module-enable).
--
-- BACKFILL (Option 1): grant every active org_user access to all modules their
-- org currently has enabled, so existing behaviour is preserved exactly. Only
-- newly-provisioned users start scoped.
--
-- NUMBERING: 80 = project_members. This is 81.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

CREATE TABLE IF NOT EXISTS user_module_access (
  id         serial PRIMARY KEY,
  org_id     integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_key text    NOT NULL,
  granted_by integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, module_key)
);
CREATE INDEX IF NOT EXISTS idx_user_module_access ON user_module_access (org_id, user_id);

-- Backfill: for every active org_user, grant each module their org has enabled.
-- Handles both the new object shape {allowed,enabled} and the legacy scalar bool.
INSERT INTO user_module_access (org_id, user_id, module_key)
SELECT ou.org_id, ou.user_id, m.key
FROM org_users ou
JOIN organizations o ON o.id = ou.org_id
CROSS JOIN LATERAL jsonb_each(COALESCE(o.settings->'modules', '{}'::jsonb)) AS m(key, val)
WHERE ou.is_active = TRUE
  AND (
        (jsonb_typeof(m.val) = 'object'  AND COALESCE((m.val->>'allowed')::boolean, false)
                                         AND COALESCE((m.val->>'enabled')::boolean, false))
     OR (jsonb_typeof(m.val) = 'boolean' AND m.val::text::boolean = true)
      )
ON CONFLICT (org_id, user_id, module_key) DO NOTHING;

COMMIT;
