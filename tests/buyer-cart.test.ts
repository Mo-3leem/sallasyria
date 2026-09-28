import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import {
  accountCart,
  addCartItem,
  claimCart,
  createCart,
  getCart,
  mergeGuestCart,
  setCartItemQty,
  unclaimCart,
} from "../src/services/buyer-cart.js";

interface Cart {
  id: string;
  store_id: string;
  customer_id: string | null;
  expires_at: string;
  checked_out_at: string | null;
}
interface Line {
  id: string;
  cart_id: string;
  product_id: string;
  quantity: number;
}

// Runtime-relative timestamps (DB format, no millis): the service derives
// expiries from the real clock while liveness is checked against the passed
// nowIso, so fixed dates would rot. NOW = now, LIVE = now + 30d (live),
// PAST = now - 30d (expired) — ordering preserved forever.
const fmtIso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const NOW_MS = Date.now();
const NOW = fmtIso(NOW_MS);
const LIVE = fmtIso(NOW_MS + 30 * 24 * 3600 * 1000);
const PAST = fmtIso(NOW_MS - 30 * 24 * 3600 * 1000);

function stubDb() {
  const carts = new Map<string, Cart>();
  const lines = new Map<string, Line>();
  const products = new Map<string, { store_id: string; name: string; price: number; published: boolean; active: boolean }>();
  let n = 0;
  const nid = () => `line-${++n}`;

  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        const stmt = {
          run: async () => ({ meta: { changes: 1 } }),
          first: async (): Promise<unknown> => null,
          all: async () => ({ results: [] as unknown[] }),
        };
        if (sql.startsWith("INSERT INTO carts")) {
          const [id, storeId, customerId, expiresAt] = args as [string, string, string | null, string, string, string];
          const c: Cart = { id, store_id: storeId, customer_id: customerId, expires_at: expiresAt, checked_out_at: null };
          carts.set(id, c);
          return { ...stmt, first: async () => ({ ...c }) };
        }
        if (sql.startsWith("SELECT id, store_id, customer_id, expires_at, checked_out_at FROM carts WHERE id = ? AND store_id = ?")) {
          const [id, storeId] = args as [string, string];
          const c = carts.get(id);
          return { ...stmt, first: async () => (c && c.store_id === storeId ? { ...c } : null) };
        }
        if (sql.startsWith("SELECT id, store_id, customer_id, expires_at, checked_out_at FROM carts WHERE store_id = ? AND customer_id = ?")) {
          const [storeId, customerId, nowIso] = args as [string, string, string];
          const found = [...carts.values()].find(
            (c) => c.store_id === storeId && c.customer_id === customerId && c.expires_at > nowIso && c.checked_out_at === null
          );
          return { ...stmt, first: async () => (found ? { ...found } : null) };
        }
        if (sql.startsWith("SELECT i.id, i.product_id, p.name AS product_name")) {
          const [cartId] = args as [string];
          const out = [...lines.values()]
            .filter((l) => l.cart_id === cartId)
            .map((l) => {
              const p = products.get(l.product_id)!;
              return { id: l.id, product_id: l.product_id, product_name: p.name, unit_price: p.price, quantity: l.quantity };
            });
          return { ...stmt, all: async () => ({ results: out }) };
        }
        if (sql.startsWith("SELECT is_active FROM products")) {
          const [productId, storeId] = args as [string, string];
          const p = products.get(productId);
          return {
            ...stmt,
            first: async () =>
              p && p.store_id === storeId ? { is_active: p.published && p.active ? 1 : 0 } : null,
          };
        }
        if (sql.startsWith("SELECT id, quantity FROM cart_items WHERE cart_id = ? AND product_id = ?")) {
          const [cartId, productId] = args as [string, string];
          const found = [...lines.values()].find((l) => l.cart_id === cartId && l.product_id === productId);
          return { ...stmt, first: async () => (found ? { id: found.id, quantity: found.quantity } : null) };
        }
        if (sql.startsWith("UPDATE cart_items SET quantity = ? WHERE id = ?")) {
          const [qty, id] = args as [number, string];
          const l = lines.get(id);
          if (l) l.quantity = qty;
          return stmt;
        }
        if (sql.startsWith("INSERT INTO cart_items")) {
          const [id, cartId, productId, qty] = args as [string, string, string, number];
          lines.set(id, { id, cart_id: cartId, product_id: productId, quantity: qty });
          return stmt;
        }
        if (sql.startsWith("UPDATE carts SET expires_at = ?, updated_at = ? WHERE id = ?")) {
          const [expiresAt, , id] = args as [string, string, string];
          const c = carts.get(id);
          if (c) c.expires_at = expiresAt;
          return stmt;
        }
        if (sql.startsWith("SELECT id FROM cart_items WHERE id = ? AND cart_id = ?")) {
          const [id, cartId] = args as [string, string];
          const l = lines.get(id);
          return { ...stmt, first: async () => (l && l.cart_id === cartId ? { id: l.id } : null) };
        }
        if (sql.startsWith("DELETE FROM cart_items WHERE id = ?")) {
          lines.delete(args[0] as string);
          return stmt;
        }
        if (sql.startsWith("DELETE FROM carts WHERE id = ?")) {
          const id = args[0] as string;
          carts.delete(id);
          for (const [lid, l] of lines) if (l.cart_id === id) lines.delete(lid);
          return stmt;
        }
        if (sql.startsWith("UPDATE carts SET checked_out_at = ? WHERE id = ? AND store_id = ?")) {
          const [nowIso, id, storeId, cmp] = args as [string, string, string, string];
          const c = carts.get(id);
          if (c && c.store_id === storeId && c.expires_at > cmp && c.checked_out_at === null) {
            c.checked_out_at = nowIso;
            return { run: async () => ({ meta: { changes: 1 } }) };
          }
          return { run: async () => ({ meta: { changes: 0 } }) };
        }
        if (sql.startsWith("UPDATE carts SET checked_out_at = NULL WHERE id = ?")) {
          const c = carts.get(args[0] as string);
          if (c) c.checked_out_at = null;
          return stmt;
        }
        throw new Error(`unexpected SQL in stub: ${sql.slice(0, 80)}`);
      },
    }),
  } as unknown as D1Database;
  return {
    db,
    seedProduct: (id: string, store: string, opts: { published?: boolean; active?: boolean } = {}) =>
      products.set(id, { store_id: store, name: `P-${id}`, price: 500, published: opts.published ?? true, active: opts.active ?? true }),
    expireCart: (id: string) => {
      const c = carts.get(id);
      if (c) c.expires_at = PAST;
    },
  };
}

