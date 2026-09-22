// B5 integration suite: buyer domain (customers/addresses/rates) with the
// documented public/private split. Real workerd + real local D1. Fixtures use
// user_verify_b5c_* (covered by scripts/clean-verify.mjs). Two logins total;
// public probes are anonymous by design.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18882;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const OWNER_A = "+963900000821";
const OWNER_B = "+963900000822";
const PASS = "Buyers-Strong-1";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b5test-"));
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

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`dev server never ready\n${serverOutput.slice(-3000)}`);
}

async function api(path: string, init: RequestInit = {}, cookies = "") {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body };
}

function cookieOf(setCookie: string | null): string {
  if (!setCookie) throw new Error("expected Set-Cookie");
  return `ss_session=${(setCookie.split(";")[0] ?? "").split("=").slice(1).join("=")}`;
}

const A = "/stores/store_verify_b5c_a";
const B = "/stores/store_verify_b5c_b";
const EXP = "/stores/store_verify_b5c_expired";

let jarA = "";
let jarB = "";

beforeAll(async () => {
  server = spawn(isWindows ? "npx.cmd" : "npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
    windowsHide: true,
  });
  server.stdout?.on("data", (d) => { serverOutput += String(d); });
  server.stderr?.on("data", (d) => { serverOutput += String(d); });
  await waitForHealth();

  assertCleanVerify("b5 reset");
  const h = hashPassword(PASS);
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b5c_a', '${OWNER_A}', 'b5ca@example.com', 'B5 Owner A', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b5c_b', '${OWNER_B}', 'b5cb@example.com', 'B5 Owner B', '${h}', 'merchant');`,
    `INSERT INTO plans (id, code, name) VALUES ('plan_verify_b5c', 'b5c-plan', 'B5 Plan');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b5c_a', 'user_verify_b5c_a', 'b5c-store-a', 'B5 Store A');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b5c_expired', 'user_verify_b5c_a', 'b5c-store-expired', 'B5 Expired');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b5c_b', 'user_verify_b5c_b', 'b5c-store-b', 'B5 Store B');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b5c_a', 'store_verify_b5c_a', 'plan_verify_b5c', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b5c_e', 'store_verify_b5c_expired', 'plan_verify_b5c', 'expired', 'monthly', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b5c_b', 'store_verify_b5c_b', 'plan_verify_b5c', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO customers (id, store_id, name, phone) VALUES ('cust_verify_b5c_a', 'store_verify_b5c_a', 'Cust A', '+963911500001');`,
    `INSERT INTO customers (id, store_id, name, phone) VALUES ('cust_verify_b5c_b', 'store_verify_b5c_b', 'Cust B', '+963911500002');`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`B5 seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id IN ('user_verify_b5c_a', 'user_verify_b5c_b');`);

  async function loginCookie(email: string): Promise<string> {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASS }),
    });
    if (res.status !== 200) throw new Error(`B5 setup login failed for ${email}: ${res.status}`);
    return cookieOf(res.headers.get("set-cookie"));
  }
  jarA = await loginCookie("b5ca@example.com");
  jarB = await loginCookie("b5cb@example.com");
}, 180_000);

afterAll(async () => {
  try {
    assertCleanVerify("b5 end");
  } finally {
    if (server && server.exitCode === null) {
      try {
        if (isWindows && server.pid !== undefined) execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
        else server.kill("SIGTERM");
      } catch { /* best effort */ }
    }
    server = null;
  }
}, 60_000);

describe("B5 customers: public upsert + normalization", () => {
  it("anonymous upsert creates then updates the same row", async () => {
    const first = await api(`${A}/customers`, {
      method: "POST",
      body: JSON.stringify({ name: "Buyer One", phone: "+963911500011" }),
    });
    expect(first.status).toBe(200);
    const id1 = (first.body as { data: { customer: { id: string } } }).data.customer.id;

    const second = await api(`${A}/customers`, {
      method: "POST",
      body: JSON.stringify({ name: "Buyer One Renamed", phone: "+963911500011" }),
    });
    expect(second.status).toBe(200);
    const row2 = (second.body as { data: { customer: { id: string; name: string } } }).data.customer;
    expect(row2.id).toBe(id1);
    expect(row2.name).toBe("Buyer One Renamed");
  });

  it("formatting variants normalize to one canonical row", async () => {
    const variants = [" 0991 150 021 ", "963991150021", "(+963) 991-150-021"];
    const ids = new Set<string>();
    for (const phone of variants) {
      const res = await api(`${A}/customers`, {
        method: "POST",
        body: JSON.stringify({ name: "Variant", phone }),
      });
      expect(res.status).toBe(200);
      ids.add((res.body as { data: { customer: { id: string } } }).data.customer.id);
    }
    expect(ids.size).toBe(1);
    const check = await api(`${A}/customers`, {}, jarA);
    const found = ((check.body as { data: { customers: { phone: string }[] } }).data.customers)
      .filter((c) => c.phone === "+963991150021");
    expect(found.length).toBe(1);
  });

  it("garbage phones are 400; same phone lives independently per store", async () => {
    const bad = await api(`${A}/customers`, {
      method: "POST",
      body: JSON.stringify({ name: "Bad", phone: "not-a-phone" }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({
      ok: false,
      error: { code: "invalid_phone", message: "Invalid phone number." },
    });

    const other = await api(`${B}/customers`, {
      method: "POST",
      body: JSON.stringify({ name: "Buyer B", phone: "+963911500011" }),
    });
    expect(other.status).toBe(200);
    expect(
      (other.body as { data: { customer: { id: string } } }).data.customer.id
    ).not.toBe("");
  });
});

describe("B5 customers: private management + isolation", () => {
  it("list/get require auth and stay scoped", async () => {
    expect((await api(`${A}/customers`)).status).toBe(401);
    const list = await api(`${A}/customers`, {}, jarA);
    expect(list.status).toBe(200);
    const phones = ((list.body as { data: { customers: { phone: string }[] } }).data.customers)
      .map((c) => c.phone);
    expect(phones).toContain("+963911500001");
    expect(phones).not.toContain("+963911500002");

    expect((await api(`${A}/customers/cust_verify_b5c_b`, {}, jarA)).status).toBe(404);
    const own = await api(`${A}/customers/cust_verify_b5c_a`, {}, jarA);
    expect(own.status).toBe(200);
  });

  it("patch validates, guards phone clashes and immutable fields", async () => {
    const renamed = await api(`${A}/customers/cust_verify_b5c_a`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Cust A Renamed" }),
    }, jarA);
    expect(renamed.status).toBe(200);

    const clash = await api(`${A}/customers/cust_verify_b5c_a`, {
      method: "PATCH",
      body: JSON.stringify({ phone: "+963911500011" }),
    }, jarA);
    expect(clash.status).toBe(409);
    expect(clash.body).toEqual({
      ok: false,
      error: { code: "phone_taken", message: expect.any(String) },
    });

    const forged = await api(`${A}/customers/cust_verify_b5c_a`, {
      method: "PATCH",
      body: JSON.stringify({ name: "X", store_id: "store_verify_b5c_b" }),
    }, jarA);
    expect(forged.status).toBe(400);

    const cross = await api(`${A}/customers/cust_verify_b5c_b`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Hijacked" }),
    }, jarA);
    expect(cross.status).toBe(404);
    const intact = await api(`${B}/customers/cust_verify_b5c_b`, {}, jarB);
    expect(((intact.body as { data: { customer: { name: string } } }).data.customer.name)).toBe("Cust B");
  });

  it("patch without email preserves the stored email (no null-wipe)", async () => {
    const mk = await api(`${A}/customers`, {
      method: "POST",
      body: JSON.stringify({ name: "Mailable", phone: "+963911500077", email: "mailable@example.com" }),
    });
    expect(mk.status).toBe(200);
    const id = (mk.body as { data: { customer: { id: string } } }).data.customer.id;

    const renamed = await api(`${A}/customers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Mailable Renamed" }),
    }, jarA);
    expect(renamed.status).toBe(200);
    const kept = await api(`${A}/customers/${id}`, {}, jarA);
    expect(((kept.body as { data: { customer: { email: string | null } } }).data.customer.email))
      .toBe("mailable@example.com");

    const cleared = await api(`${A}/customers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ email: null }),
    }, jarA);
    expect(cleared.status).toBe(200);
    const gone = await api(`${A}/customers/${id}`, {}, jarA);
    expect(((gone.body as { data: { customer: { email: string | null } } }).data.customer.email))
      .toBe(null);

    const noop = await api(`${A}/customers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({}),
    }, jarA);
    expect(noop.status).toBe(200);
    expect(((noop.body as { data: { customer: { name: string } } }).data.customer.name))
      .toBe("Mailable Renamed");
  });

  it("delete removes unused customers; missing is 404", async () => {
    const mk = await api(`${A}/customers`, {
      method: "POST",
      body: JSON.stringify({ name: "Doomed", phone: "+963911500099" }),
    });
    const id = (mk.body as { data: { customer: { id: string } } }).data.customer.id;
    expect((await api(`${A}/customers/${id}`, { method: "DELETE" }, jarA)).status).toBe(200);
    expect((await api(`${A}/customers/${id}`, {}, jarA)).status).toBe(404);
    expect((await api(`${A}/customers/cust_verify_b5c_b`, { method: "DELETE" }, jarA)).status).toBe(404);
  });
});

