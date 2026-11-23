-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_146_ai_spend_guard.sql
--
-- Phase 1, step 1.1a: AI spend guard.
--
--   ai_user_budgets     Per-person daily AI limit set by an org admin. Absent
--                       row = the org default (org_action_config.ai_settings
--                       ->>'daily_budget_usd', $3 when unset). A limit of 0
--                       is allowed and means "no AI for this person today".
--
--   ai_kill_switch_log  Audit trail for the org-level AI kill switch. The
--                       live state sits in org_action_config.ai_settings
--                       (ai_enabled / ai_disabled_reason / _by / _at) so the
--                       resolver reads it with the settings row it already
--                       loads; this table is the history of who flipped it,
--                       when and why.
--
--   ai_budget_alerts    One row per person per local day once they hit their
--                       limit. The INSERT … ON CONFLICT DO NOTHING is what
--                       makes the "you've hit today's budget" notification
--                       fire once a day even with several processes (web +
--                       worker) blocking calls at the same moment.
--
-- No new index on ai_token_usage: the daily-spend query filters on
-- (user_id, created_at), which idx_ai_token_usage_user_date already covers.
--
-- Idempotent. NUMBERING: 145 = msteams_meeting_chat_kind. This is 146.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

CREATE TABLE IF NOT EXISTS ai_user_budgets (
  org_id           integer       NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          integer       NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  daily_limit_usd  numeric(10,2) NOT NULL CHECK (daily_limit_usd >= 0),
  updated_by       integer                REFERENCES users(id)         ON DELETE SET NULL,
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS ai_kill_switch_log (
  id          serial       PRIMARY KEY,
  org_id      integer      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  enabled     boolean      NOT NULL,
  reason      text,
  changed_by  integer               REFERENCES users(id)         ON DELETE SET NULL,
  changed_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_kill_switch_log_org
  ON ai_kill_switch_log (org_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS ai_budget_alerts (
  org_id      integer      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     integer      NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  day         date         NOT NULL,
  limit_usd   numeric(10,2),
  spent_usd   numeric(10,4),
  created_at  timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, day)
);

COMMIT;
