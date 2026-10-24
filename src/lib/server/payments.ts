import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";

export class PaymentConfigError extends Error {}

export class MarzPayApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly errorCode: string | null,
  ) {
    super(message);
  }
}

export type MarzPayConfig = {
  apiBase: string;
  authorization: string;
  callbackUrl: string;
};

export function createMarzPayConfig(): MarzPayConfig {
  const apiKey = process.env.MARZPAY_API_KEY;
  const apiSecret = process.env.MARZPAY_API_SECRET;
  const apiBase = process.env.MARZPAY_API_BASE || "https://wallet.wearemarz.com/api/v1";
  const callbackUrl = process.env.MARZPAY_CALLBACK_URL;
  if (!apiKey || !apiSecret || !callbackUrl) {
    throw new PaymentConfigError("MarzPay server configuration is incomplete.");
  }

  let parsedCallbackUrl: URL;
  try {
    parsedCallbackUrl = new URL(callbackUrl);
  } catch {
    throw new PaymentConfigError("MarzPay callback URL is invalid.");
  }
  if (parsedCallbackUrl.protocol !== "https:" || parsedCallbackUrl.username || parsedCallbackUrl.password) {
    throw new PaymentConfigError("MarzPay callback URL must be an HTTPS URL.");
  }

  let parsedApiBase: URL;
  try {
    parsedApiBase = new URL(apiBase);
  } catch {
    throw new PaymentConfigError("MarzPay API base URL is invalid.");
  }
  if (parsedApiBase.protocol !== "https:" || parsedApiBase.username || parsedApiBase.password) {
    throw new PaymentConfigError("MarzPay API base URL must be an HTTPS URL.");
  }

  return {
    apiBase: parsedApiBase.toString().replace(/\/+$/, ""),
    authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`,
    callbackUrl: parsedCallbackUrl.toString(),
  };
}

export async function requestMarzPay(
  config: MarzPayConfig,
  path: string,
  method: "GET" | "POST",
  payload?: Record<string, unknown>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${config.apiBase}/${path.replace(/^\/+/, "")}`, {
      method,
      headers: {
        Authorization: config.authorization,
        Accept: "application/json",
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      cache: "no-store",
    });
  } catch (error) {
    throw new Error("Could not connect to MarzPay.", { cause: error });
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new MarzPayApiError("MarzPay returned an invalid response.", response.status, null);
  }

  if (!isRecord(result)) {
    throw new MarzPayApiError("MarzPay returned an unexpected response.", response.status, null);
  }
  if (!response.ok || result.status === "error") {
    throw new MarzPayApiError(
      typeof result.message === "string" ? result.message : "MarzPay rejected the request.",
      response.status,
      typeof result.error_code === "string" ? result.error_code : null,
    );
  }
  return result;
}

export type MarzPayPaymentKind = "deposit" | "withdraw";

export type MarzPayWebhookVerification = "valid" | "invalid" | "absent" | "unconfigured";

export function verifyMarzPayWebhookSignature(
  rawBody: string,
  headers: Headers,
): MarzPayWebhookVerification {
  const secret = process.env.MARZPAY_WEBHOOK_SECRET;
  if (!secret) return "unconfigured";

  const signature = headers.get("x-marzpay-signature");
  if (!signature) return "absent";
  const timestamp = headers.get("x-marzpay-timestamp")
    ?? signature.match(/(?:^|,)\s*t=(\d+)\s*(?=,|$)/)?.[1]
    ?? null;

  const candidates = new Set<string>();
  for (const match of signature.matchAll(/(?:^|,)\s*(?:v1=)?([a-f0-9]{64})\s*(?=,|$)/gi)) {
    candidates.add(match[1].toLowerCase());
  }
  const direct = signature.trim().match(/^(?:sha256=)?([a-f0-9]{64})$/i);
  if (direct) candidates.add(direct[1].toLowerCase());
  if (candidates.size === 0) return "invalid";

  const messages = [rawBody];
  if (timestamp) messages.push(`${timestamp}.${rawBody}`, `${rawBody}.${timestamp}`);
  const signedTimestamp = signature.match(/(?:^|,)\s*t=(\d+)\s*(?=,|$)/)?.[1];
  if (signedTimestamp) messages.push(`${signedTimestamp}.${rawBody}`);

  const valid = [...candidates].some((candidate) => {
    const received = Buffer.from(candidate, "hex");
    return messages.some((message) => {
      const expected = createHmac("sha256", secret).update(message).digest();
      return received.length === expected.length && timingSafeEqual(received, expected);
    });
  });
  if (!valid) return "invalid";

  if (timestamp && /^\d+$/.test(timestamp)) {
    const seconds = Number(timestamp);
    if (!Number.isSafeInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) {
      return "invalid";
    }
  }
  return "valid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readMoney(value: unknown): { raw: number; currency: string | null } | null {
  if (!isRecord(value)) return null;
  const raw = readNumber(value.raw);
  if (raw === null) return null;
  return { raw, currency: typeof value.currency === "string" ? value.currency : null };
}

