import type { Context, Next } from "hono";
import type { AppEnv } from "../env.js";
import { AppError } from "../http/errors.js";
import { storeScope } from "../db/tenant.js";
import { checkPublicMutationLimit } from "../lib/rate-limit.js";

// Shared guard for PUBLIC (unauthenticated) buyer mutations (roadmap B5).
// Public does NOT mean unscoped: resolveStore must already have run, and the
// limit is keyed per client+store. Throws 429 envelope when exhausted.
export async function limitPublicMutations(
  c: Context<AppEnv>,
  next: Next
): Promise<void> {
  const { storeId } = storeScope(c);
  if (!checkPublicMutationLimit(c, storeId)) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  await next();
}
