-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_33_network_connections.sql
--
-- P0 substrate for network job-change detection (see Design & Execution Tracker,
-- §C / §G-P0). Four additive tables, no behavior — detection only. Nothing here
-- generates plays or touches prospects; that is P1+.
--
--   1. linkedin_connections      — the rep's FULL 1st-degree network roster
--                                  (D1), one row per (owner)×(person). Separate
--                                  from prospects (D7) so the funnel stays clean;
--                                  a qualifying move later PROMOTES a row into a
--                                  prospect (P1, prospect_id backfilled then).
--
--   2. connection_snapshots      — one header row per import (a parsed export or
--                                  extension harvest). Carries completeness +
--                                  the prior snapshot it will be diffed against.
--
--   3. connection_snapshot_rows  — raw six-field CSV rows as-received, retained
--                                  for audit + re-diff. Resolved to a connection.
--
--   4. connection_job_events     — the move log (the product payload). One row
--                                  per detected change. Classification flags +
--                                  play linkage are written by P1+; P0 leaves
--                                  them null.
--
-- IDENTITY KEY (§E, D8): linkedin_connections.identity_key is APP-COMPUTED at
-- insert, in priority order:
--     'urn:'  || member_urn                      (stable; preferred)
--     'slug:' || lower(slug from linkedin_url)    (mutable but good)
--     'nd:'   || lower(full_name) || '|' || connected_on   (CSV bridge; immutable
--                                                  Connected-On survives a company
--                                                  change so a move re-links as a
--                                                  move, not delete+add)
-- It is the single uniqueness guarantee per (org_id, owner_id). When a URN is
-- later backfilled (P2) the key is "upgraded" via a controlled merge that dedups
-- — NOT a blind UPDATE — so two rows for the same person collapse to one. P0 only
-- sets the best key available at first sight.
--
-- MULTI-TENANCY: every table carries org_id and every app INSERT must include it
-- (mirror of the prospecting_activities discipline in LinkedInConnectionSyncService).
--
-- FKs: deliberately NOT enforced at the DB level for prospect_id / seat_id /
-- prior_snapshot_id, matching the existing loose-coupling style (prospects
-- references account_id/contact_id/deal_id as plain integers). App logic owns
-- referential integrity; this avoids cross-tenant FK headaches and soft-delete
-- cascade surprises.
--
-- All statements are additive + idempotent (IF NOT EXISTS). New tables are
-- empty, so in-transaction index creation takes no meaningful lock — no need for
-- CONCURRENTLY here (unlike 2026_29 on the large prospects table).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Roster: the full 1st-degree network ───────────────────────────────────
CREATE TABLE IF NOT EXISTS linkedin_connections (
    id                        bigserial   PRIMARY KEY,
    org_id                    integer     NOT NULL,
    owner_id                  integer     NOT NULL,   -- the rep whose network this is

    -- Identity (resolution order URN → slug → name+connected_on; see header)
    identity_key              text        NOT NULL,   -- app-computed; uniqueness anchor
    member_urn                text,                   -- urn:li:fsd_profile:… when known (backfilled P2)
    linkedin_url              text,                   -- /in/<slug> when known; NULL for CSV-only rows

    -- Person (latest known state from the most recent snapshot)
    full_name                 text        NOT NULL,
    first_name                text,
    last_name                 text,
    company_name              text,
    company_domain            text,                   -- derived/enriched; NULL when unknown (no guessing)
    title                     text,
    connected_on              date,                   -- immutable; from CSV "Connected On"

    -- Lifecycle
    status                    text        NOT NULL DEFAULT 'active',
    first_seen_at             timestamptz NOT NULL DEFAULT now(),
    last_seen_in_snapshot_at  timestamptz,
    missing_since             timestamptz,            -- set when absent from a snapshot; cleared if it returns

    -- Promotion (P1+: set when a qualifying move creates a prospect)
    prospect_id               integer,

    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chk_linkedin_connections_status
        CHECK (status IN ('active', 'pending_disconnect', 'disconnected'))
);

COMMENT ON TABLE  linkedin_connections IS
    'Full 1st-degree LinkedIn network roster per (org, owner). Separate from prospects; promote-on-signal. identity_key (app-computed, URN→slug→name+connected_on) is the per-(org,owner) uniqueness anchor.';
COMMENT ON COLUMN linkedin_connections.identity_key IS
    'App-computed identity: urn:<urn> | slug:<lowerslug> | nd:<lowername>|<connected_on>. Single uniqueness guarantee per (org_id, owner_id). Upgraded URN-first via controlled merge in P2, never a blind UPDATE.';
COMMENT ON COLUMN linkedin_connections.connected_on IS
    'LinkedIn "Connected On" date. Immutable across exports — survives a company change, so it anchors move detection in the CSV bridge key.';
COMMENT ON COLUMN linkedin_connections.prospect_id IS
    'Set (P1+) when a qualifying job-change promotes this connection into a prospect. NULL means network-only.';

-- One person per (org, owner). identity_key is the resolution-order result.
CREATE UNIQUE INDEX IF NOT EXISTS uq_linkedin_connections_identity
    ON linkedin_connections (org_id, owner_id, identity_key);

-- Roster listing / "my network".
CREATE INDEX IF NOT EXISTS idx_linkedin_connections_owner
    ON linkedin_connections (org_id, owner_id);

-- URN lookup for P2 backfill + cross-source resolution.
CREATE INDEX IF NOT EXISTS idx_linkedin_connections_member_urn
    ON linkedin_connections (org_id, member_urn)
    WHERE member_urn IS NOT NULL;

