import { defineConfig } from "vitest/config";

// Frontend unit tests (roadmap B14): pure-logic specs only (no DOM).
// Node environment, colocated `src/**/*.test.ts`. Hook/component tests
// need jsdom + Testing Library and are explicitly out of scope here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
