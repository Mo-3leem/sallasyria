// Phase 2 verification script (categories, products, product_images).
//
// Follows the same convention as scripts/verify-phase1.mjs: each SQL
// statement is written to a temp .sql file and run via
// `wrangler d1 execute --local --file`, because on Windows, passing SQL
// inline via `--command` through a shell re-tokenizes on spaces and breaks
// multi-argument INSERT statements. Using --file avoids all shell-quoting
// issues and keeps this script portable.
//
// Usage: node scripts/verify-phase2.mjs
// Requires: Phase 1 + Phase 2 migrations already applied locally
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
const tmpDir = mkdtempSync(join(tmpdir(), "sallasyria-verify2-"));
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

console.log("Resetting Phase 2 test rows (and their Phase 1 fixtures)...");
cleanVerify("phase 2 reset");

// ------------------------------------------------------------------
// Fixtures: two stores (A, B), each with an owning user.
// ------------------------------------------------------------------
const userAId = uid("user_verify2");
const userBId = uid("user_verify2");
const storeAId = uid("store_verify2");
const storeBId = uid("store_verify2");

mustSucceed(
  "setup: user A",
  run(
    `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${userAId}', '+963900000101', 'a@example.com', 'Owner A', 'hashA');`
  )
);
mustSucceed(
  "setup: user B",
  run(
    `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${userBId}', '+963900000102', 'b@example.com', 'Owner B', 'hashB');`
  )
);
mustSucceed(
  "setup: store A",
  run(
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('${storeAId}', '${userAId}', 'store-a-${Date.now()}', 'Store A');`
  )
);
mustSucceed(
  "setup: store B",
  run(
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('${storeBId}', '${userBId}', 'store-b-${Date.now()}', 'Store B');`
  )
);

// ------------------------------------------------------------------
// 1. category -> product -> product_image chain inserts for store A.
// ------------------------------------------------------------------
console.log("\n[1] Insert category + product + product_image chain for one store");
const catAId = uid("cat_verify2");
const prodAId = uid("prod_verify2");
const imgAId = uid("img_verify2");

const insertCatA = run(
  `INSERT INTO categories (id, store_id, name, slug) VALUES ('${catAId}', '${storeAId}', 'Category A', 'cat-a-${Date.now()}');`
);
mustSucceed("setup: category A", insertCatA);
check("category insert (store A) succeeds", insertCatA.ok, insertCatA.error);

const insertProdA = run(
  `INSERT INTO products (id, store_id, category_id, name, slug, price) VALUES ('${prodAId}', '${storeAId}', '${catAId}', 'Product A', 'prod-a-${Date.now()}', 150000);`
);
mustSucceed("setup: product A", insertProdA);
check("product insert (store A, category A) succeeds", insertProdA.ok, insertProdA.error);

const insertImgA = run(
  `INSERT INTO product_images (id, store_id, product_id, url, sort_order) VALUES ('${imgAId}', '${storeAId}', '${prodAId}', 'https://example.com/a.jpg', 0);`
);
mustSucceed("setup: image A", insertImgA);
check("product_image insert (store A, product A) succeeds", insertImgA.ok, insertImgA.error);

// ------------------------------------------------------------------
// 2. Cross-store reference blocked via composite FK.
// ------------------------------------------------------------------
console.log("\n[2] Cross-store references blocked by composite FKs");

const catBId = uid("cat_verify2");
mustSucceed(
  "setup: category B",
  run(
    `INSERT INTO categories (id, store_id, name, slug) VALUES ('${catBId}', '${storeBId}', 'Category B', 'cat-b-${Date.now()}');`
  )
);

const crossStoreProduct = run(
  `INSERT INTO products (id, store_id, category_id, name, slug, price) VALUES ('${uid("prod_verify2")}', '${storeAId}', '${catBId}', 'Bad Product', 'prod-bad-${Date.now()}', 100);`
);
check(
  "product in store A referencing category of store B is rejected",
  !crossStoreProduct.ok,
  crossStoreProduct.ok ? "expected failure but insert succeeded" : undefined
);

const prodBId = uid("prod_verify2");
mustSucceed(
  "setup: product B",
  run(
    `INSERT INTO products (id, store_id, category_id, name, slug, price) VALUES ('${prodBId}', '${storeBId}', '${catBId}', 'Product B', 'prod-b-${Date.now()}', 200000);`
  )
);
const crossStoreImage = run(
  `INSERT INTO product_images (id, store_id, product_id, url) VALUES ('${uid("img_verify2")}', '${storeAId}', '${prodBId}', 'https://example.com/bad.jpg');`
);
check(
  "product_image in store A referencing product of store B is rejected",
  !crossStoreImage.ok,
  crossStoreImage.ok ? "expected failure but insert succeeded" : undefined
);

