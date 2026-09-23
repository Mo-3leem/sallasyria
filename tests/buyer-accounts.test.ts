import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import {
  buyerStoreOf,
  createBuyerSession,
  findAccountByEmail,
  loginBuyer,
  markBuyerVerified,
  registerBuyer,
  resolveBuyerSession,
  revokeBuyerSession,
  setBuyerPassword,
  updateBuyerName,
  type BuyerRow,
} from "../src/services/buyers.js";
import {
  issueBuyerToken,
  redeemBuyerToken,
} from "../src/services/buyer-tokens.js";

// In-memory D1 double honoring the exact SQL shapes used by the buyer
// services. Customers/sessions/tokens live in maps; RETURNING is served via
// .first(), exactly as the services consume it.
interface Customer {
  id: string;
  store_id: string;
  name: string;
  phone: string;
  email: string | null;
  password_hash: string | null;
  email_verified: number;
}
interface Session {
  id: string;
  customer_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}
interface Token {
  id: string;
  customer_id: string;
  purpose: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
}

function stubDb() {
  const customers = new Map<string, Customer>();
  const sessions = new Map<string, Session>();
  const tokens = new Map<string, Token>();
  const cols = (c: Customer): BuyerRow => ({ ...c });

  const db = {
    __customers: customers,
    __sessions: sessions,
    __tokens: tokens,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        const stmt = {
          run: async () => ({ meta: { changes: 1 } }),
          first: async (): Promise<unknown> => null,
          all: async () => ({ results: [] }),
        };
        // --- customers reads ---
        if (sql.startsWith("SELECT id, store_id, name, phone, email, password_hash, email_verified FROM customers WHERE store_id = ? AND phone = ?")) {
          const [storeId, phone] = args as [string, string];
          const found = [...customers.values()].find((c) => c.store_id === storeId && c.phone === phone);
          return { ...stmt, first: async () => (found ? cols(found) : null) };
        }
        if (sql.startsWith("SELECT id, store_id, name, phone, email, password_hash, email_verified FROM customers WHERE store_id = ? AND email = ? LIMIT 1")) {
          const [storeId, email] = args as [string, string];
          const found = [...customers.values()].find((c) => c.store_id === storeId && c.email === email);
          return { ...stmt, first: async () => (found ? cols(found) : null) };
        }
        if (sql.startsWith("SELECT id FROM customers WHERE store_id = ? AND email = ? AND password_hash IS NOT NULL LIMIT 1")) {
          const [storeId, email] = args as [string, string];
          const found = [...customers.values()].find(
            (c) => c.store_id === storeId && c.email === email && c.password_hash !== null
          );
          return { ...stmt, first: async () => (found ? { id: found.id } : null) };
        }
        // --- registration writes ---
        if (sql.startsWith("UPDATE customers SET name = ?, email = ?, password_hash = ?")) {
          const [name, email, hash, , id] = args as [string, string | null, string, string, string];
          const c = customers.get(id);
          if (!c) return { ...stmt, first: async () => null };
          c.name = name;
          c.email = email;
          c.password_hash = hash;
          c.email_verified = 0;
          return { ...stmt, first: async () => cols(c) };
        }
        if (sql.startsWith("INSERT INTO customers (id, store_id, name, phone, email, password_hash, email_verified")) {
          const [id, storeId, name, phone, email, hash] = args as [string, string, string, string, string | null, string, number, string, string];
          if ([...customers.values()].some((c) => c.store_id === storeId && c.phone === phone)) {
            throw new Error("UNIQUE constraint failed: customers.store_id, customers.phone");
          }
          const c: Customer = { id, store_id: storeId, name, phone, email, password_hash: hash, email_verified: 0 };
          customers.set(id, c);
          return { ...stmt, first: async () => cols(c) };
        }
        // --- sessions ---
        if (sql.startsWith("INSERT INTO buyer_sessions")) {
          const [id, customerId, tokenHash, expiresAt, lastUsed] = args as [string, string, string, string, string, string, string];
          sessions.set(tokenHash, { id, customer_id: customerId, token_hash: tokenHash, expires_at: expiresAt, revoked_at: null, last_used_at: lastUsed });
          return stmt;
        }
        if (sql.startsWith("SELECT s.id AS sid")) {
          const [tokenHash] = args as [string];
          const s = sessions.get(tokenHash);
          const c = s ? customers.get(s.customer_id) : undefined;
          return {
            ...stmt,
            first: async () =>
              s && c
                ? {
                    sid: s.id,
                    customer_id: s.customer_id,
                    expires_at: s.expires_at,
                    revoked_at: s.revoked_at,
                    last_used_at: s.last_used_at,
                    id: c.id,
                    store_id: c.store_id,
                    name: c.name,
                    phone: c.phone,
                    email: c.email,
                    password_hash: c.password_hash,
                    email_verified: c.email_verified,
                  }
                : null,
          };
        }
        if (sql.startsWith("UPDATE buyer_sessions SET last_used_at")) {
          const [nowIso, sid] = args as [string, string];
          for (const s of sessions.values()) if (s.id === sid) s.last_used_at = nowIso;
          return stmt;
        }
        if (sql.startsWith("UPDATE buyer_sessions SET revoked_at")) {
          const [nowIso, target] = args as [string, string];
          // Handles both revoke-by-id and revoke-by-customer (reset flow).
          for (const s of sessions.values()) {
            if (s.id === target || s.customer_id === target) s.revoked_at = nowIso;
          }
          return stmt;
        }
        // --- profile / verify / reset ---
        if (sql.startsWith("UPDATE customers SET name = ?, updated_at")) {
          const [name, , id] = args as [string, string, string];
          const c = customers.get(id);
          if (!c) return { ...stmt, first: async () => null };
          c.name = name;
          return { ...stmt, first: async () => cols(c) };
        }
        if (sql.startsWith("UPDATE customers SET email_verified = 1")) {
          const [, id] = args as [string, string];
          const c = customers.get(id);
          if (c) c.email_verified = 1;
          return stmt;
        }
        if (sql.startsWith("UPDATE customers SET password_hash = ?")) {
          const [hash, , id] = args as [string, string, string];
          const c = customers.get(id);
          if (c) c.password_hash = hash;
          return stmt;
        }
        if (sql.startsWith("SELECT store_id FROM customers WHERE id = ?")) {
          const [id] = args as [string];
          const c = customers.get(id);
          return { ...stmt, first: async () => (c ? { store_id: c.store_id } : null) };
        }
        if (sql.startsWith("SELECT id, email, name FROM customers WHERE store_id = ? AND email = ? AND password_hash IS NOT NULL LIMIT 1")) {
          const [storeId, email] = args as [string, string];
          const found = [...customers.values()].find(
            (c) => c.store_id === storeId && c.email === email && c.password_hash !== null
          );
          return {
            ...stmt,
            first: async () => (found ? { id: found.id, email: found.email, name: found.name } : null),
          };
        }
        // --- buyer tokens ---
        if (sql.startsWith("UPDATE buyer_tokens SET used_at = ? WHERE customer_id")) {
          const [nowIso, customerId, purpose] = args as [string, string, string];
          for (const t of tokens.values()) {
            if (t.customer_id === customerId && t.purpose === purpose && t.used_at === null) t.used_at = nowIso;
          }
          return stmt;
        }
        if (sql.startsWith("INSERT INTO buyer_tokens")) {
          const [id, customerId, purpose, tokenHash, expiresAt] = args as [string, string, string, string, string, string];
          tokens.set(tokenHash, { id, customer_id: customerId, purpose, token_hash: tokenHash, expires_at: expiresAt, used_at: null });
          return stmt;
        }
        if (sql.startsWith("SELECT id, customer_id, purpose, token_hash, expires_at, used_at FROM buyer_tokens")) {
          const [tokenHash, purpose] = args as [string, string];
          const t = tokens.get(tokenHash);
          return { ...stmt, first: async () => (t && t.purpose === purpose ? { ...t } : null) };
        }
        if (sql.startsWith("UPDATE buyer_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL")) {
          const [nowIso, id] = args as [string, string];
          let changes = 0;
          for (const t of tokens.values()) {
            if (t.id === id && t.used_at === null) {
              t.used_at = nowIso;
              changes = 1;
            }
          }
          return { run: async () => ({ meta: { changes } }) };
        }
        throw new Error(`unexpected SQL in stub: ${sql.slice(0, 80)}`);
      },
    }),
    batch: async (stmts: { run?: () => Promise<unknown> }[]) => {
      const out = [];
      for (const s of stmts) {
        await s.run?.();
        out.push({ success: true });
      }
      return out;
    },
  } as unknown as D1Database & {
    __customers: Map<string, Customer>;
    __sessions: Map<string, Session>;
    __tokens: Map<string, Token>;
  };
  return { db, customers, sessions, tokens };
}

