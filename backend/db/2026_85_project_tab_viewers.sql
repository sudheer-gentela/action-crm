-- 2026_85_project_tab_viewers.sql
-- Named per-project viewers for restricted tabs (starting with "commercial").
-- Effective visibility = role (project/service owner, deal owner, org admin/owner)
-- OR an explicit named viewer here.

CREATE TABLE IF NOT EXISTS project_tab_viewers (
  id           SERIAL PRIMARY KEY,
  org_id       INTEGER NOT NULL,
  handover_id  INTEGER NOT NULL,
  tab_key      VARCHAR(50) NOT NULL,
  user_id      INTEGER NOT NULL,
  created_by   INTEGER,
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (handover_id, tab_key, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_tab_viewers_lookup
  ON project_tab_viewers (handover_id, tab_key);
