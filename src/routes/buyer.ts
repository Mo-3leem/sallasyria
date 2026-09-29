import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { appUrl } from "../env.js";
import { getDb } from "../db.js";
import { storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, validationHook } from "../http/validate.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { idParam, turnstileTokenHeader } from "../openapi/params.js";
import { GOVERNORATES } from "../lib/governorates.js";
import { PASSWORD_RULES } from "../lib/password.js";
import {
  BUYER_COOKIE,
  buildClearCookie,
  buildSetCookie,
  getCookieToken,
  SESSION_ABSOLUTE_MS,
} from "../lib/session.js";
import { limitPublicMutations } from "../middleware/public.js";
import { resolvePublishedStoreBySlug } from "../middleware/store.js";
import { requireTurnstile } from "../middleware/turnstile.js";
import { currentBuyer, currentBuyerSessionId, requireBuyer } from "../middleware/buyer.js";
import {
  changeBuyerPassword,
  createBuyerSession,
  findAccountByEmail,
  buyerStoreOf,
  loginBuyer,
  markBuyerVerified,
  publicBuyer,
  registerBuyer,
  resolveBuyerSession,
  revokeBuyerSession,
  setBuyerPassword,
  updateBuyerName,
} from "../services/buyers.js";
import {
  issueBuyerToken,
  redeemBuyerToken,
  VERIFY_TOKEN_TTL_MS,
  RESET_TOKEN_TTL_MS,
} from "../services/buyer-tokens.js";
import {
  accountCart,
  addCartItem,
  createCart,
  getCart,
  getCartLines,
  mergeGuestCart,
  setCartItemQty,
} from "../services/buyer-cart.js";
import {
  listCustomerOrders,
} from "../services/orders.js";
import {
  createAddress,
  deleteAddress,
  getAddress,
  listAddresses,
  makeDefaultAddress,
  updateAddress,
} from "../services/customers.js";
import { sendMail, dispatchMail } from "../services/mail.js";
import { hashEmailToken } from "../services/email-tokens.js";
import { checkForgotTargetLimit } from "../lib/rate-limit.js";
import { cookieSameSite } from "./auth.js";

export const buyer = new OpenAPIHono<AppEnv>();

// NOTE (type-level boundary): zero SQL strings here; scoping only from
// storeScope(c). Buyer routes resolve the store from the public slug and
// mount resolvePublishedStoreBySlug, so draft slugs 404 identically to
// missing ones. Guest checkout stays fully open; accounts are optional
// convenience + history, never a gate.

// cookieSecure mirrors auth.ts: Secure cookies in every non-development
// environment (required for SameSite=None, harmless same-origin).
function cookieSecure(c: { env: { ENVIRONMENT?: string } }): boolean {
  return (c.env.ENVIRONMENT ?? "development") !== "development";
}

function buyerSetCookie(c: Parameters<typeof cookieSameSite>[0], token: string): string {
  return buildSetCookie(token, {
    secure: cookieSecure(c),
    maxAgeSec: Math.floor(SESSION_ABSOLUTE_MS / 1000),
    sameSite: cookieSameSite(c),
    name: BUYER_COOKIE,
  });
}

function buyerClearCookie(c: Parameters<typeof cookieSameSite>[0]): string {
  return buildClearCookie({ secure: cookieSecure(c), sameSite: cookieSameSite(c), name: BUYER_COOKIE });
}

const slugParam = z
  .string()
  .min(1)
  .max(200)
  .openapi({ param: { name: "slug", in: "path" }, example: "demo-store" });
const slugParams = z.object({ slug: slugParam });
// cartId/itemId need their own documented names: the shared idParam
// hardcodes param name "id", which would collide with the path template.
const cartIdParam = z
  .string()
  .min(1)
  .openapi({ param: { name: "cartId", in: "path" }, example: "cart_01J..." });
const itemIdParam = z
  .string()
  .min(1)
  .openapi({ param: { name: "itemId", in: "path" }, example: "item_01J..." });

const buyerDocSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    phone: z.string(),
    email: z.string().nullable(),
    email_verified: z.boolean(),
  })
  .openapi("BuyerAccount");
const buyerOkSchema = okOf(z.object({ buyer: buyerDocSchema }));

