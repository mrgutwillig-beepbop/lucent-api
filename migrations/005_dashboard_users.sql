-- =====================================================
-- 005_dashboard_users.sql
-- Managers who can open a brokerage's dashboard, and their one-time
-- email login links (only a hash of each link is stored).
-- RLS on with no policies: only the API's service key can read these tables.
-- Safe to run more than once.
-- =====================================================

CREATE TABLE IF NOT EXISTS dashboard_users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  name           TEXT,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, email)
);
CREATE INDEX IF NOT EXISTS dashboard_users_email ON dashboard_users (lower(email));
ALTER TABLE dashboard_users ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS dashboard_login_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE dashboard_login_tokens ENABLE ROW LEVEL SECURITY;

-- Dashboard queries: leads and events by brokerage and date.
CREATE INDEX IF NOT EXISTS leads_org_created ON leads (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_events_org_created ON lead_events (org_id, created_at DESC);
