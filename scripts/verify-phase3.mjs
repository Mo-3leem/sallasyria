// Phase 3 verification script (customers, customer_addresses, shipping_rates).
//
// Follows the same convention as verify-phase1.mjs / verify-phase2.mjs: each
// SQL statement is written to a temp .sql file and run via
// `wrangler d1 execute --local --file`, because on Windows, passing SQL
// inline via `--command` through a shell re-tokenizes on spaces and breaks
// multi-argument INSERT statements. Using --file avoids all shell-quoting
// issues and keeps this script portable.
//
// Usage: node scripts/verify-phase3.mjs
// Requires: Phase 1 + Phase 2 + Phase 3 migrations already applied locally
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
const tmpDir = mkdtempSync(join(tmpdir(), "sallasyria-verify3-"));
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

console.log("Resetting Phase 3 test rows (and their Phase 1 fixtures)...");
cleanVerify("phase 3 reset");

// ------------------------------------------------------------------
// Fixtures: two stores (A, B), each with an owning user.
// ------------------------------------------------------------------
const userAId = uid("user_verify3");
const userBId = uid("user_verify3");
const storeAId = uid("store_verify3");
const storeBId = uid("store_verify3");

mustSucceed(
  "setup: user A3",
  run(
    `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${userAId}', '+963900000201', 'ca@example.com', 'Owner A3', 'hashA3');`
  )
);
mustSucceed(
  "setup: user B3",
  run(
    `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${userBId}', '+963900000202', 'cb@example.com', 'Owner B3', 'hashB3');`
  )
);
mustSucceed(
  "setup: store A3",
  run(
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('${storeAId}', '${userAId}', 'store-a3-${Date.now()}', 'Store A3');`
  )
);
mustSucceed(
  "setup: store B3",
  run(
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('${storeBId}', '${userBId}', 'store-b3-${Date.now()}', 'Store B3');`
  )
);

// ------------------------------------------------------------------
// 1. customer -> address chain, plus a shipping_rate, for one store.
// ------------------------------------------------------------------
console.log("\n[1] Insert customer + address + shipping_rate chain for one store");

const custAId = uid("cust_verify3");
const addrAId = uid("addr_verify3");
const rateAId = uid("rate_verify3");

const insertCustA = run(
  `INSERT INTO customers (id, store_id, name, phone) VALUES ('${custAId}', '${storeAId}', 'Customer A', '+963911000001');`
);
mustSucceed("setup: customer A", insertCustA);
check("customer insert (store A) succeeds", insertCustA.ok, insertCustA.error);

const insertAddrA = run(
  `INSERT INTO customer_addresses (id, store_id, customer_id, recipient_name, phone, governorate, address_line) VALUES ('${addrAId}', '${storeAId}', '${custAId}', 'Recipient A', '+963911000001', 'Damascus', 'Some street 1');`
);
mustSucceed("setup: address A", insertAddrA);
check("customer_address insert (store A, customer A) succeeds", insertAddrA.ok, insertAddrA.error);

const insertRateA = run(
  `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost) VALUES ('${rateAId}', '${storeAId}', 'Damascus', 'Standard', 500000);`
);
mustSucceed("setup: shipping rate A", insertRateA);
check("shipping_rate insert (store A, Damascus) succeeds", insertRateA.ok, insertRateA.error);

// ------------------------------------------------------------------
// 2. Cross-store reference blocked via composite FK.
// ------------------------------------------------------------------
console.log("\n[2] Cross-store address->customer reference is blocked by composite FK");

const custBId = uid("cust_verify3");
mustSucceed(
  "setup: customer B",
  run(
    `INSERT INTO customers (id, store_id, name, phone) VALUES ('${custBId}', '${storeBId}', 'Customer B', '+963911000002');`
  )
);

const crossStoreAddress = run(
  `INSERT INTO customer_addresses (id, store_id, customer_id, recipient_name, phone, governorate, address_line) VALUES ('${uid("addr_verify3")}', '${storeAId}', '${custBId}', 'Bad Recipient', '+963911000002', 'Aleppo', 'Some street 2');`
);
check(
  "address in store A referencing customer of store B is rejected",
  !crossStoreAddress.ok,
  crossStoreAddress.ok ? "expected failure but insert succeeded" : undefined
);

// ------------------------------------------------------------------
// 3. Duplicate phone in same store rejected; same phone in different store succeeds.
// ------------------------------------------------------------------
console.log("\n[3] Store-scoped unique phone on customers");

const dupPhone = "+963911999999";
const custDup1 = uid("cust_verify3");
const custDup2 = uid("cust_verify3");
const custDupOtherStore = uid("cust_verify3");

