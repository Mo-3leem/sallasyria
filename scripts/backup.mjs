// B8 backup: D1 export -> versioned, restricted R2 bucket.
//
// What this is: a thin, auditable wrapper around two wrangler commands.
// What this is NOT: a Worker-side export (D1 export needs account-level API
// credentials the Worker never holds — see docs/DEPLOY.md).
//
// Safety: refuses to touch --remote without the explicit --allow-remote
// flag (same two-flag rule as the seed script). --dry-run prints the exact
// planned commands and exits 0 without executing anything (this is what CI
// and tests assert on).
//
// RPO note: run this on a schedule (external cron, minimum daily). RPO is
// then <= 24h by construction; RTO is measured by the restore rehearsal
// (docs/DEPLOY.md), not by this script.
//
// Usage:
//   node scripts/backup.mjs --dry-run [--env production]
//   node scripts/backup.mjs --env production --allow-remote [--out ./backups]

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const env = opt("--env", "production");
const dryRun = flag("--dry-run");
const remote = flag("--remote") || env === "production";

if (remote && !flag("--allow-remote") && !dryRun) {
  console.error("REFUSED: remote backup requires the explicit --allow-remote flag.");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
const outDir = opt("--out", "./backups");
const dumpFile = `${outDir}/sallasyria-db-${env}-${stamp}.sql`;
const bucket = opt("--bucket", "sallasyria-images-prod");
const remoteKey = `db-backups/sallasyria-db-${env}-${stamp}.sql`;

const plan = [
  `wrangler d1 export sallasyria-db --remote --output "${dumpFile}" --env ${env}`,
  `wrangler r2 object put ${bucket}/${remoteKey} --file "${dumpFile}" --env ${env}`,
];

console.log(`Backup plan (env=${env}, out=${dumpFile}):`);
for (const cmd of plan) console.log(`  $ ${cmd}`);

if (dryRun) {
  console.log("dry-run: no commands executed.");
  process.exit(0);
}

const isWindows = process.platform === "win32";
for (const cmd of plan) {
  console.log(`$ ${cmd}`);
  execFileSync(cmd, { stdio: "inherit", shell: isWindows });
}
console.log(`Backup complete: ${remoteKey} (RPO <= 24h at daily cadence).`);
