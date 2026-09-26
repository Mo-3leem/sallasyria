import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { AppError } from "../http/errors.js";
import { uuidv7 } from "../lib/ids.js";
import { normalizePhone } from "../lib/phone.js";
import { touch } from "../lib/time.js";

// Buyer-domain data access (roadmap B5). Same type-level boundary as catalog:
// explicit (db, storeId, ...) params, never Context; all SQL here (routes
// stay SQL-free per tests/tenant-conventions.test.ts). Phone normalization
// happens INSIDE the service (single choke) so no caller can store or match
// a raw variant and dodge the per-store UNIQUE slot.

export interface CustomerRow {
  id: string;
  store_id: string;
  name: string;
  phone: string;
  email: string | null;
}

export interface CustomerAddressRow {
  id: string;
  store_id: string;
  customer_id: string;
  recipient_name: string;
  phone: string;
  governorate: string;
  city: string | null;
  address_line: string;
  is_default: number;
}

export interface ShippingRateRow {
  id: string;
  store_id: string;
  governorate: string;
  shipping_method: string;
  cost: number;
  is_active: number;
}

// ---------------------------------------------------------------- customers

export interface CustomerInput {
  name: string;
  phone: string;
  email?: string | null;
}

// Insert-or-update by (store_id, phone): concurrent double-submits resolve
// atomically instead of surfacing UNIQUE errors to buyers (checkout contract).
// Split into builder + executor so checkout can embed the SAME statement in
// its batch (single atomic unit) instead of running a separate write.
export function buildUpsertCustomer(
  db: D1Database,
  storeId: string,
  input: CustomerInput,
  nowIso: string = touch()
): D1PreparedStatement {
  const phone = normalizePhone(input.phone);
  const id = uuidv7();
  return db
    .prepare(
      `INSERT INTO customers (id, store_id, name, phone, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store_id, phone) DO UPDATE SET
         name = excluded.name, email = excluded.email, updated_at = excluded.updated_at
       RETURNING *`
    )
    .bind(id, storeId, input.name, phone, input.email ?? null, nowIso, nowIso);
}

export async function upsertCustomer(
  db: D1Database,
  storeId: string,
  input: CustomerInput,
  nowIso: string = touch()
): Promise<CustomerRow> {
  const row = await buildUpsertCustomer(db, storeId, input, nowIso).first<CustomerRow>();
  if (!row) throw new AppError("internal", 500, "Something went wrong.");
  return row;
}

export async function listCustomers(db: D1Database, storeId: string): Promise<CustomerRow[]> {
  const res = await db
    .prepare("SELECT * FROM customers WHERE store_id = ? ORDER BY created_at")
    .bind(storeId)
    .all<CustomerRow>();
  return res.results ?? [];
}

export async function getCustomer(
  db: D1Database,
  storeId: string,
  id: string
): Promise<CustomerRow | null> {
  return db
    .prepare("SELECT * FROM customers WHERE store_id = ? AND id = ?")
    .bind(storeId, id)
    .first<CustomerRow>();
}

/**
 * Server-side customer search for admin tooling, strictly store-scoped.
 * Matches email (lowercased exact) or phone (canonical first, then the
 * exact typed value for legacy rows — same resolution as login). Capped
 * LIMIT: admin tooling, not a public API.
 */
export async function searchCustomers(
  db: D1Database,
  storeId: string,
  q: string | null
): Promise<CustomerRow[]> {
  const needle = (q ?? "").trim();
  if (needle === "") {
    const res = await db
      .prepare("SELECT * FROM customers WHERE store_id = ? ORDER BY created_at LIMIT 100")
      .bind(storeId)
      .all<CustomerRow>();
    return res.results ?? [];
  }
  const emailForm = needle.toLowerCase();
  let phoneForm: string | null = null;
  try {
    phoneForm = normalizePhone(needle);
  } catch {
    phoneForm = null;
  }
  const res = await db
    .prepare(
      `SELECT * FROM customers WHERE store_id = ? AND (email = ? OR phone = ? OR phone = ?)
       ORDER BY created_at LIMIT 100`
    )
    .bind(storeId, emailForm, phoneForm ?? needle, needle)
    .all<CustomerRow>();
  return res.results ?? [];
}

export interface CustomerPatch {
  name?: string;
  phone?: string;
  email?: string | null;
}

