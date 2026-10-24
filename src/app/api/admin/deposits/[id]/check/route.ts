import {
  authenticateRequest,
  createMarzPayConfig,
  createServiceRoleClient,
  MarzPayApiError,
  normalizeMarzPaySettlement,
  PaymentConfigError,
  requestMarzPay,
} from "@/lib/server/payments";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/deposits/[id]/check">,
) {
  const session = await authenticateRequest(request);
  if (!session) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  if (session.user.app_metadata?.role !== "admin") {
    return Response.json({ error: "Administrator access is required." }, { status: 403 });
  }

  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return Response.json({ error: "Invalid deposit ID." }, { status: 400 });
  }

  try {
    const marzPay = createMarzPayConfig();
    const serviceClient = createServiceRoleClient();
    const { data, error } = await session.client.rpc("admin_marzpay_deposit_status", {
      p_transaction_id: id,
    });
    if (error) return Response.json({ error: error.message }, { status: 409 });
    if (!isRecord(data) || typeof data.provider_request_id !== "string" || !data.provider_request_id) {
      return Response.json({ error: "This deposit has not been submitted to MarzPay yet." }, { status: 409 });
    }

    const statusResponse = await requestMarzPay(
      marzPay,
      `transactions/${encodeURIComponent(data.provider_request_id)}`,
      "GET",
    );
    const normalized = normalizeMarzPaySettlement(statusResponse, "deposit");
    if (!normalized) {
      return Response.json({ error: "MarzPay returned a status this app cannot interpret yet." }, { status: 502 });
    }
    const { error: applyError } = await serviceClient.rpc("apply_marzpay_webhook", {
      p_payload: normalized,
    });
    if (applyError) {
      console.error("MarzPay deposit status could not be applied.", applyError.message);
      return Response.json({ error: "The deposit status could not be refreshed. Try again later." }, { status: 502 });
    }

    return Response.json({
      transactionId: id,
      status: "processing",
      message: "MarzPay deposit status checked. The record reflects the provider's latest result.",
    });
  } catch (error) {
    if (error instanceof PaymentConfigError) {
      return Response.json({ error: "MarzPay is not configured. Contact support." }, { status: 503 });
    }
    if (error instanceof MarzPayApiError) {
      console.error("MarzPay deposit status check failed.", {
        statusCode: error.statusCode,
        errorCode: error.errorCode,
        message: error.message,
      });
      return Response.json({ error: `MarzPay could not confirm the deposit status: ${error.message}` }, { status: 502 });
    }
    console.error("MarzPay deposit status check failed.", error instanceof Error ? error.message : "Unknown error");
    return Response.json({ error: "The deposit status could not be checked." }, { status: 502 });
  }
}
