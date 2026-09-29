// Public resend-verification account-bucket suite: proves the per-address
// throttle trips while other addresses stay usable. Own workerd + budgets
// (the shared IP bucket would otherwise collide with the main email suite),
// no fixtures, no sessions.
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18895;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | null = null;
let serverOutput = "";

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body };
}

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; });
  await waitForHealthy(BASE, () => server, () => serverOutput);
  assertCleanVerify("resend-acct reset");
}, 180_000);

afterAll(async () => {
  stopDevServer(server);
  server = null;
  assertCleanVerify("resend-acct cleanup");
}, 120_000);

describe("public resend per-address throttling", () => {
  it("same address trips after the budget; another address stays usable", async () => {
    const pub = (email: string) =>
      api("/auth/resend-verification", { method: "POST", body: JSON.stringify({ email }) });
    // Account bucket is 5/hour: first five pass, sixth is rate-limited.
    for (let i = 0; i < 5; i++) {
      const res = await pub("flood-target@example.com");
      expect(res.status, `attempt ${i + 1}`).toBe(200);
    }
    const blocked = await pub("flood-target@example.com");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      ok: false,
      error: { code: "rate_limited", message: expect.any(String) },
    });
    // A different address has its own budget and still passes.
    const other = await pub("unrelated-recipient@example.com");
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ ok: true, data: { emailed: true } });
  }, 120_000);
});
