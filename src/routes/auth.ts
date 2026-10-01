import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv, Env } from "../env.js";
import { getDb } from "../db.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { z, assertNoImmutableFields, validationHook } from "../http/validate.js";
import {
  clearUserAvatar,
  createMerchant,
  emailTaken,
  findMerchantForResend,
  getUserByEmail,
  getUserPublic,
  phoneTaken,
  resetUserPassword,
  setPasswordHash,
  setUserAvatar,
  updateUserProfile,
} from "../services/users.js";
import {
  RESET_TOKEN_TTL_MS,
  VERIFY_TOKEN_TTL_MS,
  findUserByEmail,
  hashEmailToken,
  issueEmailToken,
  redeemEmailToken,
} from "../services/email-tokens.js";
import { buildEmailChangeNotice, buildResetEmail, buildResetSuccessEmail, buildVerificationEmail, dispatchMail, sendMail } from "../services/mail.js";
import { normalizeEmail } from "../lib/email.js";
import { normalizePhone } from "../lib/phone.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { idParam, turnstileTokenHeader } from "../openapi/params.js";
import { auditEvent } from "../services/audit.js";
import { resourceId } from "../db/tenant.js";
import { uuidv7 } from "../lib/ids.js";
import {
  ALLOWED_IMAGE_MIME,
  PRODUCT_IMAGE_MAX_BYTES,
  avatarKeyFromUrl,
  avatarRefFor,
  extensionFor,
  resolveAvatarUrl,
  sanitizeImage,
  signingSecretOrThrow,
  sniffImageMime,
  verifyAvatarUrl,
} from "../lib/uploads.js";
import { dummyHash, hashPassword, verifyPassword, PASSWORD_RULES } from "../lib/password.js";
import {
  buildClearCookie,
  buildSetCookie,
  hashSessionToken,
  newSessionToken,
  SESSION_ABSOLUTE_MS,
  sessionExpiryIso,
} from "../lib/session.js";
import { touch } from "../lib/time.js";
import { requireTurnstile } from "../middleware/turnstile.js";
import { appUrl } from "../env.js";
import { checkEmailChangeLimit, checkLoginRateLimit, checkPublicFileLimit, checkPwChangeLimit, checkRegisterRateLimit, checkResendPubAccountLimit, checkUploadAvatarLimit, clientIp, loginFailCount, loginFailKey, LOGIN_FAIL_CHALLENGE_AFTER, loginRateLimitKey, recordLoginFailure, registerRateLimitKey, resetLoginFailures } from "../lib/rate-limit.js";
import {
  currentSessionId,
  currentUser,
  requireAuth,
  tryAuthenticate,
  type AuthUser,
} from "../middleware/auth.js";

export const auth = new OpenAPIHono<AppEnv>();

const loginSchema = z.object({
  // Primary identity: an email (contains "@") or a phone number. The
  // legacy `email` field below is a deprecated alias kept so older clients
  // keep working; when both are present, `identity` wins.
  identity: z.string().trim().min(1).max(254).optional().openapi({ example: "merchant@example.com" }),
  email: z.string().trim().email().max(254).optional().openapi({ example: "merchant@example.com" }),
  password: z.string().min(1).max(PASSWORD_RULES.maxChars).openapi({ example: "Correct-Horse-9x!" }),
});

const loginUserSchema = z
  .object({
    id: z.string().openapi({ example: "user_01J..." }),
    phone: z.string().openapi({ example: "+963991234567" }),
    email: z.string().nullable().openapi({ example: "owner@example.com" }),
    email_verified: z.number().openapi({ example: 0 }),
    name: z.string().openapi({ example: "Owner One" }),
    role: z.string().openapi({ example: "merchant" }),
    avatar_url: z.string().nullable().openapi({ example: null }),
  })
  .openapi("LoginUser");

const loginOkSchema = okOf(
  z.object({
    user: loginUserSchema,
    must_rotate: z.boolean().openapi({ example: false }),
  })
);

const registerSchema = z.object({
  email: z.string().trim().email().max(254).openapi({ example: "merchant@example.com" }),
  phone: z.string().min(1).max(32).openapi({ example: "+963991234567" }),
  password: z
    .string()
    .min(PASSWORD_RULES.minNewChars)
    .max(PASSWORD_RULES.maxChars)
    .openapi({ example: "Correct-Horse-9x!" }),
  name: z.string().min(1).max(200).openapi({ example: "Mohamed Haddad" }),
});

// role and id can never come from the client: asserting them on the RAW body
// fails closed even though the zod schema would strip them silently. The
// service hardcodes role='merchant' and generates the id regardless.
// NOTE: "store_id" is deliberately NOT listed — users have no store
// dimension, and auth.ts must stay store_id-free to keep its exemption in
// tests/tenant-conventions.test.ts (it queries only global tables).
const REGISTER_FORBIDDEN = ["id", "role"] as const;

// POST /auth/register — public merchant self-registration (MVP). No admin
// involvement, no approval: a visitor becomes a merchant and then logs in
// via /auth/login with their EMAIL (separate step by design — registration
// mints no session). Abuse control is defense in depth: Turnstile bot check
// first, then a dedicated ip+email sliding window (same 429 shape as login).
// Development without a Turnstile secret passes through via the standard dev
// bypass; misconfigured production fails closed.
// Duplicate identities are 409 (email_taken / phone_taken): signup
// uniqueness is inherently an existence signal — unavoidable and standard;
// login keeps its no-oracle 401 for credential guessing, which is the
// sensitive path.
const registerRoute = createRoute({
  method: "post",
  path: "/register",
  summary: "Register a merchant account",
  description:
    "Public self-service registration (Turnstile + rate limit). Email is required and unique; " +
    "phone is required, unique, and stored in canonical form (see lib/phone.ts) so it can also authenticate at login. Role is always merchant — role in the body is 400. " +
    "Returns the public profile (never the password hash); log in separately via /auth/login. " +
    "A verification email is sent when mail is configured (best-effort; informational only).",
  middleware: [requireTurnstile()],
  request: {
    headers: turnstileTokenHeader,
    body: { content: { "application/json": { schema: registerSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: okOf(z.object({ user: loginUserSchema })) } },
      description: "Registered merchant public profile",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid body, forbidden field, or bot token required",
    },
    403: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Bot verification failed",
    },
    409: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Phone number or email already registered",
    },
    429: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Too many attempts",
    },
  },
});

