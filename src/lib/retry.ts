import { classifyDbError } from "../db.js";

// Bounded transient retry (roadmap B6, validated H6 review).
// Rules (binding):
// - Retries ONLY errors classifyDbError() marks retryable (contention /
//   transport uncertainty). Constraint, business (AppError), and unknown
//   errors propagate on first failure — default-deny.
// - Safe to wrap whole checkout calls ONLY because every retried unit is
//   idempotent: D1 batches are atomic and the idempotency key makes a
//   repeated checkout resolve to the same order instead of duplicating.
// - Exhaustion rethrows the last error (route maps it); callers convert to
//   503 + Retry-After where appropriate.
export async function retryTransient<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 100;
  let lastErr: unknown = new Error("retryTransient: no attempts ran");
  for (let n = 0; n < attempts; n++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!classifyDbError(err).retryable || n === attempts - 1) {
        throw err;
      }
      const delay = baseMs * 2 ** n + Math.floor(Math.random() * baseMs);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
