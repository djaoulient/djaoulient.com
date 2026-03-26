CREATE OR REPLACE FUNCTION public.record_event_lomi_payment(
    p_purchase_id UUID,
    p_lomi_payment_id TEXT, -- Lomi's unique ID for the payment transaction itself (if available and distinct from session ID)
    p_lomi_checkout_session_id TEXT, -- Lomi's ID for the checkout session
    p_payment_status TEXT, -- e.g., 'paid', 'failed' from Lomi webhook
    p_lomi_event_payload JSONB, -- The entire Lomi webhook event payload
    p_amount_paid NUMERIC, -- Amount confirmed by Lomi (in smallest currency unit, e.g., cents, or base unit if no subunits like XOF)
    p_currency_paid TEXT -- Currency code confirmed by Lomi
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_current_status TEXT;
    v_checkout_session TEXT;
BEGIN
    -- Empty string must not be stored: lomi_session_id is UNIQUE and '' would collide across purchases.
    v_checkout_session := NULLIF(p_lomi_checkout_session_id, '');

    SELECT status INTO v_current_status
    FROM public.purchases
    WHERE id = p_purchase_id;

    IF NOT FOUND THEN
        RAISE WARNING 'Purchase ID % not found during record_event_lomi_payment. Lomi Event: %', p_purchase_id, p_lomi_event_payload;
        RETURN;
    END IF;

    -- Idempotency check: Don't reprocess if status is already 'paid' and we're trying to set it to 'paid'
    -- Allow status changes (e.g., from 'pending' to 'paid', or 'paid' to 'failed' for refunds)
    IF v_current_status = 'paid' AND p_payment_status = 'paid' THEN
        RAISE NOTICE 'Purchase % already marked as paid, skipping duplicate payment recording', p_purchase_id;
        RETURN;
    END IF;

    UPDATE public.purchases
    SET
        status = p_payment_status,
        lomi_session_id = COALESCE(v_checkout_session, lomi_session_id),
        total_amount = p_amount_paid,
        currency_code = p_currency_paid,
        payment_processor_details = p_lomi_event_payload,
        updated_at = NOW()
    WHERE id = p_purchase_id;

    RAISE NOTICE 'Purchase % status updated to % via Lomi webhook', p_purchase_id, p_payment_status;
END;
$$;

COMMENT ON FUNCTION public.record_event_lomi_payment(UUID, TEXT, TEXT, TEXT, JSONB, NUMERIC, TEXT)
IS 'Records Lomi payment outcome for an event purchase. Blank checkout session id is ignored so UNIQUE(lomi_session_id) is not violated. Called by the Lomi webhook handler.';

-- Grant execute permission to the service_role (used by Supabase functions/backend calls)
GRANT EXECUTE ON FUNCTION public.record_event_lomi_payment(UUID, TEXT, TEXT, TEXT, JSONB, NUMERIC, TEXT) TO service_role;

-- RPC to get purchase status (for webhook idempotency, no direct table access from API)
CREATE OR REPLACE FUNCTION public.get_purchase_status(p_purchase_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT status INTO v_status
    FROM public.purchases
    WHERE id = p_purchase_id;
    RETURN v_status;
END;
$$;

COMMENT ON FUNCTION public.get_purchase_status(UUID)
IS 'Returns the status of a purchase by id. Used by webhook handler for idempotency.';

GRANT EXECUTE ON FUNCTION public.get_purchase_status(UUID) TO service_role;
