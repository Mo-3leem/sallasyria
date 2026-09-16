import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { storeScope } from "../db/tenant.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, zBodyValidator } from "../http/validate.js";
import { auditLog } from "../lib/audit.js";
import { currentUser, requireAuth } from "../middleware/auth.js";
import { requireStoreAccess, resolveStore } from "../middleware/store.js";
import { requireActiveSubscription } from "../middleware/subscription.js";
import { listAllStores, getStoreById, getStoreOwner, listStoresForOwner, renameStore } from "../services/stores.js";

export const stores = new Hono<AppEnv>();

// NOTE (type-level boundary): this file contains zero SQL strings and never
// reads store scoping from params/bodies. storeId flows ONLY from
// storeScope(c) (server-resolved by resolveStore); all queries live in
// services/*. Neither rule is commentary — tests/tenant-conventions.test.ts
// fails the suite if either is violated.

// GET /stores — own stores; admins see all (admin listing is itself audited).
stores.get("/", requireAuth, async (c) => {
  const user = currentUser(c);
  if (user.role === "admin") {
    auditLog("admin.store.read", { actor: user.id, result: "list-all" });
    return ok(c, { stores: await listAllStores(getDb(c)) });
  }
  return ok(c, { stores: await listStoresForOwner(getDb(c), user.id) });
});

// GET /stores/:storeId — owner or admin. Foreign and missing ids answer
// identically (404 store_not_found): no existence oracle.
stores.get("/:storeId", requireAuth, resolveStore, requireStoreAccess, async (c) => {
  const { storeId } = storeScope(c);
  const store = await getStoreById(getDb(c), storeId);
  if (store === null) {
    // Defensive only: requireStoreAccess proved access above, so a null here
    // means deletion raced the middlewares — still 404, never unscoped data.
    return ok(c, { store: null });
  }
  return ok(c, { store });
});

const renameSchema = z.object({ name: z.string().min(1).max(200) });

// PATCH /stores/:storeId — whitelisted { name } only. store_id/id in the body
// are 400 even when matching (assertNoImmutableFields on the RAW body —
// validated output is already stripped, so checking it would prove nothing).
// Merchant writes additionally require a covering subscription; admins bypass
// (audited) so expired stores stay manageable.
stores.patch(
  "/:storeId",
  requireAuth,
  resolveStore,
  requireStoreAccess,
  requireActiveSubscription,
  zBodyValidator(renameSchema),
  async (c) => {
    const raw: unknown = await c.req.json().catch(() => ({}));
    assertNoImmutableFields(raw);
    const { storeId } = storeScope(c);
    const user = currentUser(c);
    const updated = await renameStore(getDb(c), storeId, c.req.valid("json").name);
    const ownerId = await getStoreOwner(getDb(c), storeId);
    if (user.role === "admin" && ownerId !== user.id) {
      auditLog("admin.store.update", { actor: user.id, store: storeId, result: "ok" });
    } else {
      auditLog("store.update", { actor: user.id, store: storeId, result: "ok" });
    }
    return ok(c, { store: updated });
  }
);
