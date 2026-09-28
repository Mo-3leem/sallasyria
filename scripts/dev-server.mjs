// Shared `wrangler dev` lifecycle for integration suites.
//
// Why this file exists: every integration suite spawns its own workerd on a
// fixed port against the SAME local D1 file (see vitest.config.mts — files
// run sequentially, never parallel). Two harness flaws combined into silent
// wrong-server testing:
//   1. Duplicate hardcoded ports (previously 18882/18884/18889 shared by two
//      files each): a leaked server from an earlier file holds the port.
//   2. `server.kill("SIGTERM")` on Linux signals only the `npx` wrapper, not
//      the wrangler/workerd tree (Windows `taskkill /T /F` kills the tree,
//      which is why this only ever failed on Linux CI).
// The next suite's spawn then died with EADDRINUSE while `waitForHealth`
// attached to the orphan — same shared D1, so seeds/logins worked, but the
// worker env differed (e.g. missing ADMIN_BOOTSTRAP_PASSWORD).
//
// Rules enforced here:
//   - Unix spawns are process-group leaders (detached), so stopDevServer can
//     signal the WHOLE tree, mirroring Windows taskkill /T /F.
//   - waitForHealthy fails fast when the child exits during boot (EADDRINUSE
//     surfaces here loudly with the server tail, instead of silently testing
//     whatever happens to answer /health on the port).
//   - No external tools: node builtins only (available on GitHub Actions).

import { execFileSync, spawn } from "node:child_process";

const isWindows = process.platform === "win32";

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function spawnDevServer(port, onData, opts = {}) {
  const server = spawn(isWindows ? "npx.cmd" : "npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", ...(opts.args ?? [])], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
    windowsHide: true,
    ...(opts.env ? { env: opts.env } : {}),
    // Process-group leader on unix so stopDevServer can signal the entire
    // wrangler/workerd tree, not just the npx wrapper. Windows keeps the
    // proven taskkill /T /F path, which needs no detached group.
    detached: !isWindows,
  });
  server.stdout?.on("data", (d) => onData(String(d)));
  server.stderr?.on("data", (d) => onData(String(d)));
  return server;
}

export async function waitForHealthy(base, getServer, getOutput, deadlineMs = 120_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const server = getServer();
    // Fail fast: a dead child during boot means the port never bound
    // (EADDRINUSE from a leaked server). Never fall through to testing
    // whichever foreign server answers /health on the port.
    if (server && server.exitCode !== null) {
      throw new Error(`dev server exited during boot (port in use?)\n${getOutput().slice(-3000)}`);
    }
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`dev server never ready\n${getOutput().slice(-3000)}`);
}

export function stopDevServer(server) {
  if (!server || server.exitCode !== null) return;
  try {
    if (isWindows) {
      if (server.pid !== undefined) {
        execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      }
    } else if (server.pid !== undefined) {
      // Signal the whole process group (spawned detached above).
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        server.kill("SIGTERM");
      }
      sleepMs(500);
      if (server.exitCode === null) {
        try {
          process.kill(-server.pid, "SIGKILL");
        } catch { /* already gone */ }
      }
    } else {
      server.kill("SIGTERM");
    }
  } catch { /* best effort */ }
}