/**
 * MarzPay quotes collections gross (amount) with the customer-paid charge added.
 * The merchant's stored deposit is the net amount, so prefer net_amount or gross - charge.
 */
export function readMarzPaySettledAmount(
  kind: MarzPayPaymentKind,
  transaction: unknown,
  product: unknown,
): { amount: number; currency: string | null } | null {
  const tx = isRecord(transaction) ? transaction : {};
  const item = isRecord(product) ? product : {};
  const txAmount = readMoney(tx.amount);
  const txCharge = readMoney(tx.charge);
  const txNet = readMoney(tx.net_amount);
  const itemAmount = readMoney(item.amount);
  const itemCharge = readMoney(item.charge);
  const itemNet = readMoney(item.net_amount);

  let amount: number | null;
  let currency: string | null;
  if (kind === "deposit") {
    amount = txNet?.raw ?? itemNet?.raw
      ?? (txAmount && txCharge ? txAmount.raw - txCharge.raw : null)
      ?? (itemAmount && itemCharge ? itemAmount.raw - itemCharge.raw : null)
      ?? txAmount?.raw ?? itemAmount?.raw ?? null;
    currency = txNet?.currency ?? itemNet?.currency ?? txAmount?.currency ?? itemAmount?.currency ?? null;
  } else {
    amount = txAmount?.raw ?? itemAmount?.raw ?? txNet?.raw ?? itemNet?.raw ?? null;
    currency = txAmount?.currency ?? itemAmount?.currency ?? txNet?.currency ?? itemNet?.currency ?? null;
  }

  if (amount === null || amount <= 0) return null;
  return { amount, currency };
}

function unwrapMarzPayData(payload: unknown): unknown {
  if (!isRecord(payload)) return null;
  return isRecord(payload.data) ? payload.data : payload;
}

function marzPayEventType(payload: unknown, root: unknown): string {
  const fromPayload = isRecord(payload) && typeof payload.event_type === "string" ? payload.event_type : null;
  const fromRoot = isRecord(root) && typeof root.event_type === "string" ? root.event_type : null;
  return (fromPayload ?? fromRoot ?? "").trim().toLowerCase();
}

function readMarzPayStatus(value: unknown): "pending" | "completed" | "failed" | null {
  if (typeof value !== "string") return null;
  const status = value.trim().toLowerCase();
  if (["completed", "complete", "successful", "success", "paid", "settled"].includes(status)) return "completed";
  if (["failed", "failure", "cancelled", "canceled", "rejected", "declined", "reversed", "expired"].includes(status)) return "failed";
  if (["pending", "processing", "initiated", "queued", "submitted", "in_progress", "inprogress"].includes(status)) return "pending";
  return null;
}

export function detectMarzPayPaymentKind(payload: unknown): MarzPayPaymentKind | null {
  const root = unwrapMarzPayData(payload);
  if (!isRecord(root)) return null;
  const eventType = marzPayEventType(payload, root);
  if (eventType.startsWith("collection.")) return "deposit";
  if (eventType.startsWith("disbursement.")) return "withdraw";
  if (isRecord(root.collection)) return "deposit";
  if (isRecord(root.disbursement) || isRecord(root.withdrawal)) return "withdraw";
  return null;
}