export async function updateCustomer(
  db: D1Database,
  storeId: string,
  id: string,
  patch: CustomerPatch,
  nowIso: string = touch()
): Promise<CustomerRow | null> {
  const current = await getCustomer(db, storeId, id);
  if (!current) return null;
  const next = {
    name: patch.name ?? current.name,
    phone: patch.phone === undefined ? current.phone : normalizePhone(patch.phone),
    email: patch.email === undefined ? current.email : patch.email,
  };
  try {
    await db
      .prepare("UPDATE customers SET name = ?, phone = ?, email = ?, updated_at = ? WHERE store_id = ? AND id = ?")
      .bind(next.name, next.phone, next.email, nowIso, storeId, id)
      .run();
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err))) {
      throw new AppError("phone_taken", 409, "Phone number is already used by another customer.");
    }
    throw err;
  }
  return getCustomer(db, storeId, id);
}

// A customer with orders cannot be removed (RESTRICT): history stays intact.
export async function deleteCustomer(
  db: D1Database,
  storeId: string,
  id: string
): Promise<{ deleted: string }> {
  const current = await getCustomer(db, storeId, id);
  if (!current) {
    throw new AppError("customer_not_found", 404, "Customer not found.");
  }
  try {
    await db
      .prepare("DELETE FROM customers WHERE store_id = ? AND id = ?")
      .bind(storeId, id)
      .run();
  } catch (err) {
    if (/FOREIGN KEY constraint failed/i.test(err instanceof Error ? err.message : String(err))) {
      throw new AppError("customer_has_orders", 409, "Customer has orders and cannot be removed.");
    }
    throw err;
  }
  return { deleted: id };
}

// ---------------------------------------------------------------- addresses

export interface CustomerAddressInput {
  customer_id: string;
  recipient_name: string;
  phone: string;
  governorate: string;
  city?: string | null;
  address_line: string;
}

async function customerInStore(db: D1Database, storeId: string, customerId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM customers WHERE store_id = ? AND id = ?")
    .bind(storeId, customerId)
    .first<{ ok: number }>();
  return row !== null;
}

export async function createAddress(
  db: D1Database,
  storeId: string,
  input: CustomerAddressInput,
  nowIso: string = touch()
): Promise<CustomerAddressRow> {
  if (!(await customerInStore(db, storeId, input.customer_id))) {
    throw new AppError("customer_not_found", 404, "Customer not found.");
  }
  const id = uuidv7();
  await db
    .prepare(
      `INSERT INTO customer_addresses (id, store_id, customer_id, recipient_name, phone, governorate, city, address_line, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .bind(
      id, storeId, input.customer_id, input.recipient_name, normalizePhone(input.phone),
      input.governorate, input.city ?? null, input.address_line, nowIso, nowIso
    )
    .run();
  const row = await getAddress(db, storeId, id);
  if (!row) throw new AppError("internal", 500, "Something went wrong.");
  return row;
}

export async function listAddresses(
  db: D1Database,
  storeId: string,
  customerId: string
): Promise<CustomerAddressRow[]> {
  if (!(await customerInStore(db, storeId, customerId))) {
    throw new AppError("customer_not_found", 404, "Customer not found.");
  }
  const res = await db
    .prepare("SELECT * FROM customer_addresses WHERE store_id = ? AND customer_id = ? ORDER BY created_at")
    .bind(storeId, customerId)
    .all<CustomerAddressRow>();
  return res.results ?? [];
}

export async function getAddress(
  db: D1Database,
  storeId: string,
  id: string
): Promise<CustomerAddressRow | null> {
  return db
    .prepare("SELECT * FROM customer_addresses WHERE store_id = ? AND id = ?")
    .bind(storeId, id)
    .first<CustomerAddressRow>();
}

export interface CustomerAddressPatch {
  recipient_name?: string;
  phone?: string;
  governorate?: string;
  city?: string | null;
  address_line?: string;
}

export async function updateAddress(
  db: D1Database,
  storeId: string,
  id: string,
  patch: CustomerAddressPatch,
  nowIso: string = touch()
): Promise<CustomerAddressRow | null> {
  const current = await getAddress(db, storeId, id);
  if (!current) return null;
  const next = {
    recipient_name: patch.recipient_name ?? current.recipient_name,
    phone: patch.phone === undefined ? current.phone : normalizePhone(patch.phone),
    governorate: patch.governorate ?? current.governorate,
    city: patch.city === undefined ? current.city : patch.city,
    address_line: patch.address_line ?? current.address_line,
  };
  await db
    .prepare(
      "UPDATE customer_addresses SET recipient_name = ?, phone = ?, governorate = ?, city = ?, address_line = ?, updated_at = ? WHERE store_id = ? AND id = ?"
    )
    .bind(next.recipient_name, next.phone, next.governorate, next.city, next.address_line, nowIso, storeId, id)
    .run();
  return getAddress(db, storeId, id);
}

export async function deleteAddress(
  db: D1Database,
  storeId: string,
  id: string
): Promise<{ deleted: string }> {
  const current = await getAddress(db, storeId, id);
  if (!current) {
    throw new AppError("address_not_found", 404, "Address not found.");
  }
  await db
    .prepare("DELETE FROM customer_addresses WHERE store_id = ? AND id = ?")
    .bind(storeId, id)
    .run();
  return { deleted: id };
}

// Atomic default swap: unset the old default and set the new one in ONE
// batch, so concurrent swaps can never leave two defaults (the partial
// unique index is the backstop, this is the mechanism). is_default is NOT
// patchable directly — this endpoint is the only writer.
export async function makeDefaultAddress(
  db: D1Database,
  storeId: string,
  id: string,
  nowIso: string = touch()
): Promise<CustomerAddressRow | null> {
  const current = await getAddress(db, storeId, id);
  if (!current) return null;
  const batch = await db.batch([
    db
      .prepare("UPDATE customer_addresses SET is_default = 0, updated_at = ? WHERE store_id = ? AND customer_id = ? AND is_default = 1")
      .bind(nowIso, storeId, current.customer_id),
    db
      .prepare("UPDATE customer_addresses SET is_default = 1, updated_at = ? WHERE store_id = ? AND id = ?")
      .bind(nowIso, storeId, id),
  ]);
  if (!batch.every((r) => r.success)) {
    throw new AppError("internal", 500, "Something went wrong.");
  }
  return getAddress(db, storeId, id);
}

// ---------------------------------------------------------------- rates

export interface ShippingRateInput {
  governorate: string;
  shipping_method: string;
  cost: number;
  is_active?: number;
}

export async function createRate(
  db: D1Database,
  storeId: string,
  input: ShippingRateInput,
  nowIso: string = touch()
): Promise<ShippingRateRow> {
  const id = uuidv7();
  try {
    await db
      .prepare(
        `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, storeId, input.governorate, input.shipping_method, input.cost, input.is_active ?? 1, nowIso, nowIso)
      .run();
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err))) {
      throw new AppError("rate_exists", 409, "A rate for this governorate already exists.");
    }
    throw err;
  }
  const row = await getRate(db, storeId, id);
  if (!row) throw new AppError("internal", 500, "Something went wrong.");
  return row;
}