auth.openapi(registerRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, REGISTER_FORBIDDEN);
  const input = c.req.valid("json");
  const email = normalizeEmail(input.email);
  // Canonical contact identity going forward: stored phones are normalized
  // so phone login can resolve them. Shapes normalizePhone() rejects
  // (non-Syrian numbers) are 400 here, exactly like the checkout/customers
  // surfaces — registration no longer stores unresolvable raw strings.
  const phone = normalizePhone(input.phone);
  // Own bucket (register:<ip>:<email>): registration spam for an address
  // must never consume that address's login attempts.
  if (!checkRegisterRateLimit(registerRateLimitKey(c, email))) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  if (await phoneTaken(getDb(c), phone)) {
    throw new AppError("phone_taken", 409, "Phone number is already registered.");
  }
  if (await emailTaken(getDb(c), email)) {
    throw new AppError("email_taken", 409, "Email address is already registered.");
  }
  const user = await createMerchant(getDb(c), {
    phone,
    email,
    name: input.name,
    passwordHash: hashPassword(input.password),
  });
  // Best-effort verification mail: registration is already committed, so any
  // failure here (D1 or SendGrid) is swallowed — the merchant can re-request
  // verification via resend-verification, then log in once verified.
  try {
    const issued = await issueEmailToken(getDb(c), user.id, "verify", VERIFY_TOKEN_TTL_MS);
    const msg = buildVerificationEmail(
      user.name,
      `${appUrl(c.env)}/auth/verify-email?token=${issued.token}`,
      issued.token
    );
    dispatchMail(
      c,
      sendMail(
        { to: email, subject: msg.subject, text: msg.text, html: msg.html },
        { apiKey: c.env.SENDGRID_API_KEY, from: c.env.MAIL_FROM }
      )
    );
  } catch {
    // Fall through to the normal 201 below.
  }
  return ok(c, { user }, 201);
}, validationHook);

interface UserRow {
  id: string;
  phone: string;
  email: string | null;
  name: string;
  role: string;
  password_hash: string;
  is_active: number;
  email_verified: number | null;
}

interface UserRow {
  id: string;
  phone: string;
  email: string | null;
  name: string;
  role: string;
  password_hash: string;
  is_active: number;
  email_verified: number | null;
}

// ---- email verification + password reset (SendGrid-backed) ----
//
// Token model: 32 random bytes over the wire, SHA-256 at rest, redeemed via
// a compare-and-swap UPDATE (used_at IS NULL AND expires_at > now), so
// concurrent redeems collapse to exactly one winner and unknown / expired /
// already-used tokens are indistinguishable (no enumeration). Password rules
// and session handling reuse the existing implementations verbatim. Login
// stays available before verification (documented policy — see verify-email
// description); the emailed flows prove inbox possession at use time.

const verifyEmailSchema = z.object({
  token: z.string().min(1).max(512),
});

const verifyEmailRoute = createRoute({
  method: "post",
  path: "/verify-email",
  summary: "Verify a merchant email address",
  description:
    "Redeems a single-use verification token (24h TTL). Unknown, expired, and already-used tokens " +
    "return an identical 400. Verification is required before login: unverified credentials get 403.",
  request: {
    body: { content: { "application/json": { schema: verifyEmailSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ verified: z.boolean() })) } },
      description: "Email verified",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid body, or invalid/expired/used token",
    },
    429: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Too many attempts",
    },
  },
});

auth.openapi(verifyEmailRoute, async (c) => {
  if (!checkLoginRateLimit(`verify:${clientIp(c)}`)) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  const input = c.req.valid("json");
  const claimed = await redeemEmailToken(getDb(c), input.token, "verify");
  if (!claimed) {
    throw new AppError("invalid_token", 400, "Invalid or expired token.");
  }
  await getDb(c)
    .prepare("UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?")
    .bind(touch(), claimed.userId)
    .run();
  return ok(c, { verified: true });
}, validationHook);

const resendVerificationSchema = z.object({
  email: z.string().trim().email().max(254),
});

const resendVerificationRoute = createRoute({
  method: "post",
  path: "/resend-verification",
  summary: "Re-send the verification email",
  description:
    "Two modes on one path (no enumeration). Authenticated callers keep the strict behavior: the address " +
    "must belong to the caller, and already-verified accounts get success without an email. Without a " +
    "session, anyone may request recovery for an address and always receives the same success response; " +
    "a fresh 24h token is issued and mailed ONLY for a real, unverified merchant account. Retires live " +
    "tokens and issues a fresh 24h one in both modes.",
  request: {
    body: { content: { "application/json": { schema: resendVerificationSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ emailed: z.boolean() })) } },
      description: "Accepted (public callers always receive emailed:true)",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid body, or (authenticated only) email does not belong to the caller",
    },
    429: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Too many attempts",
    },
  },
});

