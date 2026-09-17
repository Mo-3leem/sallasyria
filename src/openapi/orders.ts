import { z } from "@hono/zod-openapi";

// Shared order documentation schemas (used by checkout + orders routes).
// Shapes mirror the service row types exactly; runtime behavior lives in
// services/checkout.ts and services/orders.ts and is unchanged.
export const orderDocSchema = z
  .object({
    id: z.string(),
    store_id: z.string(),
    order_number: z.number(),
    status: z.string(),
    subtotal: z.number(),
    discount: z.number(),
    total: z.number(),
    payment_method: z.string(),
    payment_status: z.string(),
    customer_name: z.string(),
    customer_phone: z.string(),
    shipping_method: z.string(),
    shipping_cost: z.number(),
    shipping_governorate: z.string(),
    shipping_address: z.string(),
  })
  .openapi("Order");

export const orderItemDocSchema = z
  .object({
    id: z.string(),
    product_name: z.string(),
    quantity: z.number(),
    unit_price: z.number(),
    line_total: z.number(),
  })
  .openapi("OrderItem");
