-- =====================================================
-- 003_total_response_time.sql
-- Two response times per lead:
--   response_time_seconds          agent's time, from the latest assignment
--                                  (unchanged; fair to a reassigned agent)
--   time_to_first_contact_seconds  total time the lead waited, from when it
--                                  arrived (what a broker cares about)
-- Also: the first contact is never overwritten by later activity.
-- Safe to run more than once.
-- =====================================================

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS time_to_first_contact_seconds INTEGER;

-- Backfill leads already contacted.
UPDATE leads
SET time_to_first_contact_seconds = EXTRACT(EPOCH FROM (first_contact_at - created_at))::INTEGER
WHERE first_contact_at IS NOT NULL AND time_to_first_contact_seconds IS NULL;

CREATE OR REPLACE FUNCTION public.mark_lead_contacted(p_lead_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_org_id UUID;
    v_assigned_at TIMESTAMPTZ;
    v_created_at TIMESTAMPTZ;
    v_first_contact TIMESTAMPTZ;
    v_response_time INTEGER;
    v_total_time INTEGER;
BEGIN
    SELECT org_id, assigned_at, created_at, first_contact_at
    INTO v_org_id, v_assigned_at, v_created_at, v_first_contact
    FROM leads WHERE id = p_lead_id
    FOR UPDATE;

    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'Lead not found: %', p_lead_id;
    END IF;

    -- Already contacted: keep the original first-contact record.
    IF v_first_contact IS NOT NULL THEN
        RETURN TRUE;
    END IF;

    v_response_time := EXTRACT(EPOCH FROM (NOW() - COALESCE(v_assigned_at, v_created_at)))::INTEGER;
    v_total_time := EXTRACT(EPOCH FROM (NOW() - v_created_at))::INTEGER;

    UPDATE leads
    SET first_contact_at = NOW(),
        response_time_seconds = v_response_time,
        time_to_first_contact_seconds = v_total_time,
        status = 'contacted',
        updated_at = NOW()
    WHERE id = p_lead_id;

    INSERT INTO lead_events (lead_id, org_id, event_type, event_data)
    VALUES (p_lead_id, v_org_id, 'contacted', jsonb_build_object(
        'response_time_seconds', v_response_time,
        'time_to_first_contact_seconds', v_total_time
    ));

    RETURN TRUE;
END;
$function$;
