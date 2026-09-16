import { createApp } from "./app.js";
import type { Env } from "./env.js";
import { runScheduledMaintenance } from "./services/maintenance.js";

const app = createApp();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
  // Production cron entrypoint (wired via wrangler.jsonc triggers in B8):
  // retention purges only. Backup exports run outside the Worker (B8 runbook)
  // because D1 export needs account-level API credentials the Worker never holds.
  scheduled: async (_event: ScheduledEvent, env: Env) => {
    await runScheduledMaintenance(env);
  },
};
