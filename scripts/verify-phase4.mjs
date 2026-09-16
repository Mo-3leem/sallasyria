// Phase 4 verification script (orders, order_items — final phase).
//
// Follows the same convention as verify-phase1.mjs / verify-phase2.mjs /
// verify-phase3.mjs: each SQL statement is written to a temp .sql file and
// run via `wrangler d1 execute --local --file`, because on Windows, passing
// SQL inline via `--command` through a shell re-tokenizes on spaces and
// breaks multi-argument INSERT statements. Using --file avoids all
// shell-quoting issues and keeps this script portable.
//
// Usage: node scripts/verify-phase4.mjs
// Requires: Phase 1 + Phase 2 + Phase 3 + Phase 4 migrations already applied
// locally (npx wrangler d1 migrations apply sallasyria-db --local)

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
const tmpDir = mkdtempSync(join(tmpdir(), "sallasyria-verify4-"));
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

// Runs several statements as one D1 batch (one .sql file, multiple
// semicolon-separated statements) so they execute as a single implicit
// transaction — this is the local-verification stand-in for
// env.DB.batch(), which the real Hono checkout handler will use instead of
// wrangler d1 execute.
function runBatch(statements) {
  return run(statements.join("\n"));
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

console.log("Resetting Phase 4 test rows (and their Phase 1-3 fixtures)...");
cleanVerify("phase 4 reset");

// ------------------------------------------------------------------
// Fixtures: two stores (A, B), each with an owning user, a customer, and a
// product.
// ------------------------------------------------------------------
const userAId = uid("user_verify4");
const userBId = uid("user_verify4");
const storeAId = uid("store_verify4");
const storeBId = uid("store_verify4");
const custAId = uid("cust_verify4");
const custBId = uid("cust_verify4");
const prodAId = uid("prod_verify4");
const prodBId = uid("prod_verify4");

mustSucceed(
  "setup: user A4",
  run(
    `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${userAId}', '+963900000301', 'oa4@example.com', 'Owner A4', 'hashA4');`
  )
);
mustSucceed(
  "setup: user B4",
  run(
    `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${userBId}', '+963900000302', 'ob4@example.com', 'Owner B4', 'hashB4');`
  )
);
mustSucceed(
  "setup: store A4",
  run(
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('${storeAId}', '${userAId}', 'store-a4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}', 'Store A4');`
  )
);
mustSucceed(
  "setup: store B4",
  run(
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('${storeBId}', '${userBId}', 'store-b4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}', 'Store B4');`
  )
);
mustSucceed(
  "setup: customer A4",
  run(
    `INSERT INTO customers (id, store_id, name, phone) VALUES ('${custAId}', '${storeAId}', 'Customer A4', '+963911100001');`
  )
);
mustSucceed(
  "setup: customer B4",
  run(
    `INSERT INTO customers (id, store_id, name, phone) VALUES ('${custBId}', '${storeBId}', 'Customer B4', '+963911100002');`
  )
);
mustSucceed(
  "setup: product A4",
  run(
    `INSERT INTO products (id, store_id, name, slug, price) VALUES ('${prodAId}', '${storeAId}', 'Product A4', 'prod-a4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}', 150000);`
  )
);
mustSucceed(
  "setup: product B4",
  run(
    `INSERT INTO products (id, store_id, name, slug, price) VALUES ('${prodBId}', '${storeBId}', 'Product B4', 'prod-b4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}', 250000);`
  )
);

// ------------------------------------------------------------------
// 1. Checkout wiring: the UPDATE...RETURNING counter value flows into the
//    order insert (never a hardcoded constant), and totals/line_total are
//    computed here in "application code" (this script), not in SQL.
//    Atomicity of the real single-batch checkout is proven separately in
//    [1b] below with a poisoned batch.
// ------------------------------------------------------------------
console.log("\n[1] Checkout wiring: RETURNING counter value flows into the order insert");

const orderAId = uid("order_verify4");
const itemA1Id = uid("item_verify4");
const itemA2Id = uid("item_verify4");

const qtyA1 = 2;
const unitPriceA1 = 150000;
const lineTotalA1 = qtyA1 * unitPriceA1; // app-computed, per checkout contract (3)
const qtyA2 = 1;
const unitPriceA2 = 75000;
const lineTotalA2 = qtyA2 * unitPriceA2;
const subtotalA = lineTotalA1 + lineTotalA2;
const discountA = 10000;
const shippingCostA = 500000;
const totalA = subtotalA - discountA + shippingCostA; // app-computed, per checkout contract (3)

const counterRes1 = run(
  `UPDATE stores SET order_counter = order_counter + 1 WHERE id = '${storeAId}' RETURNING order_counter;`
);
mustSucceed("setup: counter increment for store A", counterRes1);
const orderANum = rows(counterRes1)[0]?.order_counter;
check(
  "RETURNING yields a usable integer counter value",
  counterRes1.ok && Number.isInteger(Number(orderANum)),
  JSON.stringify(rows(counterRes1))
);

const checkoutBatch1 = runBatch([
  `INSERT INTO orders (id, store_id, customer_id, order_number, subtotal, discount, total, customer_name, customer_phone, shipping_method, shipping_cost, shipping_governorate, shipping_address) VALUES ('${orderAId}', '${storeAId}', '${custAId}', ${orderANum}, ${subtotalA}, ${discountA}, ${totalA}, 'Customer A4', '+963911100001', 'Standard', ${shippingCostA}, 'Damascus', 'Street 1, Damascus');`,
  `INSERT INTO order_items (id, store_id, order_id, product_id, quantity, product_name, unit_price, line_total) VALUES ('${itemA1Id}', '${storeAId}', '${orderAId}', '${prodAId}', ${qtyA1}, 'Product A4', ${unitPriceA1}, ${lineTotalA1});`,
  `INSERT INTO order_items (id, store_id, order_id, product_id, quantity, product_name, unit_price, line_total) VALUES ('${itemA2Id}', '${storeAId}', '${orderAId}', NULL, ${qtyA2}, 'Custom Line Item', ${unitPriceA2}, ${lineTotalA2});`,
]);
check(
  "batch (order + 2 items, one item with NULL product_id) succeeds",
  checkoutBatch1.ok,
  checkoutBatch1.error
);

const orderANumRead = rows(
  run(`SELECT order_number FROM orders WHERE id = '${orderAId}';`)
)[0]?.order_number;
check(
  "stored order_number equals the RETURNING counter value (wired, not hardcoded)",
  checkoutBatch1.ok && Number(orderANumRead) === Number(orderANum),
  JSON.stringify(orderANumRead)
);

const orderARow = rows(run(`SELECT subtotal, discount, total FROM orders WHERE id = '${orderAId}';`))[0];
check(
  "orders.total = subtotal - discount + shipping_cost matches app computation",
  orderARow &&
    Number(orderARow.subtotal) === subtotalA &&
    Number(orderARow.discount) === discountA &&
    Number(orderARow.total) === totalA,
  JSON.stringify(orderARow)
);

const itemA1Row = rows(
  run(`SELECT quantity, unit_price, line_total FROM order_items WHERE id = '${itemA1Id}';`)
)[0];
check(
  "order_items.line_total = quantity * unit_price for item A1",
  itemA1Row && Number(itemA1Row.line_total) === Number(itemA1Row.quantity) * Number(itemA1Row.unit_price),
  JSON.stringify(itemA1Row)
);

// ------------------------------------------------------------------
// 1b. A failed batch rolls back the counter increment (all-or-nothing),
//     so order numbers are never skipped. This is the atomicity half of
//     the checkout contract; [1] above proves the value-wiring half.
// ------------------------------------------------------------------
console.log("\n[1b] Failed batch rolls back the counter increment (all-or-nothing)");

const counterBefore = rows(
  run(`SELECT order_counter FROM stores WHERE id = '${storeAId}';`)
)[0]?.order_counter;
const poisonedBatch = runBatch([
  `UPDATE stores SET order_counter = order_counter + 1 WHERE id = '${storeAId}' RETURNING order_counter;`,
  `INSERT INTO orders (id, store_id, customer_id, order_number, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address) VALUES ('${uid("order_verify4")}', '${storeAId}', 'nonexistent_customer_id', 999999, 'Ghost', '+963900000000', 'Standard', 'Damascus', 'Nowhere');`,
]);
check(
  "batch with a failing order insert (bad customer FK) fails as a unit",
  !poisonedBatch.ok,
  poisonedBatch.ok ? "expected failure but batch succeeded" : undefined
);
const counterAfter = rows(
  run(`SELECT order_counter FROM stores WHERE id = '${storeAId}';`)
)[0]?.order_counter;
check(
  "counter is unchanged after the failed batch (numbers never skipped)",
  Number(counterAfter) === Number(counterBefore),
  JSON.stringify({ before: counterBefore, after: counterAfter })
);

// ------------------------------------------------------------------
// 2. Sequential per-store order numbers, wired from RETURNING (no hardcoded
//    constants): a second increment for store A must return previous + 1.
// ------------------------------------------------------------------
console.log("\n[2] Counter RETURNING issues sequential per-store order numbers");

const orderA2Id = uid("order_verify4");
const counterRes2 = run(
  `UPDATE stores SET order_counter = order_counter + 1 WHERE id = '${storeAId}' RETURNING order_counter;`
);
mustSucceed("setup: second counter increment for store A", counterRes2);
const orderA2Num = rows(counterRes2)[0]?.order_counter;
check(
  "second increment for store A returns previous + 1 (sequential, not reused)",
  counterRes2.ok && Number(orderA2Num) === Number(orderANum) + 1,
  JSON.stringify(rows(counterRes2))
);
const checkoutBatch2 = runBatch([
  `INSERT INTO orders (id, store_id, customer_id, order_number, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address) VALUES ('${orderA2Id}', '${storeAId}', '${custAId}', ${orderA2Num}, 'Customer A4', '+963911100001', 'Standard', 'Aleppo', 'Street 2, Aleppo');`,
]);
check("second order insert (wired number) succeeds", checkoutBatch2.ok, checkoutBatch2.error);

// Store B gets its own counter sequence. Its first order deliberately reuses
// store A's first order number to prove numbers are per-store, not global.
const orderB1Id = uid("order_verify4");
const counterResB = run(
  `UPDATE stores SET order_counter = order_counter + 1 WHERE id = '${storeBId}' RETURNING order_counter;`
);
mustSucceed("setup: counter increment for store B", counterResB);
const checkoutBatchB = runBatch([
  `INSERT INTO orders (id, store_id, customer_id, order_number, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address) VALUES ('${orderB1Id}', '${storeBId}', '${custBId}', ${orderANum}, 'Customer B4', '+963911100002', 'Standard', 'Homs', 'Street 1, Homs');`,
]);
check("store B order insert (same number as store A) succeeds", checkoutBatchB.ok, checkoutBatchB.error);
const orderBNumRead = rows(
  run(`SELECT order_number FROM orders WHERE id = '${orderB1Id}';`)
)[0]?.order_number;
check(
  "store B's order carries the same number as store A's first order (per-store numbering)",
  checkoutBatchB.ok && Number(orderBNumRead) === Number(orderANum),
  JSON.stringify(orderBNumRead)
);

// ------------------------------------------------------------------
// 3. Cross-store references blocked by composite FKs.
// ------------------------------------------------------------------
console.log("\n[3] Cross-store references blocked by composite FKs");

const crossStoreOrderCustomer = run(
  `INSERT INTO orders (id, store_id, customer_id, order_number, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address) VALUES ('${uid("order_verify4")}', '${storeAId}', '${custBId}', 9001, 'Bad Customer', '+963911100002', 'Standard', 'Homs', 'Street X');`
);
check(
  "order in store A referencing customer of store B is rejected",
  !crossStoreOrderCustomer.ok,
  crossStoreOrderCustomer.ok ? "expected failure but insert succeeded" : undefined
);

const crossStoreItemOrder = run(
  `INSERT INTO order_items (id, store_id, order_id, product_id, quantity, product_name, unit_price, line_total) VALUES ('${uid("item_verify4")}', '${storeAId}', '${orderB1Id}', '${prodAId}', 1, 'Bad Item', 1000, 1000);`
);
check(
  "order_item in store A referencing order of store B is rejected",
  !crossStoreItemOrder.ok,
  crossStoreItemOrder.ok ? "expected failure but insert succeeded" : undefined
);

const crossStoreItemProduct = run(
  `INSERT INTO order_items (id, store_id, order_id, product_id, quantity, product_name, unit_price, line_total) VALUES ('${uid("item_verify4")}', '${storeAId}', '${orderAId}', '${prodBId}', 1, 'Bad Item Product', 1000, 1000);`
);
check(
  "order_item in store A referencing product of store B is rejected",
  !crossStoreItemProduct.ok,
  crossStoreItemProduct.ok ? "expected failure but insert succeeded" : undefined
);

// ------------------------------------------------------------------
// 4. order_number uniqueness: per-store unique, cross-store allowed.
// ------------------------------------------------------------------
console.log("\n[4] Store-scoped unique order_number");

const dupOrderNumber = run(
  `INSERT INTO orders (id, store_id, customer_id, order_number, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address) VALUES ('${uid("order_verify4")}', '${storeAId}', '${custAId}', ${orderANum}, 'Dup Number', '+963911100001', 'Standard', 'Hama', 'Street Dup');`
);
check(
  "duplicate order_number in same store (store A) is rejected",
  !dupOrderNumber.ok,
  dupOrderNumber.ok ? "expected failure but insert succeeded" : undefined
);

const sameNumberOtherStore = rows(
  run(`SELECT order_number FROM orders WHERE id = '${orderB1Id}';`)
)[0];
check(
  "the same order_number already exists independently in a different store (store B)",
  sameNumberOtherStore && Number(sameNumberOtherStore.order_number) === Number(orderANum),
  JSON.stringify(sameNumberOtherStore)
);

// ------------------------------------------------------------------
// 5. Invalid enum / CHECK values rejected.
// ------------------------------------------------------------------
console.log("\n[5] CHECK constraints: status, payment_method, payment_status, governorate, quantity, money");

const invalidStatus = run(
  `INSERT INTO orders (id, store_id, customer_id, order_number, status, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address) VALUES ('${uid("order_verify4")}', '${storeAId}', '${custAId}', 9101, 'not_a_status', 'X', '+963911100001', 'Standard', 'Hama', 'Street X');`
);
check("order with invalid status is rejected", !invalidStatus.ok, invalidStatus.ok ? "expected failure but insert succeeded" : undefined);

const invalidPaymentMethod = run(
  `INSERT INTO orders (id, store_id, customer_id, order_number, payment_method, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address) VALUES ('${uid("order_verify4")}', '${storeAId}', '${custAId}', 9102, 'crypto', 'X', '+963911100001', 'Standard', 'Hama', 'Street X');`
);
check(
  "order with invalid payment_method is rejected",
  !invalidPaymentMethod.ok,
  invalidPaymentMethod.ok ? "expected failure but insert succeeded" : undefined
);

const invalidPaymentStatus = run(
  `INSERT INTO orders (id, store_id, customer_id, order_number, payment_status, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address) VALUES ('${uid("order_verify4")}', '${storeAId}', '${custAId}', 9103, 'not_a_payment_status', 'X', '+963911100001', 'Standard', 'Hama', 'Street X');`
);
check(
  "order with invalid payment_status is rejected",
  !invalidPaymentStatus.ok,
  invalidPaymentStatus.ok ? "expected failure but insert succeeded" : undefined
);

const invalidGovernorate = run(
  `INSERT INTO orders (id, store_id, customer_id, order_number, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address) VALUES ('${uid("order_verify4")}', '${storeAId}', '${custAId}', 9104, 'X', '+963911100001', 'Standard', 'Not A Real Governorate', 'Street X');`
);
check(
  "order with invalid shipping_governorate is rejected",
  !invalidGovernorate.ok,
  invalidGovernorate.ok ? "expected failure but insert succeeded" : undefined
);

const zeroQuantity = run(
  `INSERT INTO order_items (id, store_id, order_id, product_id, quantity, product_name, unit_price, line_total) VALUES ('${uid("item_verify4")}', '${storeAId}', '${orderAId}', '${prodAId}', 0, 'Zero Qty', 1000, 0);`
);
check(
  "order_item with quantity = 0 is rejected",
  !zeroQuantity.ok,
  zeroQuantity.ok ? "expected failure but insert succeeded" : undefined
);

const negativeUnitPrice = run(
  `INSERT INTO order_items (id, store_id, order_id, product_id, quantity, product_name, unit_price, line_total) VALUES ('${uid("item_verify4")}', '${storeAId}', '${orderAId}', '${prodAId}', 1, 'Negative Price', -100, -100);`
);
check(
  "order_item with negative unit_price is rejected",
  !negativeUnitPrice.ok,
  negativeUnitPrice.ok ? "expected failure but insert succeeded" : undefined
);

const negativeSubtotal = run(
  `INSERT INTO orders (id, store_id, customer_id, order_number, subtotal, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address) VALUES ('${uid("order_verify4")}', '${storeAId}', '${custAId}', 9105, -500, 'X', '+963911100001', 'Standard', 'Hama', 'Street X');`
);
check(
  "order with negative subtotal is rejected",
  !negativeSubtotal.ok,
  negativeSubtotal.ok ? "expected failure but insert succeeded" : undefined
);

// ------------------------------------------------------------------
// 6. Product hard-delete with order_items referencing it is RESTRICTed
//    (deviation from doc's SET NULL); soft-delete succeeds and leaves the
//    order/order_item untouched.
// ------------------------------------------------------------------
console.log("\n[6] Product hard-delete blocked while order_items reference it (RESTRICT deviation); soft-delete succeeds");

const hardDeleteProductInUse = run(`DELETE FROM products WHERE id = '${prodAId}';`);
check(
  "hard DELETE of product A4 while order_items reference it is rejected",
  !hardDeleteProductInUse.ok,
  hardDeleteProductInUse.ok ? "expected failure but delete succeeded" : undefined
);

const softDeleteProduct = run(
  `UPDATE products SET deleted_at = '2026-09-15T00:00:00Z' WHERE id = '${prodAId}';`
);
check("soft-delete of product A4 (set deleted_at) succeeds", softDeleteProduct.ok, softDeleteProduct.error);

const itemA1AfterSoftDelete = rows(
  run(`SELECT product_id, product_name, unit_price, line_total FROM order_items WHERE id = '${itemA1Id}';`)
)[0];
check(
  "order_item A1 is unchanged after its product is soft-deleted (snapshot + product_id link both intact)",
  itemA1AfterSoftDelete &&
    itemA1AfterSoftDelete.product_id === prodAId &&
    itemA1AfterSoftDelete.product_name === "Product A4" &&
    Number(itemA1AfterSoftDelete.unit_price) === unitPriceA1 &&
    Number(itemA1AfterSoftDelete.line_total) === lineTotalA1,
  JSON.stringify(itemA1AfterSoftDelete)
);

const orderAAfterSoftDelete = rows(
  run(`SELECT id, subtotal, total FROM orders WHERE id = '${orderAId}';`)
)[0];
check(
  "order A is unchanged after its item's product is soft-deleted",
  orderAAfterSoftDelete &&
    Number(orderAAfterSoftDelete.subtotal) === subtotalA &&
    Number(orderAAfterSoftDelete.total) === totalA,
  JSON.stringify(orderAAfterSoftDelete)
);

// ------------------------------------------------------------------
// 7. Customer-with-orders delete blocked; store-with-orders delete blocked.
// ------------------------------------------------------------------
console.log("\n[7] Customer-with-orders and store-with-orders deletes are RESTRICTed");

const deleteCustomerWithOrders = run(`DELETE FROM customers WHERE id = '${custAId}';`);
check(
  "delete of customer A4 while they have orders is rejected",
  !deleteCustomerWithOrders.ok,
  deleteCustomerWithOrders.ok ? "expected failure but delete succeeded" : undefined
);

const deleteStoreWithOrders = run(`DELETE FROM stores WHERE id = '${storeAId}';`);
check(
  "delete of store A4 while it has orders is rejected",
  !deleteStoreWithOrders.ok,
  deleteStoreWithOrders.ok ? "expected failure but delete succeeded" : undefined
);

// ------------------------------------------------------------------
// 8. Deleting an order cascades to its order_items.
// ------------------------------------------------------------------
console.log("\n[8] Deleting an order cascades to its order_items");

const deleteOrderA2 = run(`DELETE FROM orders WHERE id = '${orderA2Id}';`);
check("delete of order A2 (no items) succeeds", deleteOrderA2.ok, deleteOrderA2.error);

// Give order A a throwaway extra item, then delete order A itself and prove
// cascade removes both order_items rows (itemA1, itemA2, and this new one).
const itemA3Id = uid("item_verify4");
mustSucceed(
  "setup: extra line item on order A",
  run(
    `INSERT INTO order_items (id, store_id, order_id, product_id, quantity, product_name, unit_price, line_total) VALUES ('${itemA3Id}', '${storeAId}', '${orderAId}', NULL, 1, 'Extra Line', 1000, 1000);`
  )
);

const deleteOrderA = run(`DELETE FROM orders WHERE id = '${orderAId}';`);
check("delete of order A succeeds", deleteOrderA.ok, deleteOrderA.error);

const itemsAfterOrderDelete = rows(
  run(
    `SELECT id FROM order_items WHERE id IN ('${itemA1Id}', '${itemA2Id}', '${itemA3Id}');`
  )
);
check(
  "all of order A's order_items rows no longer exist after the order is deleted",
  itemsAfterOrderDelete.length === 0,
  JSON.stringify(itemsAfterOrderDelete)
);

// ------------------------------------------------------------------
// 9. ON CONFLICT(store_id, phone) customer upsert (checkout contract rule 2)
//    resolves atomically instead of raising a UNIQUE constraint error.
// ------------------------------------------------------------------
console.log("\n[9] ON CONFLICT(store_id, phone) customer upsert (no check-then-insert)");

const upsertPhone = "+963911100099";
const custUpsert1Id = uid("cust_verify4");
const insertUpsert1 = run(
  `INSERT INTO customers (id, store_id, name, phone) VALUES ('${custUpsert1Id}', '${storeBId}', 'Original Name', '${upsertPhone}') ON CONFLICT(store_id, phone) DO UPDATE SET name = excluded.name;`
);
check("first ON CONFLICT upsert (new phone) inserts a new customer row", insertUpsert1.ok, insertUpsert1.error);

const custUpsert2Id = uid("cust_verify4");
const insertUpsert2 = run(
  `INSERT INTO customers (id, store_id, name, phone) VALUES ('${custUpsert2Id}', '${storeBId}', 'Updated Name', '${upsertPhone}') ON CONFLICT(store_id, phone) DO UPDATE SET name = excluded.name;`
);
check(
  "second ON CONFLICT upsert (same store+phone, different id/name) succeeds without a UNIQUE error",
  insertUpsert2.ok,
  insertUpsert2.error
);

const upsertedRow = rows(
  run(`SELECT id, name FROM customers WHERE store_id = '${storeBId}' AND phone = '${upsertPhone}';`)
)[0];
check(
  "exactly one customer row exists for that store+phone, with the original id but the updated name (DO UPDATE, not a second insert)",
  upsertedRow && upsertedRow.id === custUpsert1Id && upsertedRow.name === "Updated Name",
  JSON.stringify(upsertedRow)
);

// ------------------------------------------------------------------
cleanVerify("phase 4 end");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
