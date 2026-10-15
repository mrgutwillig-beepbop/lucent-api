-- =====================================================
-- 006_close_public_policies.sql
-- The original tables had a policy named "Enable all for service role" that
-- actually applied to everyone (role public, USING true), so the browser key
-- could read and change every lead, agent and brokerage. The API uses the
-- service key, which RLS does not restrict, so these policies are not needed.
-- Applied 2026-10-15. Safe to run more than once.
-- =====================================================
DROP POLICY IF EXISTS "Enable all for service role" ON agents;
DROP POLICY IF EXISTS "Enable all for service role" ON lead_events;
DROP POLICY IF EXISTS "Enable all for service role" ON escalations;
DROP POLICY IF EXISTS "Enable all for service role" ON organizations;
DROP POLICY IF EXISTS "Enable all for service role" ON leads;
