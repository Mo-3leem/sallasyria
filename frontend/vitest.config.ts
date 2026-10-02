import { defineConfig } from "vitest/config";

// Frontend unit tests (roadmap B14): pure-logic specs on Node by default,
// DOM specs opt in per file. JSX specs need the .tsx suffix, so discovery
// uses the standard Vitest pattern rather than *.test.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  },
  // The repo tsconfig sets jsx: preserve for Next.js. Tests run through
  // esbuild instead, so force the automatic runtime here; production
  // builds are unaffected (Next.js handles its own transform).
  esbuild: {
    jsx: "automatic",
  },
});