const STORE = "store-1";

describe("server carts", () => {
  it("adds, reads, updates, and removes guest lines", async () => {
    const { db, seedProduct } = stubDb();
    seedProduct("p1", STORE);
    seedProduct("p2", STORE);
    const cart = await createCart(db, STORE, null, NOW);
    let res = await addCartItem(db, STORE, cart.id, "p1", 2, NOW);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ product_id: "p1", product_name: "P-p1", unit_price: 500, quantity: 2 });
    res = await addCartItem(db, STORE, cart.id, "p1", 3, NOW);
    expect(res.items[0]!.quantity).toBe(5);
    const itemId = res.items[0]!.id;
    res = await setCartItemQty(db, STORE, cart.id, itemId, 1, NOW);
    expect(res.items[0]!.quantity).toBe(1);
    res = await setCartItemQty(db, STORE, cart.id, itemId, 0, NOW);
    expect(res.items).toHaveLength(0);
    const read = await getCart(db, STORE, cart.id, NOW);
    expect(read.items).toHaveLength(0);
  });

  it("rejects unavailable products and quantity overflow", async () => {
    const { db, seedProduct } = stubDb();
    seedProduct("draft", STORE, { published: false });
    seedProduct("off", STORE, { active: false });
    seedProduct("ok", STORE);
    const cart = await createCart(db, STORE, null, NOW);
    await expect(addCartItem(db, STORE, cart.id, "draft", 1, NOW)).rejects.toMatchObject({
      code: "product_unavailable",
    });
    await expect(addCartItem(db, STORE, cart.id, "off", 1, NOW)).rejects.toMatchObject({
      code: "product_unavailable",
    });
    await expect(addCartItem(db, STORE, cart.id, "missing", 1, NOW)).rejects.toMatchObject({
      code: "product_unavailable",
    });
    await addCartItem(db, STORE, cart.id, "ok", 999, NOW);
    await expect(addCartItem(db, STORE, cart.id, "ok", 1, NOW)).rejects.toMatchObject({
      code: "quantity_exceeded",
    });
  });

  it("404s expired carts and claims exactly once", async () => {
    const { db, seedProduct, expireCart } = stubDb();
    seedProduct("p1", STORE);
    const cart = await createCart(db, STORE, null, NOW);
    await addCartItem(db, STORE, cart.id, "p1", 1, NOW);
    expireCart(cart.id);
    await expect(getCart(db, STORE, cart.id, NOW)).rejects.toMatchObject({ code: "cart_not_found" });

    const cart2 = await createCart(db, STORE, null, NOW);
    await addCartItem(db, STORE, cart2.id, "p1", 2, NOW);
    const claimed = await claimCart(db, STORE, cart2.id, NOW);
    expect(claimed).toEqual([{ product_id: "p1", quantity: 2 }]);
    await expect(claimCart(db, STORE, cart2.id, NOW)).rejects.toMatchObject({ code: "cart_not_found" });
    await unclaimCart(db, cart2.id);
    const reclaimed = await claimCart(db, STORE, cart2.id, NOW);
    expect(reclaimed).toHaveLength(1);
  });

  it("merges a guest cart into the account cart and rejects owned carts", async () => {
    const { db, seedProduct } = stubDb();
    seedProduct("p1", STORE);
    seedProduct("p2", STORE);
    const guest = await createCart(db, STORE, null, NOW);
    await addCartItem(db, STORE, guest.id, "p1", 2, NOW);
    await addCartItem(db, STORE, guest.id, "p2", 1, NOW);
    const mine = await accountCart(db, STORE, "cust-1", NOW);
    await addCartItem(db, STORE, mine.id, "p1", 1, NOW);
    const merged = await mergeGuestCart(db, STORE, "cust-1", guest.id, NOW);
    const byProduct = Object.fromEntries(merged.items.map((l) => [l.product_id, l.quantity]));
    expect(byProduct).toEqual({ p1: 3, p2: 1 });
    await expect(getCart(db, STORE, guest.id, NOW)).rejects.toMatchObject({ code: "cart_not_found" });
    // Same account cart resolves stably.
    const again = await accountCart(db, STORE, "cust-1", NOW);
    expect(again.id).toBe(merged.cart.id);
    // An owned cart is not mergeable.
    await expect(mergeGuestCart(db, STORE, "cust-2", merged.cart.id, NOW)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});
