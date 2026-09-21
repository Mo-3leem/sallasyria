// B8 smoke probe: cheapest meaningful production check, no writes by default.
//
// Reads SMOKE_BASE_URL (e.g. https://api.sallasyria.example). Exit codes:
//   0 .... all checks passed
//   1 .... a check FAILED (do not ship / roll back)
//   2 .... skipped: SMOKE_BASE_URL unset (local runs without a target)
//
// Checks (all read-only unless --write is passed WITH --allow-remote):
//   1. GET /health -> 200 envelope
//   2. GET /ready  -> 200 envelope (proves Worker->D1 path remotely)
//   3. GET /no-such-route -> 404 envelope (error contract holds remotely)
//   4. Absence of Access-Control-Allow-Origin: * (fail-closed CORS)
//   5. Optional authenticated flow when SMOKE_EMAIL/SMOKE_PASSWORD are set:
//      login -> me -> logout, asserting envelope shapes only.
// Test purchases are deliberately NOT automated here (they write prod data);
// the runbook (docs/DEPLOY.md) makes one manual purchase-then-void the
// first-prod-write gate instead.
//
// Usage:
//   SMOKE_BASE_URL=https://api.example.com node scripts/smoke.mjs

const BASE = process.env.SMOKE_BASE_URL ?? "";

if (!BASE) {
  console.log("SKIP: SMOKE_BASE_URL is not set (no remote target).");
  process.exit(2);
}

let failures = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${label}\n        ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function get(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers });
  let body = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body, headers: res.headers };
}

await check("GET /health is a 200 envelope", async () => {
  const r = await get("/health");
  assert(r.status === 200, `status ${r.status}`);
  assert(r.body?.ok === true, "envelope");
});

await check("GET /ready proves the remote Worker->D1 path", async () => {
  const r = await get("/ready");
  assert(r.status === 200, `status ${r.status} (check D1 bindings/migrations)`);
  assert(r.body?.data?.db === "up", "db up");
});

await check("unknown routes are 404 envelopes", async () => {
  const r = await get("/no-such-route");
  assert(r.status === 404, `status ${r.status}`);
  assert(r.body?.error?.code === "not_found", "code");
});

await check("no wildcard CORS header", async () => {
  const r = await get("/health");
  assert(r.headers.get("access-control-allow-origin") !== "*", "wildcard ACAO present");
});

if (process.env.SMOKE_EMAIL && process.env.SMOKE_PASSWORD) {
  await check("login -> me -> logout envelope flow", async () => {
    const login = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: process.env.SMOKE_EMAIL, password: process.env.SMOKE_PASSWORD }),
    });
    assert(login.status === 200, `login status ${login.status}`);
    const setCookie = login.headers.get("set-cookie") ?? "";
    assert(setCookie.includes("ss_session="), "session cookie");
    assert(setCookie.includes("HttpOnly"), "HttpOnly flag");
    const jar = `ss_session=${(setCookie.split(";")[0] ?? "").split("=").slice(1).join("=")}`;
    const me = await get("/auth/me", { Cookie: jar });
    assert(me.status === 200, `me status ${me.status}`);
    const out = await fetch(`${BASE}/auth/logout`, { method: "POST", headers: { Cookie: jar } });
    assert(out.status === 200, `logout status ${out.status}`);
    const dead = await get("/auth/me", { Cookie: jar });
    assert(dead.status === 401, `post-logout status ${dead.status}`);
  });
} else {
  console.log("  SKIP  authenticated flow (SMOKE_EMAIL/SMOKE_PASSWORD unset)");
}

if (failures > 0) {
  console.log(`${failures} smoke check(s) FAILED.`);
  process.exit(1);
}
console.log("Smoke green.");