const insertPhoneDup1 = run(
  `INSERT INTO customers (id, store_id, name, phone) VALUES ('${custDup1}', '${storeAId}', 'Dup Phone One', '${dupPhone}');`
);
mustSucceed("setup: first dup-phone customer", insertPhoneDup1);
check("first customer with phone in store A succeeds", insertPhoneDup1.ok, insertPhoneDup1.error);

const insertPhoneDup2 = run(
  `INSERT INTO customers (id, store_id, name, phone) VALUES ('${custDup2}', '${storeAId}', 'Dup Phone Two', '${dupPhone}');`
);
check(
  "duplicate phone in same store (store A) is rejected",
  !insertPhoneDup2.ok,
  insertPhoneDup2.ok ? "expected failure but insert succeeded" : undefined
);

const insertPhoneOtherStore = run(
  `INSERT INTO customers (id, store_id, name, phone) VALUES ('${custDupOtherStore}', '${storeBId}', 'Dup Phone Other Store', '${dupPhone}');`
);
mustSucceed("setup: cross-store dup-phone customer", insertPhoneOtherStore);
check(
  "same phone in a different store (store B) succeeds",
  insertPhoneOtherStore.ok,
  insertPhoneOtherStore.error
);

// ------------------------------------------------------------------
// 4. is_default partial-unique behavior on customer_addresses.
// ------------------------------------------------------------------
console.log("\n[4] Partial-unique: one default address per customer");

const addrDefault1 = uid("addr_verify3");
const addrDefault2 = uid("addr_verify3");
const addrNonDefault1 = uid("addr_verify3");
const addrNonDefault2 = uid("addr_verify3");
const addrOtherCustDefault = uid("addr_verify3");

const insertDefault1 = run(
  `INSERT INTO customer_addresses (id, store_id, customer_id, recipient_name, phone, governorate, address_line, is_default) VALUES ('${addrDefault1}', '${storeAId}', '${custAId}', 'Def One', '+963911000001', 'Homs', 'Street D1', 1);`
);
mustSucceed("setup: first default address", insertDefault1);
check("first is_default=1 address for customer A succeeds", insertDefault1.ok, insertDefault1.error);

const insertDefault2 = run(
  `INSERT INTO customer_addresses (id, store_id, customer_id, recipient_name, phone, governorate, address_line, is_default) VALUES ('${addrDefault2}', '${storeAId}', '${custAId}', 'Def Two', '+963911000001', 'Hama', 'Street D2', 1);`
);
check(
  "second is_default=1 address for the SAME customer A is rejected",
  !insertDefault2.ok,
  insertDefault2.ok ? "expected failure but insert succeeded" : undefined
);

const insertOtherCustDefault = run(
  `INSERT INTO customer_addresses (id, store_id, customer_id, recipient_name, phone, governorate, address_line, is_default) VALUES ('${addrOtherCustDefault}', '${storeBId}', '${custBId}', 'Def Other Cust', '+963911000002', 'Latakia', 'Street D3', 1);`
);
mustSucceed("setup: other-customer default address", insertOtherCustDefault);
check(
  "is_default=1 address for a DIFFERENT customer (B) succeeds",
  insertOtherCustDefault.ok,
  insertOtherCustDefault.error
);

const insertNonDefault1 = run(
  `INSERT INTO customer_addresses (id, store_id, customer_id, recipient_name, phone, governorate, address_line, is_default) VALUES ('${addrNonDefault1}', '${storeAId}', '${custAId}', 'NonDef One', '+963911000001', 'Idlib', 'Street N1', 0);`
);
mustSucceed("setup: first non-default address", insertNonDefault1);
check("first is_default=0 address for customer A succeeds", insertNonDefault1.ok, insertNonDefault1.error);

const insertNonDefault2 = run(
  `INSERT INTO customer_addresses (id, store_id, customer_id, recipient_name, phone, governorate, address_line, is_default) VALUES ('${addrNonDefault2}', '${storeAId}', '${custAId}', 'NonDef Two', '+963911000001', 'Tartus', 'Street N2', 0);`
);
mustSucceed("setup: second non-default address", insertNonDefault2);
check(
  "second is_default=0 address for the SAME customer A also succeeds (multiples allowed)",
  insertNonDefault2.ok,
  insertNonDefault2.error
);

// ------------------------------------------------------------------
// 5. shipping_rates: duplicate governorate in same store rejected; same
//    governorate in different store succeeds.
// ------------------------------------------------------------------
console.log("\n[5] Store-scoped unique governorate on shipping_rates");

const rateDup2 = uid("rate_verify3");
const rateOtherStore = uid("rate_verify3");

