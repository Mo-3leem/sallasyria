// Theme designer integration suite: draft/publish/preview authorization,
// extended design keys, and public published-theme exposure. Real workerd +
// real local D1. Fixtures use user_verify_b4t_* (covered by
// scripts/clean-verify.mjs).

import { execFileSync, type ChildProcess } from "node:child_process";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18881;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const OWNER_A = "+963900000821";
const OWNER_B = "+963900000822";
const PASS = "Theme-Strong-1";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b4ttest-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  try {
    const out = execFileSync(isWindows ? "npx.cmd" : "npx", ["wrangler", "d1", "execute", "sallasyria-db", "--local", "--json", "--file", file], {
      encoding: "utf8",
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows,
    });
    const parsed = JSON.parse(out);
    const ok = (parsed as { success: boolean }[]).every((r) => r.success);
    return { ok, error: ok ? undefined : JSON.stringify(parsed) };
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string };
    return { ok: false, error: String(e.stderr ?? e.message ?? err) };
  }
}



async function api(path: string, init: RequestInit = {}, cookies = "") {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body, setCookie: res.headers.get("set-cookie") };
}

function cookieOf(setCookie: string | null): string {
  if (!setCookie) throw new Error("expected Set-Cookie");
  return `ss_session=${(setCookie.split(";")[0] ?? "").split("=").slice(1).join("=")}`;
}

const A = "store_verify_b4t_a";
const B = "store_verify_b4t_b";