export async function listRates(db: D1Database, storeId: string): Promise<ShippingRateRow[]> {
  const res = await db
    .prepare("SELECT * FROM shipping_rates WHERE store_id = ? ORDER BY governorate")
    .bind(storeId)
    .all<ShippingRateRow>();
  return res.results ?? [];
}

export async function getRate(
  db: D1Database,
  storeId: string,
  id: string
): Promise<ShippingRateRow | null> {
  return db
    .prepare("SELECT * FROM shipping_rates WHERE store_id = ? AND id = ?")
    .bind(storeId, id)
    .first<ShippingRateRow>();
}

export interface ShippingRatePatch {
  shipping_method?: string;
  cost?: number;
  is_active?: number;
}

export async function updateRate(
  db: D1Database,
  storeId: string,
  id: string,
  patch: ShippingRatePatch,
  nowIso: string = touch()
): Promise<ShippingRateRow | null> {
  const current = await getRate(db, storeId, id);
  if (!current) return null;
  const next = {
    shipping_method: patch.shipping_method ?? current.shipping_method,
    cost: patch.cost ?? current.cost,
    is_active: patch.is_active ?? current.is_active,
  };
  await db
    .prepare("UPDATE shipping_rates SET shipping_method = ?, cost = ?, is_active = ?, updated_at = ? WHERE store_id = ? AND id = ?")
    .bind(next.shipping_method, next.cost, next.is_active, nowIso, storeId, id)
    .run();
  return getRate(db, storeId, id);
}

export async function deleteRate(
  db: D1Database,
  storeId: string,
  id: string
): Promise<{ deleted: string }> {
  const current = await getRate(db, storeId, id);
  if (!current) {
    throw new AppError("rate_not_found", 404, "Shipping rate not found.");
  }
  await db
    .prepare("DELETE FROM shipping_rates WHERE store_id = ? AND id = ?")
    .bind(storeId, id)
    .run();
  return { deleted: id };
}
