import { defineConfig, devices } from "@playwright/test";

// B14-c E2E smoke (Chromium only): real Next.js production server against a
// real local workerd backend. Servers are started per spec file (see
// e2e/helpers.mjs) rather than via webServer, mirroring the explicit
// lifecycle of scripts/dev-server.mjs. Files run serially: every suite
// shares ONE local D1 file, so parallel browsers would cross-contaminate
// fixtures (same reason vitest.config.mts sets maxWorkers: 1).
//
// Prerequisites before `npm run test:e2e`:
//   npm run db:migrate:local && npm run build --prefix frontend
// Guest-checkout specs additionally need the E2E frontend build (opt-in
// Turnstile gate documented in frontend/.env.example):
//   NEXT_PUBLIC_E2E_ALLOW_MISSING_TURNSTILE=1 npm run build --prefix frontend
export default defineConfig({
  testDir: "./e2e",
  // 180s: file-level hooks boot `wrangler dev` + `next start` and run the D1
  // reset (~20 sequential `wrangler d1 execute` calls, ~3s each on Windows).
  // Hook timeouts derive from this value; the in-test assertions stay fast.
  timeout: 180_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  fullyParallel: false,
  use: {
    // localhost (not 127.0.0.1): the backend CSRF gate compares Origin
    // hostname to request hostname, and the baked Next rewrite targets
    // localhost:8787 — a 127.0.0.1 browser origin would 403 every mutation.
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  outputDir: "test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
});
