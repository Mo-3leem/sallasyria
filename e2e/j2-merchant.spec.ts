import { test, expect } from "@playwright/test";
import { startE2E, stopE2E } from "./helpers.mjs";
import { E2E_MERCHANT, E2E_STORE } from "./fixtures.mjs";

// J2 merchant login → dashboard smoke: real seeded merchant, real login
// page, real HttpOnly session cookie, real dashboard. No cookie/token
// injection, no mocked auth or API calls. Fresh logins need no Turnstile
// (the widget only appears after repeated failures).
// Holder published incrementally by startE2E (see helpers.mjs): assigned
// before awaiting so afterAll can stop partial state on hook timeout.
let ctx: { stop?: () => void } | null = null;

// File-level hook boots both servers + resets D1 (see config timeout note).
// The holder is assigned BEFORE awaiting: if this hook times out while
// startE2E is still pending, afterAll still owns the published handles.
test.beforeAll(async () => {
  ctx = {};
  await startE2E({ seed: true }, ctx);
});

test.afterAll(async () => {
  await stopE2E(ctx);
  ctx = null;
});

test("J2: seeded merchant logs in and sees the dashboard store", async ({
  page,
  context,
}) => {
  // 1. Real login page + real form (frontend/src/app/auth/login/page.tsx).
  await page.goto("/auth/login");
  const identity = page.getByLabel(/البريد الإلكتروني أو رقم الهاتف/);
  await expect(identity).toBeVisible();
  // textbox role: the show/hide toggle button shares the label substring.
  const password = page.getByRole("textbox", { name: /كلمة المرور/ });
  await expect(password).toBeVisible();
  await expect(
    page.getByRole("button", { name: /تسجيل الدخول/ })
  ).toBeVisible();

  // 2. Submit the seeded credentials through the UI.
  await identity.fill(E2E_MERCHANT.email);
  await password.fill(E2E_MERCHANT.password);
  await page.getByRole("button", { name: /تسجيل الدخول/ }).click();

  // 3. Real post-login navigation to the authenticated app home.
  await page.waitForURL("**/app/dashboard", { timeout: 30_000 });

  // 4. The browser received the real HttpOnly session cookie.
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === "ss_session");
  expect(session).toBeTruthy();
  expect(session?.httpOnly).toBe(true);

  // 5. Real dashboard surface with the seeded store
  // (frontend/src/app/app/dashboard/page.tsx).
  await expect(
    page.getByRole("heading", { name: /لوحة التحكم/ })
  ).toBeVisible();
  // Store name renders twice (header switcher + dashboard row): assert the
  // dashboard row link, which also carries the seeded slug.
  await expect(
    page.getByRole("link", { name: new RegExp(`${E2E_STORE.name}.*${E2E_STORE.slug}`) })
  ).toBeVisible();
  await expect(page.getByText(E2E_MERCHANT.name).first()).toBeVisible();
});