let jarA = "";
let jarB = "";

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  const h = hashPassword(PASS);
  assertCleanVerify("b4t reset");
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b4t_a', '${OWNER_A}', 'b4ta@example.com', 'B4T Owner A', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b4t_b', '${OWNER_B}', 'b4tb@example.com', 'B4T Owner B', '${h}', 'merchant');`,
    `INSERT INTO plans (id, code, name) VALUES ('plan_verify_b4t', 'b4t-plan', 'B4T Plan');`,
    `INSERT INTO stores (id, owner_id, slug, name, is_published) VALUES ('${A}', 'user_verify_b4t_a', 'b4t-store-a', 'B4T Store A', 1);`,
    `INSERT INTO stores (id, owner_id, slug, name, is_published) VALUES ('${B}', 'user_verify_b4t_b', 'b4t-store-b', 'B4T Store B', 1);`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b4t_a', '${A}', 'plan_verify_b4t', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b4t_b', '${B}', 'plan_verify_b4t', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`B4T seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id IN ('user_verify_b4t_a', 'user_verify_b4t_b');`);

  async function loginCookie(email: string): Promise<string> {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASS }),
    });
    if (res.status !== 200) throw new Error(`B4T setup login failed for ${email}: ${res.status}`);
    return cookieOf(res.headers.get("set-cookie"));
  }
  jarA = await loginCookie("b4ta@example.com");
  jarB = await loginCookie("b4tb@example.com");
}, 180_000);

afterAll(async () => {
  try {
    assertCleanVerify("b4t end");
  } finally {
    stopDevServer(server);
    server = null;
  }
}, 60_000);

interface ThemeBody {
  data: {
    theme: {
      draft: Record<string, unknown>;
      published_snapshot: Record<string, unknown> | null;
      published_at: string | null;
    };
  };
}

describe("theme designer authorization", () => {
  it("owner reads own theme; stranger gets 404; anonymous gets 401", async () => {
    const own = await api(`/stores/${A}/theme`, {}, jarA);
    expect(own.status).toBe(200);
    const stranger = await api(`/stores/${A}/theme`, {}, jarB);
    expect(stranger.status).toBe(404);
    const anon = await api(`/stores/${A}/theme`, {});
    expect(anon.status).toBe(401);
  });

  it("stranger cannot update, publish, or issue preview for another store", async () => {
    const patch = await api(`/stores/${A}/theme`, {
      method: "PATCH",
      body: JSON.stringify({ palette: { primary: "#000000" } }),
    }, jarB);
    expect(patch.status).toBe(404);
    const publish = await api(`/stores/${A}/theme/publish`, { method: "POST" }, jarB);
    expect(publish.status).toBe(404);
    const preview = await api(`/stores/${A}/theme/preview`, { method: "POST" }, jarB);
    expect(preview.status).toBe(404);
  });
});

describe("theme draft extended keys", () => {
  it("accepts header/hero/products/footer/font/secondary keys; unknown keys 400", async () => {
    const patch = await api(`/stores/${A}/theme`, {
      method: "PATCH",
      body: JSON.stringify({
        palette: { secondary: "#111111", button: "#222222" },
        font: "system",
        header: { show_cart: 0, background: "#333333" },
        hero: { title: "Hello", align: "right", cta_visible: 0, image: "https://example.com/h.png" },
        products: { show_prices: 0 },
        footer: { visible: 1, text: "Custom footer" },
        sections: [{ type: "hero", order: 0, is_visible: 1, title: "Top" }],
      }),
    }, jarA);
    expect(patch.status).toBe(200);
    const draft = (patch.body as ThemeBody).data.theme.draft;
    expect(draft).toMatchObject({
      font: "system",
      header: { show_cart: 0 },
      hero: { title: "Hello", align: "right" },
      footer: { text: "Custom footer" },
    });

    const bad = await api(`/stores/${A}/theme`, {
      method: "PATCH",
      body: JSON.stringify({ nope: 1 }),
    }, jarA);
    expect(bad.status).toBe(400);
  });

  it("logo accepts https and null; rejects http and javascript: URLs", async () => {
    const good = await api(`/stores/${A}/theme`, {
      method: "PATCH",
      body: JSON.stringify({ logo: "https://cdn.example.com/logo.png" }),
    }, jarA);
    expect(good.status).toBe(200);
    expect((good.body as ThemeBody).data.theme.draft.logo).toBe("https://cdn.example.com/logo.png");

    for (const badLogo of ["http://cdn.example.com/logo.png", "javascript:alert(1)"]) {
      const bad = await api(`/stores/${A}/theme`, {
        method: "PATCH",
        body: JSON.stringify({ logo: badLogo }),
      }, jarA);
      expect(bad.status, badLogo).toBe(400);
      expect((bad.body as { error: { code: string } }).error.code).toBe("validation_failed");
    }

    const cleared = await api(`/stores/${A}/theme`, {
      method: "PATCH",
      body: JSON.stringify({ logo: null }),
    }, jarA);
    expect(cleared.status).toBe(200);
    expect((cleared.body as ThemeBody).data.theme.draft.logo).toBeNull();
  });
});

describe("theme publish + public exposure", () => {
  it("unpublished store exposes null theme publicly", async () => {
    const res = await api(`/stores/${B}/catalog/store`, {});
    expect(res.status).toBe(200);
    expect((res.body as { data: { theme: unknown } }).data.theme).toBeNull();
  });

  it("publish snapshots draft; public store serves the snapshot, not the live draft", async () => {
    const marker = `snap-${Date.now().toString(36)}`;
    const patched = await api(`/stores/${A}/theme`, {
      method: "PATCH",
      body: JSON.stringify({ footer: { visible: 1, text: marker } }),
    }, jarA);
    expect(patched.status).toBe(200);

    const published = await api(`/stores/${A}/theme/publish`, { method: "POST" }, jarA);
    expect(published.status).toBe(200);
    expect((published.body as ThemeBody).data.theme.published_at).toBeTruthy();

    const pub = await api(`/stores/${A}/catalog/store`, {});
    expect(pub.status).toBe(200);
    expect(
      ((pub.body as { data: { theme: { footer: { text: string } } } }).data.theme.footer.text)
    ).toBe(marker);

    // Post-publish draft edits do not leak to the public payload.
    await api(`/stores/${A}/theme`, {
      method: "PATCH",
      body: JSON.stringify({ footer: { visible: 1, text: `${marker}-draft` } }),
    }, jarA);
    const pub2 = await api(`/stores/${A}/catalog/store`, {});
    expect(
      ((pub2.body as { data: { theme: { footer: { text: string } } } }).data.theme.footer.text)
    ).toBe(marker);
  });

  it("preview token renders the current draft; unknown tokens 404", async () => {
    const marker = `draft-${Date.now().toString(36)}`;
    const patched = await api(`/stores/${A}/theme`, {
      method: "PATCH",
      body: JSON.stringify({ footer: { visible: 1, text: marker } }),
    }, jarA);
    expect(patched.status).toBe(200);
    const issued = await api(`/stores/${A}/theme/preview`, { method: "POST" }, jarA);
    expect(issued.status).toBe(200);
    const token = (issued.body as { data: { token: string } }).data.token;
    const rendered = await api(`/s/preview/${token}`, {});
    expect(rendered.status).toBe(200);
    const payload = rendered.body as {
      data: { store: { id: string }; theme: { draft: { footer: { text: string } } } };
    };
    expect(payload.data.store.id).toBe(A);
    // Guest preview serves the CURRENT draft, not the published snapshot.
    expect(payload.data.theme.draft.footer.text).toBe(marker);
    const ghost = await api(`/s/preview/${"0".repeat(43)}`, {});
    expect(ghost.status).toBe(404);
  });

  it("published background color survives the full pipeline; later drafts do not leak", async () => {
    const publishedBg = "#123456";
    const draftBg = "#654321";
    // 1-3. Builder control -> draft -> save.
    const saved = await api(`/stores/${A}/theme`, {
      method: "PATCH",
      body: JSON.stringify({ palette: { background: publishedBg } }),
    }, jarA);
    expect(saved.status).toBe(200);
    expect(
      ((saved.body as ThemeBody).data.theme.draft as { palette: { background: string } }).palette.background
    ).toBe(publishedBg);
    // 4. Publish copies it into the snapshot.
    const published = await api(`/stores/${A}/theme/publish`, { method: "POST" }, jarA);
    expect(published.status).toBe(200);
    // 5-6. Public storefront API returns it; the storefront theme mapping
    // receives the identical value (same field, palette.background).
    const pub = await api(`/stores/${A}/catalog/store`, {});
    expect(pub.status).toBe(200);
    const pubTheme = (pub.body as { data: { theme: { palette: { background: string } } } }).data.theme;
    expect(pubTheme.palette.background).toBe(publishedBg);
    // 7. A newer unsaved-for-visitors draft does not move the published value.
    await api(`/stores/${A}/theme`, {
      method: "PATCH",
      body: JSON.stringify({ palette: { background: draftBg } }),
    }, jarA);
    const pub2 = await api(`/stores/${A}/catalog/store`, {});
    expect(
      (pub2.body as { data: { theme: { palette: { background: string } } } }).data.theme.palette.background
    ).toBe(publishedBg);
    // And the guest preview follows the new draft, not the published value.
    const issued = await api(`/stores/${A}/theme/preview`, { method: "POST" }, jarA);
    const token = (issued.body as { data: { token: string } }).data.token;
    const rendered = await api(`/s/preview/${token}`, {});
    expect(
      (rendered.body as { data: { theme: { draft: { palette: { background: string } } } } }).data.theme.draft.palette.background
    ).toBe(draftBg);
  });

  it("preview fan-out is bounded: unknown tokens 404, then 429", async () => {
    // Limiter runs before the token lookup, so misses still count. Loop past
    // the generous budget; assert the trip plus ample legitimate headroom
    // (prior tests in this file make only a handful of preview calls).
    let successes = 0;
    let trippedAt = -1;
    for (let i = 0; i < 80 && trippedAt < 0; i++) {
      const res = await api(`/s/preview/${"9".repeat(42)}${String(i % 10)}`, {});
      if (res.status === 429) {
        trippedAt = i;
        expect(res.body).toEqual({
          ok: false,
          error: { code: "rate_limited", message: expect.any(String) },
        });
      } else {
        expect(res.status).toBe(404);
        successes++;
      }
    }
    expect(trippedAt).toBeGreaterThanOrEqual(0);
    expect(successes).toBeGreaterThanOrEqual(50);
  });
});
