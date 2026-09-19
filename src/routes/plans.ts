import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { ok } from "../http/respond.js";
import { z, validationHook } from "../http/validate.js";
import { okOf } from "../openapi/envelope.js";
import { listPlans } from "../services/plans.js";

export const plans = new OpenAPIHono<AppEnv>();

// NOTE (type-level boundary): zero SQL strings here; all queries live in
// services/plans. Plans are platform-global, so no auth, no store scope, and
// no tenant middleware on this router. Public shape exposes only what a
// merchant needs to choose a plan (no timestamps).

const publicPlanSchema = z
  .object({
    id: z.string().openapi({ example: "plan_01J..." }),
    code: z.string().openapi({ example: "premium" }),
    name: z.string().openapi({ example: "Premium" }),
    price_monthly: z.number().openapi({ example: 250000 }),
    price_yearly: z.number().openapi({ example: 2500000 }),
    max_products: z.number().nullable().openapi({ example: 500 }),
  })
  .openapi("PublicPlan");

const listPublicPlansRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List available plans",
  description: "Public plan catalog for merchants choosing a subscription. No authentication.",
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ plans: z.array(publicPlanSchema) })) } },
      description: "Available plans",
    },
  },
});

plans.openapi(listPublicPlansRoute, async (c) => {
  const rows = await listPlans(getDb(c));
  return ok(c, {
    plans: rows.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      price_monthly: p.price_monthly,
      price_yearly: p.price_yearly,
      max_products: p.max_products,
    })),
  });
}, validationHook);
