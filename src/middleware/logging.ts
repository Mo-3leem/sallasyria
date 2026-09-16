import type { Context, Next } from "hono";
import type { AppEnv } from "../env.js";

// Minimal access log embodying the binding logging policy: method, pathname,
// status, duration. NEVER query strings (may carry phones/tokens), headers
// (cookies/auth), or bodies. Emitted via console.log (Workers Logs).
export async function accessLog(c: Context<AppEnv>, next: Next): Promise<void> {
  const started = Date.now();
  await next();
  const pathname = new URL(c.req.url).pathname;
  console.log(
    `${c.req.method} ${pathname} -> ${c.res.status} (${Date.now() - started}ms)`
  );
}