auth.openapi(resendVerificationRoute, async (c) => {
  const input = c.req.valid("json");
  const authed = await tryAuthenticate(c);
  if (authed) {
    if (!checkLoginRateLimit(`resend:${clientIp(c)}`)) {
      throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
    }
    const user = authed;
    const email = normalizeEmail(input.email);
    // The address must belong to the caller — otherwise this would be an
    // oracle/bait endpoint for third-party addresses.
    const mine = await getDb(c)
      .prepare("SELECT email_verified FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ email_verified: number | null }>();
    const currentEmail = user.email === null ? null : normalizeEmail(user.email);
    if (!mine || currentEmail === null || email !== currentEmail) {
      throw new AppError("invalid_email", 400, "Email address is not on this account.");
    }
    if ((mine.email_verified ?? 0) === 1) {
      return ok(c, { emailed: false });
    }
    try {
      const issued = await issueEmailToken(getDb(c), user.id, "verify", VERIFY_TOKEN_TTL_MS);
      const msg = buildVerificationEmail(
        user.name,
        `${appUrl(c.env)}/auth/verify-email?token=${issued.token}`,
        issued.token
      );
      dispatchMail(
        c,
        sendMail(
          { to: email, subject: msg.subject, text: msg.text, html: msg.html },
          { apiKey: c.env.SENDGRID_API_KEY, from: c.env.MAIL_FROM }
        )
      );
    } catch {
      // Best-effort: fall through to the normal 200 below.
    }
    return ok(c, { emailed: true });
  }
  // Public recovery path (no session): enumeration-flat always-200. Both
  // buckets gate every attempt so one victim address cannot be mail-bombed
  // across rotated IPs, and resend traffic never consumes the login bucket.
  if (!checkLoginRateLimit(`resend-pub:${clientIp(c)}`)) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  const email = normalizeEmail(input.email);
  if (!checkResendPubAccountLimit(await hashEmailToken(email))) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  const found = await findMerchantForResend(getDb(c), email);
  if (
    found &&
    found.role === "merchant" &&
    found.email !== null &&
    normalizeEmail(found.email) === email &&
    (found.email_verified ?? 0) === 0
  ) {
    try {
      const issued = await issueEmailToken(getDb(c), found.id, "verify", VERIFY_TOKEN_TTL_MS);
      const msg = buildVerificationEmail(
        found.name,
        `${appUrl(c.env)}/auth/verify-email?token=${issued.token}`,
        issued.token
      );
      dispatchMail(
        c,
        sendMail(
          { to: email, subject: msg.subject, text: msg.text, html: msg.html },
          { apiKey: c.env.SENDGRID_API_KEY, from: c.env.MAIL_FROM }
        )
      );
    } catch {
      // Best-effort: fall through to the identical success below.
    }
  }
  return ok(c, { emailed: true });
}, validationHook);

const forgotPasswordSchema = z.object({
  email: z.string().trim().email().max(254),
});

const forgotPasswordRoute = createRoute({
  method: "post",
  path: "/forgot-password",
  summary: "Request a password-reset email",
  description:
    "Always 200 with the same body, whether or not the email belongs to an account. " +
    "When it does, a single-use reset token (1h TTL) is emailed.",
  request: {
    body: { content: { "application/json": { schema: forgotPasswordSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ emailed: z.boolean() })) } },
      description: "Request accepted (reveals nothing about the email)",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid body",
    },
    429: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Too many attempts",
    },
  },
});

auth.openapi(forgotPasswordRoute, async (c) => {
  if (!checkLoginRateLimit(`forgot:${clientIp(c)}`)) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  const input = c.req.valid("json");
  const found = await findUserByEmail(getDb(c), normalizeEmail(input.email));
  // Best-effort send, same as registration: failures (D1 or SendGrid) never
  // change the 200 — and unknown emails take the identical path.
  if (found && found.email) {
    try {
      const issued = await issueEmailToken(getDb(c), found.id, "reset", RESET_TOKEN_TTL_MS);
      const msg = buildResetEmail(
        found.name,
        `${appUrl(c.env)}/auth/reset-password?token=${issued.token}`,
        issued.token
      );
      dispatchMail(
        c,
        sendMail(
          { to: found.email, subject: msg.subject, text: msg.text, html: msg.html },
          { apiKey: c.env.SENDGRID_API_KEY, from: c.env.MAIL_FROM }
        )
      );
    } catch {
      // Fall through to the normal 200 below.
    }
  }
  return ok(c, { emailed: true });
}, validationHook);

const resetPasswordSchema = z.object({
  token: z.string().min(1).max(512),
  new_password: z
    .string()
    .min(PASSWORD_RULES.minNewChars)
    .max(PASSWORD_RULES.maxChars),
  logout_other_sessions: z.boolean().default(true),
});

const resetPasswordRoute = createRoute({
  method: "post",
  path: "/reset-password",
  summary: "Reset a password with an emailed token",
  description:
    "Redeems a single-use reset token (1h TTL) and sets the new password. All sessions are revoked " +
    "by default (logout_other_sessions defaults true); pass logout_other_sessions false explicitly " +
    "to keep existing sessions (weaker: a stolen session would survive the reset). There is no calling " +
    "session in this token flow. Unknown, expired, and already-used " +
    "tokens return an identical 400. A confirmation email is sent best-effort afterwards.",
  request: {
    body: { content: { "application/json": { schema: resetPasswordSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ reset: z.boolean() })) } },
      description: "Password reset; all sessions revoked unless explicitly kept",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid body, or invalid/expired/used token",
    },
    429: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Too many attempts",
    },
  },
});

auth.openapi(resetPasswordRoute, async (c) => {
  if (!checkLoginRateLimit(`reset:${clientIp(c)}`)) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  const input = c.req.valid("json");
  // Single-use is enforced by the CAS claim inside redeemEmailToken: at most
  // one concurrent caller proceeds. A crash between the claim and the batch
  // below burns the token (safe direction); the user re-requests.
  const claimed = await redeemEmailToken(getDb(c), input.token, "reset");
  if (!claimed) {
    throw new AppError("invalid_token", 400, "Invalid or expired token.");
  }
  const now = touch();
  // Secure default: the hash rotates AND every live session is revoked in one
  // batch (resetUserPassword), so a stolen session cannot survive the reset.
  // Explicit logout_other_sessions false keeps the old opt-out (hash only);
  // the confirmation email below is worded to match whichever path ran.
  const sessionsRevoked = input.logout_other_sessions;
  if (sessionsRevoked) {
    await resetUserPassword(getDb(c), claimed.userId, hashPassword(input.new_password), now);
  } else {
    await setPasswordHash(getDb(c), claimed.userId, hashPassword(input.new_password), now);
  }
  // Confirmation notice, best-effort like every other send in this file.
  try {
    const account = await getUserPublic(getDb(c), claimed.userId);
    if (account && account.email) {
      const msg = buildResetSuccessEmail(publicUser(account).name, sessionsRevoked);
      dispatchMail(
        c,
        sendMail(
          { to: account.email, subject: msg.subject, text: msg.text },
          { apiKey: c.env.SENDGRID_API_KEY, from: c.env.MAIL_FROM }
        )
      );
    }
  } catch {
    // Fall through to the normal 200 below.
  }
  return ok(c, { reset: true });
}, validationHook);

