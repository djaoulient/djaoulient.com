-- Migration: Combined Multi-Ticket Verification System
-- This migration sets up the complete system for handling both new individual tickets and legacy multi-use tickets.

-- 1. Create the table for individual tickets
CREATE TABLE IF NOT EXISTS public.individual_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_id UUID NOT NULL REFERENCES public.purchases(id) ON DELETE CASCADE,
    ticket_identifier TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'active' NOT NULL, -- 'active', 'used', 'cancelled'
    is_used BOOLEAN DEFAULT FALSE NOT NULL,
    used_at TIMESTAMPTZ,
    verified_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_individual_tickets_purchase_id ON public.individual_tickets(purchase_id);
CREATE INDEX IF NOT EXISTS idx_individual_tickets_ticket_identifier ON public.individual_tickets(ticket_identifier);

-- Enable Row Level Security (RLS) on the individual_tickets table
ALTER TABLE public.individual_tickets ENABLE ROW LEVEL SECURITY;

-- Allow service_role full access on individual_tickets
CREATE POLICY "Allow service_role full access on individual_tickets"
ON public.individual_tickets
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Allow authenticated users to read individual tickets (for verification)
CREATE POLICY "Allow authenticated read on individual_tickets"
ON public.individual_tickets
FOR SELECT
TO authenticated
USING (true);

-- Grant permissions to service_role and authenticated
GRANT SELECT, INSERT, UPDATE, DELETE ON public.individual_tickets TO service_role;
GRANT SELECT ON public.individual_tickets TO authenticated;

-- Add comments for clarity
COMMENT ON TABLE public.individual_tickets IS 'Stores individual tickets for multi-ticket purchases, each with a unique identifier for QR codes.';
COMMENT ON COLUMN public.individual_tickets.status IS 'Status of the individual ticket (e.g., active, used, cancelled).';

-- 2. Add columns to the purchases table for legacy ticket handling and tracking
ALTER TABLE public.purchases
ADD COLUMN IF NOT EXISTS use_count INTEGER DEFAULT 0 NOT NULL,
ADD COLUMN IF NOT EXISTS individual_tickets_generated BOOLEAN DEFAULT FALSE NOT NULL;

COMMENT ON COLUMN public.purchases.use_count IS 'For legacy tickets, tracks how many times a multi-person ticket has been scanned.';
COMMENT ON COLUMN public.purchases.individual_tickets_generated IS 'Indicates if individual tickets have been generated for this purchase.';

