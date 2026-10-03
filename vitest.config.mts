import { defineConfig, defaultExclude } from "vitest/config";

// Integration suites share ONE local D1 file and assert exact contents, so
// test files must NEVER run in parallel (parallel dev servers kill each
// other fighting over the same SQLite file, and fixtures cross-contaminate).
// maxWorkers: 1 serializes files deterministically. Every suite self-cleans
// via scripts/clean-verify.mjs regardless.
//
// History: this was once `poolOptions.forks.singleFork`, which Vitest 4+
// silently ignores (poolOptions removed) — the suite then ran parallel and
// died with SQLITE_BUSY boot fatalities. If this file ever stops serializing
// (check for parallel "Starting local server" lines), fix THIS file first.
export default defineConfig({
  test: {
    pool: "forks",
    maxWorkers: 1,
    sequence: {
      shuffle: false,
    },
    // e2e/** holds Playwright specs (run via `npm run test:e2e`), not
    // Vitest suites — without this, the default include pattern collects
    // them and every file fails with "Playwright Test did not expect
    // test.beforeAll()". defaultExclude keeps the stock ignores intact.
    exclude: [...defaultExclude, "e2e/**"],
  },
});
