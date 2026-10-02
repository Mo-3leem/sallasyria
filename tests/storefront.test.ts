import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env.js";
import { errorHandler } from "../src/http/errors.js";
import { ok } from "../src/http/respond.js";
import { resolvePublishedStore, resolvePublishedStoreBySlug } from "../src/middleware/store.js";
import { storeScope } from "../src/db/tenant.js";
import {
  getPublicStore,
  listPublishedCategories,
  listPublishedProducts,
} from "../src/services/storefront.js";

// Public catalog matrix (fast, no server): published-only reads, drafts
// invisible, retired/hidden rows never serialize. Uses the real service
// functions against an in-memory row set.

// Minimal in-memory D1 stand-in keyed by SQL shape. Mirrors the public
// availability predicate (published AND active); paused/archived rows hide
// exactly like drafts.
function fakeDb(tables: {
  stores: Record<string, { id: string; slug: string; name: string; currency: string; is_published: number; status: string }>;
  categories: { id: string; store_id: string; name: string; slug: string; parent_id: string | null; sort_order: number; is_active: number }[];
  products: { id: string; store_id: string; category_id: string | null; name: string; slug: string; price: number; stock_quantity: number | null; is_active: number; deleted_at: string | null }[];
  images: { id: string; store_id: string; product_id: string; url: string; alt_text: string | null; sort_order: number; deleted_at: string | null; created_at: string }[];
}) {
  const pick = (sql: string, id: string | null, slug: string | null) => {
    if (sql.includes("FROM stores WHERE id = ?")) {
      const row = Object.values(tables.stores).find((s) => s.id === id) ?? null;
      if (!row || row.is_published !== 1 || row.status !== "active") return null;
      return row;
    }
    if (sql.includes("FROM stores WHERE slug = ?")) {
      const row = Object.values(tables.stores).find((s) => s.slug === slug) ?? null;
      if (!row || row.is_published !== 1 || row.status !== "active") return null;
      return row;
    }
    if (sql.includes("FROM categories")) {
      return tables.categories
        .filter((c) => c.store_id === id && c.is_active === 1)
        .sort((a, b) => a.sort_order - b.sort_order || (a.name < b.name ? -1 : 1));
    }
    if (sql.includes("FROM products")) {
      return tables.products
        .filter((p) => p.store_id === id && p.deleted_at === null && p.is_active === 1)
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    }
    if (sql.includes("FROM product_images")) {
      return (tables.images ?? [])
        .filter((img) => img.store_id === id && img.deleted_at === null)
        .sort((a, b) => a.sort_order - b.sort_order || (a.created_at < b.created_at ? -1 : 1));
    }
    return null;
  };
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          const out = pick(sql, (args[0] as string) ?? null, (args[0] as string) ?? null);
          return Array.isArray(out) ? (out[0] ?? null) : out;
        },
        all: async () => ({
          results: (pick(sql, (args[0] as string) ?? null, (args[0] as string) ?? null) as unknown[]) ?? [],
        }),
      }),
    }),
  };
}

const pub = { id: "s-pub", slug: "pub", name: "Pub", currency: "SYP", is_published: 1, status: "active" };
const draft = { id: "s-draft", slug: "draft", name: "Draft", currency: "SYP", is_published: 0, status: "active" };
const paused = { id: "s-paused", slug: "paused", name: "Paused", currency: "SYP", is_published: 1, status: "paused" };