function publicUser(u: { id: string; phone: string; email: string | null; name: string; role: string; email_verified?: number | null; avatar_url?: string | null }) {
  return { id: u.id, phone: u.phone, email: u.email, name: u.name, role: u.role, email_verified: u.email_verified ?? 0, avatar_url: u.avatar_url ?? null };
}

// Resolve the stored avatar reference into a short-lived signed URL for API
// responses. The raw r2:// reference never leaves the server; without a
// signing secret the field resolves to null (fail-closed display).
async function userWithAvatar(
  c: { env: Env },
  u: { id: string; phone: string; email: string | null; name: string; role: string; email_verified?: number | null; avatar_url?: string | null }
) {
  const avatar_url = await resolveAvatarUrl(u.avatar_url ?? null, u.id, c.env.URL_SIGNING_SECRET);
  return publicUser({ ...u, avatar_url });
}

function cookieSecure(c: { env: Env }): boolean {
  // Same-origin MVP: Secure cookies in every non-development environment.
  // Local `wrangler dev` serves plain http, where a Secure cookie would
  // never be sent back — hence the explicit environment switch.
  return (c.env.ENVIRONMENT ?? "development") !== "development";
}

// SameSite derivation (split-deployment fix): cross-origin production
// (frontend on pages.dev calling the API on workers.dev) needs
// SameSite=None or browsers reject the session cookie third-party-style.
// Same-origin callers and all of development keep Lax: None without Secure
// is rejected by browsers, and dev serves plain http. Detection is
// per-request (Origin host vs request host) so one deployment serves both
// same-origin and split frontends correctly; unparsable/missing Origin
// fails safe to Lax (non-browser clients send cookies explicitly anyway).
// Exported for the buyer router (P4): buyer cookies follow the identical
// split-deployment rule so one deployment serves both frontends correctly.
export function cookieSameSite(c: {
  req: { header(name: string): string | undefined; url: string };
  env: Env;
}): "lax" | "none" {
  if (!cookieSecure(c)) return "lax";
  try {
    const origin = c.req.header("Origin");
    if (!origin) return "lax";
    const originHost = new URL(origin).hostname.toLowerCase();
    const requestHost = new URL(c.req.url).hostname.toLowerCase();
    if (originHost && requestHost && originHost !== requestHost) {
      return "none";
    }
    return "lax";
  } catch {
    return "lax";
  }
}

// POST /auth/login — verifies credentials, mints ONE opaque session row,
// returns the raw token exactly once (Set-Cookie). The identity is either a
// NORMALIZED email (Test@Example.com and test@example.com are the same
// account) or a NORMALIZED phone (099..., +963... and spaced/dashed variants
// are the same account; Syrian shapes only, see lib/phone.ts). Detection is
// a literal "@": identities containing "@" resolve by email, everything else
// by phone. Failures are indistinguishable (unknown identity / inactive /
// wrong password all 401 with identical code+message); unknown accounts
// still pay one scrypt verify against a dummy hash so timing gives nothing
// away. A malformed phone never 400s — it follows the generic 401 path.
const loginRoute = createRoute({
  method: "post",
  path: "/login",
  summary: "Log in with email or phone + password",
  description:
    "Verifies credentials and mints one opaque server-side session returned as an HttpOnly cookie. " +
    "The identity is an email (contains @) or a phone number (Syrian shapes, any common formatting). " +
    "Unknown identity, inactive account, and wrong password all return an identical 401. " +
    "After repeated failed passwords for one identity, a Turnstile challenge is required first. " +
    "Correct credentials on an unverified email return 403 email_not_verified — verify first, then log in.",
  request: {
    body: { content: { "application/json": { schema: loginSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: loginOkSchema } },
      description: "Logged in; session cookie set",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid body",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid identity or password",
    },
    403: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Correct credentials but email not verified",
    },
    429: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Too many attempts",
    },
  },
});

