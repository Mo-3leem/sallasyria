// B6 verification script (idempotency_keys — exactly-once claim table).
//
// Same convention as the other verify scripts: statements run via
// `wrangler d1 execute --local --file`. Proves the DB-level guarantees the
// checkout service depends on: global key uniqueness, store-scoped order
// linkage, cascade behavior, and purge-index targeting.
//
// Usage: node scripts/verify-idempotency.mjs
// Requires: migrations 0001-0006 applied locally.

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
const tmpDir = mkdtempSync(join(tmpdir(), "sallasyria-verifyidem-"));
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

function rows(res) {
  return res.result?.[0]?.results ?? [];
}

console.log("Resetting idempotency test rows...");
cleanVerify("idempotency reset");

// ------------------------------------------------------------------
// Fixtures: owner + store + customer + order to link keys against.
// ------------------------------------------------------------------
const userId = uid("user_verify");
const storeId = uid("store_verify");
const custId = uid("cust_verify");
const orderId = uid("order_verify");

mustSucceed(
  "setup: user",
  run(
    `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${userId}', '+963900000901', 'idem@example.com', 'Idem Owner', 'hashIdem');`
  )
);
mustSucceed(
  "setup: store",
  run(
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('${storeId}', '${userId}', 'idem-store-${Date.now()}', 'Idem Store');`
  )
);
mustSucceed(
  "setup: customer",
  run(
    `INSERT INTO customers (id, store_id, name, phone) VALUES ('${custId}', '${storeId}', 'Idem Cust', '+963911900001');`
  )
);
mustSucceed(
  "setup: order",
  run(
    `INSERT INTO orders (id, store_id, customer_id, order_number, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address) VALUES ('${orderId}', '${storeId}', '${custId}', 1001, 'Idem Cust', '+963911900001', 'Standard', 'Damascus', 'Street 1');`
  )
);

// ------------------------------------------------------------------
// 1. Key claim insert succeeds with mapping + metadata intact.
// ------------------------------------------------------------------
console.log("\n[1] Key claim insert");

const key1 = `idem-key-${Date.now()}-a`;
const insertKey = run(
  `INSERT INTO idempotency_keys (key, store_id, order_id, request_hash, status) VALUES ('${key1}', '${storeId}', '${orderId}', '${"a".repeat(64)}', 'completed');`
);
mustSucceed("setup: key claim", insertKey);
check("key claim insert succeeds", insertKey.ok, insertKey.error);

const keyRow = rows(run(`SELECT key, store_id, order_id, request_hash, status FROM idempotency_keys WHERE key = '${key1}';`))[0];
check(
  "stored mapping carries store, order, hash, and status",
  keyRow && keyRow.store_id === storeId && keyRow.order_id === orderId &&
    keyRow.request_hash === "a".repeat(64) && keyRow.status === "completed",
  JSON.stringify(keyRow)
);

// ------------------------------------------------------------------
// 2. Duplicate key rejected (the exactly-once backstop).
// ------------------------------------------------------------------
console.log("\n[2] Duplicate key rejected");

const dupKey = run(
  `INSERT INTO idempotency_keys (key, store_id, request_hash) VALUES ('${key1}', '${storeId}', '${"b".repeat(64)}');`
);
check(
  "second claim of the same key is rejected",
  !dupKey.ok,
  dupKey.ok ? "expected failure but insert succeeded" : undefined
);

// ------------------------------------------------------------------
// 3. Key for a nonexistent store rejected (FK enforced).
// ------------------------------------------------------------------
console.log("\n[3] Store FK enforced");

const ghostStore = run(
  `INSERT INTO idempotency_keys (key, store_id, request_hash) VALUES ('${uid("idem-key")}', 'nonexistent_store', '${"c".repeat(64)}');`
);
check(
  "key claim for a nonexistent store is rejected",
  !ghostStore.ok,
  ghostStore.ok ? "expected failure but insert succeeded" : undefined
);

// ------------------------------------------------------------------
// 4. Cross-store order linkage rejected (composite FK, same store only).
// ------------------------------------------------------------------
console.log("\n[4] Cross-store order linkage rejected");

const userBId = uid("user_verify");
const storeBId = uid("store_verify");
mustSucceed(
  "setup: second owner",
  run(
    `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${userBId}', '+963900000902', 'idemb@example.com', 'Idem Owner B', 'hashIdemB');`
  )
);
mustSucceed(
  "setup: second store",
  run(
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('${storeBId}', '${userBId}', 'idem-store-b-${Date.now()}', 'Idem Store B');`
  )
);
const crossLink = run(
  `INSERT INTO idempotency_keys (key, store_id, order_id, request_hash) VALUES ('${uid("idem-key")}', '${storeBId}', '${orderId}', '${"d".repeat(64)}');`
);
check(
  "key in store B linked to store A's order is rejected",
  !crossLink.ok,
  crossLink.ok ? "expected failure but insert succeeded" : undefined
);

// ------------------------------------------------------------------
// 5. NULL order_id allowed (claim-before-order shape).
// ------------------------------------------------------------------
console.log("\n[5] NULL order_id allowed");

const nullOrderKey = `idem-key-${Date.now()}-null`;
const nullOrder = run(
  `INSERT INTO idempotency_keys (key, store_id, order_id, request_hash) VALUES ('${nullOrderKey}', '${storeId}', NULL, '${"e".repeat(64)}');`
);
check("key claim with NULL order_id succeeds", nullOrder.ok, nullOrder.error);

// ------------------------------------------------------------------
// 6. Order delete cascades its key claim (same key retries as fresh).
// ------------------------------------------------------------------
console.log("\n[6] Order delete cascades key claim");

const deleteOrder = run(`DELETE FROM orders WHERE id = '${orderId}';`);
check("delete of linked order succeeds", deleteOrder.ok, deleteOrder.error);
const keyAfter = run(`SELECT key FROM idempotency_keys WHERE key = '${key1}';`);
check(
  "key claim is gone after its order is deleted",
  keyAfter.ok && rows(keyAfter).length === 0,
  JSON.stringify(rows(keyAfter))
);

// ------------------------------------------------------------------
// 7. Retention predicate identifies purge-eligible rows.
// ------------------------------------------------------------------
console.log("\n[7] Retention predicate");

const oldKey = `idem-key-${Date.now()}-old`;
mustSucceed(
  "setup: aged key row",
  run(
    `INSERT INTO idempotency_keys (key, store_id, request_hash, created_at) VALUES ('${oldKey}', '${storeId}', '${"f".repeat(64)}', '2020-01-01T00:00:00Z');`
  )
);
const purgeable = rows(
  run(
    `SELECT key FROM idempotency_keys WHERE store_id = '${storeId}' AND created_at < '2021-01-01T00:00:00Z';`
  )
);
check(
  "aged row is identified by the (store_id, created_at) purge predicate",
  purgeable.some((r) => r.key === oldKey),
  JSON.stringify(purgeable.map((r) => r.key))
);

// ------------------------------------------------------------------
cleanVerify("idempotency end");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