const tables = {
  stores: { "s-pub": pub, "s-draft": draft, "s-paused": paused } as Record<string, typeof pub>,
  categories: [
    { id: "c1", store_id: "s-pub", name: "Live", slug: "live", parent_id: null, sort_order: 0, is_active: 1 },
    { id: "c2", store_id: "s-pub", name: "Hidden", slug: "hidden", parent_id: null, sort_order: 1, is_active: 0 },
  ],
  products: [
    { id: "p1", store_id: "s-pub", category_id: "c1", name: "Live", slug: "live", price: 100, stock_quantity: 1, is_active: 1, deleted_at: null },
    { id: "p2", store_id: "s-pub", category_id: null, name: "Retired", slug: "retired", price: 100, stock_quantity: null, is_active: 0, deleted_at: "2026-01-01T00:00:00Z" },
    { id: "p3", store_id: "s-pub", category_id: null, name: "Off", slug: "off", price: 100, stock_quantity: null, is_active: 0, deleted_at: null },
  ],
  images: [
    { id: "i1", store_id: "s-pub", product_id: "p1", url: "https://example.com/a.jpg", alt_text: null, sort_order: 1, deleted_at: null, created_at: "2026-02-01T00:00:00Z" },
    { id: "i2", store_id: "s-pub", product_id: "p1", url: "https://example.com/b.jpg", alt_text: "Cover", sort_order: 0, deleted_at: null, created_at: "2026-02-02T00:00:00Z" },
    { id: "i3", store_id: "s-pub", product_id: "p1", url: "https://example.com/retired.jpg", alt_text: null, sort_order: 0, deleted_at: "2026-03-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
    { id: "i4", store_id: "s-pub", product_id: "p2", url: "https://example.com/hidden.jpg", alt_text: null, sort_order: 0, deleted_at: null, created_at: "2026-02-01T00:00:00Z" },
  ],
};

describe("storefront services", () => {
  it("reads published stores, hides drafts", async () => {
    const db = fakeDb(tables) as never;
    expect(await getPublicStore(db, "s-pub")).toMatchObject({ slug: "pub" });
    expect(await getPublicStore(db, "s-draft")).toBeNull();
    expect(await getPublicStore(db, "s-paused")).toBeNull();
    expect(await getPublicStore(db, "s-nope")).toBeNull();
  });

  it("lists live categories and products only", async () => {
    const db = fakeDb(tables) as never;
    expect((await listPublishedCategories(db, "s-pub")).map((c) => c.slug)).toEqual(["live"]);
    expect((await listPublishedProducts(db, "s-pub")).map((p) => p.slug)).toEqual(["live"]);
    expect(await listPublishedProducts(db, "s-draft")).toEqual([]);
  });

  it("attaches live gallery images in sort order, never retired rows", async () => {
    const db = fakeDb(tables) as never;
    const products = await listPublishedProducts(db, "s-pub");
    expect(products).toHaveLength(1);
    const live = products[0]!;
    expect(live.slug).toBe("live");
    // Cover first (sort_order 0), retired image excluded, retired
    // product's image never leaks, URLs pass through untouched.
    expect(live.images.map((img) => img.url)).toEqual([
      "https://example.com/b.jpg",
      "https://example.com/a.jpg",
    ]);
    expect(live.images[0]).toMatchObject({ alt_text: "Cover", sort_order: 0 });
  });
});

describe("storefront middleware", () => {
  function probeApp() {
    const app = new OpenAPIHono<AppEnv>();
    app.onError(errorHandler);
    app.get("/s/:storeId", resolvePublishedStore, (c) =>
      ok(c, { storeId: storeScope(c).storeId })
    );
    app.get("/by-slug/:slug", resolvePublishedStoreBySlug, (c) =>
      ok(c, { storeId: storeScope(c).storeId })
    );
    return { app, env: { DB: fakeDb(tables) } as unknown as AppEnv };
  }

  it("draft, paused, and missing answer identically (id and slug)", async () => {
    const { app, env } = probeApp();
    const bodies: unknown[] = [];
    for (const path of ["/s/s-nope", "/s/s-draft", "/s/s-paused", "/by-slug/nope", "/by-slug/draft", "/by-slug/paused"]) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(404);
      bodies.push(await res.json());
    }
    for (const body of bodies.slice(1)) {
      expect(body).toEqual(bodies[0]);
    }
    const okRes = await app.request("/s/s-pub", {}, env);
    expect(okRes.status).toBe(200);
    const okSlug = await app.request("/by-slug/pub", {}, env);
    expect(okSlug.status).toBe(200);
  });
});
