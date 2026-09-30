import { SwaggerUI } from "@hono/swagger-ui";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, Env } from "../env.js";
import { fail } from "../http/respond.js";
import { normalizeDocPaths } from "../openapi/paths.js";
import { AppError } from "../http/errors.js";
import { checkDocsLimit, clientIp } from "../lib/rate-limit.js";

// API documentation surface (Swagger/OpenAPI, manual testing).
// Developer tooling, not production surface (roadmap B9): in production
// both routes answer the normal 404 below, so no document is generated,
// no Swagger HTML is rendered, and no CDN dependency is touched.
// Development, test, and any non-production value keep existing behavior.
// The spec itself is generated from the createRoute() definitions across the
// route files; this module only exposes it. No business logic lives here.
function docsDisabledIn(c: { env?: Partial<Env> }): boolean {
  return (c.env ?? {}).ENVIRONMENT === "production";
}
export function registerDocs(app: OpenAPIHono<AppEnv>): void {
  const config = {
    openapi: "3.1.0" as const,
    info: {
      title: "Salla Syria API",
      version: "1.0.0",
      description:
        "Multi-tenant e-commerce API (Hono + D1). Envelopes: success " +
        "{ok:true,data}, failure {ok:false,error:{code,message}}.",
    },
  };
  // NOTE: generated on each request (not cached) so the document always
  // reflects the registered routes, and so path templates pass through
  // normalizeDocPaths (see src/openapi/paths.ts for why this is required).
  // Abuse guard: regeneration walks every route definition, so bound it
  // generously per IP. The static /ui shell below stays unthrottled.
  app.get("/doc", (c) => {
    // B9 production gate first: identical envelope to unknown routes.
    if (docsDisabledIn(c)) {
      return fail(c, "not_found", "Route does not exist.", 404);
    }
    if (!checkDocsLimit(clientIp(c))) {
      throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
    }
    return c.json(normalizeDocPaths(app.getOpenAPI31Document(config)));
  });
  app.get("/ui", (c) => {
    // B9 production gate: no Swagger render, no CDN dependency touched.
    if (docsDisabledIn(c)) {
      return fail(c, "not_found", "Route does not exist.", 404);
    }
    return c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="Salla Syria API — interactive docs" />
    <title>Salla Syria API</title>
  </head>
  <body>
    ${SwaggerUI({
      url: "/doc",
      docExpansion: "none",
      filter: true,
      defaultModelsExpandDepth: 0,
      defaultModelExpandDepth: 0,
      displayRequestDuration: true,
      deepLinking: true,
    })}
  </body>
</html>`);
  });
}