export function extractMarzPayReference(payload: unknown, kind: MarzPayPaymentKind): string | null {
  const root = unwrapMarzPayData(payload);
  if (!isRecord(root) || !isRecord(root.transaction)) return null;
  const transaction = root.transaction;
  if (kind === "deposit") {
    return typeof transaction.reference === "string" && transaction.reference.trim()
      ? transaction.reference.trim()
      : null;
  }
  const reference = typeof transaction.provider_reference === "string" && transaction.provider_reference.trim()
    ? transaction.provider_reference
    : transaction.reference;
  return typeof reference === "string" && reference.trim() ? reference.trim() : null;
}

/**
 * Convert MarzPay create/status/webhook payloads into the callback shape that
 * apply_marzpay_webhook expects, using the merchant net amount for deposits.
 */
export function normalizeMarzPaySettlement(
  payload: unknown,
  kind: MarzPayPaymentKind,
): Record<string, unknown> | null {
  const root = unwrapMarzPayData(payload);
  if (!isRecord(root) || !isRecord(root.transaction)) return null;
  const transaction = root.transaction;
  if (!isRecord(transaction)) return null;

  const eventType = marzPayEventType(payload, root);
  const prefix = kind === "deposit" ? "collection" : "disbursement";
  const eventStatus = eventType.startsWith(`${prefix}.`) ? eventType.slice(prefix.length + 1) : "";
  const status = readMarzPayStatus(eventStatus)
    ?? (eventType === "success" ? "completed" : eventType === "failure" ? "failed" : null)
    ?? readMarzPayStatus(transaction.status)
    ?? readMarzPayStatus(root.status);
  if (!status) return null;

  const uuid = typeof transaction.uuid === "string" && transaction.uuid.trim() ? transaction.uuid.trim() : null;
  if (!uuid) return null;

  const reference = extractMarzPayReference(payload, kind);
  if (!reference) return null;

  const product = kind === "deposit" && isRecord(root.collection)
    ? root.collection
    : kind === "withdraw" && isRecord(root.disbursement)
      ? root.disbursement
      : kind === "withdraw" && isRecord(root.withdrawal)
        ? root.withdrawal
        : {};
  const settled = readMarzPaySettledAmount(kind, transaction, product);
  if (!settled) return null;

  const provider = (
    typeof transaction.provider === "string" ? transaction.provider
      : typeof product.provider === "string" ? product.provider
        : ""
  ).trim().toLowerCase() || null;
  const phone = typeof transaction.phone_number === "string"
    ? transaction.phone_number
    : typeof product.phone_number === "string" ? product.phone_number : null;
  const providerTransactionId = typeof product.provider_transaction_id === "string"
    && product.provider_transaction_id.trim()
    && product.provider_transaction_id.trim().toLowerCase() !== "na"
    ? product.provider_transaction_id.trim()
    : null;

  const normalizedTransaction: Record<string, unknown> = {
    uuid,
    reference: typeof transaction.reference === "string" ? transaction.reference : reference,
    provider_reference: typeof transaction.provider_reference === "string"
      ? transaction.provider_reference
      : kind === "withdraw" ? reference : undefined,
    status,
    amount: { raw: settled.amount, currency: settled.currency ?? "UGX" },
    ...(provider ? { provider } : {}),
    ...(phone ? { phone_number: phone } : {}),
  };
  const normalizedProduct: Record<string, unknown> = {
    amount: { raw: settled.amount, currency: settled.currency ?? "UGX" },
    ...(providerTransactionId ? { provider_transaction_id: providerTransactionId } : {}),
    ...(provider ? { provider } : {}),
    ...(phone ? { phone_number: phone } : {}),
  };

  return {
    event_type: `${prefix}.${status}`,
    transaction: normalizedTransaction,
    [prefix]: normalizedProduct,
  };
}

export function createServiceRoleClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new PaymentConfigError("Supabase server configuration is incomplete.");
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function authenticateRequest(request: Request): Promise<{
  client: SupabaseClient;
  user: User;
} | null> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!token || !url || !anonKey) return null;

  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return { client, user: data.user };
}
