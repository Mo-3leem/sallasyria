import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv, Env } from "../env.js";
import { getDb } from "../db.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { z, assertNoImmutableFields, validationHook } from "../http/validate.js";
import { createMerchant, emailTaken, getUserByEmail, getUserPublic, phoneTaken, resetUserPassword, setPasswordHash, updateUserProfile } from "../services/users.js";
import {
  RESET_TOKEN_TTL_MS,
  VERIFY_TOKEN_TTL_MS,
  findUserByEmail,
  issueEmailToken,
  redeemEmailToken,
} from "../services/email-tokens.js";
import { buildResetEmail, buildResetSuccessEmail, buildVerificationEmail, dispatchMail, sendMail } from "../services/mail.js";
import { normalizeEmail } from "../lib/email.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { auditLog } from "../lib/audit.js";
import { uuidv7 } from "../lib/ids.js";
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
import { appUrl } from "../env.js";
import { checkLoginRateLimit, checkRegisterRateLimit, clientIp, loginRateLimitKey, registerRateLimitKey } from "../lib/rate-limit.js";
import {
  currentSessionId,
  currentUser,
  requireAuth,
  type AuthUser,
} from "../middleware/auth.js";

export const auth = new OpenAPIHono<AppEnv>();

const loginSchema = z.object({
  email: z.string().trim().email().max(254).openapi({ example: "merchant@example.com" }),
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
// mints no session). Abuse control is a dedicated ip+email sliding window
// (same 429 shape as login) rather than Turnstile: Turnstile fail-closed
// 503s when unconfigured, which would brick registration in any environment
// without a widget, while rate-limit-only is the accepted pattern for
// public auth mutations.
// Duplicate identities are 409 (email_taken / phone_taken): signup
// uniqueness is inherently an existence signal — unavoidable and standard;
// login keeps its no-oracle 401 for credential guessing, which is the
// sensitive path.
const registerRoute = createRoute({
  method: "post",
  path: "/register",
  summary: "Register a merchant account",
  description:
    "Public self-service registration. Email is the authentication identity (required, unique); " +
    "phone is still collected as contact identity. Role is always merchant — role in the body is 400. " +
    "Returns the public profile (never the password hash); log in separately via /auth/login. " +
    "A verification email is sent when mail is configured (best-effort; informational only).",
  request: {
    body: { content: { "application/json": { schema: registerSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: okOf(z.object({ user: loginUserSchema })) } },
      description: "Registered merchant public profile",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid body or forbidden field",
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
  // Own bucket (register:<ip>:<email>): registration spam for an address
  // must never consume that address's login attempts.
  if (!checkRegisterRateLimit(registerRateLimitKey(c, email))) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  if (await phoneTaken(getDb(c), input.phone)) {
    throw new AppError("phone_taken", 409, "Phone number is already registered.");
  }
  if (await emailTaken(getDb(c), email)) {
    throw new AppError("email_taken", 409, "Email address is already registered.");
  }
  const user = await createMerchant(getDb(c), {
    phone: input.phone,
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
      `${appUrl(c.env)}/verify-email?token=${issued.token}`,
      issued.token
    );
    dispatchMail(
      c,
      sendMail(
        { to: email, subject: msg.subject, text: msg.text },
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
    "Authenticated callers only (no enumeration: the caller proves ownership with a session). " +
    "Retires live tokens and issues a fresh 24h one. Already-verified accounts get a success " +
    "response without an email.",
  middleware: [requireAuth],
  request: {
    body: { content: { "application/json": { schema: resendVerificationSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ emailed: z.boolean() })) } },
      description: "Verification email sent (false when already verified)",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid body, or email does not belong to the caller",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
    429: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Too many attempts",
    },
  },
});

auth.openapi(resendVerificationRoute, async (c) => {
  if (!checkLoginRateLimit(`resend:${clientIp(c)}`)) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  const user = currentUser(c);
  const input = c.req.valid("json");
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
      `${appUrl(c.env)}/verify-email?token=${issued.token}`,
      issued.token
    );
    dispatchMail(
      c,
      sendMail(
        { to: email, subject: msg.subject, text: msg.text },
        { apiKey: c.env.SENDGRID_API_KEY, from: c.env.MAIL_FROM }
      )
    );
  } catch {
    // Best-effort: fall through to the normal 200 below.
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
        `${appUrl(c.env)}/reset-password?token=${issued.token}`,
        issued.token
      );
      dispatchMail(
        c,
        sendMail(
          { to: found.email, subject: msg.subject, text: msg.text },
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
  logout_other_sessions: z.boolean().default(false),
});

const resetPasswordRoute = createRoute({
  method: "post",
  path: "/reset-password",
  summary: "Reset a password with an emailed token",
  description:
    "Redeems a single-use reset token (1h TTL) and sets the new password. Sessions are revoked " +
    "only when logout_other_sessions is true (default false, keep everything); there is no calling " +
    "session in this token flow. Unknown, expired, and already-used " +
    "tokens return an identical 400. A confirmation email is sent best-effort afterwards.",
  request: {
    body: { content: { "application/json": { schema: resetPasswordSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ reset: z.boolean() })) } },
      description: "Password reset; sessions revoked only when requested",
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
  // Opt-in revocation only: by default the hash rotates while every session
  // stays alive. The forced variant (existing resetUserPassword, also used by
  // the admin reset) additionally revokes all target sessions.
  if (input.logout_other_sessions) {
    await resetUserPassword(getDb(c), claimed.userId, hashPassword(input.new_password), now);
  } else {
    await setPasswordHash(getDb(c), claimed.userId, hashPassword(input.new_password), now);
  }
  // Confirmation notice, best-effort like every other send in this file.
  try {
    const account = await getUserPublic(getDb(c), claimed.userId);
    if (account && account.email) {
      const msg = buildResetSuccessEmail(publicUser(account).name);
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

function publicUser(u: { id: string; phone: string; email: string | null; name: string; role: string; email_verified?: number | null }) {
  return { id: u.id, phone: u.phone, email: u.email, name: u.name, role: u.role, email_verified: u.email_verified ?? 0 };
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
// returns the raw token exactly once (Set-Cookie). The identity is the
// NORMALIZED email: Test@Example.com and test@example.com are the same
// account, and phones never authenticate. Failures are indistinguishable
// (unknown email / inactive / wrong password all 401 with identical
// code+message); unknown accounts still pay one scrypt verify against a
// dummy hash so timing gives nothing away.
const loginRoute = createRoute({
  method: "post",
  path: "/login",
  summary: "Log in with email + password",
  description:
    "Verifies credentials and mints one opaque server-side session returned as an HttpOnly cookie. " +
    "Unknown email, inactive account, and wrong password all return an identical 401. " +
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
      description: "Invalid email or password",
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
  const { email: rawEmail, password } = c.req.valid("json");
  const email = normalizeEmail(rawEmail);

  if (!checkLoginRateLimit(loginRateLimitKey(c, email))) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }

  const user = await getDb(c)
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(email)
    .first<UserRow>();

  const hashToCheck = user !== null && user.is_active === 1 ? user.password_hash : dummyHash();
  const passwordOk = verifyPassword(password, hashToCheck);
  if (user === null || user.is_active !== 1 || !passwordOk) {
    throw new AppError("invalid_credentials", 401, "Invalid email or password.");
  }
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
  return ok(c, { user: publicUser(user), must_rotate }, 200);
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

auth.openapi(meRoute, (c) => {
  const user: AuthUser = currentUser(c);
  return ok(c, { user: publicUser(user) });
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
const ME_FORBIDDEN = ["id", "role", "is_active", "password_hash", "created_at"] as const;

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
  },
});

auth.openapi(patchMeRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ME_FORBIDDEN);
  const user = currentUser(c);
  const input = c.req.valid("json");
  const emailChanged =
    input.email !== undefined && (input.email ?? null) !== (user.email ?? null);
  const phoneChanged = input.phone !== undefined && input.phone !== user.phone;
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
  const updated = await updateUserProfile(getDb(c), user.id, {
    name: input.name,
    email: input.email,
    phone: input.phone,
  });
  if (!updated) throw new AppError("internal", 500, "Something went wrong.");
  if ((emailChanged || phoneChanged) && input.logout_other_sessions) {
    // Other sessions only: the caller's session always survives (its id is
    // excluded), same statement shape as the change-password route.
    const now = touch();
    await getDb(c)
      .prepare("UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL")
      .bind(now, now, user.id, currentSessionId(c))
      .run();
  }
  auditLog("user.profile.update", { actor: user.id, result: user.id });
  return ok(c, { user: publicUser(updated), reauth_required: false });
}, validationHook);

const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(PASSWORD_RULES.maxChars),
  new_password: z
    .string()
    .min(PASSWORD_RULES.minNewChars)
    .max(PASSWORD_RULES.maxChars),
  logout_other_sessions: z.boolean().default(false),
});

// POST /auth/change-password — self-service rotation (B7). Verifies the
// current password (same invalid_credentials code as login: no oracle),
// stores the new scrypt hash. Other sessions are revoked only on explicit
// opt-in (logout_other_sessions, default false); the caller keeps its own
// either way so the rotation flow itself is not interrupted.
const changePasswordRoute = createRoute({
  method: "post",
  path: "/change-password",
  summary: "Change own password",
  description:
    "Verifies the current password (same 401 as login: no oracle), stores the new scrypt hash. " +
    "Other sessions are revoked only when logout_other_sessions is true (default false, keep everything); " +
    "the calling session always survives. New password minimum 8 characters.",
  middleware: [requireAuth],
  request: {
    body: { content: { "application/json": { schema: changePasswordSchema } } },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ changed: z.boolean() })) },
      },
      description: "Password changed; other sessions revoked only when requested",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid body",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated or wrong current password",
    },
  },
});

auth.openapi(changePasswordRoute, async (c) => {
  const user = currentUser(c);
  const { current_password, new_password, logout_other_sessions } = c.req.valid("json");
  const stored = await getDb(c)
    .prepare("SELECT password_hash FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ password_hash: string }>();
  if (!stored || !verifyPassword(current_password, stored.password_hash)) {
    throw new AppError("invalid_credentials", 401, "Invalid email or password.");
  }
  const now = touch();
  // The sessions statement is included only on explicit opt-in; by default
  // (false) the hash rotates while every session — including the caller's —
  // stays alive.
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