// ------------------------------------------------------------------
// 3a. Deleting a category that still has a product assigned is RESTRICTed.
//
// NOTE ON DEVIATION: the document specifies ON DELETE SET NULL here, but
// SQLite composite FKs set ALL child key columns to NULL on that action
// (including the NOT NULL store_id), which fails outright. To preserve
// the document's tenant-isolation guarantee (composite FK enforcing
// same-store parent/child), this was changed to ON DELETE RESTRICT — see
// the DEVIATION comment in migrations/0002_phase2_catalog.sql. So deleting
// a category with a product still pointing at it must be BLOCKED, and the
// app must re-categorise or remove the product first.
// ------------------------------------------------------------------
console.log("\n[3a] Deleting a category with an assigned product is RESTRICTed (deviation: SET NULL -> RESTRICT, see migration file)");

const deleteCatAWhileInUse = run(`DELETE FROM categories WHERE id = '${catAId}';`);
check(
  "delete of category A while product A still references it is rejected",
  !deleteCatAWhileInUse.ok,
  deleteCatAWhileInUse.ok ? "expected failure but delete succeeded" : undefined
);

// App-level re-categorise (uncategorise) before delete is allowed.
const uncategoriseProdA = run(
  `UPDATE products SET category_id = NULL WHERE id = '${prodAId}';`
);
mustSucceed("setup: uncategorise product A", uncategoriseProdA);
check("uncategorising product A (category_id = NULL) succeeds", uncategoriseProdA.ok, uncategoriseProdA.error);

const deleteCatAAfterUncategorise = run(`DELETE FROM categories WHERE id = '${catAId}';`);
check(
  "delete of category A succeeds once no product references it",
  deleteCatAAfterUncategorise.ok,
  deleteCatAAfterUncategorise.error
);

const prodAAfterCatDelete = run(
  `SELECT category_id FROM products WHERE id = '${prodAId}';`
);
const prodARowsDebug = rows(prodAAfterCatDelete);
const prodACategoryId = prodARowsDebug.length > 0 ? prodARowsDebug[0].category_id : "MISSING_ROW";
check(
  "product A's category_id is NULL after category A is gone",
  prodAAfterCatDelete.ok && prodARowsDebug.length > 0 && prodACategoryId === null,
  `raw result: ${JSON.stringify(prodAAfterCatDelete.result)}`
);

// ------------------------------------------------------------------
// 3b. Deleting a product deletes its images (CASCADE).
// ------------------------------------------------------------------
console.log("\n[3b] Deleting a product cascades to its product_images");

const deleteProdA = run(`DELETE FROM products WHERE id = '${prodAId}';`);
check("delete of product A succeeds", deleteProdA.ok, deleteProdA.error);

const imgAAfterProdDelete = run(
  `SELECT id FROM product_images WHERE id = '${imgAId}';`
);
check(
  "product A's image row no longer exists",
  imgAAfterProdDelete.ok && rows(imgAAfterProdDelete).length === 0,
  JSON.stringify(rows(imgAAfterProdDelete))
);

// ------------------------------------------------------------------
// 3c. Deleting a store cascades to its categories/products/images.
// ------------------------------------------------------------------
console.log("\n[3c] Deleting a store cascades to its categories, products, and images");

// Rebuild a fresh chain under store B (which already has catB, prodB) plus an image.
const imgBId = uid("img_verify2");
mustSucceed(
  "setup: image B",
  run(
    `INSERT INTO product_images (id, store_id, product_id, url) VALUES ('${imgBId}', '${storeBId}', '${prodBId}', 'https://example.com/b.jpg');`
  )
);

const deleteStoreB = run(`DELETE FROM stores WHERE id = '${storeBId}';`);
check("delete of store B succeeds", deleteStoreB.ok, deleteStoreB.error);

const catBAfter = run(`SELECT id FROM categories WHERE id = '${catBId}';`);
const prodBAfter = run(`SELECT id FROM products WHERE id = '${prodBId}';`);
const imgBAfter = run(`SELECT id FROM product_images WHERE id = '${imgBId}';`);
check(
  "store B's category no longer exists after store delete",
  catBAfter.ok && rows(catBAfter).length === 0,
  JSON.stringify(rows(catBAfter))
);
check(
  "store B's product no longer exists after store delete",
  prodBAfter.ok && rows(prodBAfter).length === 0,
  JSON.stringify(rows(prodBAfter))
);
check(
  "store B's product_image no longer exists after store delete",
  imgBAfter.ok && rows(imgBAfter).length === 0,
  JSON.stringify(rows(imgBAfter))
);

// ------------------------------------------------------------------
// 3d. Self-referencing categories.parent_id RESTRICT (see deviation note).
// ------------------------------------------------------------------
console.log("\n[3d] Deleting a parent category with a child category is RESTRICTed");