auth.openapi(loginRoute, async (c) => {
  const input = c.req.valid("json");
  const { password } = input;
  const rawIdentity = input.identity ?? input.email ?? null;
  if (rawIdentity === null) {
    throw new AppError("validation_failed", 400, "Request body is invalid.");
  }
  const trimmed = rawIdentity.trim();
  const isEmail = trimmed.includes("@");
  // Canonical identity for the rate-limit bucket (pure functions only, so
  // this runs before any database read, exactly like the old email key).
  // Un-normalizable phones share one "invalid-phone" bucket per IP rather
  // than 400ing, so malformed input reveals nothing about any account.
  let canonical: string | null = null;
  if (isEmail) {
    canonical = normalizeEmail(trimmed);
  } else {
    try {
      canonical = normalizePhone(trimmed);
    } catch {
      canonical = null;
    }
  }

  if (!checkLoginRateLimit(loginRateLimitKey(c, canonical ?? "invalid-phone"))) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }

  // Brute-force escalation (B4): after LOGIN_FAIL_CHALLENGE_AFTER consecutive
  // wrong passwords for one canonical identity, require a Turnstile challenge
  // BEFORE checking credentials, so the challenge reveals nothing about
  // account existence (unknown identities accumulate identically). Reuses the
  // standard middleware verbatim: missing token 400s, bad token 403s,
  // misconfigured production 503s, dev without secret passes through.
  // Never a lockout — the base 10/10min limiter above still applies.
  const failKey = loginFailKey(canonical ?? "invalid-phone");
  if (loginFailCount(failKey) >= LOGIN_FAIL_CHALLENGE_AFTER) {
    await requireTurnstile()(c, async () => {});
  }

  const db = getDb(c);
  let user: UserRow | null = null;
  if (canonical !== null) {
    user =
      (isEmail
        ? await db.prepare("SELECT * FROM users WHERE email = ?").bind(canonical).first<UserRow>()
        : await db.prepare("SELECT * FROM users WHERE phone = ?").bind(canonical).first<UserRow>()) ?? null;
  }
  if (!user && !isEmail && trimmed !== canonical) {
    // Legacy rows stored before phone normalization (registration accepted
    // raw strings): exact match on the typed value. Exact-string equality
    // can never resolve to the wrong account, and the password check below
    // still gates everything.
    user =
      (await db.prepare("SELECT * FROM users WHERE phone = ?").bind(trimmed).first<UserRow>()) ?? null;
  }

  const hashToCheck = user !== null && user.is_active === 1 ? user.password_hash : dummyHash();
  const passwordOk = verifyPassword(password, hashToCheck);
  if (user === null || user.is_active !== 1 || !passwordOk) {
    // Wrong password (unknown, inactive, and mismatched accounts share this
    // path by design): count the failure toward challenge escalation, then
    // answer the identical 401. Successes reset below.
    recordLoginFailure(failKey);
    throw new AppError("invalid_credentials", 401, "Invalid email/phone or password.");
  }
  // Password proven (even when the verified-gate 403s below): the account is
  // not being guessed, so clear its failure count.
  resetLoginFailures(failKey);
  // Verification gate (policy): correct credentials alone do not authenticate
  // until the email is verified. Ordered AFTER the password check so wrong
  // passwords keep the identical 401 (no verified-state oracle); a correct
  // password on an unverified account gets an explicit 403 instead. The
  // 403 reveals nothing new: it requires already proving password knowledge.
  if ((user.email_verified ?? 0) !== 1) {
    throw new AppError("email_not_verified", 403, "Email verification required.");
  }

  const token = newSessionToken();
  const nowMs = Date.now();
  const sessionId = uuidv7(nowMs);
  await getDb(c)
    .prepare(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(sessionId, user.id, await hashSessionToken(token), sessionExpiryIso(nowMs), touch(nowMs), touch(nowMs))
    .run();

  const maxAgeSec = Math.floor(SESSION_ABSOLUTE_MS / 1000);
  c.header(
    "Set-Cookie",
    buildSetCookie(token, {
      secure: cookieSecure(c),
      maxAgeSec,
      sameSite: cookieSameSite(c),
    })
  );
  // Bootstrap rotation signal (B7): true only for admins still on the seeded
  // credential. Clients MUST route to change-password when set; the server
  // additionally enforces it in requireAuth (rotation-exempt list).
  const bootstrap = c.env.ADMIN_BOOTSTRAP_PASSWORD;
  const must_rotate =
    user.role === "admin" && !!bootstrap && verifyPassword(bootstrap, user.password_hash);
  return ok(c, { user: await userWithAvatar(c, user), must_rotate }, 200);
}, validationHook);

// POST /auth/logout — immediate server-side revocation (revoked_at=now),
// then clears the cookie. A replayed cookie afterwards is 401: deletion of
// the cookie alone would never suffice.
const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  summary: "Log out the current session",
  description: "Revokes the current session server-side immediately and clears the cookie. Replays stay 401.",
  middleware: [requireAuth],
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ loggedOut: z.boolean() })) },
      },
      description: "Logged out; session revoked server-side",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
  },
});

auth.openapi(logoutRoute, async (c) => {
  const now = touch();
  await getDb(c)
    .prepare("UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE id = ?")
    .bind(now, now, currentSessionId(c))
    .run();
  c.header(
    "Set-Cookie",
    buildClearCookie({ secure: cookieSecure(c), sameSite: cookieSameSite(c) })
  );
  return ok(c, { loggedOut: true });
}, validationHook);

// POST /auth/logout-others — revoke every other live session of this user
// (the "log out everywhere" / post-password-change primitive). Returns the
// revoked count; the current session is never touched.
const logoutOthersRoute = createRoute({
  method: "post",
  path: "/logout-others",
  summary: "Log out all other sessions",
  description: "Revokes every other live session of the caller; the current session is never touched. Returns the revoked count.",
  middleware: [requireAuth],
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ revoked: z.number() })) },
      },
      description: "Other sessions revoked",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
  },
});

auth.openapi(logoutOthersRoute, async (c) => {
  const user = currentUser(c);
  const now = touch();
  const res = await getDb(c)
    .prepare(
      "UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL"
    )
    .bind(now, now, user.id, currentSessionId(c))
    .run();
  return ok(c, { revoked: res.meta.changes ?? 0 });
}, validationHook);

// GET /auth/sessions — list the caller's live sessions for the session
// management UI. Never accepts a user id: identity comes only from the
// session. Returns safe metadata only (no token, no token_hash); revoked and
// expired rows are excluded, and the calling session is flagged.
const sessionIdParams = z.object({ id: idParam });

const sessionEntrySchema = z.object({
  id: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  current: z.boolean(),
});

const listSessionsRoute = createRoute({
  method: "get",
  path: "/sessions",
  summary: "List my live sessions",
  description:
    "Returns the caller's non-revoked, unexpired sessions newest first with the current session flagged. Metadata only: no token material is ever serialized.",
  middleware: [requireAuth],
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ sessions: z.array(sessionEntrySchema) })) },
      },
      description: "Caller's live sessions",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
  },
});

auth.openapi(listSessionsRoute, async (c) => {
  const user = currentUser(c);
  const now = touch();
  const rows = await getDb(c)
    .prepare(
      "SELECT id, created_at, last_used_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC"
    )
    .bind(user.id, now)
    .all<{ id: string; created_at: string; last_used_at: string | null }>();
  const current = currentSessionId(c);
  return ok(c, {
    sessions: (rows.results ?? []).map((r) => ({ ...r, current: r.id === current })),
  });
}, validationHook);

