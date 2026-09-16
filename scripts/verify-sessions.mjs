// DB-S1 verification script (sessions — server-side auth sessions).
//
// Follows the suite convention (see verify-phase1.mjs): each SQL statement
// runs via `wrangler d1 execute --local --file`. DB-level only: it proves
// what the schema enforces (uniqueness, FK, cascade, representation).
// Expiry/revocation *decisions* live in B2 application queries; here we prove
// the stored state those queries rely on.
//
// Usage: node scripts/verify-sessions.mjs
// Requires: migrations 0001-0005 applied locally.

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
const tmpDir = mkdtempSync(join(tmpdir(), "sallasyria-verifysess-"));
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

// Deterministic fake SHA-256 hex stand-ins (DB level needs uniqueness and
// shape, not real hashes; B2 generates real ones). Random tail keeps reruns
// and parallel runs collision-free.
function fakeHash() {
  return (Math.random().toString(16).slice(2) + "0".repeat(64)).slice(0, 64);
}

function rows(res) {
  return res.result?.[0]?.results ?? [];
}

console.log("Resetting sessions test rows...");
cleanVerify("sessions reset");

// ------------------------------------------------------------------
// Fixture: one user owning all session rows below.
// ------------------------------------------------------------------
const userAId = uid("user_verify");

mustSucceed(
  "setup: session owner",
  run(
    `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${userAId}', '+963900000501', 'sess@example.com', 'Session Owner', 'hashSess');`
  )
);

// ------------------------------------------------------------------
// 1. Session row creation succeeds.
// ------------------------------------------------------------------
console.log("\n[1] Session row creation");

const sessAId = uid("sess_verify");
const hashA = fakeHash();
const insertSessA = run(
  `INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ('${sessAId}', '${userAId}', '${hashA}', '2099-01-01T00:00:00Z');`
);
mustSucceed("setup: live session row", insertSessA);
check("session row creation succeeds", insertSessA.ok, insertSessA.error);

// ------------------------------------------------------------------
// 2. token_hash uniqueness: the same hash twice is rejected, so one token
//    can never resolve to two sessions/users.
// ------------------------------------------------------------------
console.log("\n[2] token_hash uniqueness");

const dupHash = run(
  `INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ('${uid("sess_verify")}', '${userAId}', '${hashA}', '2099-01-01T00:00:00Z');`
);
check(
  "duplicate token_hash is rejected",
  !dupHash.ok,
  dupHash.ok ? "expected failure but insert succeeded" : undefined
);

// ------------------------------------------------------------------
// 3. Sessions reference a real user (FK enforced).
// ------------------------------------------------------------------
console.log("\n[3] user/session FK");

const ghostSess = run(
  `INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ('${uid("sess_verify")}', 'nonexistent_user_id', '${fakeHash()}', '2099-01-01T00:00:00Z');`
);
check(
  "session for a nonexistent user is rejected",
  !ghostSess.ok,
  ghostSess.ok ? "expected failure but insert succeeded" : undefined
);

// ------------------------------------------------------------------
// 4. Expiry is stored state: an already-expired row inserts fine (the DB
//    does not police the clock — B2 queries do), and it is identifiable
//    as expired by the exact predicate B2 will use.
// ------------------------------------------------------------------
console.log("\n[4] Expiry representation");

const sessExpiredId = uid("sess_verify");
const insertExpired = run(
  `INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ('${sessExpiredId}', '${userAId}', '${fakeHash()}', '2020-01-01T00:00:00Z');`
);
mustSucceed("setup: expired session row", insertExpired);
check("already-expired session row inserts (clock policed by app)", insertExpired.ok, insertExpired.error);

const expiredRows = rows(
  run(
    `SELECT id FROM sessions WHERE user_id = '${userAId}' AND expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now');`
  )
);
check(
  "expired row is identifiable by the B2 expiry predicate",
  expiredRows.some((r) => r.id === sessExpiredId),
  JSON.stringify(expiredRows.map((r) => r.id))
);

// ------------------------------------------------------------------
// 5. Revocation preserves the row with revoked_at set (audit, not erase).
// ------------------------------------------------------------------
console.log("\n[5] Revocation representation");

const revokeRes = run(
  `UPDATE sessions SET revoked_at = '2026-09-15T00:00:00Z' WHERE id = '${sessExpiredId}';`
);
mustSucceed("setup: revoke expired session", revokeRes);
const revokedRow = rows(
  run(`SELECT id, revoked_at FROM sessions WHERE id = '${sessExpiredId}';`)
)[0];
check(
  "revoked session row is preserved with revoked_at set",
  revokedRow && revokedRow.revoked_at === "2026-09-15T00:00:00Z",
  JSON.stringify(revokedRow)
);

// ------------------------------------------------------------------
// 6. Deleting a user cascades its sessions (fail-closed offboarding).
// ------------------------------------------------------------------
console.log("\n[6] User delete cascades sessions");

const userBId = uid("user_verify");
const sessBId = uid("sess_verify");
mustSucceed(
  "setup: second user",
  run(
    `INSERT INTO users (id, phone, email, name, password_hash) VALUES ('${userBId}', '+963900000502', 'sessb@example.com', 'Session Owner B', 'hashSessB');`
  )
);
mustSucceed(
  "setup: second user's session",
  run(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ('${sessBId}', '${userBId}', '${fakeHash()}', '2099-01-01T00:00:00Z');`
  )
);
const deleteUserB = run(`DELETE FROM users WHERE id = '${userBId}';`);
check("delete of user with sessions succeeds", deleteUserB.ok, deleteUserB.error);
const sessBAfter = run(`SELECT id FROM sessions WHERE id = '${sessBId}';`);
check(
  "deleted user's session row is gone (CASCADE, no orphan)",
  sessBAfter.ok && rows(sessBAfter).length === 0,
  JSON.stringify(rows(sessBAfter))
);

// ------------------------------------------------------------------
// 7. Lookup by hash returns exactly its owner; unknown hash returns none
//    (no cross-user confusion at read level).
// ------------------------------------------------------------------
console.log("\n[7] Hash lookup returns exactly its owner");

const ownerRows = rows(
  run(`SELECT user_id FROM sessions WHERE token_hash = '${hashA}';`)
);
check(
  "token_hash lookup returns exactly the owning user",
  ownerRows.length === 1 && ownerRows[0].user_id === userAId,
  JSON.stringify(ownerRows)
);

const unknownRows = rows(
  run(`SELECT user_id FROM sessions WHERE token_hash = '${"f".repeat(64)}';`)
);
check(
  "unknown token_hash returns zero rows",
  unknownRows.length === 0,
  JSON.stringify(unknownRows)
);

// ------------------------------------------------------------------
cleanVerify("sessions end");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