const parentCatId = uid("cat_verify2");
const childCatId = uid("cat_verify2");
mustSucceed(
  "setup: parent category",
  run(
    `INSERT INTO categories (id, store_id, name, slug) VALUES ('${parentCatId}', '${storeAId}', 'Parent Cat', 'parent-cat-${Date.now()}');`
  )
);
mustSucceed(
  "setup: child category",
  run(
    `INSERT INTO categories (id, store_id, parent_id, name, slug) VALUES ('${childCatId}', '${storeAId}', '${parentCatId}', 'Child Cat', 'child-cat-${Date.now()}');`
  )
);

const deleteParentWhileChildExists = run(`DELETE FROM categories WHERE id = '${parentCatId}';`);
check(
  "delete of parent category while a child category references it is rejected",
  !deleteParentWhileChildExists.ok,
  deleteParentWhileChildExists.ok ? "expected failure but delete succeeded" : undefined
);

mustSucceed(
  "setup: detach child category",
  run(`UPDATE categories SET parent_id = NULL WHERE id = '${childCatId}';`)
);
const deleteParentAfterDetach = run(`DELETE FROM categories WHERE id = '${parentCatId}';`);
check(
  "delete of parent category succeeds once child is detached",
  deleteParentAfterDetach.ok,
  deleteParentAfterDetach.error
);

// ------------------------------------------------------------------
// 4. Slug uniqueness: per-store unique, cross-store allowed, soft-delete reuse.
// ------------------------------------------------------------------
console.log("\n[4] Slug uniqueness rules (store-scoped, partial for products)");

const dupSlug = `dup-slug-${Date.now()}`;
const prodDup1 = uid("prod_verify2");
const prodDup2 = uid("prod_verify2");
const prodDupOtherStore = uid("prod_verify2");

const insertDup1 = run(
  `INSERT INTO products (id, store_id, name, slug, price) VALUES ('${prodDup1}', '${storeAId}', 'Dup One', '${dupSlug}', 1000);`
);
mustSucceed("setup: first dup-slug product", insertDup1);
check("first product with slug in store A succeeds", insertDup1.ok, insertDup1.error);

const insertDup2 = run(
  `INSERT INTO products (id, store_id, name, slug, price) VALUES ('${prodDup2}', '${storeAId}', 'Dup Two', '${dupSlug}', 2000);`
);
check(
  "duplicate slug in same store (store A) is rejected",
  !insertDup2.ok,
  insertDup2.ok ? "expected failure but insert succeeded" : undefined
);

// storeB was deleted above in test 3c — recreate a store C to prove
// cross-store slug reuse independent of store B's lifecycle.
const userCId = uid("user_verify2");
const storeCId = uid("store_verify2");
mustSucceed(
  "setup: user C",
  run(
    `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${userCId}', '+963900000103', 'c@example.com', 'Owner C', 'hashC');`
  )
);
mustSucceed(
  "setup: store C",
  run(
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('${storeCId}', '${userCId}', 'store-c-${Date.now()}', 'Store C');`
  )
);

const insertDupOtherStore = run(
  `INSERT INTO products (id, store_id, name, slug, price) VALUES ('${prodDupOtherStore}', '${storeCId}', 'Dup Other Store', '${dupSlug}', 3000);`
);
mustSucceed("setup: cross-store dup-slug product", insertDupOtherStore);
check(
  "same slug in a different store (store C) succeeds",
  insertDupOtherStore.ok,
  insertDupOtherStore.error
);

// Soft-delete prodDup1 (store A) and confirm the slug can now be reused
// within store A itself.
const softDeleteDup1 = run(
  `UPDATE products SET deleted_at = '2026-09-15T00:00:00Z' WHERE id = '${prodDup1}';`
);
mustSucceed("setup: soft-delete dup product", softDeleteDup1);
check("soft-delete of product (set deleted_at) succeeds", softDeleteDup1.ok, softDeleteDup1.error);

const prodReuseSlug = uid("prod_verify2");
const insertReuseSlug = run(
  `INSERT INTO products (id, store_id, name, slug, price) VALUES ('${prodReuseSlug}', '${storeAId}', 'Reuses Slug', '${dupSlug}', 4000);`
);
mustSucceed("setup: slug-reuse product", insertReuseSlug);
check(
  "slug of a soft-deleted product can be reused in the same store",
  insertReuseSlug.ok,
  insertReuseSlug.error
);

// ------------------------------------------------------------------
// 5. Retired (soft-deleted) product remains queryable for history.
// ------------------------------------------------------------------
console.log("\n[5] Soft-deleted product remains queryable");

const retiredQuery = run(
  `SELECT id, deleted_at, name FROM products WHERE id = '${prodDup1}';`
);
const retiredRow = rows(retiredQuery)[0];
check(
  "retired product row is still present with deleted_at set",
  retiredQuery.ok && retiredRow && retiredRow.deleted_at === "2026-09-15T00:00:00Z",
  JSON.stringify(retiredRow)
);

// ------------------------------------------------------------------
cleanVerify("phase 2 end");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