const storeMw = [resolvePublishedStoreBySlug, limitPublicMutations] as const;
const accountMutating = [...storeMw, requireTurnstile()] as const;
const authed = [...storeMw, requireBuyer] as const;
// Guest cart mutations farm rows with a bare capability id, so they carry
// the same bot check as account mutations. Reads stay open; account carts
// stay on the session-only authed stack.
const guestCartMutating = [...storeMw, requireTurnstile()] as const;

const passwordSchema = z
  .string()
  .min(PASSWORD_RULES.minNewChars)
  .max(PASSWORD_RULES.maxChars)
  .openapi({ example: "Correct-Horse-9x!" });

// --- registration / login / logout ------------------------------------------

const registerSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(64),
  email: z.string().trim().email().max(254).nullish(),
  password: passwordSchema,
});
const REGISTER_FORBIDDEN = ["id", "store_id", "email_verified"] as const;

const registerRoute = createRoute({
  method: "post",
  path: "/:slug/account/register",
  summary: "Register a buyer account (or claim a guest row)",
  description:
    "Public buyer registration (Turnstile + rate limit). Registering with the " +
    "phone of a guest row converts it to an account, retaining order/address " +
    "history; a phone already owned by an account is 409. Mints a buyer session.",
  middleware: [...accountMutating],
  request: {
    params: slugParams,
    headers: turnstileTokenHeader,
    body: { content: { "application/json": { schema: registerSchema } } },
  },
  responses: {
    201: { content: { "application/json": { schema: okOf(z.object({ buyer: buyerDocSchema, converted: z.boolean() })) } }, description: "Account created" },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Bot verification failed" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown or draft store" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Phone or email taken" },
    429: { content: { "application/json": { schema: failEnvelope } }, description: "Rate limited" },
  },
});

buyer.openapi(registerRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, REGISTER_FORBIDDEN);
  const { storeId } = storeScope(c);
  const input = c.req.valid("json");
  const { buyer: row, converted } = await registerBuyer(getDb(c), storeId, {
    name: input.name,
    phone: input.phone,
    email: input.email ?? null,
    password: input.password,
  });
  const { token } = await createBuyerSession(getDb(c), row.id);
  c.header("Set-Cookie", buyerSetCookie(c, token));
  // Verification email is best-effort (never fails registration).
  if (row.email) {
    try {
      const issued = await issueBuyerToken(getDb(c), row.id, "verify_email", VERIFY_TOKEN_TTL_MS);
      const link = `${appUrl(c.env)}/s/${c.req.valid("param").slug}/account/verify-email?token=${issued.token}`;
      dispatchMail(
        c,
        sendMail(
          { to: row.email, subject: `Verify your email at ${c.req.valid("param").slug}`, text: `Verify your email: ${link}\nToken: ${issued.token}` },
          { apiKey: c.env.SENDGRID_API_KEY, from: c.env.MAIL_FROM }
        )
      );
    } catch {
      // Fall through to the normal 201 below.
    }
  }
  return ok(c, { buyer: publicBuyer(row), converted }, 201);
}, validationHook);

const loginSchema = z.object({
  identity: z.string().min(1).max(254).openapi({ example: "+963991234567" }),
  password: z.string().min(1).max(PASSWORD_RULES.maxChars),
});

const loginRoute = createRoute({
  method: "post",
  path: "/:slug/account/login",
  summary: "Buyer login (email or phone)",
  description:
    "Public buyer login (Turnstile + rate limit). Unknown identity, guest " +
    "row, and wrong password answer with an identical 404. Mints a buyer session.",
  middleware: [...accountMutating],
  request: {
    params: slugParams,
    headers: turnstileTokenHeader,
    body: { content: { "application/json": { schema: loginSchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: buyerOkSchema } }, description: "Logged in" },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Bot verification failed" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or invalid credentials" },
    429: { content: { "application/json": { schema: failEnvelope } }, description: "Rate limited" },
  },
});

buyer.openapi(loginRoute, async (c) => {
  const { storeId } = storeScope(c);
  const input = c.req.valid("json");
  const row = await loginBuyer(getDb(c), storeId, input.identity, input.password);
  const { token } = await createBuyerSession(getDb(c), row.id);
  c.header("Set-Cookie", buyerSetCookie(c, token));
  return ok(c, { buyer: publicBuyer(row) });
}, validationHook);

