// Public resend-verification IP-bucket suite: proves the per-source throttle
// trips while the endpoint stays healthy. Own workerd + budgets (the shared
// IP bucket would otherwise collide with other suites), no fixtures.
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18896;
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
  assertCleanVerify("resend-ip reset");
}, 180_000);

afterAll(async () => {
  stopDevServer(server);
  server = null;
  assertCleanVerify("resend-ip cleanup");
}, 120_000);

describe("public resend per-IP throttling", () => {
  it("sustained anonymous requests trip the IP bucket; shape stays flat", async () => {
    // Distinct addresses keep every per-address budget untouched, so only
    // the shared 10/10min IP bucket can trip — on the eleventh attempt.
    // Every response keeps the flat success shape until the limit bites.
    const bodies: unknown[] = [];
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await api("/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email: `flood-${i}@example.com` }),
      });
      statuses.push(res.status);
      bodies.push(res.body);
    }
    expect(statuses.slice(0, 10)).toEqual(new Array(10).fill(200));
    for (const body of bodies.slice(0, 10)) {
      expect(body).toEqual({ ok: true, data: { emailed: true } });
    }
    expect(statuses[10]).toBe(429);
    expect(bodies[10]).toEqual({
      ok: false,
      error: { code: "rate_limited", message: expect.any(String) },
    });
  }, 120_000);
});
