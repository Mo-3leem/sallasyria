import { describe, expect, it } from "vitest";
import {
  NEXT_ORDER_STATUSES,
  NEXT_PAYMENT_STATUSES,
  orderStatusLabel,
  ORDER_STATUS_LABELS,
  paymentMethodLabel,
  paymentStatusLabel,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
} from "./orders.js";

function assertClosedGraph(graph: Record<string, string[]>, label: string) {
  for (const [from, tos] of Object.entries(graph)) {
    for (const to of tos) {
      expect(Object.keys(graph).includes(to), `${label}: ${from} -> ${to}`).toBe(true);
      expect(to === from, `${label}: no self-loop on ${from}`).toBe(false);
    }
  }
}

describe("order/payment label maps", () => {
  it("labels every known value and echoes unknown values through", () => {
    for (const [map, sample] of [
      [ORDER_STATUS_LABELS, "pending"],
      [PAYMENT_STATUS_LABELS, "paid"],
      [PAYMENT_METHOD_LABELS, "cod"],
    ] as const) {
      expect(typeof map[sample]).toBe("string");
      expect(map[sample].length).toBeGreaterThan(0);
    }
    expect(orderStatusLabel("pending")).toBe(ORDER_STATUS_LABELS["pending"]);
    expect(paymentStatusLabel("mystery")).toBe("mystery");
    expect(paymentMethodLabel("mystery")).toBe("mystery");
    expect(orderStatusLabel("mystery")).toBe("mystery");
  });
});

describe("order/payment transition graphs", () => {
  it("only offers transition targets that exist as states", () => {
    assertClosedGraph(NEXT_ORDER_STATUSES, "order");
    assertClosedGraph(NEXT_PAYMENT_STATUSES, "payment");
  });

  it("terminal states offer nothing", () => {
    expect(NEXT_ORDER_STATUSES["delivered"]).toEqual([]);
    expect(NEXT_ORDER_STATUSES["cancelled"]).toEqual([]);
    expect(NEXT_PAYMENT_STATUSES["refunded"]).toEqual([]);
  });

  it("the happy paths walk end to end", () => {
    let s = "pending";
    for (const next of ["confirmed", "processing", "shipped", "delivered"] as const) {
      expect(NEXT_ORDER_STATUSES[s]).toContain(next);
      s = next;
    }
    expect(NEXT_ORDER_STATUSES["pending"]).toContain("cancelled");
    expect(NEXT_PAYMENT_STATUSES["pending"]).toEqual(
      expect.arrayContaining(["paid", "failed"])
    );
    expect(NEXT_PAYMENT_STATUSES["paid"]).toEqual(["refunded"]);
    expect(NEXT_PAYMENT_STATUSES["failed"]).toEqual(["paid"]);
  });
});
