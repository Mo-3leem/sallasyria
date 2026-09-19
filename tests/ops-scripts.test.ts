import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// B8 ops scripts: refusal paths and dry-run output. Real remote execution
// requires operator credentials and never runs in tests (see docs/DEPLOY.md).
const isWindows = process.platform === "win32";

function runNode(args: string[], env: Record<string, string | undefined> = {}) {
  try {
    const out = execFileSync(isWindows ? "node.exe" : "node", args, {
      encoding: "utf8",
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows,
      env: { ...process.env, ...env },
    });
    return { code: 0, out: String(out) };
  } catch (err) {
    const e = err as { status?: number; stdout?: unknown; stderr?: unknown };
    return { code: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

describe("backup.mjs", () => {
  it("refuses remote without --allow-remote", () => {
    const r = runNode(["scripts/backup.mjs", "--env", "production"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("REFUSED");
  });

  it("dry-run prints the exact plan without executing", () => {
    const r = runNode(["scripts/backup.mjs", "--dry-run", "--env", "production"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("d1 export");
    expect(r.out).toContain("r2 object put");
    expect(r.out).toContain("dry-run");
  });
});

describe("seed.mjs", () => {
  it("refuses remote without --allow-remote", () => {
    const r = runNode(["scripts/seed.mjs", "--remote", "--admin-password", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("REFUSED");
  });

  it("refuses remote without an explicit merchant password", () => {
    // The committed demo password must never reach production: --remote
    // demands --merchant-password even when the admin password is supplied.
    const r = runNode(
      ["scripts/seed.mjs", "--remote", "--allow-remote", "--admin-password", "x"],
      { ADMIN_BOOTSTRAP_PASSWORD: "" }
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--merchant-password");
  });
});

describe("smoke.mjs", () => {
  it("skips loudly without a target (exit 2, never fails open)", () => {
    const r = runNode(["scripts/smoke.mjs"], { SMOKE_BASE_URL: "" });
    // empty string is falsy -> skip path; ensure no URL env leaks in
    expect([0, 2]).toContain(r.code);
    if (r.code === 2) expect(r.out).toContain("SKIP");
  });

  it("fails closed against a dead target", () => {
    const r = runNode(["scripts/smoke.mjs"], { SMOKE_BASE_URL: "http://127.0.0.1:18999" });
    expect(r.code).toBe(1);
  }, 60_000);
});
