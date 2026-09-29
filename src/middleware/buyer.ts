import type { Context, Next } from "hono";
import { getDb } from "../db.js";
import type { AppEnv, BuyerIdentity } from "../env.js";
import { storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { BUYER_COOKIE, getCookieToken } from "../lib/session.js";
import { resolveBuyerSession } from "../services/buyers.js";

export type { BuyerIdentity };

type BuyerContext = Context<AppEnv>;

// requireBuyer: ss_buyer cookie -> buyer_sessions JOIN customers -> status
// checks -> c.set("buyer"). Every failure maps to the same generic 401, and
// the buyer's store must equal the URL store (a cookie from store A is
// useless at store B). Merchant ss_session cookies never validate here:
// different cookie name, different table.
export async function requireBuyer(c: BuyerContext, next: Next): Promise<void> {
  await authenticateBuyer(c);
  await next();
}

export function currentBuyer(c: BuyerContext): BuyerIdentity {
  const buyer = c.get("buyer");
  if (!buyer) throw new AppError("unauthorized", 401, "Authentication required.");
  return buyer;
}

// Optional buyer authentication for endpoints shared with the merchant
// dashboard (e.g. standalone address writes): returns the buyer when a valid
// same-store buyer session is present, null otherwise. Callers pin writes to
// buyer.id; a null result falls through to the merchant path or a 401.
export async function tryAuthenticateBuyer(c: BuyerContext): Promise<BuyerIdentity | null> {
  try {
    return await authenticateBuyer(c);
  } catch {
    return null;
  }
}

export function currentBuyerSessionId(c: BuyerContext): string {
  const sid = c.get("buyerSessionId");
  if (!sid) throw new AppError("unauthorized", 401, "Authentication required.");
  return sid;
}

async function authenticateBuyer(c: BuyerContext): Promise<BuyerIdentity> {
  const token = getCookieToken(c.req.header("Cookie") ?? null, BUYER_COOKIE);
  if (token === null) {
    throw new AppError("unauthorized", 401, "Authentication required.");
  }
  const session = await resolveBuyerSession(getDb(c), token);
  if (!session) {
    throw new AppError("unauthorized", 401, "Authentication required.");
  }
  const { storeId } = storeScope(c);
  if (session.buyer.store_id !== storeId) {
    throw new AppError("unauthorized", 401, "Authentication required.");
  }
  const buyer: BuyerIdentity = {
    id: session.buyer.id,
    store_id: session.buyer.store_id,
    name: session.buyer.name,
    phone: session.buyer.phone,
    email: session.buyer.email,
    email_verified: session.buyer.email_verified === 1,
  };
  c.set("buyer", buyer);
  c.set("buyerSessionId", session.id);
  return buyer;
}
