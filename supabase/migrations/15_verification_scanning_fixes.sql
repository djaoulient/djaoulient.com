-- Deploy fixes for verification / admin RPCs on databases that already ran older migrations.
-- mark_ticket_used, verify_ticket, sync_purchase_admission_from_individuals: see 08_multi_ticket_verification.sql

CREATE OR REPLACE FUNCTION public.get_recent_verification_errors(
    p_limit INTEGER DEFAULT 20,
    p_event_id TEXT DEFAULT NULL
)
RETURNS TABLE(
    id UUID,
    ticket_identifier TEXT,
    event_id TEXT,
    event_title TEXT,
    attempt_timestamp TIMESTAMPTZ,
    error_code TEXT,
    error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
    RETURN QUERY
    SELECT
        va.id,
        va.ticket_identifier,
        va.event_id,
        va.event_title,
        va.attempt_timestamp,
        va.error_code,
        va.error_message
    FROM public.verification_attempts va
    WHERE va.success = FALSE
    AND (p_event_id IS NULL OR va.event_id = p_event_id)
    ORDER BY va.attempt_timestamp DESC
    LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_event_guest_list(
    p_event_id TEXT
)
RETURNS TABLE(
    purchase_id UUID,
    guest_name TEXT,
    guest_email TEXT,
    guest_phone TEXT,
    ticket_count INTEGER,
    is_used BOOLEAN,
    used_at TIMESTAMPTZ,
    ticket_identifier TEXT,
    created_at TIMESTAMPTZ,
    notes TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
    RETURN QUERY
    SELECT
        p.id AS purchase_id,
        c.name AS guest_name,
        c.email AS guest_email,
        c.phone AS guest_phone,
        p.quantity AS ticket_count,
        p.is_used,
        p.used_at,
        p.unique_ticket_identifier AS ticket_identifier,
        p.created_at,
        p.notes
    FROM public.purchases p
    INNER JOIN public.customers c ON p.customer_id = c.id
    WHERE p.event_id = p_event_id
    AND p.payment_method = 'complimentary'
    ORDER BY p.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_verification_logs(
    p_event_id TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 50,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE(
    id UUID,
    ticket_identifier TEXT,
    event_id TEXT,
    event_title TEXT,
    customer_name TEXT,
    customer_email TEXT,
    attempt_timestamp TIMESTAMPTZ,
    success BOOLEAN,
    error_code TEXT,
    error_message TEXT,
    scanner_email TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
    RETURN QUERY
    SELECT
        va.id,
        va.ticket_identifier,
        va.event_id,
        va.event_title,
        COALESCE(c.name, 'Unknown Customer') AS customer_name,
        COALESCE(c.email, '') AS customer_email,
        va.attempt_timestamp,
        va.success,
        va.error_code,
        va.error_message,
        va.scanner_email
    FROM public.verification_attempts va
    LEFT JOIN public.individual_tickets it ON va.ticket_identifier = it.ticket_identifier
    LEFT JOIN public.purchases p ON (
        (it.purchase_id IS NOT NULL AND p.id = it.purchase_id)
        OR (it.purchase_id IS NULL AND va.ticket_identifier = p.unique_ticket_identifier)
    )
    LEFT JOIN public.customers c ON p.customer_id = c.id
    WHERE (p_event_id IS NULL OR va.event_id = p_event_id)
    ORDER BY va.attempt_timestamp DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_recent_verification_errors(INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_recent_verification_errors(INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_event_guest_list(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_event_guest_list(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_verification_logs(TEXT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_verification_logs(TEXT, INTEGER, INTEGER) TO authenticated;

-- Align flag for purchases that already have individual_tickets rows (e.g. guest list before issue_guest_ticket set the flag).
UPDATE public.purchases p
SET individual_tickets_generated = TRUE
WHERE EXISTS (
    SELECT 1 FROM public.individual_tickets it WHERE it.purchase_id = p.id
)
AND p.individual_tickets_generated = FALSE;
