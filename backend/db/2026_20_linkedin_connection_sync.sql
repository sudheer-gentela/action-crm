-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_20_linkedin_connection_sync.sql
--
-- LinkedIn connection-acceptance sync (extension "Check & update" buttons).
--
-- 1. user_linkedin_seats — binds a LinkedIn member (publicIdentifier slug,
--    read from /voyager/api/me by the extension scrape) to a GoWarmCRM user.
--    One LinkedIn seat can belong to exactly ONE user per org (unique index
--    on org + lower(slug)). A user MAY have multiple seats (e.g. personal +
--    company page admin account) — the PK-ish uniqueness is org+slug, not
--    org+user.
--
--    Binding happens lazily: the first time a user runs a connection sync
--    while logged into that LinkedIn account, the seat row is created. If a
--    different user later syncs from the same LinkedIn account, the API
--    returns 409 SEAT_CONFLICT and writes nothing. Unbinding is a manual
--    DELETE for now (no UI yet).
--
-- 2. idx_prospects_linkedin_slug — expression index matching the slug
--    extraction used by /api/prospects/by-linkedin-url and the new
--    /api/linkedin-connections/reconcile bulk matcher. Without it, every
--    reconcile is a seq scan over the org's prospects.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS user_linkedin_seats (
    id                bigserial PRIMARY KEY,
    org_id            integer     NOT NULL,
    user_id           integer     NOT NULL,
    public_identifier text        NOT NULL,   -- LinkedIn slug, stored as scraped (display); matching is case-insensitive
    display_name      text,                   -- viewer name at last sync, display only
    member_urn        text,                   -- urn:li:fs_miniProfile:… when available (slug-change resilience, future)
    first_seen_at     timestamptz NOT NULL DEFAULT now(),
    last_seen_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  user_linkedin_seats IS
    'Binds a LinkedIn member (publicIdentifier) to a GoWarm user. Created lazily on first extension connection-sync. One seat per org may bind to only one user.';
COMMENT ON COLUMN user_linkedin_seats.public_identifier IS
    'LinkedIn /in/<slug>. Uniqueness and matching are on lower(public_identifier) per org.';

-- One LinkedIn account → one GoWarm user per org.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_linkedin_seats_org_slug
    ON user_linkedin_seats (org_id, lower(public_identifier));

CREATE INDEX IF NOT EXISTS idx_user_linkedin_seats_user
    ON user_linkedin_seats (org_id, user_id);

-- Slug expression index for prospect matching. Mirrors EXACTLY the
-- expression used in routes (keep in lockstep — a different expression
-- will not use this index):
--   lower(substring(linkedin_url from '/in/([^/?#]+)'))
CREATE INDEX IF NOT EXISTS idx_prospects_linkedin_slug
    ON prospects (org_id, lower(substring(linkedin_url from '/in/([^/?#]+)')))
    WHERE linkedin_url IS NOT NULL AND deleted_at IS NULL;

COMMIT;
