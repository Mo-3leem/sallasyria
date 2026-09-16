// Phase 1 verification script.
//
// Runs functional checks against the local D1 database via
// `wrangler d1 execute --local --json`, exercising the actual constraint
// behavior (FKs, CHECK, partial-unique index) rather than just PRAGMA state,
// since D1's local emulator does not support PRAGMA foreign_keys and FK
// enforcement must be proven empirically per Wrangler/D1 version.
//
// Usage: node scripts/verify-phase1.mjs
// Requires: migrations already applied locally
//   (npx wrangler d1 migrations apply sallasyria-db --local)

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanVerify, mustSucceed } from "./clean-verify.mjs";

const DB = "sallasyria-db";
let passed = 0;
let failed = 0;

const isWindows = process.platform === "win32";
const npxCmd = isWindows ? "npx.cmd" : "npx";
const tmpDir = mkdtempSync(join(tmpdir(), "sallasyria-verify-"));
let fileCounter = 0;

function run(sql) {
  const filePath = join(tmpDir, `stmt_${fileCounter++}.sql`);
  writeFileSync(filePath, sql, "utf8");
  const args = ["wrangler", "d1", "execute", DB, "--local", "--json", "--file", filePath];
  try {
    const out = execFileSync(npxCmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows,
    });
    const parsed = JSON.parse(out);
    const success = Array.isArray(parsed) && parsed.every((r) => r.success);
    return { ok: success, result: parsed, error: success ? undefined : JSON.stringify(parsed) };
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    const stdout = err.stdout ? err.stdout.toString() : "";
    return { ok: false, error: stderr || stdout || err.message, spawnError: true };
  }
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
    failed++;
  }
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

console.log("Resetting Phase 1 test rows...");
cleanVerify("phase 1 reset");

// ------------------------------------------------------------------
// 1. Insert a user, then a store referencing that user, should succeed.
// ------------------------------------------------------------------
console.log("\n[1] Insert user + store referencing it");
const userId = uid("user_verify");
const storeId = uid("store_verify");

const insertUser = run(
  `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${userId}', '+963900000001', 'owner1@example.com', 'Owner One', 'hash1');`
);
mustSucceed("setup: user insert", insertUser);
check("user insert succeeds", insertUser.ok, insertUser.error);

const insertStore = run(
  `INSERT INTO stores (id, owner_id, slug, name) VALUES ('${storeId}', '${userId}', 'store-verify-${Date.now()}', 'Verify Store');`
);
mustSucceed("setup: store insert", insertStore);
check("store insert (valid owner_id) succeeds", insertStore.ok, insertStore.error);

// ------------------------------------------------------------------
// 2. Insert a store with a non-existent owner_id must fail (FK enforced).
// ------------------------------------------------------------------
console.log("\n[2] Insert store with non-existent owner_id (expect FK failure)");
const badStore = run(
  `INSERT INTO stores (id, owner_id, slug, name) VALUES ('${uid("store_verify")}', 'nonexistent_user_id', 'store-bad-${Date.now()}', 'Bad Store');`
);
check(
  "insert with invalid owner_id is rejected",
  !badStore.ok,
  badStore.ok ? "expected failure but insert succeeded" : undefined
);

// ------------------------------------------------------------------
// 3. Deleting a user who owns a store must be blocked (ON DELETE RESTRICT).
// ------------------------------------------------------------------
console.log("\n[3] Delete user who owns a store (expect RESTRICT failure)");
const deleteOwner = run(`DELETE FROM users WHERE id = '${userId}';`);
check(
  "delete of user-with-store is rejected",
  !deleteOwner.ok,
  deleteOwner.ok ? "expected failure but delete succeeded" : undefined
);

// ------------------------------------------------------------------
// 4. Two active subscriptions for the same store cannot both exist.
// ------------------------------------------------------------------
console.log("\n[4] Partial-unique: one active subscription per store");
const planId = uid("plan_verify");
const insertPlan = run(
  `INSERT INTO plans (id, code, name, price_monthly, price_yearly) VALUES ('${planId}', 'basic-${Date.now()}', 'Basic', 100000, 1000000);`
);
mustSucceed("setup: plan insert", insertPlan);
check("plan insert succeeds", insertPlan.ok, insertPlan.error);

const sub1Id = uid("sub_verify");
const insertSub1 = run(
  `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, price_amount, starts_at) VALUES ('${sub1Id}', '${storeId}', '${planId}', 'active', 'monthly', 100000, '2026-09-15T00:00:00Z');`
);
mustSucceed("setup: first active subscription insert", insertSub1);
check("first active subscription insert succeeds", insertSub1.ok, insertSub1.error);

const sub2Id = uid("sub_verify");
const insertSub2 = run(
  `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, price_amount, starts_at) VALUES ('${sub2Id}', '${storeId}', '${planId}', 'active', 'monthly', 100000, '2026-09-15T00:00:00Z');`
);
check(
  "second active subscription for same store is rejected",
  !insertSub2.ok,
  insertSub2.ok ? "expected failure but insert succeeded" : undefined
);

// ------------------------------------------------------------------
// 5. cancelled_at / status CHECK constraint.
// ------------------------------------------------------------------
console.log("\n[5] CHECK constraint: status <-> cancelled_at consistency");

const badCancelled = run(
  `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, price_amount, starts_at, cancelled_at) VALUES ('${uid("sub_verify")}', '${storeId}', '${planId}', 'cancelled', 'monthly', 100000, '2026-09-15T00:00:00Z', NULL);`
);
check(
  "status='cancelled' with cancelled_at=NULL is rejected",
  !badCancelled.ok,
  badCancelled.ok ? "expected failure but insert succeeded" : undefined
);

const badActive = run(
  `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, price_amount, starts_at, cancelled_at) VALUES ('${uid("sub_verify")}', '${storeId}', '${planId}', 'expired', 'monthly', 100000, '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z');`
);
check(
  "status!='cancelled' with cancelled_at set is rejected",
  !badActive.ok,
  badActive.ok ? "expected failure but insert succeeded" : undefined
);

const goodCancelled = run(
  `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, price_amount, starts_at, cancelled_at) VALUES ('${uid("sub_verify")}', '${storeId}', '${planId}', 'cancelled', 'monthly', 100000, '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z');`
);
check(
  "status='cancelled' with cancelled_at set succeeds",
  goodCancelled.ok,
  goodCancelled.error
);

// ------------------------------------------------------------------
cleanVerify("phase 1 end");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
