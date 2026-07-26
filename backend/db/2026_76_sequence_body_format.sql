-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_76_sequence_body_format.sql
--
-- SAFE TO DEPLOY ALONE. Both columns are additive and default to today's
-- behaviour, so they are inert until the firer change ships.
--
-- NUMBERING: 74 = step_include_signature, 75 = email_body_quotable. This is 76.
--
-- ── What this enables ───────────────────────────────────────────────────────
--
-- Every sequence email currently goes out as text/html. The two send call sites
-- hardcode it:
--
--   SequenceStepFirer.js:2092 / :2098
--     { to, subject, body: sendBodyHtml, isHtml: true }
--
-- Both providers already accept plain text — googleService maps isHtml to
-- text/plain vs text/html, outlookService to 'Text' vs 'HTML' — so the plumbing
-- exists end to end and only that hardcoded flag stood in the way.
--
-- Format lives on the SEQUENCE, not the campaign. Campaigns inherit it through
-- default_sequence_id. Two reasons: format and threading interact (the quoted
-- history block differs per format), so keeping them on one row means they cannot
-- disagree; and the send query already selects s.thread_replies /
-- s.thread_subject_mode, so this needs no new join.
--
-- ── multipart/alternative is NOT what this does ─────────────────────────────
--
-- This is a single-part choice: html OR plain. Sending both parts was considered
-- and rejected for now — Microsoft Graph's message.body accepts exactly one
-- contentType, so multipart would require moving the Outlook path to raw-MIME
-- send, which also means self-generating In-Reply-To/References and migrating
-- thread_last_message_id (which for Outlook holds a Graph immutable id, not an
-- RFC Message-ID). Disproportionate. If it is revisited, body_format is a text
-- enum precisely so 'multipart' can join it without a type change.
--
-- ── Plain text disables open AND click tracking ─────────────────────────────
--
-- EmailTrackingService appends a 1x1 <img> pixel and rewrites <a href> targets.
-- Neither survives text/plain: the pixel would appear as literal markup in the
-- recipient's email, and HREF_RE only matches anchor tags so nothing is rewritten.
-- The firer therefore SKIPS decoration entirely for plain sequences rather than
-- emitting broken markup. Reporting will show zero opens and zero clicks for
-- those campaigns — that is correct, not a bug, and the UI says so.
--
-- ── Why emails.body_format exists ───────────────────────────────────────────
--
-- Not for display. Nothing renders emails.body as HTML — there is no
-- dangerouslySetInnerHTML anywhere in the frontend, and every backend consumer
-- strips tags with regexp_replace, which is a harmless no-op on plain text.
--
-- It exists for QUOTING. The 2026_75 quote builder embeds the parent's
-- body_quotable directly. If a sequence's format changes while enrollments are in
-- flight, an HTML parent quoted into a plain reply would dump raw <div> and
-- <blockquote> markup into the recipient's inbox, and a plain parent quoted into
-- an HTML reply would lose every line break. Recording the format per row lets the
-- builder detect the mismatch and skip the quote block instead of corrupting it —
-- degrade, never corrupt. Threading survives regardless, since it rides on the
-- RFC headers.
--
-- The route layer additionally BLOCKS changing a sequence's format while it has
-- active enrollments, so the mismatch should be rare. This column is the
-- belt-and-braces for the paths that bypass the route (superadmin, direct SQL,
-- future bulk edits).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- §0. PRE-FLIGHT — informational.
--
--   Query 1: sequences that would be locked against a format change today,
--            i.e. those with active enrollments. Useful to know before anyone
--            tries and hits the 409.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT s.id, s.name, count(se.id) AS active_enrollments
--   FROM sequences s
--   JOIN sequence_enrollments se ON se.sequence_id = s.id AND se.status = 'active'
--  GROUP BY 1,2 ORDER BY 3 DESC;


-- ───────────────────────────────────────────────────────────────────────────
-- §1. Sequence-level setting.
--     NOT NULL DEFAULT 'html' reproduces current behaviour exactly.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE sequences
  ADD COLUMN IF NOT EXISTS body_format text NOT NULL DEFAULT 'html';

ALTER TABLE sequences DROP CONSTRAINT IF EXISTS sequences_body_format_check;
ALTER TABLE sequences
  ADD CONSTRAINT sequences_body_format_check
  CHECK (body_format IN ('html', 'plain'));

COMMENT ON COLUMN public.sequences.body_format IS
  'Wire format for this sequence''s outbound email: html (default) or plain. '
  'plain sends text/plain, which disables open and click tracking because the '
  'pixel and rewritten hrefs cannot survive it. Cannot be changed while the '
  'sequence has active enrollments — see PUT /api/sequences/:id. As of 2026_76.';


-- ───────────────────────────────────────────────────────────────────────────
-- §2. Per-row format on sent mail, for the quote builder.
--
--     Nullable on purpose: NULL means "written before 2026_76", which is always
--     HTML since that was the only format. The quote builder must treat NULL as
--     'html' rather than as unknown, or every in-flight thread loses its quote
--     block on the next send for no reason.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE emails
  ADD COLUMN IF NOT EXISTS body_format text;

ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_body_format_check;
ALTER TABLE emails
  ADD CONSTRAINT emails_body_format_check
  CHECK (body_format IS NULL OR body_format IN ('html', 'plain'));

COMMENT ON COLUMN public.emails.body_format IS
  'Format of body and body_quotable on this row. NULL = pre-2026_76, treat as '
  'html. Read by the threaded-reply quote builder: when the parent''s format '
  'differs from the current send format the quote block is skipped rather than '
  'emitted as broken markup.';


-- ───────────────────────────────────────────────────────────────────────────
-- §3. VERIFY before COMMIT.
--
--   Query 1: both columns present; sequences.body_format NOT NULL default html,
--            emails.body_format nullable with no default.
--   Query 2: every existing sequence reads 'html'.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT table_name, column_name, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE column_name = 'body_format' AND table_name IN ('sequences', 'emails');
--
-- SELECT body_format, count(*) FROM sequences GROUP BY 1;

COMMIT;