const logoutRoute = createRoute({
  method: "post",
  path: "/:slug/account/logout",
  summary: "Buyer logout",
  description: "Revokes the current buyer session; idempotent.",
  middleware: [...storeMw],
  request: { params: slugParams },
  responses: {
    200: { content: { "application/json": { schema: okOf(z.object({ logged_out: z.boolean() })) } }, description: "Logged out" },
  },
});

buyer.openapi(logoutRoute, async (c) => {
  // No requireBuyer here: logout must be idempotent with a stale cookie.
  // Resolve manually; unknown/expired tokens simply clear the cookie.
  const raw = getCookieToken(c.req.header("Cookie") ?? null, BUYER_COOKIE);
  if (raw) {
    const session = await resolveBuyerSession(getDb(c), raw);
    if (session) {
      await revokeBuyerSession(getDb(c), session.id);
    }
  }
  c.header("Set-Cookie", buyerClearCookie(c));
  return ok(c, { logged_out: true });
}, validationHook);

// --- me / patch ---------------------------------------------------------------

const meRoute = createRoute({
  method: "get",
  path: "/:slug/account/me",
  summary: "Current buyer profile",
  middleware: [...authed],
  request: { params: slugParams },
  responses: {
    200: { content: { "application/json": { schema: buyerOkSchema } }, description: "Profile" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store" },
  },
});

buyer.openapi(meRoute, async (c) => {
  return ok(c, { buyer: currentBuyer(c) });
}, validationHook);

const mePatchSchema = z.object({ name: z.string().min(1).max(200) });
const ME_PATCH_FORBIDDEN = ["id", "store_id", "phone", "email", "email_verified", "password_hash"] as const;

const mePatchRoute = createRoute({
  method: "patch",
  path: "/:slug/account/me",
  summary: "Update buyer name",
  description: "Name-only self update. Phone/email/password never change here.",
  middleware: [...authed],
  request: {
    params: slugParams,
    body: { content: { "application/json": { schema: mePatchSchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: buyerOkSchema } }, description: "Updated" },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
  },
});

buyer.openapi(mePatchRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ME_PATCH_FORBIDDEN);
  const buyer = currentBuyer(c);
  const row = await updateBuyerName(getDb(c), buyer.id, c.req.valid("json").name);
  return ok(c, { buyer: publicBuyer(row) });
}, validationHook);

// --- verify / forgot / reset ----------------------------------------------------

const tokenBodySchema = z.object({ token: z.string().min(1).max(200) });

