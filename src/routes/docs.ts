import { SwaggerUI } from "@hono/swagger-ui";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { normalizeDocPaths } from "../openapi/paths.js";

// API documentation surface (Swagger/OpenAPI, manual testing).
// Per explicit approval: mounted in ALL environments (local + production),
// no authentication yet — protecting or disabling it is a post-MVP decision.
// The spec itself is generated from the createRoute() definitions across the
// route files; this module only exposes it. No business logic lives here.
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
  app.get("/doc", (c) => c.json(normalizeDocPaths(app.getOpenAPI31Document(config))));
  app.get("/ui", (c) =>
    c.html(`<!doctype html>
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
</html>`)
  );
}
