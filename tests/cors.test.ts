// CORS origin-matching matrix (fast, no server): exact allow-list,
// normalization (trim/trailing-slash), comma lists, same-site preview
// subdomains, evil-origin rejection, and production fail-closed default.
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  allowedOrigins,
  normalizeOrigin,
  originAllowed,
} from "../src/middleware/cors.js";

const PRIMARY = "https://sallasyria-7qx.pages.dev";

describe("origin normalization", () => {
  it("trims whitespace and strips trailing slashes", () => {
    expect(normalizeOrigin("  https://a.example.com/ ")).toBe("https://a.example.com");
    expect(normalizeOrigin("https://a.example.com///")).toBe("https://a.example.com");
    expect(normalizeOrigin("https://a.example.com")).toBe("https://a.example.com");
  });

  it("splits comma lists and drops empties", () => {
    expect(
      allowedOrigins({ FRONTEND_URL: ` ${PRIMARY}/ , https://fix-x.sallasyria-7qx.pages.dev ,` })
    ).toEqual([PRIMARY, "https://fix-x.sallasyria-7qx.pages.dev"]);
    expect(allowedOrigins({})).toEqual([]);
  });
});

describe("origin allow-list matching", () => {
  const allowed = [PRIMARY];

  it("exact match passes", () => {
    expect(originAllowed(PRIMARY, allowed)).toBe(true);
  });

  it("trailing-slash and whitespace variants pass after normalization", () => {
    expect(originAllowed(`${PRIMARY}/`, allowed)).toBe(true);
    expect(originAllowed(`  ${PRIMARY}  `, allowed)).toBe(true);
  });

  it("same-site preview subdomains pass", () => {
    expect(
      originAllowed("https://fix-login.sallasyria-7qx.pages.dev", allowed)
    ).toBe(true);
  });

  it("evil origins get zero match", () => {
    expect(originAllowed("https://evil.com", allowed)).toBe(false);
    // http downgrade of the primary itself
    expect(originAllowed("http://sallasyria-7qx.pages.dev", allowed)).toBe(false);
    // suffix trick: host merely CONTAINS the primary as a substring
    expect(
      originAllowed("https://sallasyria-7qx.pages.dev.evil.com", allowed)
    ).toBe(false);
    // sibling without dot anchor
    expect(
      originAllowed("https://evilsallasyria-7qx.pages.dev", allowed)
    ).toBe(false);
    expect(originAllowed("", allowed)).toBe(false);
  });

  it("comma-list aliases match by entry", () => {
    const list = allowedOrigins({
      FRONTEND_URL: `${PRIMARY},https://fix-x.sallasyria-7qx.pages.dev`,
    });
    expect(originAllowed("https://fix-x.sallasyria-7qx.pages.dev", list)).toBe(true);
    expect(originAllowed("https://other.example.com", list)).toBe(false);
  });
});

describe("preflight headers end to end", () => {
  const preflight = (origin?: string) =>
    createApp().request("/auth/login", {
      method: "OPTIONS",
      headers: {
        ...(origin ? { Origin: origin } : {}),
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

  it("exact origin gets ACAO echo", async () => {
    const res = await createApp().request(
      "/auth/login",
      {
        method: "OPTIONS",
        headers: {
          Origin: PRIMARY,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
      { FRONTEND_URL: PRIMARY, ENVIRONMENT: "production" } as never
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PRIMARY);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("padded origin gets ACAO echo after normalization", async () => {
    const res = await createApp().request(
      "/auth/login",
      {
        method: "OPTIONS",
        headers: {
          Origin: `${PRIMARY}/`,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
      { FRONTEND_URL: `  ${PRIMARY}  `, ENVIRONMENT: "production" } as never
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PRIMARY);
  });

  it("evil origin gets 204 with zero ACAO", async () => {
    for (const bad of [
      "https://evil.com",
      "http://sallasyria-7qx.pages.dev",
      "https://sallasyria-7qx.pages.dev.evil.com",
    ]) {
      const res = await preflightWith(bad);
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }

    async function preflightWith(origin: string) {
      return createApp().request(
        "/auth/login",
        {
          method: "OPTIONS",
          headers: {
            Origin: origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
          },
        },
        { FRONTEND_URL: PRIMARY, ENVIRONMENT: "production" } as never
      );
    }
  });

  it("unset FRONTEND_URL in production stays fail-closed", async () => {
    const res = await preflight(PRIMARY);
    // Env-less app.request() carries no FRONTEND_URL and no ENVIRONMENT,
    // which defaults to development — so assert explicitly with production
    // env and no FRONTEND_URL instead.
    expect(res.status).toBe(204);
    const prod = await createApp().request(
      "/auth/login",
      {
        method: "OPTIONS",
        headers: {
          Origin: PRIMARY,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
      { ENVIRONMENT: "production" } as never
    );
    expect(prod.status).toBe(204);
    expect(prod.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("dev localhost fallback still works outside production", async () => {
    const res = await preflight("http://localhost:3000");
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:3000"
    );
  });
});
