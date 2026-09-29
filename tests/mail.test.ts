import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import {
  VERIFY_TOKEN_TTL_MS,
  findUserByEmail,
  hashEmailToken,
  issueEmailToken,
  newEmailToken,
  redeemEmailToken,
} from "../src/services/email-tokens.js";
import {
  buildEmailChangeNotice,
  buildOrderConfirmationEmail,
  buildResetEmail,
  buildResetSuccessEmail,
  buildStatusEmail,
  buildVerificationEmail,
  dispatchMail,
  sendMail,
} from "../src/services/mail.js";

// Minimal in-memory D1 double honoring the exact SQL shapes used by the
// email-token service (CAS redeem, retire-then-insert batch, lookups).
function stubDb(opts: { user?: { id: string; name: string; email: string | null } | null } = {}) {
  type Row = {
    id: string;
    user_id: string;
    purpose: string;
    token_hash: string;
    expires_at: string;
    used_at: string | null;
  };
  const rows = new Map<string, Row>();
  const seen: string[] = [];
  const db = {
    __rows: rows,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        seen.push(sql);
        if (sql.startsWith("UPDATE email_tokens SET used_at = ? WHERE user_id")) {
          const [nowIso, userId, purpose] = args as [string, string, string];
          for (const r of rows.values()) {
            if (r.user_id === userId && r.purpose === purpose && r.used_at === null) {
              r.used_at = nowIso;
            }
          }
          return { run: async () => ({ meta: { changes: 1 } }) };
        }
        if (sql.startsWith("INSERT INTO email_tokens")) {
          const [id, userId, purpose, tokenHash, expiresAt] = args as [
            string, string, string, string, string, string, string,
          ];
          rows.set(tokenHash, {
            id,
            user_id: userId,
            purpose,
            token_hash: tokenHash,
            expires_at: expiresAt,
            used_at: null,
          });
          return { run: async () => ({ meta: { changes: 1 } }) };
        }
        if (sql.startsWith("UPDATE email_tokens SET used_at = ?, updated_at")) {
          const [nowIso, , tokenHash, purpose, nowIso2] = args as [string, string, string, string, string];
          const r = rows.get(tokenHash);
          if (r && r.purpose === purpose && r.used_at === null && r.expires_at > nowIso2) {
            r.used_at = nowIso;
            return { run: async () => ({ meta: { changes: 1 } }) };
          }
          return { run: async () => ({ meta: { changes: 0 } }) };
        }
        if (sql.startsWith("SELECT user_id FROM email_tokens")) {
          const [tokenHash, purpose] = args as [string, string];
          const r = rows.get(tokenHash);
          return {
            first: async () =>
              r && r.purpose === purpose ? { user_id: r.user_id } : null,
          };
        }
        if (sql.startsWith("SELECT id, name, email FROM users")) {
          return { first: async () => opts.user ?? null };
        }
        throw new Error(`unexpected SQL in stub: ${sql}`);
      },
    }),
    batch: async (stmts: { run?: () => Promise<unknown> }[]) => {
      const out = [];
      for (const s of stmts) {
        out.push({ success: true });
        await s.run?.();
      }
      return out;
    },
  } as unknown as D1Database & { __rows: Map<string, Row> };
  return { db, seen, rows };
}

