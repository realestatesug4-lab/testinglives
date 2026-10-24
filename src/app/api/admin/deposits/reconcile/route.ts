import {
  authenticateRequest,
  createMarzPayConfig,
  createServiceRoleClient,
  normalizeMarzPaySettlement,
  PaymentConfigError,
  requestMarzPay,
} from "@/lib/server/payments";

type StuckDeposit = {
  id: string;
  provider_request_id: string | null;
};

function isStuckDeposit(value: unknown): value is StuckDeposit {
  return typeof value === "object"
    && value !== null
    && typeof (value as Record<string, unknown>).id === "string"
    && (typeof (value as Record<string, unknown>).provider_request_id === "string"
      || (value as Record<string, unknown>).provider_request_id === null);
}

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  if (session.user.app_metadata?.role !== "admin") {
    return Response.json({ error: "Administrator access is required." }, { status: 403 });
  }

  try {
    const marzPay = createMarzPayConfig();
    const serviceClient = createServiceRoleClient();
    const { data, error } = await session.client.rpc("get_stuck_marzpay_deposits", { p_limit: 25 });
    if (error) return Response.json({ error: error.message }, { status: 409 });

    const deposits = Array.isArray(data) ? data.filter(isStuckDeposit) : [];
    let checked = 0;
    let updated = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const deposit of deposits) {
      if (!deposit.provider_request_id) continue;
      checked += 1;
      try {
        const statusResponse = await requestMarzPay(
          marzPay,
          `transactions/${encodeURIComponent(deposit.provider_request_id)}`,
          "GET",
        );
        const normalized = normalizeMarzPaySettlement(statusResponse, "deposit");
        if (!normalized) throw new Error("MarzPay returned a status this app cannot interpret yet.");
        const { error: applyError } = await serviceClient.rpc("apply_marzpay_webhook", {
          p_payload: normalized,
        });
        if (applyError) throw new Error(applyError.message);
        updated += 1;
      } catch (checkError) {
        failed += 1;
        errors.push(`${deposit.id}: ${checkError instanceof Error ? checkError.message : "Unknown error"}`);
      }
    }

    return Response.json({
      total: deposits.length,
      checked,
      updated,
      failed,
      errors: errors.slice(0, 10),
      message: `Checked ${checked} deposit(s): ${updated} refreshed, ${failed} could not be confirmed.`,
    });
  } catch (error) {
    if (error instanceof PaymentConfigError) {
      return Response.json({ error: "MarzPay is not configured. Contact support." }, { status: 503 });
    }
    console.error("MarzPay deposit reconciliation failed.", error instanceof Error ? error.message : "Unknown error");
    return Response.json({ error: "The reconciliation pass could not be completed." }, { status: 502 });
  }
}
