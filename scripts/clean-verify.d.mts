// Type shim for ./clean-verify.mjs (plain JS harness shared with vitest).
// Kept by hand in sync with the .mjs exports; tsc strict requires it.
export interface RunResult {
  ok: boolean;
  result?: unknown[];
  error?: string;
  spawnError?: boolean;
}
export function run(sql: string): RunResult;
export function mustSucceed(label: string, res: RunResult): RunResult;
export function cleanVerify(contextLabel?: string): void;
export function assertCleanVerify(contextLabel?: string): void;