const insertRateDup2 = run(
  `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost) VALUES ('${rateDup2}', '${storeAId}', 'Damascus', 'Express', 800000);`
);
check(
  "duplicate governorate (Damascus) rate in same store (store A) is rejected",
  !insertRateDup2.ok,
  insertRateDup2.ok ? "expected failure but insert succeeded" : undefined
);

const insertRateOtherStore = run(
  `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost) VALUES ('${rateOtherStore}', '${storeBId}', 'Damascus', 'Standard', 500000);`
);
mustSucceed("setup: cross-store Damascus rate", insertRateOtherStore);
check(
  "same governorate (Damascus) rate in a different store (store B) succeeds",
  insertRateOtherStore.ok,
  insertRateOtherStore.error
);

// ------------------------------------------------------------------
// 6. Invalid governorate value rejected on addresses and shipping_rates.
// ------------------------------------------------------------------
console.log("\n[6] CHECK constraint: governorate must be one of the frozen 14 values");

const invalidGovAddress = run(
  `INSERT INTO customer_addresses (id, store_id, customer_id, recipient_name, phone, governorate, address_line) VALUES ('${uid("addr_verify3")}', '${storeAId}', '${custAId}', 'Bad Gov', '+963911000001', 'Not A Real Governorate', 'Street X');`
);
check(
  "customer_address with invalid governorate is rejected",
  !invalidGovAddress.ok,
  invalidGovAddress.ok ? "expected failure but insert succeeded" : undefined
);

const invalidGovRate = run(
  `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost) VALUES ('${uid("rate_verify3")}', '${storeAId}', 'Not A Real Governorate', 'Standard', 100000);`
);
check(
  "shipping_rate with invalid governorate is rejected",
  !invalidGovRate.ok,
  invalidGovRate.ok ? "expected failure but insert succeeded" : undefined
);

// ------------------------------------------------------------------
// 7a. Deleting a customer deletes its addresses (CASCADE).
// ------------------------------------------------------------------
console.log("\n[7a] Deleting a customer cascades to its addresses");

const custCId = uid("cust_verify3");
const addrCId = uid("addr_verify3");
mustSucceed(
  "setup: customer C",
  run(
    `INSERT INTO customers (id, store_id, name, phone) VALUES ('${custCId}', '${storeAId}', 'Customer C', '+963911000003');`
  )
);
mustSucceed(
  "setup: address C",
  run(
    `INSERT INTO customer_addresses (id, store_id, customer_id, recipient_name, phone, governorate, address_line) VALUES ('${addrCId}', '${storeAId}', '${custCId}', 'Recipient C', '+963911000003', 'Raqqa', 'Street C');`
  )
);

const deleteCustC = run(`DELETE FROM customers WHERE id = '${custCId}';`);
check("delete of customer C succeeds", deleteCustC.ok, deleteCustC.error);

const addrCAfterCustDelete = run(`SELECT id FROM customer_addresses WHERE id = '${addrCId}';`);
check(
  "customer C's address row no longer exists",
  addrCAfterCustDelete.ok && rows(addrCAfterCustDelete).length === 0,
  JSON.stringify(rows(addrCAfterCustDelete))
);

// ------------------------------------------------------------------
// 7b. Deleting a store cascades to its customers/addresses/rates.
// ------------------------------------------------------------------
console.log("\n[7b] Deleting a store cascades to its customers, addresses, and shipping_rates");

const deleteStoreB = run(`DELETE FROM stores WHERE id = '${storeBId}';`);
check("delete of store B succeeds", deleteStoreB.ok, deleteStoreB.error);

const custBAfter = run(`SELECT id FROM customers WHERE id = '${custBId}';`);
const addrOtherCustDefaultAfter = run(
  `SELECT id FROM customer_addresses WHERE id = '${addrOtherCustDefault}';`
);
const rateOtherStoreAfter = run(`SELECT id FROM shipping_rates WHERE id = '${rateOtherStore}';`);

check(
  "store B's customer no longer exists after store delete",
  custBAfter.ok && rows(custBAfter).length === 0,
  JSON.stringify(rows(custBAfter))
);
check(
  "store B's customer_address no longer exists after store delete",
  addrOtherCustDefaultAfter.ok && rows(addrOtherCustDefaultAfter).length === 0,
  JSON.stringify(rows(addrOtherCustDefaultAfter))
);
check(
  "store B's shipping_rate no longer exists after store delete",
  rateOtherStoreAfter.ok && rows(rateOtherStoreAfter).length === 0,
  JSON.stringify(rows(rateOtherStoreAfter))
);

// ------------------------------------------------------------------
cleanVerify("phase 3 end");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
