import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { ok, fail } from "../http/respond.js";

export const health = new Hono<AppEnv>();

// Liveness: no dependencies, no auth. Safe for load balancers / uptime bots.
health.get("/health", (c) => ok(c, { status: "up" }));

// Readiness: proves the Worker can reach D1. Failure returns 503 with a
// generic code — the underlying DB error is never exposed to the client.
health.get("/ready", async (c) => {
  try {
    const row = await getDb(c)
      .prepare("SELECT 1 AS ok")
      .first<{ ok: number }>();
    if (row?.ok !== 1) throw new Error("unexpected readiness result");
    return ok(c, { status: "ready", db: "up" });
  } catch {
    return fail(c, "db_unavailable", "Database is not reachable.", 503);
  }
});
