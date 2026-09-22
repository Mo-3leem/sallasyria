# Billing Gateway Handoff — Salla Syria Phase 8

The self-serve billing stack is **key-ready**: the stub adapter runs the
full flow locally with no money and no vendor, and the generic gateway
skeleton (`src/lib/billing/real.ts`) implements the same
`PaymentProvider` interface. Going live with a real gateway is a
**keys-only operation** — no application code changes.

> This file documents key NAMES and behavior only. It never contains
> values. Secrets live exclusively in `wrangler secret` / the Cloudflare
> dashboard (production) or `.dev.vars` (local, never committed).

## Exact environment names to request

| Name | Kind | Unlocks |
|---|---|---|
| `PAYMENT_PROVIDER` | var (`stub` default, `real` arms gateway) | Selects the adapter. Anything else → 404 on provider paths. |
| `PROVIDER_API_KEY` | secret | Real-gateway server calls (VENDOR HOOK: create). |
| `PROVIDER_WEBHOOK_SECRET` | secret | HMAC verification of provider callbacks. |
| `PROVIDER_BASE_URL` | secret/var | Generic hosted-pay redirect base. |
| `TRIAL_DAYS` | var (default `14`, `0` disables) | Free trialing period auto-granted on store creation. |
| `TRIAL_PLAN_CODE` | var (default `basic`) | Plan the trial period references. |

All three real-gateway values must be present together: any one missing
fails closed with **503 `payment_unavailable`** (never fail-open, never a
half-charged state). Test-vs-prod separation is by secret VALUE: use the
vendor's sandbox keys in dev, live keys in production secrets — the code
path is identical.

## Webhook URL to register at the provider

```text
https://<api-domain>/billing/webhook/real
```

Redirect/hosted flow only — our servers never accept card data (no PAN
handling exists anywhere by design). The provider must send:
`X-Provider-Signature` (HMAC-SHA256 of `<timestamp>.<raw-body>`),
`X-Provider-Timestamp` (unix millis, ±5 min window), and a JSON body with
`{ id, intent_id, status, amount?, currency? }`.

## Refund capability question (for the manager → vendor)

Refunds are recorded as order `payment_status` transitions (`paid →
refunded`) initiated by the merchant/admin in OUR system. Ask the vendor:
**does a refund require a server-to-server call, or is the dashboard
action sufficient?** If a call is required, it lands in ONE place —
the `queryIntent` VENDOR HOOK in `src/lib/billing/real.ts` — plus a small
`POST /stores/:storeId/orders/:id/refund` route that does NOT exist yet.
Do not build it until the vendor answers.

## What changes at key arrival (single step)

1. `wrangler secret put PROVIDER_API_KEY / PROVIDER_WEBHOOK_SECRET` (+ set
   `PROVIDER_BASE_URL`), 2. set `PAYMENT_PROVIDER=real`, 3. register the
   webhook URL above. No code deploy beyond config. Verify with one
   sandbox checkout end-to-end before switching live keys.
