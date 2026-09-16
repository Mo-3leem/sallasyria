# Salla Syria — multi-tenant e-commerce (Hono + D1)

## Commands

```powershell
npm run dev              # wrangler dev (Worker + local D1)
npm test                 # vitest run (B1 unit + route tests)
npm run check            # tsc --noEmit
npm run db:migrate:local # apply migrations to local D1
npm run db:test:all      # full DB verification suite (must stay green)
npm run db:clean         # remove all verification fixtures
```

## Conventions (B1, binding)

- Response envelope: `{ ok: true, data }` / `{ ok: false, error: { code, message } }`.
- Expected failures throw `AppError(code, status, client-safe message)`; anything else becomes a sanitized 500.
- D1 access only via `getDb(c)`; parameterized statements only; multi-statement atomic writes via `db.batch()` (no BEGIN/COMMIT, no PRAGMAs).
- IDs are app-generated UUIDv7 (`src/lib/ids.ts`); timestamps UTC ISO without millis (`src/lib/time.ts`); `updated_at` is app-managed (`touch()`).
- Validation: zod schemas via `src/http/validate.ts` (`zValidator`).
- Logging policy: method + path + status + duration only — never query strings, headers, cookies, or bodies.
- Same-origin deployment: API under `/api/*` on the frontend domain; `SameSite=Lax` cookies; Origin/Referer checks on mutations (B2).
- Migrations are forward-only and frozen once applied (`0001–0004` pinned; see DB track).

## Auth (B2)

- Stateful opaque sessions (`sessions` table, migration `0005`).
- Login: `POST /auth/login` (phone+password) → `ss_session` HttpOnly cookie.
- `POST /auth/logout` revokes server-side immediately; `POST /auth/logout-others`
  revokes all other sessions; `GET /auth/me` returns the caller (no hashes).
- B2-A password decision (verified, not assumed): `@noble/hashes` scrypt
  `N=16384 r=8 p=1 dkLen=32` — pure JS over `globalThis.crypto` (no Node
  built-ins; confirmed by package inspection), functional in Node WebCrypto,
  and proven in real workerd by the login integration tests. Format
  `s1$N$r$p$saltHex$hashHex` (versioned for future rotation). Documented
  fallback: WebCrypto PBKDF2-SHA256 x300k.
- Sessions: 7-day absolute expiry + 24h idle expiry; `last_used_at` touched at
  most every 15 min; login rate-limited per IP+phone (10/10min, per isolate).
- No `store_id` in sessions — tenancy resolves per request (B3).

## Tenancy (B3)

- Store id comes ONLY from the path via `resolveStore` → trusted `storeId`;
  `storeScope(c)` is the sole reader (throws 500 if unset — fail-closed).
- Services take explicit `storeId` args and own all SQL; routes contain zero
  SQL strings (`tests/tenant-conventions.test.ts` enforces both + the
  `.param()`/request-mixing bans).
- Foreign and missing stores answer identical 404s (no existence oracle).
- `store_id`/`id` in request bodies are 400 `immutable_field`, even matching.
- Subscription gate: merchant writes need a covering active/trialing period
  (`requireActiveSubscription`); reads stay open; admins bypass (audited).
- Admin cross-store reads/writes emit `audit action=…` log lines.
- Global 1 MB JSON body cap → 413 envelope (audit F3).
- `GET /stores`, `GET /stores/:storeId`, `PATCH /stores/:storeId` (`{name}` only;
  `order_counter` never serialized).

## Catalog (B4)

- Categories/products/images CRUD under `/stores/:storeId/...`, all behind
  auth + store resolution + ownership + subscription gate (writes only).
- `DELETE /categories/:id` → 409 `has_dependents` while referenced;
  `?detach=true` unassigns products/children in the same batch, then deletes.
- Products/images retire via soft-delete (idempotent); `POST /:id/restore`
  revives (409 while a live row holds the slug). No hard-delete routes.
- `max_products` enforced at product create (documented concurrent-create race).
- Slugs: lowercase alphanumeric + dashes; image URLs must be https
  (Worker upload flow becomes the sole R2-URL writer in B8).
- Deleted/inactive products are unpurchasable (enforced at B6 checkout).

## Buyers (B5)

