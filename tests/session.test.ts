import { describe, expect, it } from "vitest";
import {
  buildClearCookie,
  buildSetCookie,
  getCookieToken,
  hashSessionToken,
  newSessionToken,
  SESSION_COOKIE,
  sessionStatus,
  shouldTouchLastUsed,
} from "../src/lib/session.js";

const NOW = Date.parse("2026-09-15T12:00:00Z");

function row(over: Record<string, string | null> = {}) {
  return {
    id: "s1",
    user_id: "u1",
    revoked_at: null,
    expires_at: "2099-01-01T00:00:00Z",
    last_used_at: null,
    ...over,
  };
}

describe("session tokens", () => {
  it("are 43-char base64url with fresh entropy", () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("hash deterministically to 64-hex, distinct per token", async () => {
    const t = newSessionToken();
    expect(await hashSessionToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashSessionToken(t)).toBe(await hashSessionToken(t));
    expect(await hashSessionToken(newSessionToken())).not.toBe(
      await hashSessionToken(t)
    );
  });
});

describe("sessionStatus", () => {
  it("validates a live session", () => {
    expect(sessionStatus(row(), NOW)).toBe("valid");
  });

  it("distinguishes revoked / expired / idle-expired", () => {
    expect(sessionStatus(row({ revoked_at: "2026-09-15T11:00:00Z" }), NOW)).toBe("revoked");
    expect(sessionStatus(row({ expires_at: "2026-09-15T11:59:59Z" }), NOW)).toBe("expired");
    expect(
      sessionStatus(row({ last_used_at: "2026-09-14T11:59:59Z" }), NOW)
    ).toBe("idle_expired");
    // recently used: still valid despite old creation
    expect(sessionStatus(row({ last_used_at: "2026-09-15T11:00:00Z" }), NOW)).toBe("valid");
  });
});

describe("shouldTouchLastUsed", () => {
  it("touches never-used and stale rows only", () => {
    expect(shouldTouchLastUsed(row(), NOW)).toBe(true);
    expect(shouldTouchLastUsed(row({ last_used_at: "2026-09-15T11:50:00Z" }), NOW)).toBe(false);
    expect(shouldTouchLastUsed(row({ last_used_at: "2026-09-15T11:00:00Z" }), NOW)).toBe(true);
  });
});

describe("cookies", () => {
  it("parses the session cookie strictly", () => {
    expect(getCookieToken(null)).toBeNull();
    expect(getCookieToken("")).toBeNull();
    expect(getCookieToken(`${SESSION_COOKIE}=abc123`)).toBe("abc123");
    expect(getCookieToken("other=1; ss_session=tok-9; x=2")).toBe("tok-9");
    expect(getCookieToken(`${SESSION_COOKIE}=`)).toBeNull();
    expect(getCookieToken("unrelated=1")).toBeNull();
  });

  it("sets hardened attributes, Secure only when asked", () => {
    const prod = buildSetCookie("tok", { secure: true, maxAgeSec: 60 });
    expect(prod).toContain("HttpOnly");
    expect(prod).toContain("SameSite=Lax");
    expect(prod).toContain("Path=/");
    expect(prod).toContain("Secure");
    expect(prod).toContain("Max-Age=60");
    expect(buildSetCookie("tok", { secure: false, maxAgeSec: 60 })).not.toContain("Secure");
    expect(JSON.stringify(buildClearCookie({ secure: false }))).toContain("Max-Age=0");
  });

  it("defaults to Lax and mirrors None on explicit opt-in (clear matches set)", () => {
    // Split deployments (pages.dev -> workers.dev) need None+Secure or
    // browsers reject the third-party session cookie outright.
    const none = buildSetCookie("tok", { secure: true, maxAgeSec: 60, sameSite: "none" });
    expect(none).toContain("SameSite=None");
    expect(none).not.toContain("SameSite=Lax");
    expect(none).toContain("Secure");
    expect(buildSetCookie("tok", { secure: true, maxAgeSec: 60 })).toContain("SameSite=Lax");
    const clearNone = buildClearCookie({ secure: true, sameSite: "none" });
    expect(clearNone).toContain("SameSite=None");
    expect(clearNone).toContain("Max-Age=0");
    expect(buildClearCookie({ secure: true })).toContain("SameSite=Lax");
  });
});
