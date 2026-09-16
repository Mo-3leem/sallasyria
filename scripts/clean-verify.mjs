// Shared cleanup + setup-guard for the Salla Syria D1 verification suite.
//
// Every verify-*.mjs script imports cleanVerify() and mustSucceed() from here
// instead of hand-rolling its own reset logic.
//
// Why this file exists (adversarial bug-hunt findings):
//  1. Per-script resets used LIKE 'store_verify_%' where '_' is a SQL
//     wildcard, so one phase's reset matched other phases' fixtures
//     (e.g. 'store_verify4_...' matches 'store_verify_%').
//  2. Resets ignored statement errors silently, so a blocked delete left
//     stale rows behind that poisoned later runs (fixed emails/phones then
//     collided with UNIQUE constraints).
//  3. Scripts left fixtures behind (e.g. Phase 4 never deletes store B's
//     order), so runs were not repeatable without manual cleanup.
//
// Rules enforced here:
//  - Literal-underscore matching (ESCAPE '\') over every known test prefix,
//    so namespaces cannot interfere and nothing outside test prefixes is
//    ever touched.
//  - Deletes run strictly child-before-parent to respect RESTRICT FKs.
//  - Every statement is checked; any failure aborts loudly (exit 1).
//  - A final count query proves zero test rows remain.
//
// DO NOT run two verify scripts in parallel: cleanup is global by design.
//
// Usage from a verify script:
//   import { cleanVerify, mustSucceed } from "./clean-verify.mjs";
//   cleanVerify("phase N reset");   // throws/exits loudly on failure
//   mustSucceed("fixture: store A", run(`INSERT INTO stores ...`));
//
// Standalone: node scripts/clean-verify.mjs

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const DB = "sallasyria-db";

const isWindows = process.platform === "win32";
const npxCmd = isWindows ? "npx.cmd" : "npx";
const tmpDir = mkdtempSync(join(tmpdir(), "sallasyria-clean-"));
let fileCounter = 0;

const TRANSIENT_CLEANUP_RE = /SQLITE_BUSY|database is locked|internal error|ECONNRESET|fetch failed|workerd/i;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function run(sql) {
  const filePath = join(tmpDir, `clean_${fileCounter++}.sql`);
  writeFileSync(filePath, sql, "utf8");
  const args = ["wrangler", "d1", "execute", DB, "--local", "--json", "--file", filePath];
  let lastError;
  // Cleanup statements are idempotent deletes: safe to retry a few times on
  // the known-transient local-D1 faults (busy locks, workerd hiccups).
  // Anything else — especially constraint errors — fails immediately and
  // loudly, exactly as before.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = execFileSync(npxCmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: isWindows,
      });
      const parsed = JSON.parse(out);
      const success = Array.isArray(parsed) && parsed.every((r) => r.success);
      if (success) return { ok: true, result: parsed, error: undefined };
      lastError = JSON.stringify(parsed);
      return { ok: false, result: parsed, error: lastError };
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString() : "";
      const stdout = err.stdout ? err.stdout.toString() : "";
      lastError = stderr || stdout || err.message;
      if (!TRANSIENT_CLEANUP_RE.test(String(lastError))) {
        return { ok: false, error: lastError, spawnError: true };
      }
      sleepMs(500 * (attempt + 1));
    }
  }
  return { ok: false, error: lastError, spawnError: true };
}

// Guard for required setup operations: a failed setup must NEVER let a later
// rejection/deletion/cascade assertion pass vacuously. Aborts loudly.
export function mustSucceed(label, res) {
  if (!res || !res.ok) {
    console.error(`  SETUP FAIL  ${label}`);
    if (res && res.error) console.error(`        ${res.error}`);
    process.exit(1);
  }
  return res;
}

// Every test namespace ever used by the suite. '_' is escaped so matching is
// literal: 'store_verify%' (escaped) matches store_verify, store_verify2/3/4
// fixtures, and nothing else.
const STORE_PREFIXES = ["store\\_verify%", "store\\_bughunt%", "store\\_adv\\_%"];
const ID_PREFIXES = {
  stores: ["store\\_verify%", "store\\_bughunt%", "store\\_adv\\_%"],
  users: ["user\\_verify%", "user\\_bughunt%", "user\\_adv\\_%"],
  plans: ["plan\\_verify%", "plan\\_adv\\_%"],
};

