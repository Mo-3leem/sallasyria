/**
 * E2E-only Turnstile escape hatch (build-time, browser-visible but NOT a
 * secret). Set ONLY by the Playwright E2E frontend build:
 *   NEXT_PUBLIC_E2E_ALLOW_MISSING_TURNSTILE=1 npm run build --prefix frontend
 *
 * Effect: turnstileGate() below lets the checkout submit path proceed
 * WITHOUT a captcha token, and ONLY when no site key is configured
 * (!TURNSTILE_READY in TurnstileWidget.tsx). When a real key exists the
 * flag is never consulted.
 *
 * Why this is safe:
 * - Default (unset/any other value): behavior is byte-identical to before.
 * - The flag gates a CLIENT-SIDE submit affordance only. Server-side
 *   verification (src/middleware/turnstile.ts) is untouched: a production
 *   backend with TURNSTILE_SECRET set still rejects missing/invalid tokens
 *   however the browser was built, so a leaked flag can never disable
 *   server-side bot defense. Locally the pre-existing documented dev
 *   bypass (no secret + development env) applies, exactly as before.
 * - Never set this in production builds or Pages env vars.
 *
 * Kept in a JSX-free module (not in TurnstileWidget.tsx) so the pure gate
 * stays runnable under every Vitest config in the repo.
 */
export const TURNSTILE_E2E_NO_TOKEN =
  process.env.NEXT_PUBLIC_E2E_ALLOW_MISSING_TURNSTILE === "1";

export type TurnstileGateBlock = "need-token" | "unavailable";

/**
 * Pure checkout submit gate (unit-tested). Returns the blocking reason, or
 * null when submission may proceed. The E2E flag is consulted ONLY when no
 * site key is configured — with a real key, the normal widget flow applies
 * unconditionally.
 */
export function turnstileGate(args: {
  ready: boolean;
  hasToken: boolean;
  e2eAllowMissing: boolean;
}): TurnstileGateBlock | null {
  if (args.ready) return args.hasToken ? null : "need-token";
  return args.e2eAllowMissing ? null : "unavailable";
}
