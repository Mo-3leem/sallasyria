import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv, Env } from "../env.js";
import { getDb } from "../db.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { z, assertNoImmutableFields, validationHook } from "../http/validate.js";
import { createMerchant, phoneTaken, updateUserProfile } from "../services/users.js";
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
import { checkLoginRateLimit, checkRegisterRateLimit, loginRateLimitKey, registerRateLimitKey } from "../lib/rate-limit.js";
import {
  currentSessionId,
  currentUser,
  requireAuth,
  type AuthUser,
} from "../middleware/auth.js";

export const auth = new OpenAPIHono<AppEnv>();

const loginSchema = z.object({
  phone: z.string().min(1).max(32).openapi({ example: "+963991234567" }),
  password: z.string().min(1).max(PASSWORD_RULES.maxChars).openapi({ example: "Correct-Horse-9x!" }),
});

const loginUserSchema = z
  .object({
    id: z.string().openapi({ example: "user_01J..." }),
    phone: z.string().openapi({ example: "+963991234567" }),
    email: z.string().nullable().openapi({ example: "owner@example.com" }),
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
  phone: z.string().min(1).max(32).openapi({ example: "+963991234567" }),
  password: z
    .string()
    .min(PASSWORD_RULES.minNewChars)
    .max(PASSWORD_RULES.maxChars)
    .openapi({ example: "Correct-Horse-9x!" }),
  name: z.string().min(1).max(200).openapi({ example: "Mohamed Haddad" }),
  email: z.string().email().max(254).nullable().default(null),
});

// role and id can never come from the client: asserting them on the RAW body
// fails closed even though the zod schema would strip them silently. The
// service hardcodes role='merchant' and generates the id regardless.
// NOTE: "store_id" is deliberately NOT listed — users have no store
// dimension, and auth.ts must stay store_id-free to keep its exemption in
// tests/tenant-conventions.test.ts (it queries only global tables).
const REGISTER_FORBIDDEN = ["id", "role"] as const;

// POST /auth/register — public merchant self-registration (MVP). No admin
// involvement, no approval, no verification: a visitor becomes a merchant and
// then logs in via /auth/login (separate step by design — registration mints
// no session). Abuse control mirrors /auth/login (same per-isolate
// ip+phone sliding window, same 429) rather than Turnstile: Turnstile
// fail-closed 503s when unconfigured, which would brick registration in any
// environment without a widget, while login proves rate-limit-only is the
// accepted pattern for public auth mutations.
// Duplicate phones are 409 phone_taken (signup uniqueness is inherently an
// existence signal — unavoidable and standard; login keeps its no-oracle
// 401 for credential guessing, which is the sensitive path).
const registerRoute = createRoute({
  method: "post",
  path: "/register",
  summary: "Register a merchant account",
  description:
    "Public self-service registration. Role is always merchant — role in the body is 400. " +
    "Returns the public profile (never the password hash); log in separately via /auth/login.",
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
      description: "Phone number already registered",
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
  // Own bucket (register:<ip>:<phone>): registration spam for a phone must
  // never consume that phone's login attempts.
  if (!checkRegisterRateLimit(registerRateLimitKey(c, input.phone))) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  if (await phoneTaken(getDb(c), input.phone)) {
    throw new AppError("phone_taken", 409, "Phone number is already registered.");
  }
  const user = await createMerchant(getDb(c), {
    phone: input.phone,
    email: input.email,
    name: input.name,
    passwordHash: hashPassword(input.password),
  });
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
}

function publicUser(u: { id: string; phone: string; email: string | null; name: string; role: string }) {
  return { id: u.id, phone: u.phone, email: u.email, name: u.name, role: u.role };
}

function cookieSecure(c: { env: Env }): boolean {
  // Same-origin MVP: Secure cookies in every non-development environment.
  // Local `wrangler dev` serves plain http, where a Secure cookie would
  // never be sent back — hence the explicit environment switch.
  return (c.env.ENVIRONMENT ?? "development") !== "development";
}

// POST /auth/login — verifies credentials, mints ONE opaque session row,
// returns the raw token exactly once (Set-Cookie). Failures are
// indistinguishable (unknown phone / inactive / wrong password all 401 with
// identical code+message); unknown accounts still pay one scrypt verify
// against a dummy hash so timing gives nothing away.
const loginRoute = createRoute({
  method: "post",
  path: "/login",
  summary: "Log in with phone + password",
  description:
    "Verifies credentials and mints one opaque server-side session returned as an HttpOnly cookie. " +
    "Unknown phone, inactive account, and wrong password all return an identical 401.",
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
      description: "Invalid phone or password",
    },
    429: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Too many attempts",
    },
  },
});

