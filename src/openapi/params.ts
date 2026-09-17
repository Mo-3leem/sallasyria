import { z } from "@hono/zod-openapi";

// Shared path-parameter schemas so every documented route shows its params.
// Both are plain z.string(): they can never reject a request the router
// already matched (Hono path segments are always non-empty strings), so
// declaring them is docs-only with zero behavior change. Runtime param reads
// stay centralized in db/tenant.ts (storeScope/resourceId) as enforced by
// tests/tenant-conventions.test.ts.
export const storeIdParam = z
  .string()
  .openapi({
    param: { name: "storeId", in: "path" },
    example: "store_01J...",
  });

export const idParam = z
  .string()
  .openapi({
    param: { name: "id", in: "path" },
    example: "cat_01J...",
  });

// Every store-mounted route merges a {storeId} prefix from its parent mount.
// Declaring it documents the parameter; validation cannot fail on it (Hono
// path segments are always non-empty strings), so behavior is unchanged.
export const storeIdParams = z.object({ storeId: storeIdParam });
