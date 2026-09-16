import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { classifyDbError, getDb } from "../db.js";
import { storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, zBodyValidator } from "../http/validate.js";
import { GOVERNORATES } from "../lib/governorates.js";
import { retryTransient } from "../lib/retry.js";
import { requireTurnstile } from "../middleware/turnstile.js";
import { limitPublicMutations } from "../middleware/public.js";
import { resolveStore } from "../middleware/store.js";
import { requireActiveSubscription } from "../middleware/subscription.js";
import { checkout } from "../services/checkout.js";

export const checkoutRouter = new Hono<AppEnv>();

// NOTE (type-level boundary): zero SQL strings here; scoping only from
// storeScope(c). Enforced by tests/tenant-conventions.test.ts.
//
// PUBLIC buyer endpoint (no buyer login exists): resolveStore scoping +
// per-store rate limit + subscription gate (expired stores cannot sell) +
// Turnstile, in that cost order. The whole handler body is retried on
// transient D1 contention ONLY — safe because the idempotency key makes
// repeats resolve to one order (validated H1/H6 reviews).

const buyerCheckout = [
  resolveStore,
  limitPublicMutations,
  requireActiveSubscription,
  requireTurnstile(),
] as const;

const emailSchema = z.string().email().max(254).nullable().default(null);

const checkoutSchema = z.object({
  customer: z.object({
    name: z.string().min(1).max(200),
    phone: z.string().min(1).max(64),
    email: emailSchema.optional(),
  }),
  items: z
    .array(
      z.object({
        product_id: z.string().min(1),
        quantity: z.number().int().min(1).max(999),
        selected_options: z.string().max(500).nullable().default(null),
      })
    )
    .min(1)
    .max(100),
  shipping: z.object({
    recipient_name: z.string().min(1).max(200),
    phone: z.string().min(1).max(64),
    governorate: z.enum(GOVERNORATES),
    city: z.string().max(200).nullable().default(null),
    address_line: z.string().min(1).max(500),
  }),
  payment: z.object({
    method: z.enum(["cod", "bank_transfer", "wallet"]),
    reference: z.string().max(200).nullable().default(null),
  }),
});

// Totals are server-computed, always: any client-supplied money is rejected
// outright (fail-closed beats ignore-silently — a silently dropped discount
// trains clients to believe it applied).
const FORBIDDEN = ["store_id", "id", "subtotal", "total", "discount", "order_number"] as const;

export const IDEMPOTENCY_HEADER = "X-Idempotency-Key";

checkoutRouter.post("/", ...buyerCheckout, zBodyValidator(checkoutSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  const key = c.req.header(IDEMPOTENCY_HEADER) ?? null;
  const input = c.req.valid("json");
  try {
    const result = await retryTransient(() =>
      checkout(getDb(c), storeId, {
        customer: { name: input.customer.name, phone: input.customer.phone, email: input.customer.email ?? null },
        items: input.items.map((l) => ({
          product_id: l.product_id,
          quantity: l.quantity,
          selected_options: l.selected_options ?? null,
        })),
        shipping: {
          recipient_name: input.shipping.recipient_name,
          phone: input.shipping.phone,
          governorate: input.shipping.governorate,
          city: input.shipping.city ?? null,
          address_line: input.shipping.address_line,
        },
        payment: { method: input.payment.method, reference: input.payment.reference ?? null },
      }, key)
    );
    return ok(c, { order: result.order, items: result.items, replayed: result.replayed }, result.replayed ? 200 : 201);
  } catch (err) {
    // Retry budget exhausted on a STILL-transient failure: tell the client to
    // come back instead of serving a sanitized 500 with no guidance.
    if (classifyDbError(err).retryable) {
      c.header("Retry-After", "2");
      throw new AppError("temporarily_unavailable", 503, "Checkout is busy. Please retry.");
    }
    throw err;
  }
});
