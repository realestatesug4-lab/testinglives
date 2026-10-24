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
import { detectUgandaMobileProvider, normalizeUgandaPhone } from "@/lib/phone";

type DepositRecord = {
  transaction_id: string;
  reference: string;
  phone_number: string;
  provider: "mtn" | "airtel";
  amount: number;
  provider_request_id: string | null;
  should_submit: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isDepositRecord(value: unknown): value is DepositRecord {
  return isRecord(value)
    && typeof value.transaction_id === "string"
    && typeof value.reference === "string"
    && typeof value.phone_number === "string"
    && (value.provider === "mtn" || value.provider === "airtel")
    && typeof value.amount === "number"
    && (typeof value.provider_request_id === "string" || value.provider_request_id === null)
    && typeof value.should_submit === "boolean";
}

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  let parsedBody: unknown;
  let paymentTransactionId: string | null = null;
  try {
    parsedBody = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!isRecord(parsedBody)) return Response.json({ error: "Invalid request body." }, { status: 400 });
  const body = parsedBody;

  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    return Response.json({ error: "Enter a positive whole-number deposit amount." }, { status: 400 });
  }
  if (body.provider != null && body.provider !== "mtn" && body.provider !== "airtel") {
    return Response.json({ error: "Select a valid mobile money network." }, { status: 400 });
  }

  const normalizedPhone = typeof body.phone === "string" ? normalizeUgandaPhone(body.phone.trim()) : null;
  if (!normalizedPhone) return Response.json({ error: "Enter a valid Uganda mobile number." }, { status: 400 });
  const detectedProvider = detectUgandaMobileProvider(normalizedPhone);
  if (detectedProvider && body.provider && detectedProvider !== body.provider) {
    return Response.json({ error: "The selected network does not match this phone number." }, { status: 400 });
  }
  const provider = detectedProvider ?? body.provider;
  if (provider !== "mtn" && provider !== "airtel") {
    return Response.json({ error: "Select your mobile money network for this number." }, { status: 400 });
  }

  try {
    const marzPay = createMarzPayConfig();
    const serviceClient = createServiceRoleClient();
    const { data: requestData, error: requestError } = await session.client.rpc("request_mobile_deposit", {
      p_amount: amount,
      p_phone_number: normalizedPhone,
      p_provider: provider,
    });
    if (requestError) return Response.json({ error: requestError.message }, { status: 400 });
    if (!isRecord(requestData) || typeof requestData.transaction_id !== "string") {
      console.error("Deposit RPC returned an invalid transaction.");
      return Response.json({ error: "The deposit request could not be confirmed. Check Records before retrying." }, { status: 502 });
    }
    paymentTransactionId = requestData.transaction_id;

    const { data, error } = await session.client.rpc("begin_marzpay_deposit", {
      p_transaction_id: paymentTransactionId,
    });
    if (error) return Response.json({ error: error.message }, { status: 409 });
    if (!isDepositRecord(data)) {
      console.error("MarzPay deposit RPC returned an invalid transaction.");
      return Response.json({ error: "The deposit request could not be confirmed." }, { status: 502 });
    }

    if (!data.should_submit) {
      if (!data.provider_request_id) {
        return Response.json({
          transactionId: data.transaction_id,
          status: "processing",
          promptSent: false,
          message: "The payment prompt is still being confirmed. Do not retry; check Records again shortly.",
        }, { status: 202 });
      }

      const statusResponse = await requestMarzPay(
        marzPay,
        `transactions/${encodeURIComponent(data.provider_request_id)}`,
        "GET",
      );
      const normalized = normalizeMarzPaySettlement(statusResponse, "deposit");
      if (!normalized) {
        return Response.json({
          transactionId: data.transaction_id,
          status: "processing",
          promptSent: false,
          message: "MarzPay is still confirming this deposit. Check Records again shortly.",
        }, { status: 202 });
      }
      const { error: updateError } = await serviceClient.rpc("apply_marzpay_webhook", {
        p_payload: normalized,
      });
      if (updateError) {
        console.error("MarzPay deposit status could not be applied.", updateError.message);
        return Response.json({ error: "The deposit status could not be refreshed. Try again later." }, { status: 502 });
      }

      return Response.json({
        transactionId: data.transaction_id,
        providerTransactionId: data.provider_request_id,
        status: "processing",
        promptSent: false,
        phoneNumber: data.phone_number,
        message: "The existing MarzPay deposit status was checked.",
      }, { status: 202 });
    }

    const response = await requestMarzPay(marzPay, "collect-money", "POST", {
      amount: data.amount,
      phone_number: data.phone_number,
      reference: data.reference,
      country: "UG",
      description: "Testing Lives deposit",
      callback_url: marzPay.callbackUrl,
    });

    const responseData = isRecord(response) && isRecord(response.data) ? response.data : null;
    const transaction = responseData && isRecord(responseData.transaction) ? responseData.transaction : null;
    const collection = responseData && isRecord(responseData.collection) ? responseData.collection : null;
    const settled = readMarzPaySettledAmount("deposit", transaction, collection);
    const transactionId = transaction?.uuid;
    const transactionReference = transaction?.reference;
    const responsePhone = collection?.phone_number ?? transaction?.phone_number;
    const responseProvider = collection?.provider ?? transaction?.provider;
    const phoneMatches = responsePhone == null
      || (typeof responsePhone === "string" && responsePhone === data.phone_number);
    const providerMatches = responseProvider == null
      || (typeof responseProvider === "string" && responseProvider.toLowerCase() === data.provider);
    const currencyMatches = settled?.currency == null || settled.currency.toUpperCase() === "UGX";
    let submissionRecordError: string | null = null;
    if (isUuid(transactionId)) {
      const { error: recordError } = await serviceClient.rpc("record_marzpay_submission", {
        p_transaction_id: data.transaction_id,
        p_provider_request_id: transactionId,
        p_provider_status: "processing",
        p_failure_reason: null,
      });
      if (recordError) {
        submissionRecordError = recordError.message;
        console.error("MarzPay collection response could not be recorded.", recordError.message);
      }
    }
    if (
      !isUuid(transactionId)
      || transactionReference !== data.reference
      || !settled
      || settled.amount !== data.amount
      || !currencyMatches
      || !phoneMatches
      || !providerMatches
    ) {
      console.error("MarzPay collection response did not match the request.", {
        hasTransactionId: typeof transactionId === "string",
        referenceMatches: transactionReference === data.reference,
        settledAmount: settled?.amount ?? null,
        expectedAmount: data.amount,
        currencyMatches,
        phoneMatches,
        providerMatches,
      });
      return Response.json({ error: "MarzPay returned an unexpected response. Check Records before retrying." }, { status: 502 });
    }

    if (submissionRecordError) {
      return Response.json({
        transactionId: data.transaction_id,
        status: "processing",
        promptSent: true,
        message: "The payment prompt may have been sent. Check Records before retrying.",
      }, { status: 202 });
    }

    return Response.json({
      transactionId: data.transaction_id,
      providerTransactionId: transactionId,
      status: "processing",
      promptSent: true,
      phoneNumber: data.phone_number,
      message: "MarzPay payment prompt sent.",
    }, { status: 202 });
  } catch (error) {
    if (error instanceof PaymentConfigError) {
      return Response.json({ error: "MarzPay is not configured. Contact support." }, { status: 503 });
    }
    if (error instanceof MarzPayApiError) {
      if (paymentTransactionId && [400, 401, 403, 422].includes(error.statusCode)) {
        try {
          const { error: recordError } = await createServiceRoleClient().rpc("fail_marzpay_submission", {
            p_transaction_id: paymentTransactionId,
            p_reason: error.message,
          });
          if (recordError) console.error("Failed MarzPay collection could not be recorded.", recordError.message);
        } catch (recordError) {
          console.error("Failed MarzPay collection could not be recorded.", recordError instanceof Error ? recordError.message : "Unknown error");
        }
      }
      console.error("MarzPay collection initiation failed.", {
        statusCode: error.statusCode,
        errorCode: error.errorCode,
        message: error.message,
      });
    } else {
      console.error("MarzPay collection initiation failed.", error instanceof Error ? error.message : "Unknown error");
    }
    return Response.json({ error: "The payment prompt could not be confirmed. Check Records before retrying." }, { status: 502 });
  }
}