const verifyRoute = createRoute({
  method: "post",
  path: "/:slug/account/verify-email",
  summary: "Verify buyer email",
  description: "Single-use CAS redeem; unknown/expired/used tokens are an identical 404.",
  middleware: [...storeMw],
  request: {
    params: slugParams,
    body: { content: { "application/json": { schema: tokenBodySchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: okOf(z.object({ verified: z.boolean() })) } }, description: "Verified" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid token or store" },
  },
});

buyer.openapi(verifyRoute, async (c) => {
  const { storeId } = storeScope(c);
  const redeemed = await redeemBuyerToken(getDb(c), c.req.valid("json").token, "verify_email");
  if (!redeemed) throw new AppError("token_invalid", 404, "Invalid or expired token.");
  // Token-store binding: a token minted for another store is useless here.
  if ((await buyerStoreOf(getDb(c), redeemed.customer_id)) !== storeId) {
    throw new AppError("token_invalid", 404, "Invalid or expired token.");
  }
  await markBuyerVerified(getDb(c), redeemed.customer_id);
  return ok(c, { verified: true });
}, validationHook);

const forgotSchema = z.object({ identity: z.string().min(1).max(254) });

const forgotRoute = createRoute({
  method: "post",
  path: "/:slug/account/forgot-password",
  summary: "Request buyer password reset",
  description: "Always 200 with accepted:true: existence of the account is never revealed. Per-target mail cap (5/hour) plus the shared IP+store limit bound floods.",
  middleware: [...accountMutating],
  request: {
    params: slugParams,
    headers: turnstileTokenHeader,
    body: { content: { "application/json": { schema: forgotSchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: okOf(z.object({ accepted: z.boolean() })) } }, description: "Accepted" },
    429: { content: { "application/json": { schema: failEnvelope } }, description: "Too many attempts" },
  },
});

buyer.openapi(forgotRoute, async (c) => {
  const { storeId } = storeScope(c);
  const identity = c.req.valid("json").identity.trim();
  // Per-target mail-bomb cap (recovery-mail class: 5/hour, same as public
  // resend): counted for every request including unknown targets, so IP
  // rotation cannot flood one address. Keyed by hash; the raw target never
  // lands in limiter state or logs. IP+store limit already ran in middleware.
  if (!checkForgotTargetLimit(await hashEmailToken(identity.toLowerCase()))) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  try {
    // Reset needs a deliverable email: phone-only accounts cannot reset,
    // and the outcome stays indistinguishable regardless.
    const row = identity.includes("@")
      ? await findAccountByEmail(getDb(c), storeId, identity)
      : null;
    if (row) {
      const issued = await issueBuyerToken(getDb(c), row.id, "reset_password", RESET_TOKEN_TTL_MS);
      const link = `${appUrl(c.env)}/s/${c.req.valid("param").slug}/account/reset-password?token=${issued.token}`;
      dispatchMail(
        c,
        sendMail(
          { to: row.email, subject: "Reset your password", text: `Reset your password: ${link}\nToken: ${issued.token}` },
          { apiKey: c.env.SENDGRID_API_KEY, from: c.env.MAIL_FROM }
        )
      );
    }
  } catch {
    // Never reveal anything.
  }
  return ok(c, { accepted: true });
}, validationHook);

const resetSchema = z.object({ token: z.string().min(1).max(200), password: passwordSchema });

const resetRoute = createRoute({
  method: "post",
  path: "/:slug/account/reset-password",
  summary: "Reset buyer password",
  description: "CAS redeem + set password; all buyer sessions are revoked.",
  middleware: [...accountMutating],
  request: {
    params: slugParams,
    headers: turnstileTokenHeader,
    body: { content: { "application/json": { schema: resetSchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: okOf(z.object({ reset: z.boolean() })) } }, description: "Reset" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid token" },
  },
});

buyer.openapi(resetRoute, async (c) => {
  const { storeId } = storeScope(c);
  const input = c.req.valid("json");
  const redeemed = await redeemBuyerToken(getDb(c), input.token, "reset_password");
  if (!redeemed) throw new AppError("token_invalid", 404, "Invalid or expired token.");
  if ((await buyerStoreOf(getDb(c), redeemed.customer_id)) !== storeId) {
    throw new AppError("token_invalid", 404, "Invalid or expired token.");
  }
  await setBuyerPassword(getDb(c), redeemed.customer_id, input.password);
  return ok(c, { reset: true });
}, validationHook);

const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(PASSWORD_RULES.maxChars),
  new_password: passwordSchema,
});

const changePasswordRoute = createRoute({
  method: "post",
  path: "/:slug/account/change-password",
  summary: "Change my buyer password",
  description:
    "Authenticated self-service rotation (no Turnstile: the session is the " +
    "credential, mirroring merchant change-password). Verifies the current " +
    "password (same 401 as login: no oracle), stores the new hash, and " +
    "revokes every other buyer session. The calling session always survives.",
  middleware: [...authed],
  request: {
    params: slugParams,
    body: { content: { "application/json": { schema: changePasswordSchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: okOf(z.object({ changed: z.boolean() })) } }, description: "Changed" },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated or wrong current password" },
  },
});

buyer.openapi(changePasswordRoute, async (c) => {
  const { storeId } = storeScope(c);
  const input = c.req.valid("json");
  await changeBuyerPassword(getDb(c), storeId, currentBuyer(c).id, input.current_password, input.new_password, currentBuyerSessionId(c));
  return ok(c, { changed: true });
}, validationHook);

// Ownership reads (verify/reset token binding, reset lookup) live in the
// buyer service; routes stay SQL-free per tests/tenant-conventions.test.ts.

// --- order history ---------------------------------------------------------------