- Public (no buyer login exists) vs merchant-private split, enforced per route:
  - PUBLIC: `POST /customers` (phone upsert), `POST /customer-addresses`,
    `POST /:id/make-default`, `GET /shipping-rates[/:id]`. All mutations behind
    Turnstile + per-store rate limit (60/min); reads need neither.
  - PRIVATE: customer/address list/get/patch/delete, all rate writes
    (mutations additionally gated by subscription).
- Phones normalized server-side (`src/lib/phone.ts`, incl. Arabic-Indic
  digits) before every match/write — formatting variants share one UNIQUE slot.
- Governorates: frozen 14 (`src/lib/governorates.ts`), same strings as the DDL.
- `is_default` writable ONLY via make-default (atomic unset+set batch);
  direct writes are 400. Governorate is identity on rates (PATCH forbids it).

## Checkout (B6)

- `POST /stores/:storeId/checkout` is PUBLIC (buyer flow): rate limit → gate
  (expired stores cannot sell) → Turnstile → one atomic `batch()`.
- Exactly-once via `idempotency_keys` (`X-Idempotency-Key` header): same
  key+body replays the order (200); same key+different body is 422; concurrent
  duplicates collapse to one order (UNIQUE-in-batch). No KV involved.
- Batch order: stock decrements → counter `UPDATE...RETURNING` → customer
  upsert → order `INSERT` (number read in-transaction via subquery) → items →
  key claim LAST (its FK needs the order row first). Any failure rolls back
  everything: no partial orders, no skipped numbers, no stock leak.
- Stock: tracked lines decrement guarded by the existing `CHECK>=0`
  (insufficient → batch aborts → 409, nothing moved); NULL means untracked;
  deleted/inactive/cross-store products are uniformly 409.
- Money: subtotal/total/discount keys in the body are 400; totals computed
  server-side; discount is 0 (no promotion engine); payment reference required
  unless cod; shipping method/cost come from the store's active rate row.
- Snapshots frozen at write; order/payment move only along explicit transition
  maps (terminal states final); post-commit purchasability recheck with
  compensating delete covers the retire-mid-flight race (counter gaps possible
  ONLY on failed checkouts — numbers never reused).
- Transient D1 contention retries ≤3 with backoff+jitter (default-deny
  classification; safe only because of idempotency); exhaustion → 503.
- Merchant reads/transitions: `GET /orders[/:id]`, `PATCH /:id/status`,
  `PATCH /:id/payment` (owner/admin + subscription gate).

## Ops (B7)

- Seed: `node scripts/seed.mjs --admin-password ...` (local by default;
  `--remote` requires `--allow-remote`). Idempotent natural-key upserts, never
  overwrites an existing admin hash. `.dev.vars` holds local secrets (gitignored).
- Bootstrap rotation: seeded admins log in with `must_rotate: true` and are
  403-gated everywhere except rotate/me/logout until `POST /auth/change-password`.
  Unset `ADMIN_BOOTSTRAP_PASSWORD` after rotation (the value stays a live
  credential otherwise). Change revokes all other sessions.
- Admin API (`/admin/*`, audited): subscriptions activate/cancel/renew
  (append-only; double-active is 409), assisted password reset (revokes all
  target sessions), dev-only maintenance purge.
- Hygiene crons: `scheduled()` purges expired/revoked sessions (30d) and
  consumed idempotency keys (72h). D1 exports run outside the Worker (B8).

## Production (B8)

- Same-origin deploy: Hono `/api/*` + frontend on one domain; envs in
  `wrangler.jsonc` (`production` overrides D1 id, R2 bucket, `ENVIRONMENT`).
- Secrets (`wrangler secret put --env production`): `ADMIN_BOOTSTRAP_PASSWORD`
  (one-time), `TURNSTILE_SECRET`, `URL_SIGNING_SECRET`. Absent signing/bot
  secrets fail closed (503), never open.
- Images: merchant upload validates size (5 MB), magic bytes (claimed MIME
  ignored), strips metadata (JPEG APP1/APP13, PNG text, GIF comments, WebP
  EXIF/XMP); private R2 objects under random keys; reads only via 15-min
  store-bound HMAC URLs (`GET .../file/:key?exp&sig`).
- Ops: `npm run backup` (daily cron minimum, RPO <= 24h), restore rehearsal
  before first prod write + quarterly (RTO measured, not asserted),
  `npm run smoke` with `SMOKE_BASE_URL`, rollback via `wrangler rollback`,
  forward-only migrations. Full procedure: `docs/DEPLOY.md`.
