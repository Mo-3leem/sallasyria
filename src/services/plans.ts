import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "../http/errors.js";
import { uuidv7 } from "../lib/ids.js";
import { touch } from "../lib/time.js";

// Plan data access (platform-level, NOT tenant-scoped). Same type-level
// boundary as every other service: explicit ids, never a Hono Context, all
// SQL lives here (routes contain zero SQL strings, enforced by
// tests/tenant-conventions.test.ts). Plans carry no store_id — the same
// functions serve the admin and public readers.

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  price_monthly: number;
  price_yearly: number;
  max_products: number | null;
  created_at: string;
  updated_at: string;
}

const PLAN_COLUMNS = "id, code, name, price_monthly, price_yearly, max_products, created_at, updated_at";

export interface PlanCreate {
  code: string;
  name: string;
  price_monthly?: number;
  price_yearly?: number;
  max_products?: number | null;
}

export interface PlanPatch {
  name?: string;
  price_monthly?: number;
  price_yearly?: number;
  max_products?: number | null;
}

export async function listPlans(db: D1Database): Promise<PlanRow[]> {
  const res = await db
    .prepare(`SELECT ${PLAN_COLUMNS} FROM plans ORDER BY created_at`)
    .all<PlanRow>();
  return res.results ?? [];
}

export async function getPlan(db: D1Database, id: string): Promise<PlanRow | null> {
  return db
    .prepare(`SELECT ${PLAN_COLUMNS} FROM plans WHERE id = ?`)
    .bind(id)
    .first<PlanRow>();
}

// Code uniqueness is pre-checked by callers only as a fast path; the
// uq_plans_code UNIQUE below is the race backstop (residual-race pattern
// mirrors services/catalog.ts and services/users.ts).
export async function createPlan(
  db: D1Database,
  input: PlanCreate,
  nowIso: string = touch()
): Promise<PlanRow> {
  const id = uuidv7();
  try {
    await db
      .prepare(
        "INSERT INTO plans (id, code, name, price_monthly, price_yearly, max_products, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        id,
        input.code,
        input.name,
        input.price_monthly ?? 0,
        input.price_yearly ?? 0,
        input.max_products ?? null,
        nowIso,
        nowIso
      )
      .run();
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(text)) {
      throw new AppError("plan_code_taken", 409, "Plan code is already in use.");
    }
    throw err;
  }
  const row = await getPlan(db, id);
  if (!row) throw new AppError("internal", 500, "Something went wrong.");
  return row;
}

// Partial update over a route-whitelisted patch (code/id never reach here —
// the route 400s them on the raw body first). SET identifiers below are
// fixed literals, never client input.
export async function updatePlan(
  db: D1Database,
  id: string,
  patch: PlanPatch,
  nowIso: string = touch()
): Promise<PlanRow | null> {
  if (!(await getPlan(db, id))) return null;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    vals.push(patch.name);
  }
  if (patch.price_monthly !== undefined) {
    sets.push("price_monthly = ?");
    vals.push(patch.price_monthly);
  }
  if (patch.price_yearly !== undefined) {
    sets.push("price_yearly = ?");
    vals.push(patch.price_yearly);
  }
  if (patch.max_products !== undefined) {
    sets.push("max_products = ?");
    vals.push(patch.max_products);
  }
  if (sets.length > 0) {
    await db
      .prepare(`UPDATE plans SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
      .bind(...vals, nowIso, id)
      .run();
  }
  return getPlan(db, id);
}

// Hard delete with a subscription-reference guard: a referenced plan 409s
// with the referencing count instead of leaking a RESTRICT 500. The
// FOREIGN KEY backstop below covers the check-then-delete race only.
export async function deletePlan(
  db: D1Database,
  id: string
): Promise<{ deleted: string } | null> {
  if (!(await getPlan(db, id))) return null;
  const refs = await db
    .prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE plan_id = ?")
    .bind(id)
    .first<{ n: number }>();
  const n = refs?.n ?? 0;
  if (n > 0) {
    throw new AppError(
      "plan_in_use",
      409,
      `Plan is referenced by ${n} subscription(s) and cannot be deleted.`
    );
  }
  try {
    await db.prepare("DELETE FROM plans WHERE id = ?").bind(id).run();
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/FOREIGN KEY constraint failed/i.test(text)) {
      throw new AppError(
        "plan_in_use",
        409,
        "Plan is referenced by subscriptions and cannot be deleted."
      );
    }
    throw err;
  }
  return { deleted: id };
}
