import { OpenAPIHono } from "@hono/zod-openapi";
import { requestId } from "hono/request-id";
import type { AppEnv } from "./env.js";
import { errorHandler } from "./http/errors.js";
import { fail } from "./http/respond.js";
import { accessLog } from "./middleware/logging.js";
import { bodyLimitMw } from "./middleware/body-limit.js";
import { corsMw } from "./middleware/cors.js";
import { csrfMw } from "./middleware/csrf.js";
import { health } from "./routes/health.js";
import { auth } from "./routes/auth.js";
import { stores } from "./routes/stores.js";
import { categories } from "./routes/categories.js";
import { products } from "./routes/products.js";
import { productImages } from "./routes/product-images.js";
import { customers } from "./routes/customers.js";
import { customerAddresses } from "./routes/customer-addresses.js";
import { shippingRates } from "./routes/shipping-rates.js";
import { checkoutRouter } from "./routes/checkout.js";
import { orders } from "./routes/orders.js";
import { admin } from "./routes/admin.js";
import { billingWebhook, storeBilling } from "./routes/billing.js";
import { plans } from "./routes/plans.js";
import { registerDocs } from "./routes/docs.js";

// Application factory (exported for tests via app.request(); src/index.ts
// wires the same instance to the Worker entrypoint).
// NOTE: OpenAPIHono extends Hono — routing, middleware, onError and notFound
// behave identically; it additionally merges createRoute() definitions from
// mounted sub-routers into the /doc OpenAPI document.
export function createApp() {
  const app = new OpenAPIHono<AppEnv>();

  app.onError(errorHandler);
  app.notFound((c) => fail(c, "not_found", "Route does not exist.", 404));

  app.use(requestId());
  app.use(accessLog);
  app.use(bodyLimitMw());
  // Cookie-credentialed CORS for the frontend. Registered before the routes
  // so OPTIONS preflights are answered with 204 here and never reach route
  // or auth middleware (previously they fell through to the 404 handler).
  app.use(corsMw());
  // CSRF origin gate for cookie-authed mutations (companion to
  // SameSite=None sessions): runs after CORS so OPTIONS preflights pass
  // through untouched; safe methods are never gated.
  app.use(csrfMw);

  app.route("/", health);
  app.route("/auth", auth);
  app.route("/stores", stores);
  app.route("/stores/:storeId/categories", categories);
  app.route("/stores/:storeId/products", products);
  app.route("/stores/:storeId/product-images", productImages);
  app.route("/stores/:storeId/customers", customers);
  app.route("/stores/:storeId/customer-addresses", customerAddresses);
  app.route("/stores/:storeId/shipping-rates", shippingRates);
  app.route("/stores/:storeId/checkout", checkoutRouter);
  app.route("/stores/:storeId/orders", orders);
  app.route("/admin", admin);
  app.route("/stores/:storeId", storeBilling);
  app.route("/billing", billingWebhook);
  app.route("/plans", plans);
  registerDocs(app);

  // B8+ mount points attach here. Nothing else
  // exists yet by design — no route file, no public surface.

  return app;
}
