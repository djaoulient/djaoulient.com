import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { Resend } from "npm:resend@2.0.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resendApiKey = Deno.env.get("RESEND_API_KEY")!;
const fromEmail =
  Deno.env.get("FROM_EMAIL") || "notifications@tickets.djaoulient.com";
const APP_BASE_URL = (
  Deno.env.get("APP_BASE_URL") || "http://localhost:3000"
).replace(/\/$/, "");
const defaultLogoUrl = "https://www.djaoulient.com/icon.png";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** true = paid exists for same email+event; false = safe to recover; null = lookup failed */
async function hasPaidPurchaseSameEmailEvent(
  supabase: ReturnType<typeof createClient>,
  eventId: string,
  email: string,
): Promise<boolean | null> {
  const want = normalizeEmail(email);
  const { data, error } = await supabase
    .from("purchases")
    .select("customers!inner(email)")
    .eq("event_id", eventId)
    .eq("status", "paid");

  if (error) {
    console.error("send-recovery-email: paid lookup error", error);
    return null;
  }

  for (const row of data ?? []) {
    const cust = row.customers as { email: string | null };
    const em = cust?.email;
    if (em && normalizeEmail(em) === want) return true;
  }
  return false;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let purchaseIdFromRequest: string | null = null;

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
    const resend = new Resend(resendApiKey);

    const body = await req.json();
    const purchase_id = body.purchase_id;
    purchaseIdFromRequest = purchase_id;

    if (!purchaseIdFromRequest) {
      console.error("send-recovery-email: Missing purchase_id in request");
      return new Response(JSON.stringify({ error: "Missing purchase_id" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    console.log(
      `send-recovery-email: Fetching purchase data for ${purchaseIdFromRequest}`,
    );
    const { data: purchaseDataArray, error: purchaseError } =
      await supabase.rpc("get_purchase_for_email_dispatch", {
        p_purchase_id: purchaseIdFromRequest,
      });

    if (purchaseError || !purchaseDataArray || purchaseDataArray.length === 0) {
      console.error(
        `send-recovery-email: Error fetching purchase ${purchaseIdFromRequest}:`,
        purchaseError,
      );
      if (purchaseIdFromRequest) {
        await supabase
          .rpc("update_email_dispatch_status", {
            p_purchase_id: purchaseIdFromRequest,
            p_email_dispatch_status: "DISPATCH_FAILED",
            p_email_dispatch_error: `Purchase not found or DB error: ${purchaseError?.message}`,
          })
          .catch((err: unknown) =>
            console.error("Failed to update error status:", err),
          );
      }
      return new Response(
        JSON.stringify({ error: "Purchase not found or database error" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 404,
        },
      );
    }

    const purchaseData = purchaseDataArray[0];

    if (purchaseData.status !== "payment_failed") {
      console.warn(
        `send-recovery-email: Purchase ${purchaseIdFromRequest} status is ${purchaseData.status}, not payment_failed`,
      );
      return new Response(
        JSON.stringify({
          error: "Recovery email is only for failed payments",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        },
      );
    }

    const paidCheck = await hasPaidPurchaseSameEmailEvent(
      supabase,
      purchaseData.event_id,
      purchaseData.customer_email ?? "",
    );
    if (paidCheck === null) {
      return new Response(
        JSON.stringify({
          error: "Could not verify checkout state; try again shortly",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 503,
        },
      );
    }
    if (paidCheck) {
      console.warn(
        `send-recovery-email: Customer already has paid purchase for event ${purchaseData.event_id}`,
      );
      return new Response(
        JSON.stringify({
          error:
            "A successful payment exists for this email and event; recovery not applicable",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        },
      );
    }

    if (
      purchaseData.email_dispatch_status === "SENT_SUCCESSFULLY" ||
      purchaseData.email_dispatch_status === "DISPATCH_IN_PROGRESS"
    ) {
      console.warn(
        `send-recovery-email: Purchase ${purchaseIdFromRequest} already processed (${purchaseData.email_dispatch_status}). Skipping.`,
      );
      return new Response(
        JSON.stringify({
          message: "Recovery email already processed or in progress.",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        },
      );
    }

    console.log(
      `send-recovery-email: Setting purchase ${purchaseIdFromRequest} to DISPATCH_IN_PROGRESS`,
    );
    const { error: updateError } = await supabase.rpc(
      "update_email_dispatch_status",
      {
        p_purchase_id: purchaseIdFromRequest,
        p_email_dispatch_status: "DISPATCH_IN_PROGRESS",
        p_email_dispatch_attempts:
          (purchaseData.email_dispatch_attempts || 0) + 1,
      },
    );

    if (updateError) {
      console.error(
        `send-recovery-email: Failed to update dispatch status:`,
        updateError,
      );
      return new Response(
        JSON.stringify({ error: "Failed to update dispatch status" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        },
      );
    }

    if (!purchaseData.customer_email || !purchaseData.customer_name) {
      console.error(
        `send-recovery-email: Customer data missing for purchase ${purchaseIdFromRequest}`,
      );
      await supabase.rpc("update_email_dispatch_status", {
        p_purchase_id: purchaseIdFromRequest,
        p_email_dispatch_status: "DISPATCH_FAILED",
        p_email_dispatch_error: "Customer data missing for purchase.",
      });
      return new Response(JSON.stringify({ error: "Customer data missing" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      });
    }

    const customerName = purchaseData.customer_name || "Bonjour";
    const nameParts = customerName.split(" ");
    const firstName = nameParts[0];
    const eventName = purchaseData.event_title || "cet événement";
    const logoSrc = defaultLogoUrl;

    const emailHtmlBody = `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Finaliser votre réservation</title>
</head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background-color:#f0f0f0;color:#333;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f0f0f0;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="width:560px;max-width:100%;background-color:#ffffff;">
          <tr>
            <td style="padding:24px 24px 16px;text-align:center;">
              <img src="${logoSrc}" alt="Djaouli Entertainment" width="80" height="80" style="display:block;margin:0 auto;border:0;" />
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 24px;">
              <h1 style="margin:0 0 16px;font-size:20px;font-weight:bold;color:#111;">Votre réservation n’a pas pu être finalisée</h1>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Bonjour ${firstName},</p>
              <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">Vous avez récemment essayé de réserver un ticket pour <strong>${eventName}</strong> mais votre paiement n’a pas pu aboutir.</p>
              <p style="margin:0 0 24px;font-size:15px;line-height:1.5;">Vous pouvez toujours réserver votre place sur <a href="${APP_BASE_URL}" style="color:#2563eb;font-weight:bold;">notre site Web</a>.</p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
                <tr>
                  <td style="border-radius:4px;background-color:#111;">
                    <a href="${APP_BASE_URL}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">Réserver maintenant</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #eee;font-size:12px;color:#888;text-align:center;">© ${new Date().getFullYear()} Djaouli Entertainment</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const { data: emailData, error: emailError } = await resend.emails.send({
      from: `Djaouli Entertainment <${fromEmail}>`,
      to: purchaseData.customer_email,
      reply_to: "djaoulient@gmail.com",
      subject: `Finalisez votre réservation — ${eventName}`,
      html: emailHtmlBody,
    });

    if (emailError) {
      const resendErrorMsg =
        emailError instanceof Error
          ? emailError.message
          : JSON.stringify(emailError);
      console.error(
        `send-recovery-email: Resend error for ${purchaseIdFromRequest}:`,
        resendErrorMsg,
      );
      await supabase.rpc("update_email_dispatch_status", {
        p_purchase_id: purchaseIdFromRequest,
        p_email_dispatch_status: "DISPATCH_FAILED",
        p_email_dispatch_error: `Resend API error: ${resendErrorMsg}`,
      });
      return new Response(
        JSON.stringify({
          error: "Failed to send email",
          details: resendErrorMsg,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    console.log(
      `send-recovery-email: Email sent for purchase ${purchaseIdFromRequest}. Email ID: ${emailData?.id}`,
    );
    await supabase.rpc("update_email_dispatch_status", {
      p_purchase_id: purchaseIdFromRequest,
      p_email_dispatch_status: "SENT_SUCCESSFULLY",
      p_email_dispatch_error: null,
    });

    return new Response(
      JSON.stringify({
        message: "Recovery email sent successfully!",
        email_id: emailData?.id,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e: unknown) {
    const errorMessage =
      e instanceof Error ? e.message : "An unknown error occurred";
    console.error(
      `send-recovery-email: Unexpected error for ${purchaseIdFromRequest || "unknown"}:`,
      e,
    );
    if (purchaseIdFromRequest) {
      try {
        const supabaseForErrorFallback = createClient(
          supabaseUrl!,
          supabaseServiceRoleKey!,
        );
        await supabaseForErrorFallback.rpc("update_email_dispatch_status", {
          p_purchase_id: purchaseIdFromRequest,
          p_email_dispatch_status: "DISPATCH_FAILED",
          p_email_dispatch_error: `Unexpected error: ${errorMessage}`,
        });
      } catch (updateError) {
        console.error(
          `Failed to update error status for ${purchaseIdFromRequest}:`,
          updateError,
        );
      }
    }
    return new Response(
      JSON.stringify({ error: "Internal server error", details: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