const historyRoute = createRoute({
  method: "get",
  path: "/:slug/account/orders",
  summary: "Buyer order history",
  description: "Orders for this account only, newest first, bounded.",
  middleware: [...authed],
  request: { params: slugParams },
  responses: {
    200: { content: { "application/json": { schema: okOf(z.object({ orders: z.array(z.object({ id: z.string(), order_number: z.number(), status: z.string(), payment_status: z.string(), total: z.number() })) })) } }, description: "History" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
  },
});

buyer.openapi(historyRoute, async (c) => {
  const { storeId } = storeScope(c);
  const orders = await listCustomerOrders(getDb(c), storeId, currentBuyer(c).id);
  return ok(c, {
    orders: orders.map((o) => ({
      id: o.id,
      order_number: o.order_number,
      status: o.status,
      payment_status: o.payment_status,
      total: o.total,
    })),
  });
}, validationHook);

// --- address book (owned by account) -----------------------------------------------

const addressSchema = z.object({
  recipient_name: z.string().min(1).max(200),
  phone: z.string().min(1).max(64),
  governorate: z.enum(GOVERNORATES),
  city: z.string().max(200).nullable().default(null),
  address_line: z.string().min(1).max(500),
});
const addressPatchSchema = z.object({
  recipient_name: z.string().min(1).max(200).optional(),
  phone: z.string().min(1).max(64).optional(),
  governorate: z.enum(GOVERNORATES).optional(),
  city: z.string().max(200).nullable().optional(),
  address_line: z.string().min(1).max(500).optional(),
});
const ADDRESS_FORBIDDEN = ["store_id", "id", "customer_id", "is_default"] as const;

const addressDocSchema = z
  .object({
    id: z.string(),
    customer_id: z.string(),
    recipient_name: z.string(),
    phone: z.string(),
    governorate: z.string(),
    city: z.string().nullable(),
    address_line: z.string(),
    is_default: z.number(),
  })
  .openapi("BuyerAddress");
const addressOkSchema = okOf(z.object({ address: addressDocSchema }));
const addressIdParams = z.object({ slug: slugParam, id: idParam });

const listAddressesRoute = createRoute({
  method: "get",
  path: "/:slug/account/addresses",
  summary: "List my addresses",
  middleware: [...authed],
  request: { params: slugParams },
  responses: {
    200: { content: { "application/json": { schema: okOf(z.object({ addresses: z.array(addressDocSchema) })) } }, description: "Addresses" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
  },
});

buyer.openapi(listAddressesRoute, async (c) => {
  const { storeId } = storeScope(c);
  const addresses = await listAddresses(getDb(c), storeId, currentBuyer(c).id);
  return ok(c, { addresses });
}, validationHook);

const createAddressRoute = createRoute({
  method: "post",
  path: "/:slug/account/addresses",
  summary: "Add an address to my book",
  middleware: [...authed],
  request: {
    params: slugParams,
    body: { content: { "application/json": { schema: addressSchema } } },
  },
  responses: {
    201: { content: { "application/json": { schema: addressOkSchema } }, description: "Created" },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
  },
});

buyer.openapi(createAddressRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ADDRESS_FORBIDDEN);
  const { storeId } = storeScope(c);
  const input = c.req.valid("json");
  const address = await createAddress(getDb(c), storeId, { ...input, customer_id: currentBuyer(c).id });
  return ok(c, { address }, 201);
}, validationHook);

const patchAddressRoute = createRoute({
  method: "patch",
  path: "/:slug/account/addresses/:id",
  summary: "Update my address",
  middleware: [...authed],
  request: {
    params: addressIdParams,
    body: { content: { "application/json": { schema: addressPatchSchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: addressOkSchema } }, description: "Updated" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown address" },
  },
});

buyer.openapi(patchAddressRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ADDRESS_FORBIDDEN);
  const { storeId } = storeScope(c);
  const { id } = c.req.valid("param");
  const current = await getAddress(getDb(c), storeId, id);
  if (!current || current.customer_id !== currentBuyer(c).id) {
    throw new AppError("address_not_found", 404, "Address not found.");
  }
  const address = await updateAddress(getDb(c), storeId, id, c.req.valid("json"));
  if (!address) throw new AppError("address_not_found", 404, "Address not found.");
  return ok(c, { address });
}, validationHook);

