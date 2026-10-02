import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { resetDocsLimit } from "../src/lib/rate-limit.js";
import { signAvatarUrl, signImageUrl } from "../src/lib/uploads.js";

// B8 security-header suite (in-process createApp().request style, no live
// server). Asserts the global header set across every response class,
// the CORP carve-out on the two bearer-URL file routes, the production
// HSTS gate, and that /doc + /ui behavior is unchanged.

const GLOBAL_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["X-Frame-Options", "DENY"],
  [
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  ],
  ["Cross-Origin-Opener-Policy", "same-origin"],
];

function expectGlobalHeaders(res: Response, corp = "same-origin") {
  for (const [name, value] of GLOBAL_HEADERS) {
    expect(res.headers.get(name)).toBe(value);
  }
  expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe(corp);
  // No CSP anywhere in B8 scope (deferred: Next hydration, Turnstile,
  // fonts, /ui inline script).
  expect(res.headers.get("Content-Security-Policy")).toBeNull();
  expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
}

// Query-aware D1 stub: answers just enough for the exercised paths.
// Anything else resolves null (unknown session/store -> auth 404/401).
function stubDb() {
  return {
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => ({
        first: async () => {
          if (sql.includes("FROM subscriptions")) return { ok: 1 };
          if (sql.includes("FROM stores")) return { id: "s1", status: "active" };
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({}),
      }),
    }),
  };
}

const TEST_SECRET = "security-headers-test-secret";
const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600;

function fileEnv() {
  return {
    DB: stubDb(),
    URL_SIGNING_SECRET: TEST_SECRET,
    R2: {
      get: async () => ({
        body: "fake-image-bytes",
        httpMetadata: { contentType: "image/png" },
      }),
    },
  } as unknown as Env;
}

describe("B8 global security headers", () => {
  it("normal 200 responses carry the global set, no HSTS, no CSP", async () => {
    const res = await createApp().request("/health");
    expect(res.status).toBe(200);
    expectGlobalHeaders(res);
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("404/notFound responses carry the global set", async () => {
    const res = await createApp().request("/no-such-route");
    expect(res.status).toBe(404);
    expectGlobalHeaders(res);
  });

  it("401 responses carry the global set", async () => {
    const res = await createApp().request("/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: "x", new_password: "Yy-123456" }),
    });
    expect(res.status).toBe(401);
    expectGlobalHeaders(res);
  });

  it("422 responses carry the global set", async () => {
    // Checkout with neither items nor cart_id: schema-valid, so the
    // cart_or_items 422 fires. Stub DB satisfies resolveStore +
    // subscription gate; Turnstile bypasses without a secret in dev.
    const res = await createApp().request(
      "/stores/s1/checkout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer: { name: "N", phone: "+963900000001" },
          shipping: {
            recipient_name: "N",
            phone: "+963900000001",
            governorate: "Damascus",
            address_line: "Street 1",
          },
          payment: { method: "cod" },
        }),
      },
      { DB: stubDb() } as unknown as Env
    );
    expect(res.status).toBe(422);
    expectGlobalHeaders(res);
  });

  it("429 responses carry the global set", async () => {
    // /doc regeneration is DB-free: 60 allowed, 61st trips in-process.
    const app = createApp();
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) {
      last = await app.request("/doc");
    }
    expect(last!.status).toBe(429);
    expectGlobalHeaders(last!);
  });

  it("500 error responses carry the global set", async () => {
    // GET /plans is public (no auth gate) but needs D1: without bindings
    // getDb returns undefined and the error sink answers generic 500.
    // This also proves post-next header application survives onError.
    const res = await createApp().request("/plans");
    expect(res.status).toBe(500);
    expectGlobalHeaders(res);
  });
});

describe("B8 HSTS environment gate", () => {
  it("emits HSTS only when ENVIRONMENT is production", async () => {
    const prod = await createApp().request(
      "/health",
      {},
      { ENVIRONMENT: "production" } as unknown as Env
    );
    expect(prod.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
    expectGlobalHeaders(prod);

    const dev = await createApp().request(
      "/health",
      {},
      { ENVIRONMENT: "development" } as unknown as Env
    );
    expect(dev.headers.get("Strict-Transport-Security")).toBeNull();

    const unset = await createApp().request("/health");
    expect(unset.headers.get("Strict-Transport-Security")).toBeNull();
  });
});

describe("B8 file-route CORP carve-out", () => {
  it("product-image file bytes: CORP cross-origin, private cache intact", async () => {
    const app = createApp();
    const signed = await signImageUrl(TEST_SECRET, "s1", "photo.png", FUTURE_EXP);
    const res = await app.request(signed, {}, fileEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(res.headers.get("Cache-Control")).toMatch(/^private, max-age=/);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("avatar file bytes: CORP cross-origin, private cache intact", async () => {
    const app = createApp();
    const signed = await signAvatarUrl(TEST_SECRET, "u1", "a.png", FUTURE_EXP);
    const res = await app.request(signed, {}, fileEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(res.headers.get("Cache-Control")).toMatch(/^private, max-age=/);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("B8 docs surfaces unchanged", () => {
  it("/doc shape unchanged with safe headers present", async () => {
    // The 429 test above trips the shared in-process "unknown" docs bucket;
    // reopen it so this test asserts shape, not sibling consumption.
    resetDocsLimit("unknown");
    const res = await createApp().request("/doc");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    expectGlobalHeaders(res);
  });

  it("/ui renders Swagger without CSP", async () => {
    const res = await createApp().request("/ui");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("swagger");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("B9 production /doc 404 still carries the global headers", async () => {
    const res = await createApp().request(
      "/doc",
      {},
      { ENVIRONMENT: "production" } as unknown as Env
    );
    expect(res.status).toBe(404);
    expectGlobalHeaders(res);
  });
});
