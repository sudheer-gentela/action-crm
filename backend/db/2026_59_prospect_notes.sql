-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_59_prospect_notes.sql
--
-- Prospect notes — APPEND-ONLY, attributed, timestamped notes log on a
-- prospect ("why we want to work with them"). Surfaced in the Chrome-extension
-- side panel as one read-only chronological log with a separate composer that
-- appends new entries.
--
-- DESIGN.
--   • Append-only by construction: each entry is its own row with its own
--     author + created_at, and rows are IMMUTABLE once written. The API
--     exposes GET + POST only — no update, no delete. "Editing" the notes
--     means appending a new entry; nothing already recorded can be changed
--     or overwritten. This makes the log a trustworthy record of who said
--     what, when — no edited_at/edited_by machinery needed because edits
--     don't exist.
--   • Belt-and-braces: a trigger REJECTS any UPDATE to a note row at the
--     database level, so even a future code path (or a manual psql session
--     on autopilot) can't silently rewrite history. DELETE is left possible
--     via SQL only (GDPR/cleanup escape hatch) but has no API surface.
--   • Authorization (enforced in routes): any org member who can view the
--     prospect may read + append. Reads honour restrict_prospect_view_to_scope
--     exactly like GET /prospects/:id.
--   • Agency module: notes key on (org_id, prospect_id) and follow the
--     prospect regardless of client_id; the client portal never queries this
--     table, so notes are internal-only by construction.
--   • org_id denormalized onto every row (house pattern, cf.
--     linkedin_message_events); no FK constraints, app layer verifies the
--     prospect belongs to the org before every write.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS; CREATE OR REPLACE + DROP
-- TRIGGER IF EXISTS on the trigger pair. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS prospect_notes (
    id          bigserial   PRIMARY KEY,
    org_id      integer     NOT NULL,
    prospect_id integer     NOT NULL,
    user_id     integer     NOT NULL,   -- author (req.userId at insert)
    body        text        NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
    created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE prospect_notes IS
  'Append-only attributed notes log per prospect (extension side panel). '
  'Entries are immutable once written — API is GET+POST only, and '
  'trg_prospect_notes_immutable rejects UPDATEs at the DB level. Anyone in '
  'the org who can view the prospect may read/append.';
COMMENT ON COLUMN prospect_notes.user_id IS
  'Author — the user who wrote the entry. Immutable, like the rest of the row.';

-- Panel load path: latest-N for one prospect (client reverses for display).
CREATE INDEX IF NOT EXISTS idx_prospect_notes_prospect
    ON prospect_notes (org_id, prospect_id, created_at DESC);

-- ── Immutability guard ───────────────────────────────────────────────────────
-- History must stay history: block ALL updates to note rows. Raised as an
-- exception (not a silent skip) so a buggy caller fails loudly in logs.
CREATE OR REPLACE FUNCTION prospect_notes_reject_update()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'prospect_notes is append-only — entries cannot be modified (id=%)', OLD.id
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prospect_notes_immutable ON prospect_notes;
CREATE TRIGGER trg_prospect_notes_immutable
  BEFORE UPDATE ON prospect_notes
  FOR EACH ROW EXECUTE FUNCTION prospect_notes_reject_update();

COMMIT;

-- ── Verification (run manually after applying) ───────────────────────────────
--   \d prospect_notes
--   -- immutability check (expect ERROR, then clean up):
--   --   INSERT INTO prospect_notes (org_id, prospect_id, user_id, body)
--   --     VALUES (0, 0, 0, 'probe') RETURNING id;
--   --   UPDATE prospect_notes SET body = 'x' WHERE org_id = 0;   -- must FAIL
--   --   DELETE FROM prospect_notes WHERE org_id = 0;
--
-- Rollback (manual, if ever needed):
--   DROP TRIGGER IF EXISTS trg_prospect_notes_immutable ON prospect_notes;
--   DROP FUNCTION IF EXISTS prospect_notes_reject_update();
--   DROP TABLE IF EXISTS prospect_notes;
