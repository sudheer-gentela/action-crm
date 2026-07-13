-- 2026_49_linkedin_message_events.sql
--
-- Ledger of LinkedIn messages observed by the Chrome extension's inbox
-- harvest ("reconcile-messages"). One row per message per org, keyed on
-- LinkedIn's own stable per-message id (backendUrn:
-- urn:li:messagingMessage:<id> — NOT the viewer-scoped entityUrn composite).
--
-- Purpose (design doc D4): message_count / reply_count on
-- prospects.channel_data.linkedin are incrementing counters, and multiple
-- messages are legitimate — so idempotency cannot live in the monotonic
-- status guard. It lives here: INSERT … ON CONFLICT DO NOTHING, and callers
-- bump counters ONLY when the insert actually inserted AND the event passes
-- the post-acceptance time gate (F14: connection-request notes render as
-- thread messages and must be ledgered but never counted).
--
-- Scope (D5): rows exist only for GoWarm-attributed prospects
-- (channel_data.linkedin.request_sent_at present) owned by the calling user.
-- Non-attributed inbox threads are never persisted.
--
-- Rollback: DROP TABLE linkedin_message_events;

BEGIN;

CREATE TABLE IF NOT EXISTS linkedin_message_events (
    id          bigserial PRIMARY KEY,
    org_id      integer     NOT NULL,
    prospect_id integer     NOT NULL,
    user_id     integer     NOT NULL,
    seat        text        NOT NULL,   -- user_linkedin_seats.public_identifier
    message_urn text        NOT NULL,   -- urn:li:messagingMessage:<id> (backendUrn)
    thread_urn  text,                   -- urn:li:messagingThread:<id>; <id> is the
                                        -- /messaging/thread/<id>/ URL segment (deep link)
    direction   text        NOT NULL CHECK (direction IN ('outbound','inbound')),
    counted     boolean     NOT NULL DEFAULT false,  -- passed the post-acceptance gate
                                        -- and bumped prospect counters (audit; F14)
    occurred_at timestamptz NOT NULL,   -- messengerMessages elements[].deliveredAt
    created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE linkedin_message_events IS
  'Dedup ledger for LinkedIn inbox harvest. message_urn is LinkedIn''s stable backendUrn; counters on prospects bump only when a row inserts AND counted=true (post-acceptance gate, design doc §5.3/F14).';

CREATE UNIQUE INDEX IF NOT EXISTS idx_li_msg_events_urn
    ON linkedin_message_events (org_id, message_urn);

CREATE INDEX IF NOT EXISTS idx_li_msg_events_prospect
    ON linkedin_message_events (org_id, prospect_id, occurred_at DESC);

-- P5a (sequence reply auto-stop) probes: "any inbound event for this prospect
-- after enrollment?" — partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_li_msg_events_inbound
    ON linkedin_message_events (org_id, prospect_id, occurred_at)
    WHERE direction = 'inbound';

COMMIT;