-- 3. Function to generate individual tickets for a purchase
CREATE OR REPLACE FUNCTION public.generate_individual_tickets_for_purchase(
    p_purchase_id UUID
)
RETURNS TABLE (ticket_identifier TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    purchase_record RECORD;
    actual_ticket_quantity INTEGER;
    new_ticket_identifier TEXT;
    existing_ticket_count INTEGER;
BEGIN
    -- Get purchase details
    SELECT * INTO purchase_record FROM public.purchases WHERE id = p_purchase_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Purchase with ID % not found.', p_purchase_id;
    END IF;

    -- Prevent generating tickets for old purchases that shouldn't have them
    IF purchase_record.created_at < '2024-08-01' THEN
        RAISE EXCEPTION 'Cannot generate individual tickets for this legacy purchase.';
    END IF;

    -- Determine the actual number of tickets
    actual_ticket_quantity := COALESCE(
        CASE WHEN purchase_record.is_bundle THEN purchase_record.quantity * purchase_record.tickets_per_bundle ELSE purchase_record.quantity END,
        purchase_record.quantity,
        1
    );

    -- Check how many tickets already exist
    SELECT count(*) INTO existing_ticket_count FROM public.individual_tickets WHERE purchase_id = p_purchase_id;

    IF existing_ticket_count >= actual_ticket_quantity THEN
        -- Tickets already exist, just return the existing ones (idempotent safe)
        FOR new_ticket_identifier IN 
            SELECT it.ticket_identifier FROM public.individual_tickets it WHERE it.purchase_id = p_purchase_id
        LOOP
            ticket_identifier := new_ticket_identifier;
            RETURN NEXT;
        END LOOP;
        RETURN;
    END IF;

    -- If there's a mismatch (partial generation failure previously), clean slate ONLY IF none are used
    IF existing_ticket_count > 0 THEN
        PERFORM 1 FROM public.individual_tickets WHERE purchase_id = p_purchase_id AND is_used = TRUE;
        IF FOUND THEN
            RAISE EXCEPTION 'Cannot regenerate tickets for purchase % because some tickets are already used.', p_purchase_id;
        END IF;
        -- Safe to clean slate because none were used
        DELETE FROM public.individual_tickets WHERE purchase_id = p_purchase_id;
    END IF;

    -- Generate N individual tickets and return their identifiers
    FOR i IN 1..actual_ticket_quantity LOOP
        new_ticket_identifier := gen_random_uuid()::TEXT;
        INSERT INTO public.individual_tickets (purchase_id, ticket_identifier)
        VALUES (p_purchase_id, new_ticket_identifier);
        
        -- Return the newly created identifier
        ticket_identifier := new_ticket_identifier;
        RETURN NEXT;
    END LOOP;

    -- Mark the main purchase as having its tickets generated
    UPDATE public.purchases
    SET individual_tickets_generated = TRUE
    WHERE id = p_purchase_id;
END;
$$;

-- 4. Drop existing functions before creating new versions with different signatures
DROP FUNCTION IF EXISTS public.verify_ticket(TEXT);
DROP FUNCTION IF EXISTS public.mark_ticket_used(TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.sync_purchase_admission_from_individuals(p_purchase_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.individual_tickets it WHERE it.purchase_id = p_purchase_id
    ) THEN
        RETURN;
    END IF;

    UPDATE public.purchases p
    SET
        use_count = (
            SELECT COUNT(*)::INTEGER
            FROM public.individual_tickets it
            WHERE it.purchase_id = p_purchase_id AND it.is_used = TRUE
        ),
        is_used = NOT EXISTS (
            SELECT 1 FROM public.individual_tickets it
            WHERE it.purchase_id = p_purchase_id AND it.is_used = FALSE
        ),
        used_at = (
            SELECT MAX(it.used_at)
            FROM public.individual_tickets it
            WHERE it.purchase_id = p_purchase_id AND it.used_at IS NOT NULL
        ),
        updated_at = NOW()
    WHERE p.id = p_purchase_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.verify_ticket(
    p_ticket_identifier TEXT,
    p_scanner_email TEXT DEFAULT NULL
)
RETURNS TABLE(
    purchase_id UUID,
    customer_name TEXT,
    customer_email TEXT,
    customer_phone TEXT,
    event_id TEXT,
    event_title TEXT,
    event_date_text TEXT,
    event_time_text TEXT,
    event_venue_name TEXT,
    ticket_type_id TEXT,
    ticket_name TEXT,
    quantity INTEGER,
    price_per_ticket NUMERIC,
    total_amount NUMERIC,
    currency_code TEXT,
    status TEXT,
    is_used BOOLEAN,
    used_at TIMESTAMPTZ,
    verified_by TEXT,
    use_count INTEGER,
    total_quantity INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    individual_ticket RECORD;
    purchase_record RECORD;
    v_used INTEGER;
    v_total INTEGER;
BEGIN
    IF p_ticket_identifier IS NULL OR TRIM(p_ticket_identifier) = '' THEN
        RAISE EXCEPTION 'INVALID_TICKET_ID: Ticket identifier cannot be empty';
    END IF;

    SELECT it.* INTO individual_ticket FROM public.individual_tickets it WHERE it.ticket_identifier = p_ticket_identifier;

    IF FOUND THEN
        SELECT p.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone
        INTO purchase_record
        FROM public.purchases p
        INNER JOIN public.customers c ON p.customer_id = c.id
        WHERE p.id = individual_ticket.purchase_id;

        IF NOT FOUND THEN
            PERFORM public.log_verification_attempt(
                p_ticket_identifier, NULL, NULL, FALSE, 'ORPHANED_TICKET', 'Individual ticket found but associated purchase not found', p_scanner_email
            );
            RAISE EXCEPTION 'ORPHANED_TICKET: Ticket found but purchase record missing';
        END IF;

        IF purchase_record.status != 'paid' THEN
            PERFORM public.log_verification_attempt(
                p_ticket_identifier, purchase_record.event_id, purchase_record.event_title, FALSE, 'UNPAID_TICKET', 'Ticket belongs to unpaid purchase', p_scanner_email
            );
            RAISE EXCEPTION 'UNPAID_TICKET: This ticket has not been paid for';
        END IF;

        SELECT
            COUNT(*) FILTER (WHERE ita.is_used)::INTEGER,
            COUNT(*)::INTEGER
        INTO v_used, v_total
        FROM public.individual_tickets ita
        WHERE ita.purchase_id = purchase_record.id;

        v_used := GREATEST(v_used, LEAST(purchase_record.use_count, v_total));

        RETURN QUERY SELECT
            purchase_record.id, purchase_record.customer_name, purchase_record.customer_email, purchase_record.customer_phone,
            purchase_record.event_id, purchase_record.event_title, purchase_record.event_date_text, purchase_record.event_time_text,
            purchase_record.event_venue_name, purchase_record.ticket_type_id, purchase_record.ticket_name,
            1, purchase_record.price_per_ticket, purchase_record.total_amount, purchase_record.currency_code,
            individual_ticket.status, individual_ticket.is_used, individual_ticket.used_at, individual_ticket.verified_by,
            v_used,
            v_total;
        RETURN;
    END IF;

    SELECT p.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone
    INTO purchase_record
    FROM public.purchases p
    INNER JOIN public.customers c ON p.customer_id = c.id
    WHERE p.unique_ticket_identifier = p_ticket_identifier;

    IF FOUND THEN
        IF purchase_record.status != 'paid' THEN
            PERFORM public.log_verification_attempt(
                p_ticket_identifier, purchase_record.event_id, purchase_record.event_title, FALSE, 'UNPAID_TICKET', 'Ticket belongs to unpaid purchase', p_scanner_email
            );
            RAISE EXCEPTION 'UNPAID_TICKET: This ticket has not been paid for';
        END IF;

        IF EXISTS (SELECT 1 FROM public.individual_tickets it0 WHERE it0.purchase_id = purchase_record.id) THEN
            SELECT
                COUNT(*) FILTER (WHERE ita.is_used)::INTEGER,
                COUNT(*)::INTEGER
            INTO v_used, v_total
            FROM public.individual_tickets ita
            WHERE ita.purchase_id = purchase_record.id;

            v_used := GREATEST(v_used, LEAST(purchase_record.use_count, v_total));

            RETURN QUERY SELECT
                purchase_record.id, purchase_record.customer_name, purchase_record.customer_email, purchase_record.customer_phone,
                purchase_record.event_id, purchase_record.event_title, purchase_record.event_date_text, purchase_record.event_time_text,
                purchase_record.event_venue_name, purchase_record.ticket_type_id, purchase_record.ticket_name,
                1, purchase_record.price_per_ticket, purchase_record.total_amount, purchase_record.currency_code,
                CASE WHEN v_used >= v_total THEN 'used' ELSE 'valid' END::TEXT,
                (v_used >= v_total),
                (SELECT MAX(itm.used_at) FROM public.individual_tickets itm WHERE itm.purchase_id = purchase_record.id),
                NULL::TEXT,
                v_used,
                v_total;
            RETURN;
        END IF;

        RETURN QUERY SELECT
            purchase_record.id, purchase_record.customer_name, purchase_record.customer_email, purchase_record.customer_phone,
            purchase_record.event_id, purchase_record.event_title, purchase_record.event_date_text, purchase_record.event_time_text,
            purchase_record.event_venue_name, purchase_record.ticket_type_id, purchase_record.ticket_name,
            purchase_record.quantity, purchase_record.price_per_ticket, purchase_record.total_amount, purchase_record.currency_code,
            purchase_record.status, (purchase_record.use_count >= purchase_record.quantity), purchase_record.used_at, purchase_record.verified_by,
            purchase_record.use_count, purchase_record.quantity;
        RETURN;
    END IF;

    PERFORM public.log_verification_attempt(
        p_ticket_identifier, NULL, NULL, FALSE, 'TICKET_NOT_FOUND', 'No ticket found with this identifier', p_scanner_email
    );
    RAISE EXCEPTION 'TICKET_NOT_FOUND: Ticket not found in system';
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_ticket_used(
    p_ticket_identifier TEXT,
    p_verified_by TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    individual_ticket RECORD;
    purchase_record RECORD;
    time_since_last_scan INTERVAL;
    iused INTEGER;
    itotal INTEGER;
    target INTEGER;
    to_sync INTEGER;
BEGIN
    SELECT * INTO individual_ticket FROM public.individual_tickets it WHERE it.ticket_identifier = p_ticket_identifier;

    IF FOUND THEN
        IF individual_ticket.used_at IS NOT NULL THEN
            time_since_last_scan := NOW() - individual_ticket.used_at;
            IF time_since_last_scan < INTERVAL '2 seconds' THEN
                PERFORM public.log_verification_attempt(
                    p_ticket_identifier, NULL, NULL, FALSE, 'DUPLICATE_SCAN', 'Ticket scanned again within 2 seconds of last scan', p_verified_by
                );
                RETURN 'DUPLICATE_SCAN';
            END IF;
        END IF;

        IF individual_ticket.is_used THEN
            SELECT p.event_id, p.event_title INTO purchase_record
            FROM public.purchases p WHERE p.id = individual_ticket.purchase_id;

            PERFORM public.log_verification_attempt(
                p_ticket_identifier, purchase_record.event_id, purchase_record.event_title, FALSE, 'ALREADY_USED', 'Ticket has already been used for entry', p_verified_by
            );
            RETURN 'ALREADY_USED';
        END IF;

        UPDATE public.individual_tickets
        SET is_used = TRUE, used_at = NOW(), verified_by = p_verified_by, status = 'used', updated_at = NOW()
        WHERE id = individual_ticket.id;

        SELECT p.event_id, p.event_title INTO purchase_record
        FROM public.purchases p WHERE p.id = individual_ticket.purchase_id;

        PERFORM public.log_verification_attempt(
            p_ticket_identifier, purchase_record.event_id, purchase_record.event_title, TRUE, NULL, 'Admission recorded', p_verified_by
        );

        PERFORM public.sync_purchase_admission_from_individuals(individual_ticket.purchase_id);

        RETURN 'SUCCESS';
    END IF;

    SELECT * INTO purchase_record FROM public.purchases WHERE unique_ticket_identifier = p_ticket_identifier;

    IF FOUND THEN
        IF EXISTS (SELECT 1 FROM public.individual_tickets it0 WHERE it0.purchase_id = purchase_record.id) THEN
            SELECT
                COUNT(*) FILTER (WHERE ita.is_used)::INTEGER,
                COUNT(*)::INTEGER
            INTO iused, itotal
            FROM public.individual_tickets ita
            WHERE ita.purchase_id = purchase_record.id;

            target := GREATEST(iused, LEAST(purchase_record.use_count, itotal));
            to_sync := target - iused;

            IF to_sync > 0 THEN
                UPDATE public.individual_tickets it
                SET is_used = TRUE, used_at = COALESCE(it.used_at, NOW()), verified_by = COALESCE(it.verified_by, 'reconciled'),
                    status = 'used', updated_at = NOW()
                WHERE it.id IN (
                    SELECT it2.id
                    FROM public.individual_tickets it2
                    WHERE it2.purchase_id = purchase_record.id AND it2.is_used = FALSE
                    ORDER BY it2.ticket_identifier ASC
                    LIMIT to_sync
                );
            END IF;

            PERFORM public.sync_purchase_admission_from_individuals(purchase_record.id);

            SELECT it.* INTO individual_ticket
            FROM public.individual_tickets it
            WHERE it.purchase_id = purchase_record.id AND it.is_used = FALSE
            ORDER BY it.ticket_identifier ASC
            LIMIT 1;

            IF NOT FOUND THEN
                PERFORM public.log_verification_attempt(
                    p_ticket_identifier, purchase_record.event_id, purchase_record.event_title, FALSE, 'ALREADY_USED', 'All admissions for this purchase have been used', p_verified_by
                );
                RETURN 'ALREADY_USED';
            END IF;

            IF individual_ticket.used_at IS NOT NULL THEN
                time_since_last_scan := NOW() - individual_ticket.used_at;
                IF time_since_last_scan < INTERVAL '2 seconds' THEN
                    PERFORM public.log_verification_attempt(
                        p_ticket_identifier, purchase_record.event_id, purchase_record.event_title, FALSE, 'DUPLICATE_SCAN', 'Ticket scanned again within 2 seconds of last scan', p_verified_by
                    );
                    RETURN 'DUPLICATE_SCAN';
                END IF;
            END IF;

            UPDATE public.individual_tickets
            SET is_used = TRUE, used_at = NOW(), verified_by = p_verified_by, status = 'used', updated_at = NOW()
            WHERE id = individual_ticket.id;

            PERFORM public.log_verification_attempt(
                p_ticket_identifier, purchase_record.event_id, purchase_record.event_title, TRUE, NULL, 'Admission recorded', p_verified_by
            );

            PERFORM public.sync_purchase_admission_from_individuals(purchase_record.id);

            RETURN 'SUCCESS';
        END IF;

        IF purchase_record.used_at IS NOT NULL THEN
            time_since_last_scan := NOW() - purchase_record.used_at;
            IF time_since_last_scan < INTERVAL '2 seconds' THEN
                PERFORM public.log_verification_attempt(
                    p_ticket_identifier, purchase_record.event_id, purchase_record.event_title, FALSE, 'DUPLICATE_SCAN', 'Ticket scanned again within 2 seconds of last scan', p_verified_by
                );
                RETURN 'DUPLICATE_SCAN';
            END IF;
        END IF;

        IF purchase_record.use_count >= purchase_record.quantity THEN
            PERFORM public.log_verification_attempt(
                p_ticket_identifier, purchase_record.event_id, purchase_record.event_title, FALSE, 'ALREADY_USED', 'All admissions for this purchase have been used', p_verified_by
            );
            RETURN 'ALREADY_USED';
        END IF;

        UPDATE public.purchases
        SET use_count = purchase_record.use_count + 1, used_at = NOW(), verified_by = p_verified_by,
            is_used = (purchase_record.use_count + 1) >= purchase_record.quantity, updated_at = NOW()
        WHERE id = purchase_record.id;

        PERFORM public.log_verification_attempt(
            p_ticket_identifier, purchase_record.event_id, purchase_record.event_title, TRUE, NULL, 'Admission recorded', p_verified_by
        );

        RETURN 'SUCCESS';
    END IF;

    PERFORM public.log_verification_attempt(
        p_ticket_identifier, NULL, NULL, FALSE, 'NOT_FOUND', 'Ticket identifier not found in system', p_verified_by
    );

    RETURN 'NOT_FOUND';
END;
$$;

-- One-time: mirror historical purchases.use_count onto individual rows (hybrid state before individual-only admissions)
DO $$
DECLARE
    r RECORD;
    iused INTEGER;
    itotal INTEGER;
    target INTEGER;
    to_sync INTEGER;
BEGIN
    FOR r IN
        SELECT p.id AS pid, p.use_count AS p_use
        FROM public.purchases p
        WHERE EXISTS (SELECT 1 FROM public.individual_tickets it WHERE it.purchase_id = p.id)
    LOOP
        SELECT
            COUNT(*) FILTER (WHERE ita.is_used)::INTEGER,
            COUNT(*)::INTEGER
        INTO iused, itotal
        FROM public.individual_tickets ita
        WHERE ita.purchase_id = r.pid;

        target := GREATEST(iused, LEAST(r.p_use, itotal));
        to_sync := target - iused;

        IF to_sync > 0 THEN
            UPDATE public.individual_tickets it
            SET is_used = TRUE, used_at = COALESCE(it.used_at, NOW()), verified_by = COALESCE(it.verified_by, 'reconciled'),
                status = 'used', updated_at = NOW()
            WHERE it.id IN (
                SELECT it2.id
                FROM public.individual_tickets it2
                WHERE it2.purchase_id = r.pid AND it2.is_used = FALSE
                ORDER BY it2.ticket_identifier ASC
                LIMIT to_sync
            );
        END IF;

        PERFORM public.sync_purchase_admission_from_individuals(r.pid);
    END LOOP;
END;
$$;

DROP FUNCTION IF EXISTS public.get_purchase_for_email_dispatch(UUID);

CREATE FUNCTION public.get_purchase_for_email_dispatch(
    p_purchase_id UUID
)
RETURNS TABLE(
    purchase_id UUID,
    customer_id UUID,
    customer_name TEXT,
    customer_email TEXT,
    customer_phone TEXT,
    event_id TEXT,
    event_title TEXT,
    event_date_text TEXT,
    event_time_text TEXT,
    event_venue_name TEXT,
    ticket_type_id TEXT,
    ticket_name TEXT,
    quantity INTEGER,
    price_per_ticket NUMERIC,
    total_amount NUMERIC,
    currency_code TEXT,
    status TEXT,
    email_dispatch_status TEXT,
    email_dispatch_attempts INTEGER,
    unique_ticket_identifier TEXT,
    is_bundle BOOLEAN,
    tickets_per_bundle INTEGER,
    individual_tickets_generated BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id AS purchase_id,
        p.customer_id,
        c.name AS customer_name,
        c.email AS customer_email,
        c.phone AS customer_phone,
        p.event_id,
        p.event_title,
        p.event_date_text,
        p.event_time_text,
        p.event_venue_name,
        p.ticket_type_id,
        p.ticket_name,
        p.quantity,
        p.price_per_ticket,
        p.total_amount,
        p.currency_code,
        p.status,
        p.email_dispatch_status,
        p.email_dispatch_attempts,
        p.unique_ticket_identifier,
        p.is_bundle,
        p.tickets_per_bundle,
        p.individual_tickets_generated
    FROM public.purchases p
    INNER JOIN public.customers c ON p.customer_id = c.id
    WHERE p.id = p_purchase_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.purchase_has_individual_tickets(p_purchase_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.individual_tickets it
        WHERE it.purchase_id = p_purchase_id
    );
$$;

COMMENT ON FUNCTION public.verify_ticket(TEXT, TEXT) IS
'Admission state for purchases with individual_tickets is derived from those rows; purchase unique_ticket_identifier resolves to aggregate counts; reconciles display with purchases.use_count when needed.';

COMMENT ON FUNCTION public.sync_purchase_admission_from_individuals(UUID) IS
'Copies admission totals from individual_tickets into purchases for orders that use per-ticket rows.';

COMMENT ON FUNCTION public.get_purchase_for_email_dispatch(UUID) IS
'Purchase + customer row for email dispatch; includes individual_tickets_generated for QR strategy.';

COMMENT ON FUNCTION public.purchase_has_individual_tickets(UUID) IS
'TRUE if any individual_tickets rows exist for this purchase (e.g. guest list); for Edge email dispatch when RLS blocks direct table reads.';

-- Grant permissions for the new functions
GRANT EXECUTE ON FUNCTION public.generate_individual_tickets_for_purchase(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_individual_tickets_for_purchase(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_ticket(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_ticket(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_ticket_used(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_ticket_used(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_purchase_for_email_dispatch(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.purchase_has_individual_tickets(UUID) TO service_role;

-- 6. Function to reset stuck email dispatch statuses
-- This helps resolve the issue where purchases get stuck in DISPATCH_IN_PROGRESS
CREATE OR REPLACE FUNCTION public.reset_stuck_email_dispatches()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    reset_count INTEGER;
BEGIN
    -- Reset purchases that have been in DISPATCH_IN_PROGRESS for more than 10 minutes
    UPDATE public.purchases
    SET 
        email_dispatch_status = 'DISPATCH_FAILED',
        email_dispatch_error = 'Dispatch timed out - reset by cleanup function',
        updated_at = NOW()
    WHERE email_dispatch_status = 'DISPATCH_IN_PROGRESS'
    AND email_last_dispatch_attempt_at < NOW() - INTERVAL '10 minutes';
    
    GET DIAGNOSTICS reset_count = ROW_COUNT;
    
    RETURN reset_count;
END;
$$;

-- Grant execute permissions for the cleanup function
GRANT EXECUTE ON FUNCTION public.reset_stuck_email_dispatches() TO service_role;

COMMENT ON FUNCTION public.reset_stuck_email_dispatches()
IS 'Resets email dispatch statuses that have been stuck in DISPATCH_IN_PROGRESS for more than 10 minutes';

-- Align flag for purchases that already have individual_tickets rows (e.g. guest list before issue_guest_ticket set the flag).
UPDATE public.purchases p
SET individual_tickets_generated = TRUE
WHERE EXISTS (
    SELECT 1 FROM public.individual_tickets it WHERE it.purchase_id = p.id
)
AND p.individual_tickets_generated = FALSE;
