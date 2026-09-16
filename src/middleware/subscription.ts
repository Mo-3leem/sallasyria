import type { Context, Next } from "hono";
import { getDb } from "../db.js";
import type { AppEnv } from "../env.js";
import { AppError } from "../http/errors.js";
import { storeScope } from "../db/tenant.js";
import { nowIso } from "../lib/time.js";
import { hasCoveringSubscription } from "../services/subscriptions.js";
import { currentUser } from "./auth.js";

// Subscription gate (roadmap B3 + H4). Merchant WRITES require a covering
// subscription; reads are unaffected (enforced by only mounting this on
// mutating routes). Admins bypass — suspension tooling must work on expired
// stores — and the bypass is intentional, audited at the route.
export async function requireActiveSubscription(
  c: Context<AppEnv>,
  next: Next
): Promise<void> {
  const user = currentUser(c);
  if (user && user.role === "admin") {
    await next();
    return;
  }
  const { storeId } = storeScope(c);
  const covered = await hasCoveringSubscription(getDb(c), storeId, nowIso());
  if (!covered) {
    throw new AppError(
      "subscription_inactive",
      403,
      "Store subscription is not active."
    );
  }
  await next();
}
