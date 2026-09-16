// Adversarial coverage for the Salla Syria D1 verification suite.
//
// Fills the gaps found by the adversarial bug-hunt that the per-phase
// scripts do not cover: cross-store parent links, UPDATE-path FK
// enforcement, plan-in-use deletes, NULL-email semantics, and subscription
// restore conflicts. Every setup uses mustSucceed() so no check can pass
// vacuously; reset and end-of-run use the shared cleanVerify().
//
// Fixtures use the adv_ namespace (see scripts/clean-verify.mjs).
// Do NOT run verify scripts in parallel.
//
// Usage: node scripts/verify-adversarial.mjs

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
const tmpDir = mkdtempSync(join(tmpdir(), "sallasyria-verifyadv-"));
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

function slug(base) {
  return `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function rows(res) {
  return res.result?.[0]?.results ?? [];
}

console.log("Resetting adversarial test rows...");
cleanVerify("adversarial reset");

// ------------------------------------------------------------------
// Fixtures: two stores (A, B) under one owner, plus catalog/customer/
// billing rows needed by the attack probes below.
// ------------------------------------------------------------------
const userId = uid("user_adv");
const storeAId = uid("store_adv");
const storeBId = uid("store_adv");
const catBId = uid("cat_adv");
const prodAId = uid("prod_adv");
const custAId = uid("cust_adv");
const custBId = uid("cust_adv");
const addrAId = uid("addr_adv");
const planId = uid("plan_adv");
const subId = uid("sub_adv");

mustSucceed(
  "setup: owner",
  run(
    `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${userId}', '+963900000401', 'adv@example.com', 'Adv Owner', 'hashAdv');`
  )
);
mustSucceed(
  "setup: store A",
  run(
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('${storeAId}', '${userId}', '${slug("store-adv-a")}', 'Adv Store A');`
  )
);
mustSucceed(
  "setup: store B",
  run(
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('${storeBId}', '${userId}', '${slug("store-adv-b")}', 'Adv Store B');`
  )
);
mustSucceed(
  "setup: category B",
  run(
    `INSERT INTO categories (id, store_id, name, slug) VALUES ('${catBId}', '${storeBId}', 'Adv Cat B', '${slug("adv-cat-b")}');`
  )
);
mustSucceed(
  "setup: product A (uncategorised)",
  run(
    `INSERT INTO products (id, store_id, name, slug, price) VALUES ('${prodAId}', '${storeAId}', 'Adv Prod A', '${slug("adv-prod-a")}', 5000);`
  )
);
mustSucceed(
  "setup: customer A",
  run(
    `INSERT INTO customers (id, store_id, name, phone) VALUES ('${custAId}', '${storeAId}', 'Adv Cust A', '+963911400001');`
  )
);
mustSucceed(
  "setup: customer B",
  run(
    `INSERT INTO customers (id, store_id, name, phone) VALUES ('${custBId}', '${storeBId}', 'Adv Cust B', '+963911400002');`
  )
);
mustSucceed(
  "setup: address A",
  run(
    `INSERT INTO customer_addresses (id, store_id, customer_id, recipient_name, phone, governorate, address_line) VALUES ('${addrAId}', '${storeAId}', '${custAId}', 'Adv Recip', '+963911400001', 'Damascus', 'Adv Street 1');`
  )
);
mustSucceed(
  "setup: plan",
  run(
    `INSERT INTO plans (id, code, name) VALUES ('${planId}', '${slug("adv-plan")}', 'Adv Plan');`
  )
);
mustSucceed(
  "setup: active subscription",
  run(
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at) VALUES ('${subId}', '${storeAId}', '${planId}', 'active', 'monthly', '2026-09-15T00:00:00Z');`
  )
);

// ------------------------------------------------------------------
// A. Cross-store parent link: a category in store A cannot hang under a
//    parent category belonging to store B (self-referencing composite FK).
//    Phase 2 proves this for products/images but never for parent_id.
// ------------------------------------------------------------------
console.log("\n[A] Cross-store parent category link is rejected");

const crossStoreParent = run(
  `INSERT INTO categories (id, store_id, parent_id, name, slug) VALUES ('${uid("cat_adv")}', '${storeAId}', '${catBId}', 'Sneaky Child', '${slug("adv-sneaky")}');`
);
check(
  "category in store A with parent_id of store B is rejected",
  !crossStoreParent.ok,
  crossStoreParent.ok ? "expected failure but insert succeeded" : undefined
);

// ------------------------------------------------------------------
// B. UPDATE-path enforcement: FKs must also reject re-pointing an
//    existing row at another store's parent (INSERT-only tests miss this).
// ------------------------------------------------------------------
console.log("\n[B] Cross-store UPDATE path is rejected");

const crossStoreRecategorise = run(
  `UPDATE products SET category_id = '${catBId}' WHERE id = '${prodAId}';`
);
check(
  "re-pointing product A at store B's category is rejected",
  !crossStoreRecategorise.ok,
  crossStoreRecategorise.ok ? "expected failure but update succeeded" : undefined
);

const crossStoreReassignAddress = run(
  `UPDATE customer_addresses SET customer_id = '${custBId}' WHERE id = '${addrAId}';`
);
check(
  "re-pointing address A at store B's customer is rejected",
  !crossStoreReassignAddress.ok,
  crossStoreReassignAddress.ok ? "expected failure but update succeeded" : undefined
);

// ------------------------------------------------------------------
// C. Plan-in-use: a plan referenced by any subscription row cannot be
//    removed (RESTRICT is status-blind); an unused plan can.
// ------------------------------------------------------------------
console.log("\n[C] Plan-in-use delete is blocked, unused plan deletes cleanly");

const deletePlanInUse = run(`DELETE FROM plans WHERE id = '${planId}';`);
check(
  "delete of plan referenced by a subscription is rejected",
  !deletePlanInUse.ok,
  deletePlanInUse.ok ? "expected failure but delete succeeded" : undefined
);

const unusedPlanId = uid("plan_adv");
mustSucceed(
  "setup: unused plan",
  run(
    `INSERT INTO plans (id, code, name) VALUES ('${unusedPlanId}', '${slug("adv-plan-unused")}', 'Adv Unused');`
  )
);
const deleteUnusedPlan = run(`DELETE FROM plans WHERE id = '${unusedPlanId}';`);
check("delete of unreferenced plan succeeds", deleteUnusedPlan.ok, deleteUnusedPlan.error);

// A plan referenced only by an expired (historical) subscription is still
// protected: history must never be orphaned.
mustSucceed(
  "setup: expire the active subscription",
  run(`UPDATE subscriptions SET status = 'expired' WHERE id = '${subId}';`)
);
const deletePlanWithHistory = run(`DELETE FROM plans WHERE id = '${planId}';`);
check(
  "delete of plan referenced only by an expired subscription is still rejected",
  !deletePlanWithHistory.ok,
  deletePlanWithHistory.ok ? "expected failure but delete succeeded" : undefined
);

// ------------------------------------------------------------------
// D. NULL-email semantics: nullable means repeatable (partial unique
//    index), while a concrete duplicate must still be rejected.
// ------------------------------------------------------------------
console.log("\n[D] NULL emails repeat, concrete duplicate emails rejected");

const nullEmail1 = run(
  `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${uid("user_adv")}', '+963900000402', NULL, 'Null Mail One', 'hashN');`
);
const nullEmail2 = run(
  `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${uid("user_adv")}', '+963900000403', NULL, 'Null Mail Two', 'hashN');`
);
check("first user with NULL email succeeds", nullEmail1.ok, nullEmail1.error);
check("second user with NULL email succeeds", nullEmail2.ok, nullEmail2.error);

