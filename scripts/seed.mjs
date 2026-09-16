// B7 seed: deterministic local bootstrap (plans, admin, demo merchant data).
//
// Re-runnable and idempotent: every statement is INSERT ... ON CONFLICT /
// WHERE NOT EXISTS keyed by natural keys (plans.code, users.phone,
// stores.slug, ...), so a second run changes nothing. Prints created-vs-
// skipped per row and exits non-zero on any real database error.
//
// Password hashing duplicates src/lib/password.ts's s1 format on purpose:
// .mjs tooling cannot import .ts sources, so the parameters live in both
// places with a cross-reference comment. Drift is caught, not assumed away:
// the B7 integration suite seeds and then LOGS IN as the seeded admin,
// which fails loudly if the formats ever diverge.
//
// Secrets: the admin password comes ONLY from ADMIN_BOOTSTRAP_PASSWORD env
// or --admin-password (required). It is never written anywhere except the
// users.password_hash column (scrypt hash, never plaintext).
//
// Remote safety: default target is LOCAL D1. --remote requires the explicit
// second flag --allow-remote; anything else refuses to run.
//
// Usage:
//   node scripts/seed.mjs [--admin-phone +963990000001] [--admin-password ...]
//   node scripts/seed.mjs --remote --allow-remote [--admin-password ...]

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scrypt } from "@noble/hashes/scrypt.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";

const isWindows = process.platform === "win32";
const npxCmd = isWindows ? "npx.cmd" : "npx";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const remote = flag("--remote");
if (remote && !flag("--allow-remote")) {
  console.error("REFUSED: --remote requires the explicit --allow-remote flag.");
  process.exit(1);
}

const ADMIN_PHONE = opt("--admin-phone", "+963990000001");
const ADMIN_PASSWORD = opt("--admin-password", process.env.ADMIN_BOOTSTRAP_PASSWORD ?? "");
if (!ADMIN_PASSWORD) {
  console.error("REFUSED: admin password required via --admin-password or ADMIN_BOOTSTRAP_PASSWORD env.");
  process.exit(1);
}

// s1 format mirror of src/lib/password.ts (N=16384, r=8, p=1, dkLen=32).
// See header comment: divergence breaks the seed-login proof test in B7.
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scrypt(new TextEncoder().encode(password), salt, { N: 16384, r: 8, p: 1, dkLen: 32 });
  return `s1$16384$8$1$${bytesToHex(salt)}$${bytesToHex(hash)}`;
}

const tmpDir = mkdtempSync(join(tmpdir(), "sallasyria-seed-"));

function execOne(sql) {
  const file = join(tmpDir, `seed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.sql`);
  writeFileSync(file, sql, "utf8");
  const cmdArgs = ["wrangler", "d1", "execute", "sallasyria-db", remote ? "--remote" : "--local", "--json", "--file", file];
  try {
    const out = execFileSync(npxCmd, cmdArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows,
    });
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed) || !parsed.every((r) => r.success)) {
      throw new Error(JSON.stringify(parsed));
    }
    return parsed;
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr) : "";
    throw new Error(`seed execute failed: ${stderr || err.message} [${sql.slice(0, 80)}]`);
  }
}

function exists(sql) {
  const parsed = execOne(sql);
  const rows = parsed[0]?.results ?? [];
  return rows.length > 0;
}

