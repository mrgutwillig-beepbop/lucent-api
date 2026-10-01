-- =====================================================
-- 002_enforcement.sql
-- Adds what the API's enforcement worker needs:
--   agent notification tracking, reassignment settings, and two
--   race-safe functions (enforce_escalate, reassign_lead).
-- Additive and safe to run more than once.
-- =====================================================

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS agent_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reassign_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS reassign_after_minutes INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS max_reassignments INTEGER NOT NULL DEFAULT 2;

-- Existing leads count as already notified, so the worker never texts
-- agents about old or test leads when it first starts.
UPDATE leads
SET agent_notified_at = COALESCE(assigned_at, NOW())
WHERE agent_notified_at IS NULL AND assigned_to IS NOT NULL;

-- Escalate only if the lead is still assigned and not contacted.
-- Returns the escalation id, or NULL if nothing was done.
CREATE OR REPLACE FUNCTION public.enforce_escalate(p_lead_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $function$
DECLARE
  v_lead RECORD;
BEGIN
  SELECT id, status, first_contact_at, escalation_count
  INTO v_lead
  FROM leads WHERE id = p_lead_id
  FOR UPDATE;

  IF v_lead.id IS NULL OR v_lead.status <> 'assigned' OR v_lead.first_contact_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  RETURN escalate_lead(p_lead_id, v_lead.escalation_count + 1);
END;
$function$;

-- Move an escalated, uncontacted lead to the next available agent.
-- Returns one row on success, no rows if the lead changed or no other agent is available.
CREATE OR REPLACE FUNCTION public.reassign_lead(p_lead_id uuid)
RETURNS TABLE(
  new_agent_id uuid,
  new_agent_name text,
  new_agent_phone text,
  previous_agent_name text,
  previous_agent_phone text,
  sla_deadline timestamptz
)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_lead RECORD;
  v_prev RECORD;
  v_next RECORD;
  v_sla_minutes INTEGER;
  v_deadline TIMESTAMPTZ;
BEGIN
  SELECT l.id, l.org_id, l.status, l.first_contact_at, l.assigned_to, l.lead_temperature
  INTO v_lead
  FROM leads l WHERE l.id = p_lead_id
  FOR UPDATE;

  IF v_lead.id IS NULL OR v_lead.status <> 'escalated' OR v_lead.first_contact_at IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT a.name, a.phone INTO v_prev FROM agents a WHERE a.id = v_lead.assigned_to;

  SELECT a.id, a.name, a.phone
  INTO v_next
  FROM agents a
  WHERE a.org_id = v_lead.org_id
    AND a.is_active = true
    AND a.is_available = true
    AND a.id IS DISTINCT FROM v_lead.assigned_to
  ORDER BY a.rotation_order ASC
  LIMIT 1;

  IF v_next.id IS NULL THEN
    RETURN;
  END IF;

  SELECT CASE v_lead.lead_temperature
           WHEN 'hot' THEN o.sla_hot_minutes
           WHEN 'warm' THEN o.sla_warm_minutes
           WHEN 'cold' THEN o.sla_cold_minutes
           ELSE 15 END
  INTO v_sla_minutes
  FROM organizations o WHERE o.id = v_lead.org_id;

  v_deadline := NOW() + (COALESCE(v_sla_minutes, 15) || ' minutes')::INTERVAL;

  UPDATE leads
  SET assigned_to = v_next.id,
      assigned_at = NOW(),
      sla_deadline = v_deadline,
      status = 'assigned',
      agent_notified_at = NULL,
      reassign_count = reassign_count + 1,
      updated_at = NOW()
  WHERE id = p_lead_id;

  INSERT INTO lead_events (lead_id, org_id, event_type, event_data)
  VALUES (p_lead_id, v_lead.org_id, 'reassigned', jsonb_build_object(
    'from_agent_id', v_lead.assigned_to,
    'to_agent_id', v_next.id,
    'to_agent_name', v_next.name,
    'sla_deadline', v_deadline
  ));

  RETURN QUERY SELECT v_next.id, v_next.name, v_next.phone, v_prev.name, v_prev.phone, v_deadline;
END;
$function$;
