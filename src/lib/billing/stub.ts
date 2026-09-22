import { AppError } from "../../http/errors.js";
import type { Env } from "../../env.js";
import type {
  CreateIntentInput,
  IntentQuery,
  PaymentIntent,
  PaymentProvider,
  WebhookResult,
} from "./provider.js";

// Development stub adapter. Simulates a hosted redirect flow WITHOUT any
// network, money, or vendor: createIntent returns a local return-URL, and
// the return page POSTs the auto-verifiable token to the real webhook path
// below, so the full success/failure/replay machinery is exercised.
//
// The stub token is HMAC-bound to the intent id with a fixed DEV-ONLY key.
// verifyWebhook accepts it ONLY when ENVIRONMENT is development; anywhere
// else the stub path fails closed (unknown token -> 400), exactly like an
// unsigned real webhook. Nothing secret is ever logged (method+path+status
// +intent_id at most — see routes/billing.ts).

const STUB_DEV_KEY = "salla-syria-stub-dev-only-not-a-secret";

async function hmacHex(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(data)
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function stubTokenFor(intentId: string): Promise<string> {
  const sig = await hmacHex(STUB_DEV_KEY, intentId);
  return `${intentId}.${sig}`;
}

async function stubTokenValid(token: string): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const intentId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (intentId.length === 0 || intentId.length > 200) return null;
  const expected = await hmacHex(STUB_DEV_KEY, intentId);
  return timingSafeEqual(sig, expected) ? intentId : null;
}

export const stubProvider: PaymentProvider = {
  name: "stub",

  async createIntent(input: CreateIntentInput): Promise<PaymentIntent> {
    const token = await stubTokenFor(input.intentId);
    const sep = input.returnUrl.includes("?") ? "&" : "?";
    return {
      intentId: input.intentId,
      redirectUrl:
        `${input.returnUrl}${sep}intent=${encodeURIComponent(input.intentId)}` +
        `&stub_token=${encodeURIComponent(token)}`,
    };
  },

  async verifyWebhook(req: Request, env: Env): Promise<WebhookResult> {
    if ((env.ENVIRONMENT ?? "development") !== "development") {
      throw new AppError(
        "webhook_rejected",
        400,
        "Unknown or invalid webhook signature."
      );
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new AppError("invalid_webhook", 400, "Invalid webhook payload.");
    }
    const { intent_id, stub_token, result } = (body ?? {}) as {
      intent_id?: unknown;
      stub_token?: unknown;
      result?: unknown;
    };
    if (typeof intent_id !== "string" || typeof stub_token !== "string") {
      throw new AppError("invalid_webhook", 400, "Invalid webhook payload.");
    }
    const bound = await stubTokenValid(stub_token);
    if (bound === null || bound !== intent_id) {
      throw new AppError(
        "webhook_rejected",
        400,
        "Unknown or invalid webhook signature."
      );
    }
    return {
      intentId: intent_id,
      success: result !== "failed",
      // Stub reports no amount/currency: the service settles on the row.
      eventId: `stub:${stub_token}`,
    };
  },

  async queryIntent(): Promise<IntentQuery> {
    // The stub keeps no provider-side state; the service answers polling
    // from the intent row instead. This satisfies the interface.
    throw new AppError(
      "intent_unknown",
      404,
      "Stub intents are tracked in the local row only."
    );
  },
};
