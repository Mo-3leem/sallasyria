import type { Env } from "../../env.js";

// Payment provider contract (Phase 8). Money NEVER flows through our
// servers: providers work by redirect (merchant goes to the provider,
// provider calls our webhook). No card data, no PAN, no auto-charge —
// renewals are new intents, never stored credentials.
//
// Amount integrity rule (binding): the intent row carries the SERVER price.
// Adapters may report what the provider charged (real), or nothing (stub);
// the service activates ONLY when reported amounts match the row, or when
// nothing was reported. A tampered amount can never activate a period.

export interface CreateIntentInput {
  intentId: string;
  storeId: string;
  storeName: string;
  planId: string;
  planName: string;
  billingPeriod: "monthly" | "yearly";
  amount: number;
  currency: string;
  /** Where the provider sends the merchant back afterwards. */
  returnUrl: string;
  /** Where the provider sends the merchant on cancel. */
  cancelUrl: string;
}

export interface PaymentIntent {
  intentId: string;
  redirectUrl: string;
}

export interface WebhookResult {
  intentId: string;
  success: boolean;
  /** Charged amount as reported by the provider; undefined = not reported. */
  amount?: number;
  /** Charged currency as reported by the provider; undefined = not reported. */
  currency?: string;
  /** Provider event id for replay-cache (duplicate deliveries collapse). */
  eventId: string;
  providerRef?: string;
}

export interface IntentQuery {
  status: "pending" | "succeeded" | "failed" | "expired";
  amount: number;
  currency: string;
}

export interface PaymentProvider {
  readonly name: string;
  createIntent(input: CreateIntentInput, env: Env): Promise<PaymentIntent>;
  verifyWebhook(req: Request, env: Env): Promise<WebhookResult>;
  queryIntent(intentId: string, env: Env): Promise<IntentQuery>;
}