// DELETE /auth/sessions/:id — revoke one of the caller's own non-current
// sessions (per-session "log out elsewhere"). Caller-scoped: the UPDATE is
// keyed by (id, user_id), so unknown and foreign ids answer an identical
// 404 and reveal nothing. The current session is rejected with 400 (use
// POST /auth/logout for that); already-revoked rows 404 like unknown ones.
// Rows are never deleted: revoked_at preserves the audit trail.
const deleteSessionRoute = createRoute({
  method: "delete",
  path: "/sessions/:id",
  summary: "Revoke one of my sessions",
  description:
    "Revokes a single non-current session of the caller. Unknown, foreign, and already-revoked ids answer an identical 404; the current session is rejected (log out instead).",
  middleware: [requireAuth],
  request: { params: sessionIdParams },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ revoked: z.boolean() })) },
      },
      description: "Session revoked",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Cannot revoke the current session here",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
    404: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unknown session",
    },
  },
});

auth.openapi(deleteSessionRoute, async (c) => {
  const user = currentUser(c);
  const targetId = resourceId(c);
  if (targetId === currentSessionId(c)) {
    throw new AppError("cannot_revoke_current", 400, "Cannot revoke the current session here. Log out instead.");
  }
  const now = touch();
  const res = await getDb(c)
    .prepare("UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(now, now, targetId, user.id)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    throw new AppError("session_not_found", 404, "Session not found.");
  }
  return ok(c, { revoked: true });
}, validationHook);

const meRoute = createRoute({
  method: "get",
  path: "/me",
  summary: "Get the current user",
  description: "Returns the authenticated user's public profile. Never includes the password hash.",
  middleware: [requireAuth],
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ user: loginUserSchema })) } },
      description: "Current user",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
  },
});

auth.openapi(meRoute, async (c) => {
  const user: AuthUser = currentUser(c);
  return ok(c, { user: await userWithAvatar(c, user) });
}, validationHook);

const mePatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().trim().email().max(254).nullable().optional(),
  phone: z.string().min(1).max(32).optional(),
  current_password: z.string().min(1).max(PASSWORD_RULES.maxChars).optional(),
  logout_other_sessions: z.boolean().default(false),
});

// Identity and security fields can never be written through this endpoint.
// (updated_at is app-managed and ignored; the schema already strips anything
// else silently, but these fail closed loudly by design.)
const ME_FORBIDDEN = ["id", "role", "is_active", "password_hash", "created_at", "avatar_url"] as const;

// PATCH /auth/me — self-service profile update. Name-only edits need no
// password and touch no sessions. Phone/email edits are credential-identity
// changes: they require the current password (same 401 as login), then honor
// logout_other_sessions (default false) — revoking every OTHER session only
// when the caller opts in, while the calling session always survives. The
// current session is never revoked by this endpoint, so reauth_required stays
// false and is kept only for API compatibility.
const patchMeRoute = createRoute({
  method: "patch",
  path: "/me",
  summary: "Update own profile",
  description:
    "Partial update of name, email, phone, plus logout_other_sessions (default false, keep everything). " +
    "Phone/email changes require current_password; with logout_other_sessions true all other " +
    "sessions are revoked while the current session stays alive, with false (or omitted) every session survives. " +
    "Changing the email resets email_verified and mails a fresh verification link to the new address " +
    "(the current session survives; login requires verification afterwards). " +
    "id, role, is_active, and password_hash in the body are 400.",
  middleware: [requireAuth],
  request: {
    body: { content: { "application/json": { schema: mePatchSchema } } },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: okOf(
            z.object({ user: loginUserSchema, reauth_required: z.boolean() })
          ),
        },
      },
      description: "Updated public profile; reauth_required tells whether to log in again",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid body, immutable field, or missing current password",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated or wrong current password",
    },
    409: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Phone or email already registered",
    },
    429: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Too many attempts",
    },
  },
});