const dupEmail = run(
  `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${uid("user_adv")}', '+963900000404', 'adv@example.com', 'Dup Mail', 'hashN');`
);
check(
  "duplicate concrete email is rejected (control: index is active)",
  !dupEmail.ok,
  dupEmail.ok ? "expected failure but insert succeeded" : undefined
);

const nullCustEmail1 = run(
  `INSERT INTO customers (id, store_id, name, phone, email) VALUES ('${uid("cust_adv")}', '${storeAId}', 'Null Mail C1', '+963911400011', NULL);`
);
const nullCustEmail2 = run(
  `INSERT INTO customers (id, store_id, name, phone, email) VALUES ('${uid("cust_adv")}', '${storeAId}', 'Null Mail C2', '+963911400012', NULL);`
);
check("customers accept repeated NULL emails (not unique)", nullCustEmail1.ok && nullCustEmail2.ok);

// ------------------------------------------------------------------
// E. Subscription restore conflict: flipping an old period back to
//    active while a newer active period exists must be rejected by the
//    partial-unique index; flipping a cancelled row back must additionally
//    trip the cancelled_at CHECK.
// ------------------------------------------------------------------
console.log("\n[E] Conflicting subscription restore is rejected");

const sub2Id = uid("sub_adv");
mustSucceed(
  "setup: second (newer) active subscription",
  run(
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at) VALUES ('${sub2Id}', '${storeAId}', '${planId}', 'active', 'monthly', '2026-09-16T00:00:00Z');`
  )
);
const restoreOld = run(`UPDATE subscriptions SET status = 'active' WHERE id = '${subId}';`);
check(
  "restoring the expired period to active while a newer active exists is rejected",
  !restoreOld.ok,
  restoreOld.ok ? "expected failure but update succeeded" : undefined
);

const cancelledId = uid("sub_adv");
mustSucceed(
  "setup: cancelled subscription",
  run(
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, cancelled_at) VALUES ('${cancelledId}', '${storeBId}', '${planId}', 'cancelled', 'monthly', '2026-09-15T00:00:00Z', '2026-09-15T01:00:00Z');`
  )
);
const restoreCancelled = run(
  `UPDATE subscriptions SET status = 'active' WHERE id = '${cancelledId}';`
);
check(
  "restoring a cancelled period to active is rejected (cancelled_at CHECK)",
  !restoreCancelled.ok,
  restoreCancelled.ok ? "expected failure but update succeeded" : undefined
);

// ------------------------------------------------------------------
cleanVerify("adversarial end");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
