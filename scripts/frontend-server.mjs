// Frontend production server lifecycle for E2E smoke (B14-c), sibling of
// dev-server.mjs (backend workerd). Runs `next start` against a PRE-BUILT
// frontend — build first with `npm run build --prefix frontend`; never
// `next dev` (slow boot, non-production behavior).
//
// Same process discipline as dev-server.mjs: detached unix process group /
// Windows taskkill tree via stopFrontendServer below, fail-fast boot
// detection, node builtins only (available on GitHub Actions).
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";

const isWindows = process.platform === "win32";

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function spawnFrontendServer(port, onData, opts = {}) {
  // Unambiguous production invocation: `next start -p <port>` with the
  // frontend directory as cwd. This avoids relying on npm argument
  // forwarding through `npm run start --prefix frontend -- -p ...`.
  const server = spawn(
    isWindows ? "npx.cmd" : "npx",
    ["next", "start", "-p", String(port)],
    {
      cwd: join(process.cwd(), "frontend"),
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows,
      windowsHide: true,
      env: { ...process.env, ...(opts.env ?? {}) },
      detached: !isWindows,
    }
  );
  server.stdout?.on("data", (d) => onData(String(d)));
  server.stderr?.on("data", (d) => onData(String(d)));
  return server;
}

export async function waitForFrontendReady(base, getServer, getOutput, deadlineMs = 120_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const server = getServer();
    // Fail fast: a dead child during boot means the port never bound.
    if (server && server.exitCode !== null) {
      throw new Error(`frontend server exited during boot\n${getOutput().slice(-3000)}`);
    }
    try {
      // Tolerate redirects (e.g. `/` -> locale/auth redirect): any response
      // below 400 proves the Next production server is up. 4xx/5xx are NOT
      // accepted as ready — a misbuilt page must fail loudly, not pass.
      const r = await fetch(`${base}/`, { redirect: "manual" });
      if (r.status < 400) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`frontend server never ready\n${getOutput().slice(-3000)}`);
}

export function stopFrontendServer(server) {
  if (!server || server.exitCode !== null) return;
  try {
    if (isWindows) {
      if (server.pid !== undefined) {
        execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      }
    } else if (server.pid !== undefined) {
      // Signal the whole process group (spawned detached above), mirroring
      // stopDevServer: kills the npx wrapper AND the next-server tree.
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
