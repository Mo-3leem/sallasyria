import { defineConfig } from "vitest/config";

// Integration suites share ONE local D1 file and assert exact contents, so
// test files must NEVER run in parallel (a parallel file's fixtures would
// pollute another's counts). Single fork = deterministic sequential runs.
// Every suite self-cleans via scripts/clean-verify.mjs regardless.
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    sequence: {
      shuffle: false,
    },
  },
});