describe("sendMail", () => {
  const call = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls[0] as [string, Record<string, unknown>];
  it("skips without config and never calls fetch", async () => {
    const fetchImpl = vi.fn();
    for (const deps of [{}, { apiKey: "k" }, { from: "a@b.c" }]) {
      expect(await sendMail({ to: "u@x.y", subject: "s", text: "t" }, deps)).toEqual({
        sent: false,
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips empty recipients without calling fetch", async () => {
    const fetchImpl = vi.fn();
    expect(
      await sendMail({ to: "", subject: "s", text: "t" }, { apiKey: "k", from: "a@b.c", fetchImpl })
    ).toEqual({ sent: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the SendGrid shape with bearer auth on success", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const r = await sendMail(
      { to: "u@x.y", subject: "Hi", text: "Body" },
      { apiKey: "sekret", from: "n@salla.sy", fetchImpl }
    );
    expect(r).toEqual({ sent: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = call(fetchImpl);
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sekret");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const payload = JSON.parse(init.body as string) as {
      personalizations?: { to?: { email?: string }[] }[];
      from?: { email?: string };
      subject?: string;
    };
    expect(payload.personalizations?.[0]?.to?.[0]?.email).toBe("u@x.y");
    expect(payload.from?.email).toBe("n@salla.sy");
    expect(payload.subject).toBe("Hi");
  });

  it("includes the HTML alternative only when provided", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    await sendMail(
      { to: "u@x.y", subject: "Hi", text: "Body", html: "<p>Body</p>" },
      { apiKey: "sekret", from: "n@salla.sy", fetchImpl }
    );
    const [, init] = call(fetchImpl);
    const payload = JSON.parse(init.body as string) as {
      content?: { type?: string; value?: string }[];
    };
    expect(payload.content).toEqual([
      { type: "text/plain", value: "Body" },
      { type: "text/html", value: "<p>Body</p>" },
    ]);

    const fetchImpl2 = vi.fn(async () => new Response(null, { status: 202 }));
    await sendMail(
      { to: "u@x.y", subject: "Hi", text: "Body" },
      { apiKey: "sekret", from: "n@salla.sy", fetchImpl: fetchImpl2 }
    );
    const [, init2] = call(fetchImpl2);
    const payload2 = JSON.parse(init2.body as string) as {
      content?: { type?: string; value?: string }[];
    };
    expect(payload2.content).toEqual([{ type: "text/plain", value: "Body" }]);
  });

  it("swallows 4xx/5xx and transport failures", async () => {
    for (const status of [400, 401, 403, 429, 500]) {
      const bad = vi.fn(async () => new Response("no", { status }));
      expect(
        await sendMail({ to: "u@x.y", subject: "s", text: "t" }, { apiKey: "k", from: "a@b.c", fetchImpl: bad })
      ).toEqual({ sent: false });
    }
    const down = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(
      await sendMail({ to: "u@x.y", subject: "s", text: "t" }, { apiKey: "k", from: "a@b.c", fetchImpl: down })
    ).toEqual({ sent: false });
    const hanging = vi.fn(() => new Promise<Response>(() => {}));
    const timeout = await Promise.race([
      sendMail({ to: "u@x.y", subject: "s", text: "t" }, { apiKey: "k", from: "a@b.c", fetchImpl: hanging }).then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("open"), 50)),
    ]);
    expect(timeout).toBe("open");
  });

  it("confines the key to the Authorization header", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    await sendMail({ to: "u@x.y", subject: "s", text: "t" }, { apiKey: "sekret", from: "a@b.c", fetchImpl });
    const [url, init] = call(fetchImpl);
    expect(url).not.toContain("sekret");
    expect(JSON.stringify(init.body)).not.toContain("sekret");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sekret");
  });
});

describe("dispatchMail", () => {
  it("uses waitUntil when an execution context exists", async () => {
    const captured: Promise<unknown>[] = [];
    let ran = false;
    dispatchMail(
      { executionCtx: { waitUntil: (p: Promise<unknown>) => void captured.push(p) } },
      Promise.resolve().then(() => {
        ran = true;
        return { sent: true };
      })
    );
    expect(captured).toHaveLength(1);
    await captured[0];
    expect(ran).toBe(true);
  });

  it("runs detached without an execution context and swallows rejection", async () => {
    let ran = false;
    dispatchMail(
      {},
      Promise.resolve()
        .then(() => {
          ran = true;
          return { sent: false };
        })
        .then(() => {
          throw new Error("late failure");
        })
    );
    await new Promise((r) => setTimeout(r, 25));
    expect(ran).toBe(true);
  });
});

describe("email builders", () => {
  it("verification mail carries the link behind a CTA, never a raw token", () => {
    const link = "https://app/auth/verify-email?token=tok-123";
    const v = buildVerificationEmail("Layla Haddad", link, "tok-123");
    expect(v.subject).toBe("تأكيد بريدك الإلكتروني في سلة سوريا");
    // Plain text keeps the functional link (required) but no standalone token.
    expect(v.text).toContain(link);
    expect(v.text.replace(link, "")).not.toContain("tok-123");
    expect(v.text).toContain("24 ساعة");
    expect(v.text).toContain("مرحبًا Layla،");
    expect(v.text).toContain("© 2025 سلة سوريا");
    // HTML hides the long URL behind the CTA button and shows no raw token.
    expect(v.html).toContain(">تأكيد البريد الإلكتروني</a>");
    expect(v.html).toContain(`href="${link}"`);
    expect(v.html.replace(link, "")).not.toContain("tok-123");
    expect(v.html).toContain('dir="rtl"');
    expect(v.html).toContain('href="https://sallasyria.com/"');
    expect(v.html).toContain("sallasyria.com</a>");
    expect(v.html).toContain("جميع الحقوق محفوظة");
    const r = buildResetEmail("Layla Haddad", "https://app/reset-password?token=tok-456", "tok-456");
    expect(r.subject).toBe("إعادة تعيين كلمة المرور في سلة سوريا");
    // Same contract as the verification mail: link behind a CTA, never a raw token.
    expect(r.text).toContain("https://app/reset-password?token=tok-456");
    expect(r.text.replace("https://app/reset-password?token=tok-456", "")).not.toContain("tok-456");
    expect(r.text).toContain("ساعة واحدة");
    expect(r.text).toContain("مرحبًا Layla،");
    expect(r.text).toContain("© 2025 سلة سوريا");
    expect(r.html).toContain(">إعادة تعيين كلمة المرور</a>");
    expect(r.html).toContain('href="https://app/reset-password?token=tok-456"');
    expect(r.html.replace("https://app/reset-password?token=tok-456", "")).not.toContain("tok-456");
    expect(r.html).toContain('dir="rtl"');
    expect(r.html).toContain("سلة سوريا</span>");
    expect(r.html).toContain("جميع الحقوق محفوظة");
    const done = buildResetSuccessEmail("Layla");
    expect(done.text).not.toMatch(/tok|password.*reset.*token/i);
    expect(done.text).toContain("signed out");
    const kept = buildResetSuccessEmail("Layla", false);
    expect(kept.text).not.toContain("signed out");
    expect(kept.text).toContain("kept as requested");
    const notice = buildEmailChangeNotice("Layla");
    expect(notice.subject).toContain("changed");
    expect(notice.text).toContain("Layla");
    expect(notice.text).toContain("no longer be used");
    expect(notice.text).not.toMatch(/token|password|secret|http/i);
  });

  it("greets by first name and escapes merchant-controlled HTML", () => {
    const named = buildVerificationEmail("محمد حداد", "https://app/auth/verify-email?token=t", "t");
    expect(named.text).toContain("مرحبًا محمد،");
    expect(named.html).toContain("مرحبًا محمد،");
    const evil = buildVerificationEmail('"><img src=x onerror=alert(1)>', "https://app/auth/verify-email?token=t", "t");
    expect(evil.html).not.toContain("<img src=x");
    expect(evil.html).toContain("&lt;img");
  });

  it("order confirmation lists server values with store context", () => {
    const m = buildOrderConfirmationEmail(
      "Demo Store",
      {
        id: "o",
        store_id: "s",
        order_number: 1007,
        status: "pending",
        subtotal: 200,
        discount: 0,
        total: 250,
        payment_method: "cod",
        payment_status: "pending",
        payment_reference: null,
        tracking_number: null,
        customer_name: "Buyer",
        customer_phone: "+9631",
        shipping_method: "Standard",
        shipping_cost: 50,
        shipping_governorate: "Damascus",
        shipping_address: "X",
      },
      [{ id: "i", product_name: "Soap", quantity: 2, unit_price: 100, line_total: 200 }]
    );
    expect(m.subject).toContain("1007");
    expect(m.subject).toContain("Demo Store");
    expect(m.text).toContain("Soap");
    expect(m.text).toContain("250");
    expect(m.text).toContain("pending");
  });

  it("status mail names store, order, and both states", () => {
    const m = buildStatusEmail("Demo Store", 42, "payment", "paid", "pending");
    expect(m.subject).toContain("42");
    expect(m.subject).toContain("Demo Store");
    expect(m.text).toContain("paid");
    expect(m.text).toContain("pending");
    const first = buildStatusEmail("S", 1, "status", "confirmed", null);
    expect(first.text).toContain("confirmed");
  });
});

describe("email tokens", () => {
  it("issues opaque tokens and redeems exactly once", async () => {
    const { db, rows } = stubDb();
    const { token } = await issueEmailToken(db, "u1", "verify", VERIFY_TOKEN_TTL_MS);
    expect(token.length).toBeGreaterThan(20);
    expect(rows.size).toBe(1);
    const stored = [...rows.values()][0]!;
    expect(stored.token_hash).not.toContain(token);
    expect(stored.token_hash).toBe(await hashEmailToken(token));

    expect(await redeemEmailToken(db, token, "verify")).toEqual({ userId: "u1" });
    expect(await redeemEmailToken(db, token, "verify")).toBeNull();
    expect(await redeemEmailToken(db, token, "reset")).toBeNull();
    expect(await redeemEmailToken(db, "forged-token-value", "verify")).toBeNull();
  });

  it("retires prior live tokens on re-issue", async () => {
    const { db } = stubDb();
    const first = await issueEmailToken(db, "u1", "reset", 3600_1000);
    const second = await issueEmailToken(db, "u1", "reset", 3600_1000);
    expect(await redeemEmailToken(db, first.token, "reset")).toBeNull();
    expect(await redeemEmailToken(db, second.token, "reset")).toEqual({ userId: "u1" });
  });

  it("rejects expired tokens", async () => {
    const { db, rows } = stubDb();
    const { token } = await issueEmailToken(db, "u1", "verify", VERIFY_TOKEN_TTL_MS);
    const hash = await hashEmailToken(token);
    rows.get(hash)!.expires_at = "2000-01-01T00:00:00Z";
    expect(await redeemEmailToken(db, token, "verify")).toBeNull();
  });

  it("token strings are high-entropy and unique", () => {
    expect(new Set([newEmailToken(), newEmailToken(), newEmailToken()]).size).toBe(3);
  });

  it("finds users by email for the forgot flow", async () => {
    const { db } = stubDb({ user: { id: "u9", name: "N", email: "n@x.y" } });
    expect(await findUserByEmail(db, "n@x.y")).toEqual({ id: "u9", name: "N", email: "n@x.y" });
    const { db: empty } = stubDb({ user: null });
    expect(await findUserByEmail(empty, "nobody@x.y")).toBeNull();
  });
});
