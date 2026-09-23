import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env.js";
import { errorHandler } from "../src/http/errors.js";
import { ok } from "../src/http/respond.js";
import { resolvePublishedStore } from "../src/middleware/store.js";
import { storeScope } from "../src/db/tenant.js";
import {
  ensureTheme,
  issuePreviewToken,
  publishTheme,
  resolvePreviewToken,
  updateThemeDraft,
} from "../src/services/theme.js";

// Theme service matrix (fast, no server): lazy draft creation, shallow
// merge semantics, audited snapshot publish, single-live preview tokens
// with unknown/expired collapsing to null.

interface ThemeRow {
  store_id: string;
  draft: string;
  published_snapshot: string | null;
  published_at: string | null;
  updated_at: string;
}

interface PreviewRow {
  id: string;
  store_id: string;
  token_hash: string;
  expires_at: string;
}

function fakeDb(state: {
  themes: Record<string, ThemeRow>;
  previews: PreviewRow[];
  sha: (token: string) => string;
}) {
  // NOTE: bind orders mirror services/theme.ts exactly:
  // UPDATE themes SET draft → (draft, updated_at, store_id).
  const pick = (sql: string, args: unknown[]) => {
    const a0 = args[0];
    if (sql.startsWith("INSERT INTO themes")) {
      if (!state.themes[String(a0)]) {
        state.themes[String(a0)] = {
          store_id: String(a0),
          draft: "{}",
          published_snapshot: null,
          published_at: null,
          updated_at: "t",
        };
      }
      return { run: async () => ({}) };
    }
    if (sql.startsWith("SELECT * FROM themes")) {
      return { first: async () => state.themes[String(a0)] ?? null };
    }
    if (sql.startsWith("UPDATE themes SET draft")) {
      const row = state.themes[String(args[2])];
      if (row) {
        row.draft = String(args[0]);
        row.updated_at = String(args[1]);
      }
      return { run: async () => ({}) };
    }
    if (sql.startsWith("UPDATE themes SET published_snapshot")) {
      return { run: async () => ({}) };
    }
    if (sql.startsWith("UPDATE theme_previews SET expires_at")) {
      return { run: async () => ({}) };
    }
    if (sql.startsWith("INSERT INTO theme_previews")) {
      return { run: async () => ({}) };
    }
    if (sql.startsWith("SELECT store_id FROM theme_previews")) {
      return { first: async () => null };
    }
    throw new Error(`unexpected SQL in theme fake: ${sql.slice(0, 60)}`);
  };
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => pick(sql, args),
    }),
    batch: async (ops: { run?: () => Promise<unknown> }[]) => {
      for (const op of ops) await op.run?.();
      return ops.map(() => ({ success: true }));
    },
  };
}

describe("theme draft", () => {
  it("lazily creates an empty draft and shallow-merges patches", async () => {
    const db = fakeDb({ themes: {}, previews: [], sha: (t) => `h:${t}` }) as never;
    const created = await ensureTheme(db, "s1");
    expect(created.draft).toEqual({});
    const updated = await updateThemeDraft(db, "s1", {
      palette: { primary: "#16a34a" },
    });
    expect(updated.draft).toEqual({ palette: { primary: "#16a34a" } });
    const merged = await updateThemeDraft(db, "s1", { logo: "https://x/y.png" });
    expect(merged.draft).toEqual({
      palette: { primary: "#16a34a" },
      logo: "https://x/y.png",
    });
  });

  it("tolerates corrupt stored JSON by falling back to empty", async () => {
    const db = fakeDb({
      themes: {
        s9: { store_id: "s9", draft: "not-json{{{", published_snapshot: null, published_at: null, updated_at: "t" },
      },
      previews: [],
      sha: (t) => `h:${t}`,
    }) as never;
    const theme = await ensureTheme(db, "s9");
    expect(theme.draft).toEqual({});
  });
});

describe("theme publish + preview tokens", () => {
  it("publish snapshots the draft and preview issuance resolves live tokens", async () => {
    const themes: Record<string, ThemeRow> = {};
    const previews: PreviewRow[] = [];
    const now = "2026-09-22T00:00:00Z";
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (sql.startsWith("INSERT INTO themes") && !themes[String(args[0])]) {
              themes[String(args[0])] = {
                store_id: String(args[0]), draft: "{}", published_snapshot: null,
                published_at: null, updated_at: now,
              };
            }
            if (sql.startsWith("UPDATE themes SET draft")) {
              // bind order: (draft, updated_at, store_id)
              themes[String(args[2])]!.draft = String(args[0]);
            }
            if (sql.startsWith("UPDATE themes SET published_snapshot")) {
              const row = themes[String(args[3])]!;
              row.published_snapshot = String(args[0]);
              row.published_at = String(args[1]);
            }
            if (sql.startsWith("INSERT INTO theme_previews")) {
              previews.push({
                id: String(args[0]), store_id: String(args[1]),
                token_hash: String(args[2]), expires_at: String(args[3]),
              });
            }
            return {};
          },
          first: async () => {
            if (sql.startsWith("SELECT * FROM themes")) return themes[String(args[0])] ?? null;
            if (sql.startsWith("SELECT store_id FROM theme_previews")) {
              const hit = previews.find(
                (p) => p.token_hash === String(args[0]) && p.expires_at > String(args[1])
              );
              return hit ? { store_id: hit.store_id } : null;
            }
            return null;
          },
          all: async () => ({ results: [] }),
        }),
      }),
      batch: async (ops: { run?: () => Promise<unknown> }[]) => {
        for (const op of ops) await op.run?.();
        return ops.map(() => ({ success: true }));
      },
    } as never;

    await updateThemeDraft(db, "s1", { palette: { primary: "#16a34a" } }, now);
    const published = await publishTheme(db, "s1", now);
    expect(published.published_snapshot).toEqual({ palette: { primary: "#16a34a" } });
    expect(published.published_at).toBe(now);
    // Draft stays editable after publish.
    expect(published.draft).toEqual({ palette: { primary: "#16a34a" } });

    const issued = await issuePreviewToken(db, "s1", now, Date.parse(now));
    expect(issued.token.length).toBeGreaterThan(20);
    const resolved = await resolvePreviewToken(db, issued.token, now);
    expect(resolved).toEqual({ storeId: "s1" });
    expect(await resolvePreviewToken(db, "forged-token", now)).toBeNull();
  });

  it("preview middleware treats missing and draft stores identically", async () => {
    const app = new OpenAPIHono<AppEnv>();
    app.onError(errorHandler);
    const fake = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
    };
    app.get(
      "/s/:storeId",
      resolvePublishedStore,
      (c) => ok(c, { storeId: storeScope(c).storeId })
    );
    const env = { DB: fake } as unknown as AppEnv;
    for (const path of ["/s/nope", "/s/draft"]) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(404);
    }
  });
});