auth.openapi(patchMeRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ME_FORBIDDEN);
  const user = currentUser(c);
  const input = c.req.valid("json");
  // Canonicalize a replacement phone before anything else so uniqueness
  // checks and storage always see the resolvable form. Rejected shapes are
  // 400 here (authenticated context — no oracle concern).
  const normalizedPhone = input.phone === undefined ? undefined : normalizePhone(input.phone);
  const emailChanged =
    input.email !== undefined && (input.email ?? null) !== (user.email ?? null);
  const phoneChanged = normalizedPhone !== undefined && normalizedPhone !== user.phone;
  if (emailChanged || phoneChanged) {
    if (!input.current_password) {
      throw new AppError(
        "current_password_required",
        400,
        "Current password is required to change email or phone."
      );
    }
    const stored = await getDb(c)
      .prepare("SELECT password_hash FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ password_hash: string }>();
    if (!stored || !verifyPassword(input.current_password, stored.password_hash)) {
      throw new AppError("invalid_credentials", 401, "Invalid email or password.");
    }
  }
  // Abuse guard on the email-identity path only: each change below issues a
  // token and sends up to two mails. Name/phone-only updates never reach
  // here. Runs after password verification (failed passwords consume
  // nothing) and before any write, so a 429 leaves zero profile, token, or
  // mail side effects.
  if (emailChanged && !checkEmailChangeLimit(user.id)) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  const updated = await updateUserProfile(getDb(c), user.id, {
    name: input.name,
    email: input.email,
    phone: normalizedPhone,
  });
  if (!updated) throw new AppError("internal", 500, "Something went wrong.");
  // Re-verification on email change: the new address must prove ownership
  // before it is trusted, so it starts unverified. Issuing the token also
  // retires any live verify tokens for previous addresses (same mechanism
  // as resend). Skipped when the address is removed entirely (null): there
  // is nothing to verify, and phone login keeps working on the kept flag.
  // The current session always survives; login gates on the flag afterwards.
  let profile = updated;
  if (emailChanged && updated.email !== null) {
    const nowVerify = touch();
    await getDb(c)
      .prepare("UPDATE users SET email_verified = 0, updated_at = ? WHERE id = ?")
      .bind(nowVerify, user.id)
      .run();
    const issued = await issueEmailToken(getDb(c), user.id, "verify", VERIFY_TOKEN_TTL_MS);
    const oldEmail = user.email;
    try {
      const msg = buildVerificationEmail(
        updated.name,
        `${appUrl(c.env)}/auth/verify-email?token=${issued.token}`,
        issued.token
      );
      dispatchMail(
        c,
        sendMail(
          { to: updated.email, subject: msg.subject, text: msg.text, html: msg.html },
          { apiKey: c.env.SENDGRID_API_KEY, from: c.env.MAIL_FROM }
        )
      );
      if (oldEmail) {
        const notice = buildEmailChangeNotice(updated.name);
        dispatchMail(
          c,
          sendMail(
            { to: oldEmail, subject: notice.subject, text: notice.text },
            { apiKey: c.env.SENDGRID_API_KEY, from: c.env.MAIL_FROM }
          )
        );
      }
    } catch {
      // Best-effort mail, like registration/resend: the flag reset and the
      // token stand on their own, and authed resend remains available.
    }
    const fresh = await getUserPublic(getDb(c), user.id);
    if (!fresh) throw new AppError("internal", 500, "Something went wrong.");
    profile = fresh;
  }
  if ((emailChanged || phoneChanged) && input.logout_other_sessions) {
    // Other sessions only: the caller's session always survives (its id is
    // excluded), same statement shape as the change-password route.
    const now = touch();
    await getDb(c)
      .prepare("UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL")
      .bind(now, now, user.id, currentSessionId(c))
      .run();
  }
  await auditEvent(c, getDb(c),"user.profile.update", { actor: user.id, result: user.id });
  return ok(c, { user: await userWithAvatar(c, profile), reauth_required: false });
}, validationHook);

// POST /auth/me/avatar — self-service profile picture upload. Multipart
// field "file". Enforcement order mirrors the product-image upload route:
// File check -> size cap (5 MB, before buffering) -> magic-byte sniff
// (claimed MIME ignored) -> metadata sanitize -> private R2 put under a
// random user-namespaced key -> users.avatar_url reference. The previous
// avatar object is deleted best-effort AFTER the DB write commits, so a
// failed put never orphans the live reference. 503 without R2 or signing
// secret (fail-closed, never a fake success). Identity flows ONLY from the
// session — no target id exists to smuggle.
const avatarUploadRoute = createRoute({
  method: "post",
  path: "/me/avatar",
  summary: "Upload own profile picture",
  description:
    "Multipart file (JPEG, PNG, WebP, or GIF, max 5 MB). Verified by magic " +
    "bytes server-side, metadata-stripped, and stored as a private R2 object " +
    "linked to the caller. Replaces any previous picture. 503 without storage.",
  middleware: [requireAuth],
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ user: loginUserSchema })) } },
      description: "Updated public profile with fresh avatar link",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Missing file or unsupported image" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    413: { content: { "application/json": { schema: failEnvelope } }, description: "Image exceeds the size limit" },
    429: { content: { "application/json": { schema: failEnvelope } }, description: "Too many attempts" },
    503: { content: { "application/json": { schema: failEnvelope } }, description: "Image storage is not configured" },
  },
});

auth.openapi(avatarUploadRoute, async (c) => {
  const user = currentUser(c);
  // Abuse guard first: buffering + sanitize + R2 PUT below are the expensive
  // part. Per-user key; validation order after this is unchanged.
  if (!checkUploadAvatarLimit(user.id)) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  const form = await c.req.parseBody().catch(() => ({}));
  const file = (form as Record<string, unknown>)["file"];
  if (!(file instanceof File)) {
    throw new AppError("validation_failed", 400, "Multipart field 'file' is required.");
  }
  if (file.size > PRODUCT_IMAGE_MAX_BYTES || file.size === 0) {
    throw new AppError("body_too_large", 413, "Image exceeds the size limit.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffImageMime(bytes);
  if (sniffed === null || !(ALLOWED_IMAGE_MIME as readonly string[]).includes(sniffed)) {
    throw new AppError("invalid_image", 400, "Uploaded file is not a supported image.");
  }
  const clean = sanitizeImage(bytes, sniffed);
  const secret = signingSecretOrThrow(c.env);
  // No-R2 production demo: fail closed with 503 (never a TypeError-500,
  // never a fake success) — same guard as the product-image upload route.
  const r2 = c.env.R2;
  if (!r2) {
    throw new AppError("storage_unavailable", 503, "Image storage is not configured.");
  }
  const fileName = `${uuidv7()}.${extensionFor(sniffed)}`;
  const objectKey = `avatars/${user.id}/${fileName}`;
  await r2.put(objectKey, clean.bytes, {
    httpMetadata: { contentType: sniffed },
  });
  const updated = await setUserAvatar(getDb(c), user.id, avatarRefFor(user.id, fileName));
  if (!updated) throw new AppError("internal", 500, "Something went wrong.");
  // Retire the previous object best-effort (post-commit; a failure here
  // must never fail the upload, and the old link is already unreferenced).
  const prev = avatarKeyFromUrl(user.avatar_url ?? "");
  if (prev && prev.file !== fileName) {
    try {
      await r2.delete(`avatars/${prev.userId}/${prev.file}`);
    } catch {
      // Best-effort only.
    }
  }
  await auditEvent(c, getDb(c),"user.profile.update", { actor: user.id, result: user.id });
  return ok(c, { user: await userWithAvatar(c, updated) });
}, validationHook);

// DELETE /auth/me/avatar — remove own profile picture. Idempotent: no
// picture is still 200 with avatar_url null. The R2 object is deleted
// best-effort; the DB clear is authoritative either way.
const avatarDeleteRoute = createRoute({
  method: "delete",
  path: "/me/avatar",
  summary: "Remove own profile picture",
  description: "Clears the picture and falls back to the default avatar. Idempotent.",
  middleware: [requireAuth],
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ user: loginUserSchema })) } },
      description: "Updated public profile without avatar",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
  },
});

