-- =====================================================
-- 004_crm_connections.sql
-- One CRM connection per brokerage (organization) and provider.
-- API keys are stored encrypted by the API (never in plain text).
-- RLS on with no policies: only the API's service key can read this table.
-- Safe to run more than once.
-- =====================================================

CREATE TABLE IF NOT EXISTS crm_connections (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL CHECK (provider IN ('follow_up_boss', 'boldtrail')),
  api_key_encrypted  TEXT NOT NULL,
  key_hint           TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disabled')),
  last_error         TEXT,
  last_checked_at    TIMESTAMPTZ,
  webhook_token      TEXT UNIQUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, provider)
);

CREATE INDEX IF NOT EXISTS crm_connections_provider_status ON crm_connections (provider, status);

ALTER TABLE crm_connections ENABLE ROW LEVEL SECURITY;

-- Speeds up short tap-to-call link lookups (lead_events event_data->>'code').
CREATE INDEX IF NOT EXISTS lead_events_call_link_code
  ON lead_events ((event_data->>'code')) WHERE event_type = 'call_link';