auth.openapi(loginRoute, async (c) => {
  const { phone, password } = c.req.valid("json");

  if (!checkLoginRateLimit(loginRateLimitKey(c, phone))) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }

  const user = await getDb(c)
    .prepare("SELECT * FROM users WHERE phone = ?")
    .bind(phone)
    .first<UserRow>();

  const hashToCheck = user !== null && user.is_active === 1 ? user.password_hash : dummyHash();
  const passwordOk = verifyPassword(password, hashToCheck);
  if (user === null || user.is_active !== 1 || !passwordOk) {
    throw new AppError("invalid_credentials", 401, "Invalid phone or password.");
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
  c.header("Set-Cookie", buildSetCookie(token, { secure: cookieSecure(c), maxAgeSec }));
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
  c.header("Set-Cookie", buildClearCookie({ secure: cookieSecure(c) }));
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
  email: z.string().email().max(254).nullable().optional(),
  phone: z.string().min(1).max(32).optional(),
  current_password: z.string().min(1).max(PASSWORD_RULES.maxChars).optional(),
  logout_other_sessions: z.boolean().default(true),
});

// Identity and security fields can never be written through this endpoint.
// (updated_at is app-managed and ignored; the schema already strips anything
// else silently, but these fail closed loudly by design.)
const ME_FORBIDDEN = ["id", "role", "is_active", "password_hash", "created_at"] as const;

// PATCH /auth/me — self-service profile update. Name-only edits need no
// password and touch no sessions. Phone/email edits are credential-identity
// changes: they require the current password (same 401 as login), then honor
// logout_other_sessions (default true) — revoking every OTHER session while
// the calling session always survives. The current session is never revoked
// by this endpoint, so reauth_required stays false and is kept only for API
// compatibility.
const patchMeRoute = createRoute({
  method: "patch",
  path: "/me",
  summary: "Update own profile",
  description:
    "Partial update of name, email, phone, plus logout_other_sessions (default true). " +
    "Phone/email changes require current_password; with logout_other_sessions true (default) all other " +
    "sessions are revoked while the current session stays alive, with false every session survives. " +
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
      throw new AppError("invalid_credentials", 401, "Invalid phone or password.");
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
});

// POST /auth/change-password — self-service rotation (B7). Verifies the
// current password (same invalid_credentials code as login: no oracle),
// stores the new scrypt hash, and revokes every OTHER session (a changed
// password must kill potentially-compromised sessions; the caller keeps its
// own so the rotation flow itself is not interrupted).
const changePasswordRoute = createRoute({
  method: "post",
  path: "/change-password",
  summary: "Change own password",
  description:
    "Verifies the current password (same 401 as login: no oracle), stores the new scrypt hash, " +
    "and revokes every other session. New password minimum 8 characters.",
  middleware: [requireAuth],
  request: {
    body: { content: { "application/json": { schema: changePasswordSchema } } },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ changed: z.boolean() })) },
      },
      description: "Password changed; other sessions revoked",
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
  const { current_password, new_password } = c.req.valid("json");
  const stored = await getDb(c)
    .prepare("SELECT password_hash FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ password_hash: string }>();
  if (!stored || !verifyPassword(current_password, stored.password_hash)) {
    throw new AppError("invalid_credentials", 401, "Invalid phone or password.");
  }
  const now = touch();
  await getDb(c).batch([
    getDb(c)
      .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .bind(hashPassword(new_password), now, user.id),
    getDb(c)
      .prepare("UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL")
      .bind(now, now, user.id, currentSessionId(c)),
  ]);
  return ok(c, { changed: true });
}, validationHook);