-- Slug match against prospects.linkedin_url — SAME expression as
-- LinkedInConnectionSyncService / 2026_20 (keep in lockstep or it won't be used).
CREATE INDEX IF NOT EXISTS idx_linkedin_connections_slug
    ON linkedin_connections (org_id, lower(substring(linkedin_url from '/in/([^/?#]+)')))
    WHERE linkedin_url IS NOT NULL;

-- Company-domain match for account classification (P1 churn / P2 target).
CREATE INDEX IF NOT EXISTS idx_linkedin_connections_company_domain
    ON linkedin_connections (org_id, lower(company_domain))
    WHERE company_domain IS NOT NULL;


-- ── 2. Snapshot headers: one per import ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS connection_snapshots (
    id                 bigserial   PRIMARY KEY,
    org_id             integer     NOT NULL,
    owner_id           integer     NOT NULL,
    seat_id            bigint,                     -- user_linkedin_seats.id (loose ref)
    source             text        NOT NULL,
    imported_at        timestamptz NOT NULL DEFAULT now(),
    row_count          integer,
    parse_warnings     jsonb       NOT NULL DEFAULT '[]'::jsonb,
    is_complete        boolean     NOT NULL DEFAULT true,   -- false when row_count drops anomalously (§E)
    prior_snapshot_id  bigint,                     -- the snapshot this one was diffed against

    CONSTRAINT chk_connection_snapshots_source
        CHECK (source IN ('csv_export', 'extension_harvest', 'on_demand'))
);

COMMENT ON TABLE  connection_snapshots IS
    'One header per network import. is_complete=false suppresses disconnect firing (large-network export gaps, §E). prior_snapshot_id is what the diff ran against.';
COMMENT ON COLUMN connection_snapshots.is_complete IS
    'Set false when row_count drops anomalously below the running max for this seat. Disconnect events are suppressed on incomplete snapshots.';

-- Latest snapshot per owner (diff picks the prior one).
CREATE INDEX IF NOT EXISTS idx_connection_snapshots_owner_time
    ON connection_snapshots (org_id, owner_id, imported_at DESC);


-- ── 3. Raw rows: as-received, for audit + re-diff ─────────────────────────────
CREATE TABLE IF NOT EXISTS connection_snapshot_rows (
    id               bigserial PRIMARY KEY,
    org_id           integer   NOT NULL,           -- carried for tenant-scoped scans (discipline mirror)
    snapshot_id      bigint    NOT NULL,
    connection_id    bigint,                        -- resolved linkedin_connections.id (NULL until resolved)

    -- The six LinkedIn export fields, stored exactly as parsed
    raw_first_name   text,
    raw_last_name    text,
    raw_email        text,
    raw_company      text,
    raw_position     text,
    raw_connected_on text,

    resolved         boolean   NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE connection_snapshot_rows IS
    'Raw six-field export rows as parsed, retained for audit and re-diff. Resolved to a linkedin_connections row; unresolved rows are candidate new connections.';

CREATE INDEX IF NOT EXISTS idx_connection_snapshot_rows_snapshot
    ON connection_snapshot_rows (snapshot_id);

CREATE INDEX IF NOT EXISTS idx_connection_snapshot_rows_connection
    ON connection_snapshot_rows (org_id, connection_id)
    WHERE connection_id IS NOT NULL;


-- ── 4. Job-change events: the move log ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS connection_job_events (
    id                       bigserial   PRIMARY KEY,
    org_id                   integer     NOT NULL,
    owner_id                 integer     NOT NULL,
    connection_id            bigint      NOT NULL,

    event_type               text        NOT NULL,
    from_company             text,
    from_title               text,
    to_company               text,
    to_title                 text,

    detected_at              timestamptz NOT NULL DEFAULT now(),  -- detection time, NOT actual move date (§E)
    detection_source         text        NOT NULL DEFAULT 'csv_diff',
    dedup_key                text,                   -- connection_id|to_company|normalized_to_title
    confidence               text        NOT NULL DEFAULT 'medium',

    -- Classification (written by P1+ routing; NULL in P0)
    is_into_target_account   boolean,
    is_from_customer_account boolean,
    is_into_icp_role         boolean,

    -- Outcome linkage (written by P1+; NULL in P0)
    play_id                  integer,
    promoted_prospect_id     integer,

    created_at               timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chk_connection_job_events_type
        CHECK (event_type IN ('role_change', 'company_change', 'disconnect_confirmed', 'new_connection')),
    CONSTRAINT chk_connection_job_events_source
        CHECK (detection_source IN ('csv_diff', 'experience_diff', 'catchup')),
    CONSTRAINT chk_connection_job_events_confidence
        CHECK (confidence IN ('low', 'medium', 'high'))
);

COMMENT ON TABLE  connection_job_events IS
    'Detected job-change log. event_type fires immediately for changes; disconnect_confirmed only after the two-cycle gate (D9). Classification flags + play/prospect linkage are P1+.';
COMMENT ON COLUMN connection_job_events.detected_at IS
    'When GoWarm detected the change (diff time), NOT when the person actually moved — the export only shows current role.';
COMMENT ON COLUMN connection_job_events.dedup_key IS
    'connection_id|to_company|normalized_to_title. One move = one event across detection sources (csv_diff/experience_diff/catchup).';

-- One move = one event (cross-source dedup, §E). Partial: events without a
-- dedup_key (e.g. disconnects) are not constrained here.
CREATE UNIQUE INDEX IF NOT EXISTS uq_connection_job_events_dedup
    ON connection_job_events (org_id, dedup_key)
    WHERE dedup_key IS NOT NULL;

-- Per-owner feed, newest first.
CREATE INDEX IF NOT EXISTS idx_connection_job_events_owner_time
    ON connection_job_events (org_id, owner_id, detected_at DESC);

-- Events for a given connection.
CREATE INDEX IF NOT EXISTS idx_connection_job_events_connection
    ON connection_job_events (org_id, connection_id);

COMMIT;