const STORE = "store-1";
const OTHER = "store-2";

describe("buyer accounts", () => {
  it("registers and logs in by phone and email", async () => {
    const { db } = stubDb();
    const { buyer } = await registerBuyer(db, STORE, {
      name: "Layla",
      phone: "+963991234567",
      email: "layla@example.com",
      password: "Correct-Horse-9x!",
    });
    expect(buyer.email_verified).toBe(0);
    const byPhone = await loginBuyer(db, STORE, "+963991234567", "Correct-Horse-9x!");
    expect(byPhone.id).toBe(buyer.id);
    const byEmail = await loginBuyer(db, STORE, "LAYLA@example.com", "Correct-Horse-9x!");
    expect(byEmail.id).toBe(buyer.id);
  });

  it("converts a guest row by same phone, retaining the id", async () => {
    const { db, customers } = stubDb();
    customers.set("guest-1", {
      id: "guest-1",
      store_id: STORE,
      name: "Guest",
      phone: "+963991111111",
      email: null,
      password_hash: null,
      email_verified: 0,
    });
    const { buyer, converted } = await registerBuyer(db, STORE, {
      name: "Guest Now",
      phone: "+963991111111",
      email: null,
      password: "Correct-Horse-9x!",
    });
    expect(converted).toBe(true);
    expect(buyer.id).toBe("guest-1");
    const authed = await loginBuyer(db, STORE, "+963991111111", "Correct-Horse-9x!");
    expect(authed.id).toBe("guest-1");
  });

  it("rejects a phone owned by an account and a taken email", async () => {
    const { db } = stubDb();
    await registerBuyer(db, STORE, {
      name: "A",
      phone: "+963992222222",
      email: "a@example.com",
      password: "Correct-Horse-9x!",
    });
    await expect(
      registerBuyer(db, STORE, { name: "B", phone: "+963992222222", password: "Correct-Horse-9x!" })
    ).rejects.toMatchObject({ code: "user_exists" });
    await expect(
      registerBuyer(db, STORE, { name: "C", phone: "+963993333333", email: "a@example.com", password: "Correct-Horse-9x!" })
    ).rejects.toMatchObject({ code: "email_taken" });
    // Same credentials in another store are independent.
    const other = await registerBuyer(db, OTHER, {
      name: "A2",
      phone: "+963992222222",
      email: "a@example.com",
      password: "Correct-Horse-9x!",
    });
    expect(other.buyer.store_id).toBe(OTHER);
  });

  it("never authenticates guest rows; wrong password is indistinguishable", async () => {
    const { db, customers } = stubDb();
    customers.set("guest-2", {
      id: "guest-2",
      store_id: STORE,
      name: "Guest",
      phone: "+963994444444",
      email: null,
      password_hash: null,
      email_verified: 0,
    });
    await expect(loginBuyer(db, STORE, "+963994444444", "anything")).rejects.toMatchObject({
      code: "user_not_found",
    });
    await registerBuyer(db, STORE, { name: "D", phone: "+963995555555", password: "Correct-Horse-9x!" });
    await expect(loginBuyer(db, STORE, "+963995555555", "wrong-password")).rejects.toMatchObject({
      code: "user_not_found",
    });
    await expect(loginBuyer(db, STORE, "+963990000000", "wrong-password")).rejects.toMatchObject({
      code: "user_not_found",
    });
  });

  it("sessions resolve, revoke, and die with the password", async () => {
    const { db } = stubDb();
    const { buyer } = await registerBuyer(db, STORE, { name: "E", phone: "+963996666666", password: "Correct-Horse-9x!" });
    const { token } = await createBuyerSession(db, buyer.id);
    const session = await resolveBuyerSession(db, token);
    expect(session?.buyer.id).toBe(buyer.id);
    await revokeBuyerSession(db, session!.id);
    expect(await resolveBuyerSession(db, token)).toBeNull();
    const { token: token2 } = await createBuyerSession(db, buyer.id);
    expect((await resolveBuyerSession(db, token2))?.buyer.id).toBe(buyer.id);
    await setBuyerPassword(db, buyer.id, "Brand-New-Pass-1!");
    expect(await resolveBuyerSession(db, token2)).toBeNull();
    const relogin = await loginBuyer(db, STORE, "+963996666666", "Brand-New-Pass-1!");
    expect(relogin.id).toBe(buyer.id);
  });

  it("verify tokens are single-use and purpose-bound; email flips verified", async () => {
    const { db } = stubDb();
    const { buyer } = await registerBuyer(db, STORE, {
      name: "F",
      phone: "+963997777777",
      email: "f@example.com",
      password: "Correct-Horse-9x!",
    });
    const { token } = await issueBuyerToken(db, buyer.id, "verify_email", 24 * 3600 * 1000);
    expect(await redeemBuyerToken(db, token, "reset_password")).toBeNull();
    const redeemed = await redeemBuyerToken(db, token, "verify_email");
    expect(redeemed?.customer_id).toBe(buyer.id);
    expect(await redeemBuyerToken(db, token, "verify_email")).toBeNull();
    await markBuyerVerified(db, buyer.id);
    const me = await loginBuyer(db, STORE, "+963997777777", "Correct-Horse-9x!");
    expect(me.email_verified).toBe(1);
    expect(await buyerStoreOf(db, buyer.id)).toBe(STORE);
  });

  it("reset lookup finds only accounts with a deliverable email", async () => {
    const { db, customers } = stubDb();
    await registerBuyer(db, STORE, {
      name: "G",
      phone: "+963998888888",
      email: "g@example.com",
      password: "Correct-Horse-9x!",
    });
    customers.set("guest-3", {
      id: "guest-3",
      store_id: STORE,
      name: "Guest",
      phone: "+963999999999",
      email: "guest@example.com",
      password_hash: null,
      email_verified: 0,
    });
    expect((await findAccountByEmail(db, STORE, "g@example.com"))?.id).toBeTruthy();
    expect(await findAccountByEmail(db, STORE, "guest@example.com")).toBeNull();
    expect(await findAccountByEmail(db, STORE, "nobody@example.com")).toBeNull();
  });

  it("updates the buyer name", async () => {
    const { db } = stubDb();
    const { buyer } = await registerBuyer(db, STORE, { name: "Old", phone: "+963990101010", password: "Correct-Horse-9x!" });
    const updated = await updateBuyerName(db, buyer.id, "New");
    expect(updated.name).toBe("New");
  });
});
