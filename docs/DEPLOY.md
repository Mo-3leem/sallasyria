# Salla Syria — Production Deployment Runbook (B8)

All remote steps below require operator Cloudflare credentials (`wrangler login`).
Nothing here runs implicitly; each step states its verification. Forward-only
migrations: there are no down migrations — a bad migration is fixed by a new
forward migration, or by restore-from-backup (section 6).

## 0. Preconditions (first-prod-write gate)

- [ ] Full local suite green: `npm test`, `npm run check`, `npm run db:test:all`.
- [ ] Migration hashes verified (section 3).
- [ ] A restore rehearsal has completed AGAINST A SCRATCH DATABASE (section 6).
      The first production write is BLOCKED until this box is checked.

## 1. Secrets (dashboard or `wrangler secret put --env production`)

| Secret | Purpose | If missing |
|---|---|---|
| `ADMIN_BOOTSTRAP_PASSWORD` | one-time seed admin | seed refuses |
| `TURNSTILE_SECRET` | public-mutation bot defense | public mutations 503 (fail-closed) |
| `URL_SIGNING_SECRET` | image upload + signed URLs | upload/serve 503 (fail-closed) |

Generate signing-grade values (e.g. `openssl rand -base64 32`). Rotate by
setting the new value; sessions/tokens are unaffected (only future signatures
use it). Never commit secrets: `.dev.vars` is gitignored; `.dev.vars.example`
is the only template.

## 2. Remote D1 + first migrate

```powershell
wrangler d1 create sallasyria-db
# paste the returned database_id into wrangler.jsonc env.production.d1_databases
npx wrangler types worker-configuration.d.ts   # regenerate after config edits
wrangler d1 migrations list sallasyria-db --remote --env production
wrangler d1 migrations apply sallasyria-db --remote --env production
wrangler d1 migrations list sallasyria-db --remote --env production  # all applied
```

Verify schema remotely (FK + index smoke — proves remote enforces like local):

```sql
-- exactly 14 application tables (12 domain + sessions + idempotency_keys)
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
-- zero triggers by design
SELECT type, name FROM sqlite_master WHERE type='trigger';
-- required indexes present (compare against structure doc footnote)
SELECT tbl_name, name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY 1,2;
-- FK spot check: must fail
INSERT INTO stores (id, owner_id, slug, name) VALUES ('probe','ghost','probe','Probe');
-- expected: FOREIGN KEY constraint failed
```

NOTE: `idempotency_keys` + `sessions` bring the domain total to 14 tables
(12 MVP + 2 approved additions). Count accordingly.

## 3. R2 provisioning

```powershell
wrangler r2 bucket create sallasyria-images-prod
```

Bucket stays private (no public access, no custom domain): objects are
readable ONLY through the Worker's signed `/file/:key?exp&sig` route
(15-minute TTL, store-bound HMAC). Uploads: merchant-only
`POST /stores/:storeId/product-images/upload` (auth + ownership + gate),
validated server-side: 5 MB cap, magic-byte sniffing (claimed MIME ignored),
EXIF/metadata stripping, random namespaced keys.

## 4. Deploy

```powershell
npm run check; npm test                       # local gate, must be green
wrangler deploy --env production
```

Rollback: `wrangler rollback --env production` (Worker versions; data
migrations are forward-only — see section 6 if data must be rewound).

## 5. Smoke (remote)

```powershell
$env:SMOKE_BASE_URL = "https://api.<your-domain>"
node scripts/smoke.mjs                        # health, ready, 404, CORS
$env:SMOKE_PHONE = "<test-merchant>"; $env:SMOKE_PASSWORD = "<secret>"
node scripts/smoke.mjs                        # + login/me/logout flow
```

Manual first-write gate: one real test purchase on prod, then cancel/void it.
Only then announce.

## 6. Backup / restore (RPO/RTO)

- **Schedule:** `node scripts/backup.mjs --env production --allow-remote`
  (add `--dry-run` to preview). Minimum **daily** via external cron/CI.
  Artifacts: versioned `db-backups/*.sql` in the restricted R2 bucket.
- **RPO ≤ 24h** by construction at daily cadence. **RTO: hours**, measured by
  the rehearsal below (not by assertion).
- **Restore rehearsal** (before first prod write, then quarterly minimum):
  1. `wrangler d1 create sallasyria-restore-test`
  2. Restore the newest backup into it (see `wrangler d1 execute --remote --file`
     against the test DB, or time-travel restore per current docs).
  3. Run the parity battery on BOTH databases and diff:
     - per-table `COUNT(*)` (all 14 tables);
     - `PRAGMA foreign_key_check;` → must return zero rows;
     - spot-check newest `orders.order_number` sequence per store.
  4. Destroy the test database. Record RTO (start→verified) in the ops log.

## 7. Monitoring / alerting

- Structured logs already emitted: `audit action=…` (admin/security events),
  `maintenance …` (cron purges), `unhandled_error …` (bugs), access lines.
- Minimum viable observability: `wrangler tail --env production` during
  rollout; then Workers Logpush to R2 + alerts on: 5xx rate spike, login
  failure spike (`invalid_credentials` burst), checkout 409/503 burst,
  `turnstile_failed` burst. Review alert thresholds after week one.

## 8. Environment separation

Local (`wrangler dev`) and production (`--env production`) share NOTHING:
separate D1 databases, separate R2 buckets, separate secrets. `.dev.vars`
never leaves the machine. Remote migrations run only with `--remote` +
explicit review of `migrations list` before/after.
