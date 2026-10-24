import {
  authenticateRequest,
  createMarzPayConfig,
  createServiceRoleClient,
  MarzPayApiError,
  normalizeMarzPaySettlement,
  PaymentConfigError,
  readMarzPaySettledAmount,
  requestMarzPay,
} from "@/lib/server/payments";

type PayoutRequest = {
  transaction_id: string;
  reference: string;
  phone_number: string;
  provider: "mtn" | "airtel";
  amount: number;
  should_submit: boolean;
  provider_request_id: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPayoutRequest(value: unknown): value is PayoutRequest {
  return isRecord(value)
    && typeof value.transaction_id === "string"
    && typeof value.reference === "string"
    && typeof value.phone_number === "string"
    && (value.provider === "mtn" || value.provider === "airtel")
    && typeof value.amount === "number"
    && typeof value.should_submit === "boolean"
    && (typeof value.provider_request_id === "string" || value.provider_request_id === null);
}

function getProviderRequestId(response: unknown) {
  if (!isRecord(response) || !isRecord(response.data) || !isRecord(response.data.transaction)) return null;
  const id = response.data.transaction.uuid;
  return typeof id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/withdrawals/[id]/approve">,
) {
  const session = await authenticateRequest(request);
  if (!session) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  if (session.user.app_metadata?.role !== "admin") {
    return Response.json({ error: "Administrator access is required." }, { status: 403 });
  }

  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return Response.json({ error: "Invalid withdrawal ID." }, { status: 400 });
  }

  let payoutTransactionId: string | null = null;
  let submittingPayout = false;
  try {
    const marzPay = createMarzPayConfig();
    const serviceClient = createServiceRoleClient();
    const { data, error } = await session.client.rpc("begin_marzpay_withdrawal", {
      p_transaction_id: id,
    });
    if (error) return Response.json({ error: error.message }, { status: 409 });
    if (!isPayoutRequest(data)) {
      console.error("MarzPay approval RPC returned an invalid payout.");
      return Response.json({ error: "The withdrawal approval could not be confirmed." }, { status: 502 });
    }
    payoutTransactionId = data.transaction_id;

    if (!data.should_submit) {
      if (!data.provider_request_id) {
        return Response.json({
          transactionId: data.transaction_id,
          status: "processing",
          message: "The provider submission is still being confirmed. Do not retry; contact support if this continues.",
        }, { status: 202 });
      }

      const statusResponse = await requestMarzPay(
        marzPay,
        `transactions/${encodeURIComponent(data.provider_request_id)}`,
        "GET",
      );
      const normalized = normalizeMarzPaySettlement(statusResponse, "withdraw");
      if (!normalized) {
        return Response.json({
          transactionId: data.transaction_id,
          status: "processing",
          message: "MarzPay is still confirming this payout. Check the record again shortly.",
        }, { status: 202 });
      }
      const { error: updateError } = await serviceClient.rpc("apply_marzpay_webhook", {
        p_payload: normalized,
      });
      if (updateError) {
        console.error("MarzPay payout status could not be applied.", updateError.message);
        return Response.json({ error: "The payout status could not be refreshed. Try again later." }, { status: 502 });
      }

      return Response.json({
        transactionId: data.transaction_id,
        providerTransactionId: data.provider_request_id,
        status: "processing",
        message: "MarzPay payout status checked. The transaction record will reflect the provider's latest result.",
      }, { status: 202 });
    }

    submittingPayout = true;
    const response = await requestMarzPay(marzPay, "send-money", "POST", {
      amount: data.amount,
      phone_number: data.phone_number,
      reference: data.reference,
      country: "UG",
      description: "Testing Lives approved withdrawal",
      callback_url: marzPay.callbackUrl,
    });
    const providerRequestId = getProviderRequestId(response);
    if (providerRequestId) {
      const { error: recordError } = await serviceClient.rpc("record_marzpay_submission", {
        p_transaction_id: data.transaction_id,
        p_provider_request_id: providerRequestId,
        p_provider_status: "processing",
        p_failure_reason: null,
      });
      if (recordError) console.error("MarzPay payout submission could not be recorded.", recordError.message);
    }

    const responseData = isRecord(response) && isRecord(response.data) ? response.data : null;
    const transaction = responseData && isRecord(responseData.transaction) ? responseData.transaction : null;
    const payout = responseData
      ? (isRecord(responseData.withdrawal) ? responseData.withdrawal : isRecord(responseData.disbursement) ? responseData.disbursement : null)
      : null;
    const settled = readMarzPaySettledAmount("withdraw", transaction, payout);
    const payoutPhone = payout?.phone_number ?? transaction?.phone_number;
    const payoutProvider = payout?.provider ?? transaction?.provider;
    const phoneMatches = payoutPhone == null
      || (typeof payoutPhone === "string" && payoutPhone === data.phone_number);
    const providerMatches = payoutProvider == null
      || (typeof payoutProvider === "string" && payoutProvider.toLowerCase() === data.provider);
    if (
      !providerRequestId
      || transaction?.provider_reference !== data.reference
      || !settled
      || settled.amount !== data.amount
      || (settled.currency != null && settled.currency.toUpperCase() !== "UGX")
      || !phoneMatches
      || !providerMatches
    ) {
      console.error("MarzPay payout response did not match the approved request.", {
        hasTransactionId: Boolean(providerRequestId),
        referenceMatches: transaction?.provider_reference === data.reference,
        settledAmount: settled?.amount ?? null,
        expectedAmount: data.amount,
        phoneMatches,
        providerMatches,
      });
      return Response.json({
        transactionId: data.transaction_id,
        status: "processing",
        message: "MarzPay returned an unexpected response. Check the payout status before taking further action.",
      }, { status: 202 });
    }

    return Response.json({
      transactionId: data.transaction_id,
      providerTransactionId: providerRequestId,
      status: "processing",
      message: "MarzPay payout submitted. Its final status will be confirmed by callback.",
    }, { status: 202 });
  } catch (error) {
    if (error instanceof PaymentConfigError) {
      return Response.json({ error: "MarzPay is not configured. Contact support." }, { status: 503 });
    }
    if (error instanceof MarzPayApiError) {
      let failureRecorded = false;
      if (submittingPayout && payoutTransactionId && [400, 401, 403, 422].includes(error.statusCode)) {
        try {
          const { error: recordError } = await createServiceRoleClient().rpc("fail_marzpay_submission", {
            p_transaction_id: payoutTransactionId,
            p_reason: error.message,
          });
          if (recordError) {
            console.error("Failed MarzPay payout could not be recorded.", recordError.message);
          } else {
            failureRecorded = true;
          }
        } catch (recordError) {
          console.error("Failed MarzPay payout could not be recorded.", recordError instanceof Error ? recordError.message : "Unknown error");
        }
      }
      console.error("MarzPay payout request failed.", {
        statusCode: error.statusCode,
        errorCode: error.errorCode,
        message: error.message,
      });
      if (failureRecorded) {
        return Response.json({ error: "MarzPay rejected the payout request. The reserved balance has been returned." }, { status: 502 });
      }
      return Response.json({
        status: "processing",
        message: "MarzPay could not confirm the payout request. Check its status before taking further action.",
      }, { status: 202 });
    }
    console.error("MarzPay payout request failed.", error instanceof Error ? error.message : "Unknown error");
    return Response.json({
      status: "processing",
      message: "MarzPay could not confirm the payout request. Check its status before taking further action.",
    }, { status: 202 });
  }
}