const deleteAddressRoute = createRoute({
  method: "delete",
  path: "/:slug/account/addresses/:id",
  summary: "Delete my address",
  middleware: [...authed],
  request: { params: addressIdParams },
  responses: {
    200: { content: { "application/json": { schema: okOf(z.object({ deleted: z.string() })) } }, description: "Deleted" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown address" },
  },
});

buyer.openapi(deleteAddressRoute, async (c) => {
  const { storeId } = storeScope(c);
  const { id } = c.req.valid("param");
  const current = await getAddress(getDb(c), storeId, id);
  if (!current || current.customer_id !== currentBuyer(c).id) {
    throw new AppError("address_not_found", 404, "Address not found.");
  }
  const res = await deleteAddress(getDb(c), storeId, id);
  return ok(c, res);
}, validationHook);

const defaultAddressRoute = createRoute({
  method: "post",
  path: "/:slug/account/addresses/:id/make-default",
  summary: "Make one of my addresses default",
  description: "The single writer of is_default for this account.",
  middleware: [...authed],
  request: { params: addressIdParams },
  responses: {
    200: { content: { "application/json": { schema: addressOkSchema } }, description: "Default set" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown address" },
  },
});

buyer.openapi(defaultAddressRoute, async (c) => {
  const { storeId } = storeScope(c);
  const { id } = c.req.valid("param");
  const current = await getAddress(getDb(c), storeId, id);
  if (!current || current.customer_id !== currentBuyer(c).id) {
    throw new AppError("address_not_found", 404, "Address not found.");
  }
  const address = await makeDefaultAddress(getDb(c), storeId, id);
  if (!address) throw new AppError("address_not_found", 404, "Address not found.");
  return ok(c, { address });
}, validationHook);

// --- server carts ------------------------------------------------------------------

const cartDocSchema = z
  .object({
    id: z.string(),
    expires_at: z.string(),
    items: z.array(
      z.object({
        id: z.string(),
        product_id: z.string(),
        product_name: z.string(),
        unit_price: z.number(),
        quantity: z.number(),
      })
    ),
  })
  .openapi("BuyerCart");
const cartOkSchema = okOf(z.object({ cart: cartDocSchema }));
const cartIdParams = z.object({ slug: slugParam, cartId: cartIdParam });
const cartItemIdParams = z.object({ slug: slugParam, cartId: cartIdParam, itemId: itemIdParam });

function cartPayload(cart: { id: string; expires_at: string }, items: { id: string; product_id: string; product_name: string; unit_price: number; quantity: number }[]) {
  return { cart: { id: cart.id, expires_at: cart.expires_at, items } };
}

const createCartRoute = createRoute({
  method: "post",
  path: "/:slug/cart",
  summary: "Create a guest cart",
  description: "Returns a capability cart id; knowledge of the id is ownership.",
  middleware: [...guestCartMutating],
  request: { params: slugParams, headers: turnstileTokenHeader },
  responses: {
    201: { content: { "application/json": { schema: cartOkSchema } }, description: "Cart created" },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Bot verification token required" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Bot verification failed" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store" },
  },
});

buyer.openapi(createCartRoute, async (c) => {
  const { storeId } = storeScope(c);
  const cart = await createCart(getDb(c), storeId, null);
  return ok(c, cartPayload(cart, []), 201);
}, validationHook);

const getCartRoute = createRoute({
  method: "get",
  path: "/:slug/cart/:cartId",
  summary: "Read a cart",
  middleware: [...storeMw],
  request: { params: cartIdParams },
  responses: {
    200: { content: { "application/json": { schema: cartOkSchema } }, description: "Cart" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown cart" },
  },
});

buyer.openapi(getCartRoute, async (c) => {
  const { storeId } = storeScope(c);
  const { cart, items } = await getCart(getDb(c), storeId, c.req.valid("param").cartId);
  return ok(c, cartPayload(cart, items));
}, validationHook);

const addItemSchema = z.object({
  product_id: z.string().min(1),
  quantity: z.number().int().min(1).max(999),
});

const addItemRoute = createRoute({
  method: "post",
  path: "/:slug/cart/:cartId/items",
  summary: "Add a line to a guest cart",
  middleware: [...guestCartMutating],
  request: {
    params: cartIdParams,
    headers: turnstileTokenHeader,
    body: { content: { "application/json": { schema: addItemSchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: cartOkSchema } }, description: "Cart" },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or bot token required" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Bot verification failed" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown cart" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Product unavailable" },
  },
});

buyer.openapi(addItemRoute, async (c) => {
  const { storeId } = storeScope(c);
  const input = c.req.valid("json");
  const { cart, items } = await addCartItem(getDb(c), storeId, c.req.valid("param").cartId, input.product_id, input.quantity);
  return ok(c, cartPayload(cart, items));
}, validationHook);

const setQtySchema = z.object({ quantity: z.number().int().min(0).max(999) });

const setQtyRoute = createRoute({
  method: "patch",
  path: "/:slug/cart/:cartId/items/:itemId",
  summary: "Set a guest cart line quantity (0 removes)",
  middleware: [...guestCartMutating],
  request: {
    params: cartItemIdParams,
    headers: turnstileTokenHeader,
    body: { content: { "application/json": { schema: setQtySchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: cartOkSchema } }, description: "Cart" },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or bot token required" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Bot verification failed" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown cart or item" },
  },
});

buyer.openapi(setQtyRoute, async (c) => {
  const { storeId } = storeScope(c);
  const { cartId, itemId } = c.req.valid("param");
  const { cart, items } = await setCartItemQty(getDb(c), storeId, cartId, itemId, c.req.valid("json").quantity);
  return ok(c, cartPayload(cart, items));
}, validationHook);

// Account carts (same shapes, bound to the session buyer).

const myCartRoute = createRoute({
  method: "get",
  path: "/:slug/account/cart",
  summary: "Read my account cart",
  middleware: [...authed],
  request: { params: slugParams },
  responses: {
    200: { content: { "application/json": { schema: cartOkSchema } }, description: "Cart" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
  },
});

buyer.openapi(myCartRoute, async (c) => {
  const { storeId } = storeScope(c);
  const cart = await accountCart(getDb(c), storeId, currentBuyer(c).id);
  return ok(c, cartPayload(cart, await getCartLines(getDb(c), cart.id)));
}, validationHook);

const myAddItemRoute = createRoute({
  method: "post",
  path: "/:slug/account/cart/items",
  summary: "Add a line to my account cart",
  middleware: [...authed],
  request: {
    params: slugParams,
    body: { content: { "application/json": { schema: addItemSchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: cartOkSchema } }, description: "Cart" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Product unavailable" },
  },
});

buyer.openapi(myAddItemRoute, async (c) => {
  const { storeId } = storeScope(c);
  const buyerId = currentBuyer(c).id;
  const input = c.req.valid("json");
  const cart = await accountCart(getDb(c), storeId, buyerId);
  const res = await addCartItem(getDb(c), storeId, cart.id, input.product_id, input.quantity);
  return ok(c, cartPayload(res.cart, res.items));
}, validationHook);

const mySetQtyRoute = createRoute({
  method: "patch",
  path: "/:slug/account/cart/items/:itemId",
  summary: "Set an account cart line quantity (0 removes)",
  middleware: [...authed],
  request: {
    params: z.object({ slug: slugParam, itemId: itemIdParam }),
    body: { content: { "application/json": { schema: setQtySchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: cartOkSchema } }, description: "Cart" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown item" },
  },
});

buyer.openapi(mySetQtyRoute, async (c) => {
  const { storeId } = storeScope(c);
  const cart = await accountCart(getDb(c), storeId, currentBuyer(c).id);
  const res = await setCartItemQty(getDb(c), storeId, cart.id, c.req.valid("param").itemId, c.req.valid("json").quantity);
  return ok(c, cartPayload(res.cart, res.items));
}, validationHook);

const mergeCartSchema = z.object({ cart_id: z.string().min(1) });

const mergeCartRoute = createRoute({
  method: "post",
  path: "/:slug/account/cart/merge",
  summary: "Merge a guest cart into my account cart",
  middleware: [...authed],
  request: {
    params: slugParams,
    body: { content: { "application/json": { schema: mergeCartSchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: cartOkSchema } }, description: "Merged cart" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown guest cart" },
  },
});

buyer.openapi(mergeCartRoute, async (c) => {
  const { storeId } = storeScope(c);
  const res = await mergeGuestCart(getDb(c), storeId, currentBuyer(c).id, c.req.valid("json").cart_id);
  return ok(c, cartPayload(res.cart, res.items));
}, validationHook);
