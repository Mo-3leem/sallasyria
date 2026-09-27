// Type shim for ./dev-server.mjs (plain JS harness shared with vitest).
// Kept by hand in sync with the .mjs exports; tsc strict requires it.
import type { ChildProcess } from "node:child_process";
export interface SpawnOpts {
  args?: string[];
  env?: NodeJS.ProcessEnv;
}
export function spawnDevServer(port: number, onData: (d: string) => void, opts?: SpawnOpts): ChildProcess;
export function waitForHealthy(
  base: string,
  getServer: () => ChildProcess | null,
  getOutput: () => string,
  deadlineMs?: number
): Promise<void>;
export function stopDevServer(server: ChildProcess | null): void;