function orLike(column, patterns) {
  return patterns.map((p) => `${column} LIKE '${p}' ESCAPE '\\'`).join(" OR ");
}

// Child-before-parent: RESTRICT FKs (subscriptions/orders/items holders,
// users-with-stores) must have their dependents removed first, otherwise the
// delete is blocked and stale rows survive.
const DELETE_ORDER = [
  ["sessions", "user_id"],
  ["idempotency_keys", "store_id"],
  ["order_items", "store_id"],
  ["orders", "store_id"],
  ["product_images", "store_id"],
  ["products", "store_id"],
  // Child categories BEFORE parents: the self-referencing composite FK is
  // RESTRICT with immediate enforcement, so one bulk DELETE containing both a
  // parent and its child fails (parent deleted while the child row still
  // exists) — as does a store-level CASCADE into such a pair. Leaf-first,
  // then the remainder. See audit finding on b4c residue.
  ["categories:children", "parent"],
  ["categories", "store_id"],
  ["customer_addresses", "store_id"],
  ["customers", "store_id"],
  ["shipping_rates", "store_id"],
  ["subscriptions", "store_id"],
  ["stores", "id"],
  ["plans", "id"],
  ["users", "id"],
];

function patternsFor(table) {
  if (table === "stores") return ID_PREFIXES.stores;
  if (table === "users" || table === "sessions") return ID_PREFIXES.users;
  if (table === "plans") return ID_PREFIXES.plans;
  return STORE_PREFIXES;
}

export function cleanVerify(contextLabel = "cleanup") {
  try {
    assertCleanVerify(contextLabel);
  } catch (err) {
    console.error(`CLEANUP FAIL (${contextLabel}):`);
    console.error(`  - ${(err && err.message) || err}`);
    process.exit(1);
  }
  console.log(`Cleanup clean (${contextLabel}): ${DELETE_ORDER.length} deletes ok, 0 test rows remain.`);
}

// Same guarantees as cleanVerify(), but THROWS instead of process.exit() so
// vitest integration suites can use it: a failed cleanup fails the test
// loudly instead of killing the worker (and, worse, instead of passing
// silently and poisoning later assertions with stale rows).
export function assertCleanVerify(contextLabel = "cleanup") {
  const failures = tryCleanVerify();
  if (failures.length > 0) {
    throw new Error(`cleanup failed (${contextLabel}): ${failures.join(" | ")}`);
  }
}

function tryCleanVerify() {
  const failures = [];
  for (const [table, column] of DELETE_ORDER) {
    // "categories:children" is a pseudo-entry (see DELETE_ORDER comment):
    // same table, leaf-first predicate.
    const realTable = table === "categories:children" ? "categories" : table;
    const where =
      table === "categories:children"
        ? `parent_id IS NOT NULL AND (${orLike("store_id", patternsFor("categories"))})`
        : orLike(column, patternsFor(table));
    const res = run(`DELETE FROM ${realTable} WHERE ${where};`);
    if (!res.ok) failures.push(`${realTable}: ${res.error}`);
  }
  // Prove nothing test-owned remains: any store/user/plan/session row under
  // a test prefix after the deletes above means cleanup did not converge.
  // (Sessions are user-keyed; the users check plus this one cover them.)
  const leftoverStores = run(
    `SELECT id FROM stores WHERE ${orLike("id", patternsFor("stores"))};`
  );
  const leftoverUsers = run(
    `SELECT id FROM users WHERE ${orLike("id", patternsFor("users"))};`
  );
  const leftoverPlans = run(
    `SELECT id FROM plans WHERE ${orLike("id", patternsFor("plans"))};`
  );
  const leftoverSessions = run(
    `SELECT id FROM sessions WHERE ${orLike("user_id", patternsFor("sessions"))};`
  );
  for (const [label, res] of [
    ["stores", leftoverStores],
    ["users", leftoverUsers],
    ["plans", leftoverPlans],
    ["sessions", leftoverSessions],
  ]) {
    if (!res.ok) {
      failures.push(`leftover check (${label}): ${res.error}`);
    } else {
      const rows = res.result?.[0]?.results ?? [];
      if (rows.length > 0) {
        failures.push(
          `leftover check (${label}): ${rows.length} test row(s) still present, e.g. ${rows[0].id}`
        );
      }
    }
  }
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  cleanVerify("standalone");
}
