// B14-c E2E lifecycle: real local workerd backend + real Next.js production
// frontend against the shared local D1 file.
//
// Ports are deterministic: backend 8787 (must match the baked frontend
// rewrite — see E2E_BACKEND_PORT below), frontend 3000 (matches
// playwright.config.ts baseURL). 8787 collides with no vitest integration
// port (18877-18910). Files run serially (workers: 1), one lifecycle per
// spec file.
//
// Prerequisites before use (same as playwright.config.ts):
//   npm run db:migrate:local && npm run build --prefix frontend
// (guest-checkout specs need the E2E build flag documented there).
// The build is NOT run here: `next start` needs the prebuilt `.next`
// directory, and rebuilding per spec file would be slow and flaky.
import { execFileSync } from "node:child_process";
import {
  spawnDevServer,
  stopDevServer,
  waitForHealthy,
} from "../scripts/dev-server.mjs";
import {
  spawnFrontendServer,
  stopFrontendServer,
  waitForFrontendReady,
} from "../scripts/frontend-server.mjs";
import { E2E_MERCHANT, resetE2EFixtures, seedE2EMerchant } from "./fixtures.mjs";

// Backend MUST be 8787: the committed frontend production build bakes the
// Next rewrite `/api/backend/* -> http://localhost:8787/*` into
// .next/routes-manifest.json at BUILD time — `next start` never re-reads
// next.config.js, so start-time env cannot repoint it. 8787 collides with
// nothing: vitest integration suites use 18877-18910, the frontend uses 3000
// (matching playwright.config.ts baseURL).
export const E2E_BACKEND_PORT = 8787;
export const E2E_FRONTEND_PORT = 3000;
export const E2E_BACKEND_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}`;
export const E2E_FRONTEND_BASE = `http://localhost:${E2E_FRONTEND_PORT}`;

const isWindows = process.platform === "win32";

function migrateLocalD1() {
  try {
    execFileSync(
      isWindows ? "npx.cmd" : "npx",
      ["wrangler", "d1", "migrations", "apply", "sallasyria-db", "--local"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: isWindows,
      }
    );
  } catch (err) {
    const out =
      (err?.stderr ? String(err.stderr) : "") +
      (err?.stdout ? String(err.stdout) : "") +
      (err?.message ? String(err.message) : String(err));
    throw new Error(`e2e migrate failed\n${out.slice(-3000)}`);
  }
}

// Smallest clean API the J1/J2 specs need. `seed: false` skips the merchant
// fixture (J1 bootstrap needs no login); the D1 migrate + global reset still
// run so every spec starts from a known-clean database.
//
// Timeout-abandonment safety: pass a caller-owned `holder` object and it is
// populated incrementally — `holder.stop` is set before anything spawns, and
// `holder.backend` / `holder.frontend` right after each spawn. If the
// Playwright `beforeAll` hook times out while this promise is still pending,
// `afterAll` still owns the holder and `stopE2E(holder)` stops whatever has
// already started. All mutations below are synchronous between awaits, so no
// interleaving can publish a stale handle.
export async function startE2E({ seed = true } = {}, holder = null) {
  let backend = null;
  let frontend = null;
  let backendOutput = "";
  let frontendOutput = "";
  const stop = () => {
    // Frontend first, backend second: the proxy must go down before the API.
    stopFrontendServer(frontend);
    frontend = null;
    stopDevServer(backend);
    backend = null;
    if (holder) {
      holder.backend = null;
      holder.frontend = null;
    }
  };
  const publish = () => {
    if (holder) {
      holder.stop = stop;
      holder.backend = backend;
      holder.frontend = frontend;
    }
  };
  publish();

  try {
    migrateLocalD1();
    resetE2EFixtures("e2e reset");

    backend = spawnDevServer(E2E_BACKEND_PORT, (d) => {
      backendOutput += d;
    });
    publish();
    await waitForHealthy(
      E2E_BACKEND_BASE,
      () => backend,
      () => backendOutput
    );

    // NEXT_PUBLIC_API_URL is passed for documentation/future rebuilds, but
    // note it does NOT repoint the baked rewrite above — only a frontend
    // rebuild with a different env would. spawnFrontendServer merges it
    // over process.env (PATH preserved).
    frontend = spawnFrontendServer(
      E2E_FRONTEND_PORT,
      (d) => {
        frontendOutput += d;
      },
      { env: { NEXT_PUBLIC_API_URL: E2E_BACKEND_BASE } }
    );
    publish();
    await waitForFrontendReady(
      E2E_FRONTEND_BASE,
      () => frontend,
      () => frontendOutput
    );

    let merchant = null;
    if (seed) {
      await seedE2EMerchant(E2E_BACKEND_BASE);
      merchant = { ...E2E_MERCHANT };
    }
    return {
      backend: () => backend,
      frontend: () => frontend,
      apiBase: E2E_BACKEND_BASE,
      webBase: E2E_FRONTEND_BASE,
      merchant,
      stop,
      output: () => ({ backendOutput, frontendOutput }),
    };
  } catch (err) {
    stop();
    throw err;
  }
}

export async function stopE2E(ctx) {
  if (!ctx) return;
  try {
    // Preferred path: the stop closure owns live handles (works even when
    // startE2E never returned — the holder was published incrementally).
    if (typeof ctx.stop === "function") {
      ctx.stop();
      return;
    }
    // Fallback: raw handles (also tolerates a holder whose stop was never
    // published because migrate/reset threw first — both are null there).
    stopFrontendServer(ctx.frontend ?? null);
    stopDevServer(ctx.backend ?? null);
  } catch {
    // Best effort: never mask the spec result with a teardown throw.
  }
}
