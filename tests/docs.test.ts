import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

// OpenAPI surface tests: the /doc document must stay a valid, complete
// contract, and /ui must render the Swagger shell. If a route is added or
// renamed without createRoute() documentation, the endpoint-count assertion
// below fails loudly instead of letting docs drift silently.
describe("OpenAPI docs", () => {
  it("GET /doc returns a valid OpenAPI 3.1 document", async () => {
    const res = await createApp().request("/doc");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components?: { schemas?: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(typeof doc.paths).toBe("object");
  });

  it("documents every API endpoint (no silent drift)", async () => {
    const res = await createApp().request("/doc");
    const doc = (await res.json()) as { paths: Record<string, Record<string, unknown>> };
    const documented = new Set<string>();
    for (const [path, ops] of Object.entries(doc.paths)) {
      // The generator is inconsistent: own-router params stay ":id" while
      // merged mount prefixes become "{storeId}". Normalize both to braces
      // so the assertion tracks routes, not formatter quirks.
      const normal = path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      for (const method of Object.keys(ops)) {
        documented.add(`${method.toUpperCase()} ${normal}`);
      }
    }
    // One entry per route in src/routes (health 2, auth 14, stores 5,
    // categories 5, products 7, product-images 8, customers 5,
    // customer-addresses 6, shipping-rates 5, checkout 1, orders 4,
    // admin 11, plans 1, buyer 22).
    const expected = [
      "GET /health",
      "GET /ready",
      "POST /auth/register",
      "POST /auth/verify-email",
      "POST /auth/resend-verification",
      "POST /auth/forgot-password",
      "POST /auth/reset-password",
      "POST /auth/login",
      "POST /auth/logout",
      "POST /auth/logout-others",
      "GET /auth/me",
      "PATCH /auth/me",
      "POST /auth/me/avatar",
      "DELETE /auth/me/avatar",
      "GET /auth/avatar/file/{key}",
      "POST /auth/change-password",
      "GET /stores",
      "POST /stores",
      "GET /stores/by-slug/{slug}",
      "GET /stores/{storeId}/catalog/store",
      "GET /stores/{storeId}/catalog/categories",
      "GET /stores/{storeId}/catalog/products",
      "GET /stores/{storeId}/theme",
      "PATCH /stores/{storeId}/theme",
      "POST /stores/{storeId}/theme/publish",
      "POST /stores/{storeId}/theme/preview",
      "GET /s/preview/{token}",
      "GET /stores/{storeId}",
      "PATCH /stores/{storeId}",
      "POST /stores/{storeId}/publish",
      "POST /stores/{storeId}/subscriptions/checkout",
      "GET /stores/{storeId}/subscriptions",
      "GET /stores/{storeId}/billing/intents",
      "GET /stores/{storeId}/billing/intents/{id}",
      "GET /stores/{storeId}/categories",
      "GET /stores/{storeId}/categories/{id}",
      "POST /stores/{storeId}/categories",
      "PATCH /stores/{storeId}/categories/{id}",
      "DELETE /stores/{storeId}/categories/{id}",
      "GET /stores/{storeId}/products",
      "GET /stores/{storeId}/products/{id}",
      "POST /stores/{storeId}/products",
      "PATCH /stores/{storeId}/products/{id}",
      "DELETE /stores/{storeId}/products/{id}",
      "POST /stores/{storeId}/products/{id}/restore",
      "POST /stores/{storeId}/products/{id}/delete",
      "GET /stores/{storeId}/product-images",
      "GET /stores/{storeId}/product-images/file/{key}",
      "GET /stores/{storeId}/product-images/{id}",
      "POST /stores/{storeId}/product-images",
      "PATCH /stores/{storeId}/product-images/{id}",
      "DELETE /stores/{storeId}/product-images/{id}",
      "POST /stores/{storeId}/product-images/{id}/restore",
      "POST /stores/{storeId}/product-images/upload",
      "GET /stores/{storeId}/customers",
      "GET /stores/{storeId}/customers/{id}",
      "POST /stores/{storeId}/customers",
      "PATCH /stores/{storeId}/customers/{id}",
      "DELETE /stores/{storeId}/customers/{id}",
      "GET /stores/{storeId}/customer-addresses",
      "GET /stores/{storeId}/customer-addresses/{id}",
      "POST /stores/{storeId}/customer-addresses",
      "PATCH /stores/{storeId}/customer-addresses/{id}",
      "DELETE /stores/{storeId}/customer-addresses/{id}",
      "POST /stores/{storeId}/customer-addresses/{id}/make-default",
      "GET /stores/{storeId}/shipping-rates",
      "GET /stores/{storeId}/shipping-rates/{id}",
      "POST /stores/{storeId}/shipping-rates",
      "PATCH /stores/{storeId}/shipping-rates/{id}",
      "DELETE /stores/{storeId}/shipping-rates/{id}",
      "POST /stores/{storeId}/checkout",
      "GET /stores/{storeId}/orders",
      "GET /stores/{storeId}/orders/{id}",
      "PATCH /stores/{storeId}/orders/{id}/status",
      "PATCH /stores/{storeId}/orders/{id}/payment",
      "GET /admin/subscriptions",
      "GET /admin/subscriptions/{id}",
      "POST /admin/subscriptions",
      "POST /admin/subscriptions/{id}/cancel",
      "POST /admin/subscriptions/{id}/renew",
      "GET /admin/plans",
      "GET /admin/plans/{id}",
      "POST /admin/plans",
      "PATCH /admin/plans/{id}",
      "DELETE /admin/plans/{id}",
      "POST /admin/users/{id}/password",
      "GET /plans",
      "POST /billing/webhook/{provider}",
      "GET /billing/admin/intents",
      "POST /s/{slug}/account/register",
      "POST /s/{slug}/account/login",
      "POST /s/{slug}/account/logout",
      "GET /s/{slug}/account/me",
      "PATCH /s/{slug}/account/me",
      "POST /s/{slug}/account/verify-email",
      "POST /s/{slug}/account/forgot-password",
      "POST /s/{slug}/account/reset-password",
      "GET /s/{slug}/account/orders",
      "GET /s/{slug}/account/addresses",
      "POST /s/{slug}/account/addresses",
      "PATCH /s/{slug}/account/addresses/{id}",
      "DELETE /s/{slug}/account/addresses/{id}",
      "POST /s/{slug}/account/addresses/{id}/make-default",
      "GET /s/{slug}/account/cart",
      "POST /s/{slug}/account/cart/items",
      "PATCH /s/{slug}/account/cart/items/{itemId}",
      "POST /s/{slug}/account/cart/merge",
      "POST /s/{slug}/cart",
      "GET /s/{slug}/cart/{cartId}",
      "POST /s/{slug}/cart/{cartId}/items",
      "PATCH /s/{slug}/cart/{cartId}/items/{itemId}",
    ];
    expect(documented.size).toBe(expected.length);
    for (const route of expected) {
      expect(documented, `missing from /doc: ${route}`).toContain(route);
    }
  });

  it("registers shared component schemas", async () => {
    const res = await createApp().request("/doc");
    const doc = (await res.json()) as {
      components?: { schemas?: Record<string, unknown> };
    };
    const names = Object.keys(doc.components?.schemas ?? {});
    for (const name of ["Category", "Product", "Customer", "Order", "Store", "Subscription"]) {
      expect(names, `missing component: ${name}`).toContain(name);
    }
  });

  it("documents the image upload as multipart/form-data with file + product_id", async () => {
    // Regression: the upload route once declared no request body, so Swagger
    // UI showed no file picker and its curl sent an empty body (every Swagger
    // upload died with "Multipart field 'file' is required."). The declared
    // schema is intentionally permissive at runtime — the handler stays the
    // sole enforcer — but the document must describe both form fields.
    const res = await createApp().request("/doc");
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
    };
    const key = Object.keys(doc.paths).find((p) => p.endsWith("/product-images/upload"));
    expect(key, "upload path missing from /doc").toBeTruthy();
    const op = doc.paths[key!]!.post as unknown as {
      requestBody?: { content?: Record<string, { schema?: unknown }> };
    };
    const media = op.requestBody?.content?.["multipart/form-data"];
    expect(media, "upload must declare a multipart/form-data body").toBeTruthy();
    const schema = media!.schema as {
      type?: string;
      properties?: Record<string, Record<string, unknown>>;
    };
    expect(schema.type).toBe("object");
    expect(schema.properties?.file).toMatchObject({ type: "string", format: "binary" });
    expect(schema.properties?.product_id).toMatchObject({ type: "string" });
  });

  it("documents the Turnstile token header on public buyer mutations", async () => {
    // The buyer endpoints (customers upsert, address create/make-default,
    // checkout) require the token via the X-Turnstile-Token header; without
    // a declared header Swagger UI gives Execute no place to put it. The
    // declaration is optional in the document (docs-only) — the middleware
    // stays the sole enforcer.
    const res = await createApp().request("/doc");
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
    };
    const key = Object.keys(doc.paths).find((p) => p.endsWith("/customers"));
    expect(key, "customers upsert path missing from /doc").toBeTruthy();
    const params = doc.paths[key!]!.post?.parameters ?? [];
    expect(
      params,
      "X-Turnstile-Token header missing from customers upsert"
    ).toContainEqual(
      expect.objectContaining({ name: "X-Turnstile-Token", in: "header" })
    );
  });

  it("GET /ui renders the Swagger shell", async () => {
    const res = await createApp().request("/ui");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("swagger");
  });

  it("uses only OpenAPI {param} templates, never Hono :param", async () => {
    // Regression: the generator emits Hono-style ":id" segments for directly
    // registered routes. Swagger UI only substitutes "{id}" tokens, so any
    // ":param" left in a path key is sent literally on the wire (observed in
    // production as GET /stores/:storeId -> 404 despite a correct value).
    const res = await createApp().request("/doc");
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
    };
    for (const [path, ops] of Object.entries(doc.paths)) {
      expect(path, `Hono-style param in documented path: ${path}`).not.toMatch(/\/:/);
      const tokens = [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
      for (const [method, op] of Object.entries(ops)) {
        const declared = (op.parameters ?? [])
          .filter((p) => p.in === "path")
          .map((p) => p.name);
        for (const token of tokens) {
          expect(
            declared,
            `${method.toUpperCase()} ${path}: path param {${token}} has no parameters entry`
          ).toContain(token);
        }
      }
    }
  });
});
