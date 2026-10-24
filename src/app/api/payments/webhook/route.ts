import {
  createMarzPayConfig,
  createServiceRoleClient,
  detectMarzPayPaymentKind,
  extractMarzPayReference,
  normalizeMarzPaySettlement,
  PaymentConfigError,
  requestMarzPay,
  verifyMarzPayWebhookSignature,
} from "@/lib/server/payments";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return Response.json({ error: "Could not read webhook payload." }, { status: 400 });
  }
  if (rawBody.length > 64_000) {
    return Response.json({ error: "Webhook payload is too large." }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid webhook payload." }, { status: 400 });
  }
  if (!isRecord(payload)) {
    return Response.json({ error: "Invalid webhook payload." }, { status: 400 });
  }

  const verification = verifyMarzPayWebhookSignature(rawBody, request.headers);
  const paymentKind = detectMarzPayPaymentKind(payload);
  const paymentReference = paymentKind ? extractMarzPayReference(payload, paymentKind) : null;

  try {
    const serviceClient = createServiceRoleClient();

    // The posted payload is only trusted when its signature verifies. In every
    // case the provider's own status endpoint is preferred so forged or partial
    // callbacks can never settle a transaction.
    let settlement: Record<string, unknown> | null = null;
    let lookupOutcome = "not_attempted";
    if (paymentKind && paymentReference) {
      const { data: rows, error: lookupError } = await serviceClient
        .from("transactions")
        .select("provider_request_id")
        .eq("payment_reference", paymentReference)
        .eq("payment_gateway", "marzpay")
        .eq("kind", paymentKind)
        .limit(1);
      if (lookupError) throw new Error(lookupError.message);

      const providerRequestId = rows?.[0]?.provider_request_id;
      if (typeof providerRequestId === "string" && providerRequestId.trim()) {
        try {
          const status = await requestMarzPay(
            createMarzPayConfig(),
            `transactions/${encodeURIComponent(providerRequestId.trim())}`,
            "GET",
          );
          settlement = normalizeMarzPaySettlement(status, paymentKind);
          lookupOutcome = settlement ? "settled" : "unrecognized";
        } catch (error) {
          lookupOutcome = "failed";
          console.error(
            "MarzPay webhook status lookup failed.",
            error instanceof Error ? error.message : "Unknown error",
          );
        }
      } else {
        lookupOutcome = "missing_provider_request_id";
      }
    } else {
      lookupOutcome = "unidentified_transaction";
    }

    if (!settlement && verification === "valid" && paymentKind) {
      settlement = normalizeMarzPaySettlement(payload, paymentKind);
    }

    if (!settlement) {
      if (verification !== "valid") {
        console.error("Rejected an unverifiable MarzPay webhook.", {
          verification,
          paymentKind,
          lookupOutcome,
        });
        return Response.json({ error: "Invalid MarzPay webhook signature." }, { status: 401 });
      }
      if (!paymentKind) {
        return Response.json({ error: "Unsupported MarzPay webhook." }, { status: 400 });
      }
      console.error("MarzPay webhook payload could not be normalized.", { lookupOutcome });
      return Response.json({ error: "Invalid webhook payload." }, { status: 400 });
    }

    const { error } = await serviceClient.rpc("apply_marzpay_webhook", {
      p_payload: settlement,
    });
    if (error) {
      console.error("MarzPay payment update could not be applied.", error.message);
      return Response.json({ error: "Webhook processing failed." }, { status: 500 });
    }
    return Response.json({ received: true });
  } catch (error) {
    if (error instanceof PaymentConfigError) {
      return Response.json({ error: "Webhook service is not configured." }, { status: 503 });
    }
    console.error("MarzPay webhook processing failed.", error instanceof Error ? error.message : "Unknown error");
    return Response.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}
