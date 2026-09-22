import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { ok, fail } from "../http/respond.js";
import { z, validationHook } from "../http/validate.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";

export const health = new OpenAPIHono<AppEnv>();

const healthOkSchema = okOf(
  z.object({ status: z.string().openapi({ example: "up" }) }),
);

const readyOkSchema = okOf(
  z.object({
    status: z.string().openapi({ example: "ready" }),
    db: z.string().openapi({ example: "up" }),
  }),
);

// Liveness: no dependencies, no auth. Safe for load balancers / uptime bots.
const healthRoute = createRoute({
  method: "get",
  path: "/health",
  summary: "Liveness probe",
  description: "Returns 200 when the service is up. No dependencies, no auth.",
  responses: {
    200: {
      content: { "application/json": { schema: healthOkSchema } },
      description: "Service is up",
    },
  },
});

health.openapi(healthRoute, (c) => ok(c, { status: "up" }), validationHook);

// Readiness: proves the Worker can reach D1. Failure returns 503 with a
// generic code — the underlying DB error is never exposed to the client.
const readyRoute = createRoute({
  method: "get",
  path: "/ready",
  summary: "Readiness probe",
  description:
    "Returns 200 when the Worker can reach D1, generic 503 otherwise.",
  responses: {
    200: {
      content: { "application/json": { schema: readyOkSchema } },
      description: "Worker can reach D1",
    },
    503: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Database is not reachable",
    },
  },
});

health.openapi(
  readyRoute,
  async (c) => {
    try {
      const row = await getDb(c)
        .prepare("SELECT 1 AS ok")
        .first<{ ok: number }>();
      if (row?.ok !== 1) throw new Error("unexpected readiness result");
      return ok(c, { status: "ready", db: "up" });
    } catch {
      return fail(c, "db_unavailable", "Database is not reachable.", 503);
    }
  },
  validationHook,
);
