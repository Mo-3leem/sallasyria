import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env.js";
import { errorHandler } from "../src/http/errors.js";
import { ok } from "../src/http/respond.js";
import { resolvePublishedStore } from "../src/middleware/store.js";
import { storeScope } from "../src/db/tenant.js";

// resolvePublishedStore matrix (fast, no server): published+active resolves;
// missing, draft, AND paused/archived answer with the identical 404 (no
// oracle). Drafts stay manageable through the unchanged merchant-private
// resolveStore path.
function probeApp(rows: Record<string, { id: string; is_published: number; status: string } | null>) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  const fakeDb = {
    prepare: (sql: string) => ({
      bind: (id: unknown) => ({
        first: async () =>
          sql.includes("FROM stores") ? (rows[String(id)] ?? null) : null,
      }),
    }),
  };
  app.get("/s/:storeId", resolvePublishedStore, (c) =>
    ok(c, { storeId: storeScope(c).storeId })
  );
  return {
    get: (storeId: string) =>
      app.request(
        `/s/${storeId}`,
        {},
        { DB: fakeDb } as unknown as AppEnv
      ),
  };
}

const PUB = { id: "s-pub", is_published: 1, status: "active" };
const DRAFT = { id: "s-draft", is_published: 0, status: "active" };
const PAUSED = { id: "s-paused", is_published: 1, status: "paused" };

describe("resolvePublishedStore", () => {
  it("resolves published stores", async () => {
    const { get } = probeApp({ "s-pub": PUB });
    const res = await get("s-pub");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { storeId: "s-pub" } });
  });

  it("answers missing, draft, and paused ids with an identical 404", async () => {
    const { get } = probeApp({ "s-draft": DRAFT, "s-paused": PAUSED });
    const missing = await get("s-nope");
    const draft = await get("s-draft");
    const paused = await get("s-paused");
    expect(missing.status).toBe(404);
    expect(draft.status).toBe(404);
    expect(paused.status).toBe(404);
    const [missingBody, draftBody, pausedBody] = await Promise.all([
      missing.json(),
      draft.json(),
      paused.json(),
    ]);
    expect(draftBody).toEqual(missingBody);
    expect(pausedBody).toEqual(missingBody);
  });
});