auth.openapi(avatarDeleteRoute, async (c) => {
  const user = currentUser(c);
  const updated = await clearUserAvatar(getDb(c), user.id);
  if (!updated) throw new AppError("internal", 500, "Something went wrong.");
  const prev = avatarKeyFromUrl(user.avatar_url ?? "");
  if (prev && c.env.R2) {
    try {
      await c.env.R2.delete(`avatars/${prev.userId}/${prev.file}`);
    } catch {
      // Best-effort only.
    }
  }
  await auditEvent(c, getDb(c),"user.profile.update", { actor: user.id, result: user.id });
  return ok(c, { user: await userWithAvatar(c, updated) });
}, validationHook);

// NOTE: registered BEFORE any /:param-style auth route could capture the
// "avatar" segment (same precedence discipline as the product file route).
const avatarFileRoute = createRoute({
  method: "get",
  path: "/avatar/file/:key",
  summary: "Serve a private avatar file",
  description:
    "Public bearer-URL reader: the user-bound HMAC signature plus expiry are verified, " +
    "so links are unforgeable and short-lived. Missing, expired, or tampered links 404 identically.",
  request: {
    params: z.object({ key: z.string().openapi({ param: { name: "key", in: "path" }, example: "01J....jpg" }) }),
    query: z.object({
      uid: z.string().optional().openapi({ example: "user_01J..." }),
      exp: z.string().optional().openapi({ example: "1758000000" }),
      sig: z.string().optional().openapi({ example: "9f2c..." }),
    }),
  },
  responses: {
    200: { description: "Image bytes (content-typed, private cache)" },
    404: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Missing, expired, or tampered link",
    },
    429: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Too many attempts",
    },
    503: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Image storage is not configured",
    },
  },
});

auth.openapi(avatarFileRoute, async (c) => {
  // Abuse guard first: R2 egress is the expensive part below. Shared budget
  // with the product file route (same bearer-URL egress boundary).
  if (!checkPublicFileLimit(clientIp(c))) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  const secret = signingSecretOrThrow(c.env);
  const file = resourceId(c, "key");
  const uid = c.req.query("uid") ?? "";
  const expRaw = c.req.query("exp");
  const sig = c.req.query("sig") ?? "";
  const exp = expRaw !== undefined ? Number(expRaw) : NaN;
  if (!(await verifyAvatarUrl(secret, uid, file, exp, sig))) {
    throw new AppError("avatar_not_found", 404, "Avatar not found.");
  }
  // No-R2 production demo: fail closed with 503 (see upload route note).
  const r2 = c.env.R2;
  if (!r2) {
    throw new AppError("storage_unavailable", 503, "Image storage is not configured.");
  }
  const object = await r2.get(`avatars/${uid}/${file}`);
  if (!object) {
    throw new AppError("avatar_not_found", 404, "Avatar not found.");
  }
  const remaining = Math.max(0, exp - Math.floor(Date.now() / 1000));
  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": `private, max-age=${remaining}`,
    },
  });
}, validationHook);

const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(PASSWORD_RULES.maxChars),
  new_password: z
    .string()
    .min(PASSWORD_RULES.minNewChars)
    .max(PASSWORD_RULES.maxChars),
  logout_other_sessions: z.boolean().default(true),
});

// POST /auth/change-password — self-service rotation (B7). Verifies the
// current password (same invalid_credentials code as login: no oracle),
// stores the new scrypt hash. Other sessions are revoked by default
// (logout_other_sessions defaults true); pass false explicitly to keep them.
// The caller keeps its own session either way so the rotation flow itself is
// not interrupted.
const changePasswordRoute = createRoute({
  method: "post",
  path: "/change-password",
  summary: "Change own password",
  description:
    "Verifies the current password (same 401 as login: no oracle), stores the new scrypt hash. " +
    "Other sessions are revoked by default (logout_other_sessions defaults true, keep nothing); " +
    "pass logout_other_sessions false explicitly to keep other sessions. " +
    "The calling session always survives. New password minimum 8 characters.",
  middleware: [requireAuth],
  request: {
    body: { content: { "application/json": { schema: changePasswordSchema } } },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ changed: z.boolean() })) },
      },
      description: "Password changed; other sessions revoked unless explicitly kept",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid body",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated or wrong current password",
    },
    429: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Too many attempts",
    },
  },
});

auth.openapi(changePasswordRoute, async (c) => {
  const user = currentUser(c);
  const { current_password, new_password, logout_other_sessions } = c.req.valid("json");
  // Abuse guard first: verify + re-hash below cost ~2x scrypt each call.
  // Per-user key so one account's rotation never throttles another.
  if (!checkPwChangeLimit(user.id)) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  const stored = await getDb(c)
    .prepare("SELECT password_hash FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ password_hash: string }>();
  if (!stored || !verifyPassword(current_password, stored.password_hash)) {
    throw new AppError("invalid_credentials", 401, "Invalid email or password.");
  }
  const now = touch();
  // Secure default: revoke every OTHER session atomically with the hash
  // update; the caller's own session (excluded by id) always survives so the
  // rotation flow is not interrupted. Explicit false keeps the old behavior
  // (hash only, every session survives).
  const statements = [
    getDb(c)
      .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .bind(hashPassword(new_password), now, user.id),
  ];
  if (logout_other_sessions) {
    statements.push(
      getDb(c)
        .prepare("UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL")
        .bind(now, now, user.id, currentSessionId(c))
    );
  }
  await getDb(c).batch(statements);
  return ok(c, { changed: true });
}, validationHook);