describe("B5 addresses: public create, atomic default swap", () => {
  it("anonymous create works; cross-store customer and bad governorate rejected", async () => {
    const created = await api(`${A}/customer-addresses`, {
      method: "POST",
      body: JSON.stringify({
        customer_id: "cust_verify_b5c_a",
        recipient_name: "Recip",
        phone: "0991 500 031",
        governorate: "Damascus",
        address_line: "Street 1",
      }),
    });
    expect(created.status).toBe(201);
    const addr = (created.body as { data: { address: { phone: string; is_default: number } } }).data.address;
    expect(addr.phone).toBe("+963991500031");
    expect(addr.is_default).toBe(0);

    const foreign = await api(`${A}/customer-addresses`, {
      method: "POST",
      body: JSON.stringify({
        customer_id: "cust_verify_b5c_b",
        recipient_name: "X",
        phone: "+963911500032",
        governorate: "Aleppo",
        address_line: "Street X",
      }),
    });
    expect(foreign.status).toBe(404);

    const badGov = await api(`${A}/customer-addresses`, {
      method: "POST",
      body: JSON.stringify({
        customer_id: "cust_verify_b5c_a",
        recipient_name: "X",
        phone: "+963911500033",
        governorate: "Atlantis",
        address_line: "Street X",
      }),
    });
    expect(badGov.status).toBe(400);
  });

  it("reads require auth and stay scoped", async () => {
    expect((await api(`${A}/customer-addresses?customer_id=cust_verify_b5c_a`)).status).toBe(401);
    const listed = await api(`${A}/customer-addresses?customer_id=cust_verify_b5c_a`, {}, jarA);
    expect(listed.status).toBe(200);
    expect((await api(`${A}/customer-addresses?customer_id=cust_verify_b5c_b`, {}, jarA)).status).toBe(404);
  });

  it("make-default swaps atomically; direct is_default writes are 400", async () => {
    const mk1 = await api(`${A}/customer-addresses`, {
      method: "POST",
      body: JSON.stringify({
        customer_id: "cust_verify_b5c_a", recipient_name: "D1", phone: "+963911500041",
        governorate: "Homs", address_line: "S1",
      }),
    });
    const mk2 = await api(`${A}/customer-addresses`, {
      method: "POST",
      body: JSON.stringify({
        customer_id: "cust_verify_b5c_a", recipient_name: "D2", phone: "+963911500042",
        governorate: "Hama", address_line: "S2",
      }),
    });
    const id1 = (mk1.body as { data: { address: { id: string } } }).data.address.id;
    const id2 = (mk2.body as { data: { address: { id: string } } }).data.address.id;

    expect((await api(`${A}/customer-addresses/${id1}/make-default`, { method: "POST" })).status).toBe(200);
    const swapped = await api(`${A}/customer-addresses/${id2}/make-default`, { method: "POST" });
    expect(swapped.status).toBe(200);
    const list = await api(`${A}/customer-addresses?customer_id=cust_verify_b5c_a`, {}, jarA);
    const rows = (list.body as { data: { addresses: { id: string; is_default: number }[] } }).data.addresses;
    const defaults = rows.filter((r) => r.is_default === 1);
    expect(defaults.map((r) => r.id)).toEqual([id2]);

    const direct = await api(`${A}/customer-addresses/${id1}`, {
      method: "PATCH",
      body: JSON.stringify({ is_default: 1 }),
    }, jarA);
    expect(direct.status).toBe(400);

    const foreign = await api(`${B}/customer-addresses/${id1}/make-default`, { method: "POST" });
    expect(foreign.status).toBe(404);
  });
});

