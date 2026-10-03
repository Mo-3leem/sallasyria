import { test, expect } from "@playwright/test";
import { startE2E, stopE2E } from "./helpers.mjs";

// J1 bootstrap smoke: proves the real Next.js production frontend and the
// real workerd backend are integrated. No mocks, no injected data.
// Holder published incrementally by startE2E (see helpers.mjs): assigned
// before awaiting so afterAll can stop partial state on hook timeout.
let ctx: { stop?: () => void } | null = null;

// File-level hook boots both servers + resets D1 (see config timeout note).
// The holder is assigned BEFORE awaiting: if this hook times out while
// startE2E is still pending, afterAll still owns the published handles.
test.beforeAll(async () => {
  ctx = {};
  await startE2E({ seed: false }, ctx);
});

test.afterAll(async () => {
  await stopE2E(ctx);
  ctx = null;
});

test("J1: real frontend renders and backend /health answers via rewrite", async ({
  page,
  request,
}) => {
  // 1. Real frontend home page (frontend/src/app/page.tsx hero).
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /أطلِق متجرك الإلكتروني/ })
  ).toBeVisible();
  await expect(
    page.getByText("أكبر منصَّة سورية للتجارة الإلكترونية", { exact: true })
  ).toBeVisible();

  // 2. Backend liveness through the application's configured Next rewrite
  // (/api/backend/* -> workerd). Proves the proxy path the app itself uses.
  const res = await request.get("/api/backend/health");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body?.ok).toBe(true);
  expect(body?.data?.status).toBe("up");
});
