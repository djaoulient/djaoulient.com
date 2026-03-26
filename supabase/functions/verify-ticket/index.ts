import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

interface TicketVerificationRequest {
  ticket_identifier: string;
  verified_by: string;
  auto_admit?: boolean; // Whether to automatically admit valid tickets
}

interface TicketVerificationResponse {
  success: boolean;
  ticket_data?: any;
  error_code?: string;
  error_message?: string;
  admitted?: boolean; // Whether the ticket was successfully admitted
}

// Environment variables
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Validation
if (!supabaseUrl || supabaseUrl.trim() === "") {
  console.error("SUPABASE_URL environment variable is missing or empty");
  throw new Error("SUPABASE_URL environment variable is required");
}

if (!supabaseServiceRoleKey || supabaseServiceRoleKey.trim() === "") {
  console.error(
    "SUPABASE_SERVICE_ROLE_KEY environment variable is missing or empty",
  );
  throw new Error("SUPABASE_SERVICE_ROLE_KEY environment variable is required");
}

/** QR payloads may be a full /verify?id= URL, quoted id, or legacy formats from scanners. */
function normalizeTicketIdentifier(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  try {
    if (/^https?:\/\//i.test(s) && /verify/i.test(s)) {
      const u = new URL(s);
      const id = u.searchParams.get("id");
      if (id) {
        try {
          return decodeURIComponent(id).trim();
        } catch {
          return id.trim();
        }
      }
    }
  } catch {
    // ignore
  }
  const idFromQuery = s.match(/[?&]id=([^&]+)/i);
  if (idFromQuery?.[1]) {
    try {
      return decodeURIComponent(idFromQuery[1]).trim();
    } catch {
      return idFromQuery[1].trim();
    }
  }
  return s;
}

// The edge function's single-threaded nature prevents race conditions
// No additional locking mechanism needed

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
    const body: TicketVerificationRequest = await req.json();

    const { ticket_identifier, verified_by, auto_admit = true } = body;

    if (!ticket_identifier || ticket_identifier.trim() === "") {
      return new Response(
        JSON.stringify({
          success: false,
          error_code: "INVALID_INPUT",
          error_message: "Ticket identifier is required",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const trimmedId = normalizeTicketIdentifier(ticket_identifier);

    // Step 1: Verify the ticket (atomic operation)
    console.log(`Verifying ticket: ${trimmedId}`);

    const { data: ticketData, error: verifyError } = await supabase.rpc(
      "verify_ticket",
      { 
        p_ticket_identifier: trimmedId,
        p_scanner_email: verified_by || "edge_function_unknown"
      },
    );

    if (verifyError) {
      console.error("Verification error:", verifyError);
      return new Response(
        JSON.stringify({
          success: false,
          error_code: "VERIFICATION_FAILED",
          error_message: verifyError.message,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (!ticketData || ticketData.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error_code: "TICKET_NOT_FOUND",
          error_message: "Ticket not found in system",
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const ticket = ticketData[0];
    console.log(
      `Ticket verified: ${ticket.customer_name} - ${ticket.event_title}`,
    );

    // Purchase-level admission budget (guest list + legacy). Per-QR must still be unused.
    const totalQty = Math.max(1, Number(ticket.total_quantity) || 1);
    const useCount = Math.max(0, Number(ticket.use_count) || 0);
    const canBeAdmitted =
      !ticket.is_used && useCount < totalQty;
    const remainingTickets = Math.max(0, totalQty - useCount);

    const ticketWithRemaining = {
      ...ticket,
      total_quantity: totalQty,
      use_count: useCount,
      remaining_tickets: remainingTickets,
    };

    if (!canBeAdmitted) {
      // Check if it was admitted VERY recently (e.g., last 15 seconds)
      // This absorbs iOS Safari pre-fetches and network retries gracefully.
      if (ticket.used_at) {
        const usedAtTime = new Date(ticket.used_at).getTime();
        const nowTime = Date.now();
        const isRecentlyUsed = (nowTime - usedAtTime) < 15000; // 15 seconds

        if (isRecentlyUsed) {
          console.log(`Ticket was used very recently (${nowTime - usedAtTime}ms ago), likely a prefetch or retry. Treated as success.`);
          
          const fakedTicket = {
            ...ticketWithRemaining,
            remaining_tickets: Math.max(0, totalQty - useCount),
          };

          return new Response(
            JSON.stringify({
              success: true,
              ticket_data: fakedTicket,
              admitted: true,
              warning: "RECENT_DUPLICATE_TREATED_AS_SUCCESS"
            }),
            {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
      }

      console.log(`Ticket cannot be admitted: already used`);
      return new Response(
        JSON.stringify({
          success: true, // Verification succeeded (ticket exists and is valid)
          ticket_data: ticketWithRemaining,
          admitted: false,
          error_code: "ALREADY_USED",
          error_message: ticket.is_used
            ? "Ticket has already been used for entry"
            : "All admissions for this ticket have been used",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Step 3: Auto-admit if requested and possible
    let admitted = false;
    if (auto_admit && canBeAdmitted) {
      console.log(`Auto-admitting ticket: ${trimmedId}`);

      const { data: admitResult, error: admitError } = await supabase.rpc(
        "mark_ticket_used",
        {
          p_ticket_identifier: trimmedId,
          p_verified_by: verified_by || "edge_function",
        },
      );

      if (admitError) {
        console.error("Admission error:", admitError);
        return new Response(
          JSON.stringify({
            success: true, // Verification succeeded, but admission failed
            ticket_data: ticketWithRemaining,
            admitted: false,
            error_code: "ADMISSION_FAILED",
            error_message: admitError.message,
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      if (admitResult === "SUCCESS") {
        admitted = true;
        ticketWithRemaining.use_count = useCount + 1;
        ticketWithRemaining.remaining_tickets = Math.max(
          0,
          totalQty - ticketWithRemaining.use_count,
        );
        console.log(`Ticket successfully admitted: ${trimmedId}`);
      } else {
        console.log(`Admission rejected: ${admitResult}`);
        return new Response(
          JSON.stringify({
            success: true,
            ticket_data: ticketWithRemaining,
            admitted: false,
            error_code: admitResult,
            error_message:
              admitResult === "ALREADY_USED"
                ? "Ticket has already been used for entry"
                : admitResult === "DUPLICATE_SCAN"
                  ? "Ticket scanned again too quickly"
                  : "Admission failed",
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // Success response
    const response: TicketVerificationResponse = {
      success: true,
      ticket_data: ticketWithRemaining,
      admitted: admitted,
    };

    console.log(
      `Verification complete: success=${response.success}, admitted=${admitted}`,
    );

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Unexpected error:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error_code: "INTERNAL_ERROR",
        error_message:
          error instanceof Error ? error.message : "Internal server error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
