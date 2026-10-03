import { describe, expect, it } from "vitest";
import { turnstileGate } from "./turnstileGate.js";

// Checkout submit gate truth table. Pins the security-critical default:
// without the E2E flag, behavior is exactly the historical two-state gate
// (token required when configured, hard block when not). The E2E flag only
// ever opens the no-key case — with a real site key it is never consulted.
describe("turnstileGate", () => {
  it("requires a token when Turnstile is configured", () => {
    expect(
      turnstileGate({ ready: true, hasToken: false, e2eAllowMissing: false })
    ).toBe("need-token");
    expect(
      turnstileGate({ ready: true, hasToken: false, e2eAllowMissing: true })
    ).toBe("need-token");
  });

  it("proceeds with a token when Turnstile is configured", () => {
    expect(
      turnstileGate({ ready: true, hasToken: true, e2eAllowMissing: false })
    ).toBeNull();
    expect(
      turnstileGate({ ready: true, hasToken: true, e2eAllowMissing: true })
    ).toBeNull();
  });

  it("blocks without a key unless the E2E flag is set", () => {
    expect(
      turnstileGate({ ready: false, hasToken: false, e2eAllowMissing: false })
    ).toBe("unavailable");
    expect(
      turnstileGate({ ready: false, hasToken: false, e2eAllowMissing: true })
    ).toBeNull();
  });

  it("ignores a stale token when no key is configured", () => {
    expect(
      turnstileGate({ ready: false, hasToken: true, e2eAllowMissing: false })
    ).toBe("unavailable");
    expect(
      turnstileGate({ ready: false, hasToken: true, e2eAllowMissing: true })
    ).toBeNull();
  });
});
