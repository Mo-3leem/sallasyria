import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Static guards for the B3 type-level tenant boundary. These tests read source
// text (not behavior) on purpose: they make the conventions structurally
// unbreakable — a future route that inlines SQL or reads scoping from the
// request fails the suite before it can ship.
//   - Routes (src/routes): HTTP only. Zero SQL strings; path params are read
//     ONLY in middleware/store.ts (resolveStore); store_id never appears on a
//     line that also touches the request (c.req / valid() / .json()).
//   - Services (src/services): SQL only. Never import hono/Context — data
//     functions take explicit ids, so client input cannot flow into scoping.

const ROOT = join(import.meta.dirname, "..", "src");

function filesOf(dir: string): { name: string; text: string }[] {
  return readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(ROOT, dir, name), "utf8") }));
}

const SQL_RE = /\b(select\s+.+?\s+from|insert\s+into|update\s+\w+\s+set|delete\s+from)\b/is;

// Exempt from the no-SQL rule ONLY: routes over global (non-tenant) tables.
// auth.ts queries users/sessions (no store dimension exists there); health.ts
// runs a static probe. Both predate this convention (B1/B2, approved as-is).
// The exemption is conditional: these files must not reference store_id at
// all — the moment they do, they become tenant routes under the full rule.
const SQL_EXEMPT = new Set(["auth.ts", "health.ts"]);

describe("tenant conventions (static)", () => {
  it("tenant routes contain zero SQL strings", () => {
    for (const { name, text } of filesOf("routes")) {
      const code = text
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .join("\n");
      if (SQL_EXEMPT.has(name)) {
        expect(code, `${name} is exempt only while store_id-free`).not.toContain("store_id");
        continue;
      }
      expect(code, `${name} must not contain SQL`).not.toMatch(SQL_RE);
    }
  });

  it("routes never read path params (centralized helpers only)", () => {
    // :storeId is read exactly once (resolveStore, middleware/store.ts);
    // resource :id/:key exactly once (resourceId, db/tenant.ts). A route
    // reaching for .param() directly bypasses the fail-closed helpers.
    for (const { name, text } of filesOf("routes")) {
      expect(text, `${name} must not call .param()`).not.toContain(".param(");
    }
    const storeMw = readFileSync(join(ROOT, "middleware", "store.ts"), "utf8");
    expect(storeMw, "resolveStore must own the :storeId read").toContain('.param("storeId")');
    const tenant = readFileSync(join(ROOT, "db", "tenant.ts"), "utf8");
    expect(tenant, "resourceId must own the resource-param read").toContain("c.req.param(name)");
  });

  it("routes never mix store_id with request input on one line", () => {
    for (const { name, text } of filesOf("routes")) {
      for (const [i, line] of text.split("\n").entries()) {
        const touchesRequest =
          line.includes("c.req") || line.includes("valid(") || line.includes(".json(");
        expect(
          !(touchesRequest && line.includes("store_id")),
          `${name}:${i + 1} mixes store_id with request input`
        ).toBe(true);
      }
    }
  });

  it("services never import hono/Context", () => {
    for (const { name, text } of filesOf("services")) {
      expect(text, `${name} must not depend on hono`).not.toMatch(/from ["']hono["']/);
      expect(text, `${name} must not take a Context`).not.toContain("Context<");
    }
  });
});