describe("B5 shipping rates: public reads, gated merchant writes", () => {
  it("reads are public and scoped; writes need auth", async () => {
    const listed = await api(`${A}/shipping-rates`);
    expect(listed.status).toBe(200);
    expect((await api(`${A}/shipping-rates`, { method: "POST", body: JSON.stringify({}) })).status).toBe(401);
  });

  it("merchant CRUD with uniqueness, validation, isolation, gate", async () => {
    const created = await api(`${A}/shipping-rates`, {
      method: "POST",
      body: JSON.stringify({ governorate: "Damascus", shipping_method: "Standard", cost: 5000 }),
    }, jarA);
    expect(created.status).toBe(201);

    const dup = await api(`${A}/shipping-rates`, {
      method: "POST",
      body: JSON.stringify({ governorate: "Damascus", shipping_method: "Express", cost: 8000 }),
    }, jarA);
    expect(dup.status).toBe(409);

    const badGov = await api(`${A}/shipping-rates`, {
      method: "POST",
      body: JSON.stringify({ governorate: "Atlantis", shipping_method: "X", cost: 1 }),
    }, jarA);
    expect(badGov.status).toBe(400);

    const id = (created.body as { data: { rate: { id: string } } }).data.rate.id;
    const patched = await api(`${A}/shipping-rates/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ cost: 6000 }),
    }, jarA);
    expect(patched.status).toBe(200);

    const cross = await api(`${A}/shipping-rates/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ cost: 1 }),
    }, jarB);
    // jarB's owner does not own store A: cross-store write fails closed as
    // 404 (identical to a missing rate — no existence oracle).
    expect(cross.status).toBe(404);

    expect((await api(`${A}/shipping-rates/${id}`, { method: "DELETE" }, jarA)).status).toBe(200);

    const expired = await api(`${EXP}/shipping-rates`, {
      method: "POST",
      body: JSON.stringify({ governorate: "Homs", shipping_method: "X", cost: 1 }),
    }, jarA);
    expect(expired.status).toBe(403);
    expect((await api(`${EXP}/shipping-rates`)).status).toBe(200);
  });
});

describe("B5 public flood control", () => {
  it("sustained anonymous upsert flood trips 429, early traffic passes", async () => {
    // Earlier tests in this file spent ~2 of store B's 60/min public budget;
    // 65 rapid requests guarantee exhaustion regardless of exact prior count.
    const statuses: number[] = [];
    for (let i = 0; i < 65; i++) {
      const res = await api(`${B}/customers`, {
        method: "POST",
        body: JSON.stringify({ name: `Flood ${i}`, phone: `+963911509${String(100 + i).slice(1)}` }),
      });
      statuses.push(res.status);
    }
    expect(statuses[0]).toBe(200);
    expect(statuses[statuses.length - 1]).toBe(429);
  }, 180_000);
});
