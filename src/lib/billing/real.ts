import { AppError } from "../../http/errors.js";
import type { Env } from "../../env.js";
import type {
  CreateIntentInput,
  IntentQuery,
  PaymentIntent,
  PaymentProvider,
  WebhookResult,
} from "./provider.js";

// ===================================================================
// REAL PROVIDER SKELETON — insertion point for the future gateway.
// ===================================================================
// This file implements the PaymentProvider interface against a GENERIC
// redirect + HMAC-webhook flow. It is deliberately vendor-free: NO vendor
// SDK is imported anywhere in the repo. Going live with a real gateway is
// a keys-only operation (see docs/BILLING-KEYS.md):
//
//   1. Set secrets:  PROVIDER_API_KEY, PROVIDER_WEBHOOK_SECRET,
//                    PROVIDER_BASE_URL (see .dev.vars.example key names).
//   2. Set var:      PAYMENT_PROVIDER=real (default is "stub").
//   3. Register at the vendor dashboard (redirect/hosted flow only — we
//      never accept card data): the webhook URL is
//      https://<api-domain>/billing/webhook/real
//   4. (Code, later) If the chosen vendor's create/session call differs
//      from the generic shape below, adapt ONLY the marked VENDOR HOOK
//      blocks in this file. Nothing else in the billing stack changes.
//
// Until keys arrive every method here fails closed with 503 (never
// fail-open, never a half-charged state).

function requireKeys(env: Env): {
  apiKey: string;
  webhookSecret: string;
  baseUrl: string;
} {
  const apiKey = env.PROVIDER_API_KEY;
  const webhookSecret = env.PROVIDER_WEBHOOK_SECRET;
  const baseUrl = env.PROVIDER_BASE_URL;
  if (!apiKey || !webhookSecret || !baseUrl) {
    throw new AppError(
      "payment_unavailable",
      503,
      "Payment provider is not configured."
    );
  }
  return { apiKey, webhookSecret, baseUrl };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const realProvider: PaymentProvider = {
  name: "real",

  async createIntent(
    input: CreateIntentInput,
    env: Env
  ): Promise<PaymentIntent> {
    const { baseUrl } = requireKeys(env);
    // ---- VENDOR HOOK (create) -------------------------------------
    // Replace this generic redirect with the vendor's hosted-session call
    // (server-to-server POST with PROVIDER_API_KEY, read the approval URL
    // from the vendor response). Keep returning { intentId, redirectUrl }
    // and keep redirect/hosted-only: never accept card fields here.
    // ---------------------------------------------------------------
    const params = new URLSearchParams({
      intent: input.intentId,
      amount: String(input.amount),
      currency: input.currency,
      return: input.returnUrl,
      cancel: input.cancelUrl,
    });
    return {
      intentId: input.intentId,
      redirectUrl: `${baseUrl.replace(/\/+$/, "")}/pay?${params.toString()}`,
    };
  },

  async verifyWebhook(req: Request, env: Env): Promise<WebhookResult> {
    const { webhookSecret } = requireKeys(env);
    // ---- VENDOR HOOK (webhook shape) ------------------------------
    // Adjust ONLY these three extractions to the vendor's event schema:
    // event id, intent reference, and outcome/amount/currency. Everything
    // below (timestamp window, replay cache, HMAC check) stays generic.
    // ---------------------------------------------------------------
    const signature = req.headers.get("X-Provider-Signature") ?? "";
    const timestamp = req.headers.get("X-Provider-Timestamp") ?? "";
    const raw = await req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new AppError("invalid_webhook", 400, "Invalid webhook payload.");
    }
    const event = (body ?? {}) as {
      id?: unknown;
      intent_id?: unknown;
      status?: unknown;
      amount?: unknown;
      currency?: unknown;
    };
    if (typeof event.id !== "string" || typeof event.intent_id !== "string") {
      throw new AppError("invalid_webhook", 400, "Invalid webhook payload.");
    }
    // Timestamp window: replayed captures outside ±5 minutes die here.
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
      throw new AppError("webhook_rejected", 400, "Stale webhook event.");
    }
    const expected = await hmacHex(webhookSecret, `${timestamp}.${raw}`);
    if (!timingSafeEqual(signature, expected)) {
      throw new AppError(
        "webhook_rejected",
        400,
        "Unknown or invalid webhook signature."
      );
    }
    const amount =
      typeof event.amount === "number" ? event.amount : undefined;
    const currency =
      typeof event.currency === "string" ? event.currency : undefined;
    return {
      intentId: event.intent_id,
      success: event.status === "succeeded",
      amount,
      currency,
      eventId: `real:${event.id}`,
      providerRef: typeof event.id === "string" ? event.id : undefined,
    };
  },

  async queryIntent(
    _intentId: string,
    env: Env
  ): Promise<IntentQuery> {
    requireKeys(env);
    // ---- VENDOR HOOK (query) --------------------------------------
    // Server-side reconciliation against the vendor (GET intent/session
    // with PROVIDER_API_KEY). Unimplemented until a vendor is chosen;
    // polling is served from the intent row, so nothing depends on this.
    // (501 is outside the AppError status union by design — every client-
    // visible error stays inside the documented envelope set.)
    // ---------------------------------------------------------------
    throw new AppError(
      "intent_unknown",
      503,
      "Provider-side intent lookup is not implemented for this gateway."
    );
  },
};
