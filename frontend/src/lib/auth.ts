/**
 * Auth route helpers (no secrets, no tokens — pure path logic).
 */

/** Authenticated application home (post-login default since Phase 2). */
const APP_HOME = "/app/dashboard";

/** Minimal readable shape of URLSearchParams for `next` extraction. */
interface NextParams {
  get(name: string): string | null;
}

/** True only for safe same-origin app paths (blocks `//evil` and schemes). */
export function isLocalPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

/** Post-login destination: `?next=` when safe, otherwise the app home. */
export function getNextPath(
  searchParams: NextParams | null,
  fallback: string = APP_HOME
): string {
  const next = searchParams?.get("next");
  return next && isLocalPath(next) ? next : fallback;
}

export { APP_HOME };
