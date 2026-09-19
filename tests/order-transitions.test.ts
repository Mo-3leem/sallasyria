import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/http/errors.js";
import { transitionOrderStatus, transitionPaymentStatus } from "../src/services/orders.js";

// Deterministic compare-and-swap proof: a stubbed D1 lets the test force the
// exact interleaving a live race produces (UPDATE matches zero rows because
// a concurrent transition moved the row first) and assert it becomes a 409
// instead of a silent last-writer-wins overwrite. Live sequential + invalid
// behavior stays covered by checkout.integration.test.ts.

const BASE_ORDER = {
  id: "o1",
  store_id: "s1",
  order_number: 1001,
  status: "pending",
  subtotal: 100,
  discount: 0,
  total: 100,
  payment_method: "cod",
  payment_status: "pending",
  payment_reference: null,
  tracking_number: null,
  customer_name: "N",
  customer_phone: "P",
  shipping_method: "S",
  shipping_cost: 0,
  shipping_governorate: "G",
  shipping_address: "A",
};

function stubDb(opts: { changes?: number; status?: string; payment_status?: string } = {}) {
  const seen: string[] = [];
  const order = {
    ...BASE_ORDER,
    status: opts.status ?? "pending",
    payment_status: opts.payment_status ?? "pending",
  };
  const db = {
    prepare: (sql: string) => ({
      bind: () => {
        seen.push(sql);
        if (sql.trimStart().startsWith("UPDATE")) {
          return { run: async () => ({ meta: { changes: opts.changes ?? 1 } }) };
        }
        if (sql.includes("FROM orders")) {
          return { first: async () => order };
        }
        if (sql.includes("FROM order_items")) {
          return { all: async () => ({ results: [] }) };
        }
        throw new Error(`unexpected SQL in stub: ${sql}`);
      },
    }),
  } as unknown as D1Database;
  return { db, seen };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    return err instanceof AppError ? err.code : `unexpected:${String(err)}`;
  }
}

describe("order status transitions", () => {
  it("valid transition applies when the row still holds the expected status", async () => {
    const { db, seen } = stubDb({ changes: 1 });
    const order = await transitionOrderStatus(db, "s1", "o1", "confirmed");
    expect(order?.id).toBe("o1");
    expect(seen.some((s) => s.includes("AND status = ?"))).toBe(true);
  });

  it("concurrent move collapses to 409 instead of overwriting", async () => {
    const { db } = stubDb({ changes: 0 });
    expect(await codeOf(transitionOrderStatus(db, "s1", "o1", "confirmed"))).toBe("invalid_transition");
  });

  it("invalid transition is rejected before any UPDATE", async () => {
    const { db, seen } = stubDb();
    expect(await codeOf(transitionOrderStatus(db, "s1", "o1", "delivered"))).toBe("invalid_transition");
    expect(seen.some((s) => s.trimStart().startsWith("UPDATE"))).toBe(false);
  });
});

describe("payment status transitions", () => {
  it("valid transition applies when the row still holds the expected status", async () => {
    const { db, seen } = stubDb({ changes: 1 });
    const order = await transitionPaymentStatus(db, "s1", "o1", "paid");
    expect(order?.id).toBe("o1");
    expect(seen.some((s) => s.includes("AND payment_status = ?"))).toBe(true);
  });

  it("concurrent move collapses to 409 instead of overwriting", async () => {
    const { db } = stubDb({ changes: 0 });
    expect(await codeOf(transitionPaymentStatus(db, "s1", "o1", "paid"))).toBe("invalid_transition");
  });

  it("invalid transition is rejected before any UPDATE", async () => {
    const { db, seen } = stubDb();
    expect(await codeOf(transitionPaymentStatus(db, "s1", "o1", "refunded"))).toBe("invalid_transition");
    expect(seen.some((s) => s.trimStart().startsWith("UPDATE"))).toBe(false);
  });
});
