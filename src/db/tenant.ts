import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { AppError } from "../http/errors.js";

// Tenant-scope helpers (roadmap B3). The design rule, enforced by types:
//  - Services take an explicit `storeId: string` argument. They never see a
//    Context, so client input cannot flow into scoping except through here.
//  - Routes obtain storeId ONLY via storeScope(c), which reads the
//    server-resolved value set by resolveStore — never params, never bodies.
//  - storeScope throws 500 (fail-closed programmer error) when resolveStore
//    did not run: a missing scope must explode loudly, never default to an
//    unscoped query.

export function storeScope(c: Context<AppEnv>): { storeId: string } {
  const storeId = c.get("storeId");
  if (typeof storeId !== "string" || storeId.length === 0) {
    throw new AppError(
      "tenant_scope_missing",
      500,
      "Something went wrong."
    );
  }
  return { storeId };
}

// Resource param reader (companion to the .param() ban): routes never
// call c.req.param() directly. A missing param on a route that declares it is
// a router-programming bug, so this fails closed with 500, never 404 (a 404
// here would masquerade a broken route as a missing record). The `name`
// argument exists because /file/:key names its segment differently from the
// conventional :id — same helper, same guarantee.
export function resourceId(c: Context<AppEnv>, name = "id"): string {
  const id = c.req.param(name);
  if (typeof id !== "string" || id.length === 0) {
    throw new AppError("internal", 500, "Something went wrong.");
  }
  return id;
}