function esc(s) {
  return String(s).replace(/'/g, "''");
}

const report = [];
let created = 0;
let skipped = 0;

// NOTE: never overwrite an existing admin's hash (they may have rotated past
// bootstrap). Existence checks gate every write, and the writes themselves
// stay ON CONFLICT DO NOTHING / WHERE NOT EXISTS so a concurrent second
// seed run can never error or duplicate.
const items = [
  {
    label: "plan basic",
    check: `SELECT 1 FROM plans WHERE code = 'basic';`,
    insert: (now) => `INSERT INTO plans (id, code, name, price_monthly, price_yearly, max_products, created_at, updated_at) VALUES ('seed-plan-basic', 'basic', 'Basic', 50000, 500000, 100, '${now}', '${now}') ON CONFLICT(code) DO NOTHING;`,
  },
  {
    label: "plan pro",
    check: `SELECT 1 FROM plans WHERE code = 'pro';`,
    insert: (now) => `INSERT INTO plans (id, code, name, price_monthly, price_yearly, max_products, created_at, updated_at) VALUES ('seed-plan-pro', 'pro', 'Pro', 150000, 1500000, NULL, '${now}', '${now}') ON CONFLICT(code) DO NOTHING;`,
  },
  {
    label: "admin user",
    check: `SELECT 1 FROM users WHERE phone = '${esc(ADMIN_PHONE)}';`,
    insert: (now, hashes) => `INSERT INTO users (id, phone, email, name, password_hash, role, created_at, updated_at) VALUES ('seed-admin', '${esc(ADMIN_PHONE)}', 'admin@sallasyria.local', 'Platform Admin', '${hashes.admin}', 'admin', '${now}', '${now}') ON CONFLICT(phone) DO NOTHING;`,
  },
  {
    label: "demo merchant",
    check: `SELECT 1 FROM users WHERE phone = '+963990000101';`,
    insert: (now, hashes) => `INSERT INTO users (id, phone, email, name, password_hash, role, created_at, updated_at) VALUES ('seed-merchant', '+963990000101', 'demo@sallasyria.local', 'Demo Merchant', '${hashes.merchant}', 'merchant', '${now}', '${now}') ON CONFLICT(phone) DO NOTHING;`,
  },
  {
    label: "demo store",
    check: `SELECT 1 FROM stores WHERE slug = 'demo-store';`,
    insert: (now) => `INSERT INTO stores (id, owner_id, slug, name, currency, created_at, updated_at) VALUES ('seed-store', 'seed-merchant', 'demo-store', 'Demo Store', 'SYP', '${now}', '${now}') ON CONFLICT(slug) DO NOTHING;`,
  },
  {
    label: "demo subscription",
    check: `SELECT 1 FROM subscriptions WHERE store_id = 'seed-store' AND status = 'active';`,
    insert: (now) => `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, price_amount, starts_at, created_at, updated_at) SELECT 'seed-sub', 'seed-store', 'seed-plan-basic', 'active', 'monthly', 50000, '${now}', '${now}', '${now}' WHERE NOT EXISTS (SELECT 1 FROM subscriptions WHERE store_id = 'seed-store' AND status = 'active');`,
  },
  {
    label: "demo category",
    check: `SELECT 1 FROM categories WHERE id = 'seed-cat';`,
    insert: (now) => `INSERT INTO categories (id, store_id, name, slug, created_at, updated_at) VALUES ('seed-cat', 'seed-store', 'Demo Category', 'demo-category', '${now}', '${now}') ON CONFLICT(id) DO NOTHING;`,
  },
  {
    label: "demo product",
    check: `SELECT 1 FROM products WHERE id = 'seed-product';`,
    insert: (now) => `INSERT INTO products (id, store_id, category_id, name, slug, price, stock_quantity, created_at, updated_at) VALUES ('seed-product', 'seed-store', 'seed-cat', 'Demo Product', 'demo-product', 250000, 20, '${now}', '${now}') ON CONFLICT(id) DO NOTHING;`,
  },
  {
    label: "demo shipping rate",
    check: `SELECT 1 FROM shipping_rates WHERE id = 'seed-rate';`,
    insert: (now) => `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost, created_at, updated_at) VALUES ('seed-rate', 'seed-store', 'Damascus', 'Standard', 15000, '${now}', '${now}') ON CONFLICT(id) DO NOTHING;`,
  },
];

const NOW = "2026-09-15T00:00:00Z";
const hashes = { admin: hashPassword(ADMIN_PASSWORD), merchant: hashPassword("Demo-Merchant-1") };

for (const item of items) {
  if (exists(item.check)) {
    skipped++;
    report.push(`skipped ${item.label} (already present)`);
  } else {
    execOne(item.insert(NOW, hashes));
    created++;
    report.push(`created ${item.label}`);
  }
}

console.log(`Seed ${remote ? "(REMOTE)" : "(local)"}: ${created} created, ${skipped} skipped.`);
for (const line of report) console.log(`  - ${line}`);
