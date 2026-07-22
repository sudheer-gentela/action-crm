-- ============================================================================
-- 2026_63_skill_bundles.sql
--
-- Phase 2 — Skills as versioned, packageable artifacts.
--
-- skill_bundles      — immutable-once-published content units. A bundle is
--                      the full file set of one skill at one semver:
--                      files jsonb = { "SKILL.md": ..., "templates/x.md": ...,
--                      "methodologies/meddic.md": ... }. scope:
--                        'platform'          — visible to every org (the
--                                              productized default)
--                        'org'               — private to owner_org_id (an
--                                              org's customized methodology)
--                      A 'partner' scope value is DEFERRED to Phase 4 — one
--                      enum value + one resolution branch when partners exist.
--
-- org_skill_installs — explicit version pins. (org_id, skill_name) →
--                      bundle_id. Resolution order at runtime:
--                        1. org pin (this table)
--                        2. newest published PLATFORM bundle for the skill
--                        3. disk (backend/skills/<name>/ — untouched fallback,
--                           so day one nothing changes for any org)
--
-- skill_runs         — gains bundle attribution: every run records exactly
--                      which methodology version produced it. This is the
--                      foundation of "methodology X vs Y" attribution later.
--
-- SKILL_REGISTRY (code) remains authoritative for EXECUTION metadata
-- (callType, maxTokens, entity). Bundles carry CONTENT. A bundle for a skill
-- name not in the registry can be stored but not run — publish/install warn.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.skill_bundles (
    id            SERIAL PRIMARY KEY,
    scope         VARCHAR(20) NOT NULL,
    owner_org_id  INTEGER REFERENCES public.organizations(id),
    name          VARCHAR(100) NOT NULL,
    version       VARCHAR(20)  NOT NULL,          -- strict semver X.Y.Z
    manifest      JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- manifest shape:
    -- { description?, entity?, methodologies?: [..],
    --   requires?: { playbook_stages?: ["demo", ...] },
    --   published_from?: 'disk' | 'import', imported_checksum? }
    files         JSONB NOT NULL,                 -- path → content (text)
    checksum      VARCHAR(64) NOT NULL,           -- sha256 over name+version+files
    status        VARCHAR(20) NOT NULL DEFAULT 'published',
    published_by  INTEGER,
    published_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT skill_bundles_scope_check
        CHECK (scope IN ('platform', 'org')),
    CONSTRAINT skill_bundles_status_check
        CHECK (status IN ('published', 'archived')),
    CONSTRAINT skill_bundles_owner_check
        CHECK ((scope = 'platform' AND owner_org_id IS NULL)
            OR (scope = 'org'      AND owner_org_id IS NOT NULL)),
    CONSTRAINT skill_bundles_version_check
        CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
    CONSTRAINT skill_bundles_name_check
        CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,80}$')
);

COMMENT ON TABLE public.skill_bundles IS
  'Versioned skill content units (Phase 2). Published bundles are treated as '
  'immutable by the service layer (new version = new row; archive, never '
  'edit). Resolution: org pin -> newest platform bundle -> disk. '
  'Introduced 2026_63.';

-- One (name, version) per scope-owner:
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_bundles_platform
    ON public.skill_bundles (name, version)
    WHERE scope = 'platform';
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_bundles_org
    ON public.skill_bundles (owner_org_id, name, version)
    WHERE scope = 'org';

CREATE INDEX IF NOT EXISTS idx_skill_bundles_name
    ON public.skill_bundles (name, status, published_at DESC);

-- RLS: platform bundles are readable by every org; org bundles only by owner.
ALTER TABLE public.skill_bundles ENABLE ROW LEVEL SECURITY;
CREATE POLICY skill_bundles_visibility ON public.skill_bundles
    USING (
      owner_org_id IS NULL
      OR owner_org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::integer
    );

-- ── org_skill_installs ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.org_skill_installs (
    id            SERIAL PRIMARY KEY,
    org_id        INTEGER NOT NULL REFERENCES public.organizations(id),
    skill_name    VARCHAR(100) NOT NULL,
    bundle_id     INTEGER NOT NULL REFERENCES public.skill_bundles(id),
    installed_by  INTEGER,
    installed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_org_skill_installs UNIQUE (org_id, skill_name)
);

COMMENT ON TABLE public.org_skill_installs IS
  'Explicit skill-version pins per org. Absence of a row = follow the newest '
  'platform bundle (or disk). Delete the row to unpin. Introduced 2026_63.';

CREATE INDEX IF NOT EXISTS idx_org_skill_installs_org
    ON public.org_skill_installs (org_id);

ALTER TABLE public.org_skill_installs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_skill_installs_org_isolation ON public.org_skill_installs
    USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::integer);

-- ── skill_runs attribution ───────────────────────────────────────────────────

ALTER TABLE public.skill_runs
    ADD COLUMN IF NOT EXISTS bundle_id      INTEGER REFERENCES public.skill_bundles(id),
    ADD COLUMN IF NOT EXISTS bundle_version VARCHAR(20),
    ADD COLUMN IF NOT EXISTS bundle_source  VARCHAR(20);
-- bundle_source: 'org' | 'platform' | 'disk'. NULL on pre-2026_63 rows and on
-- fit-gate 'skipped' rows (no bundle was loaded).

CREATE INDEX IF NOT EXISTS idx_skill_runs_bundle
    ON public.skill_runs (bundle_id)
    WHERE bundle_id IS NOT NULL;

COMMIT;
