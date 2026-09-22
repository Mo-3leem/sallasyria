import { AppError } from "../../http/errors.js";
import type { Env } from "../../env.js";
import type { PaymentProvider } from "./provider.js";
import { realProvider } from "./real.js";
import { stubProvider } from "./stub.js";

// Provider registry. PAYMENT_PROVIDER selects the adapter ("stub" default).
// Unknown names fail closed with 404 at the route (never a default vendor,
// never card handling). Switching adapters is config-only.
export function selectProvider(name: string): PaymentProvider {
  if (name === stubProvider.name) return stubProvider;
  if (name === realProvider.name) return realProvider;
  throw new AppError("unknown_provider", 404, "Unknown payment provider.");
}

export function configuredProvider(env: Env): PaymentProvider {
  return selectProvider(env.PAYMENT_PROVIDER ?? "stub");
}
