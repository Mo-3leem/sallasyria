import { test, expect } from "@playwright/test";
import { E2E_BACKEND_BASE, startE2E, stopE2E } from "./helpers.mjs";
import {
  E2E_ADMIN,
  E2E_DIRECTORY_COUNT,
  seedE2EAdmin,
  seedE2EMerchantDirectory,
} from "./fixtures.mjs";

// J3 admin directory smoke: real seeded admin, real login page, real
// HttpOnly session cookie, real admin directory with real pagination.
// No cookie/token injection, no mocked auth or API calls. The directory
// holds exactly E2E_DIRECTORY_COUNT merchants (page size 20 + 1), so the
// pager exposes precisely 2 pages.
let ctx: { stop?: () => void } | null = null;

test.beforeAll(async () => {
  ctx = {};
  await startE2E({ seed: false }, ctx);
  await seedE2EAdmin(E2E_BACKEND_BASE);
  await seedE2EMerchantDirectory(E2E_BACKEND_BASE);
});

test.afterAll(async () => {
  await stopE2E(ctx);
  ctx = null;
});

test("J3: seeded admin logs in and pages the merchant directory", async ({
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

  // 2. Submit the seeded admin credentials through the UI.
  await identity.fill(E2E_ADMIN.email);
  await password.fill(E2E_ADMIN.password);
  await page.getByRole("button", { name: /تسجيل الدخول/ }).click();

  // 3. Real post-login navigation + real HttpOnly session cookie.
  await page.waitForURL("**/app/dashboard", { timeout: 30_000 });
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === "ss_session");
  expect(session).toBeTruthy();
  expect(session?.httpOnly).toBe(true);

  // 4. Real admin landing surface (frontend/src/app/app/admin/layout.tsx).
  await page.goto("/app/admin");
  await expect(
    page.getByRole("heading", { name: /إدارة المنصة/ })
  ).toBeVisible();

  // 5. Real merchant directory (frontend/src/app/app/admin/merchants).
  // Scoped by the directory's own search to the deterministic e2edir
  // namespace: the shared local D1 legitimately holds merchants from other
  // suites (J2's merchant, demo data), and exact-count assertions must not
  // depend on them.
  await page.goto("/app/admin/merchants");
  await expect(page.getByRole("heading", { name: /التجار/ })).toBeVisible();
  const search = page.getByLabel(/البحث بالبريد الإلكتروني أو رقم الهاتف/);
  await expect(search).toBeVisible();
  await search.fill("e2edir");
  const totalAr = E2E_DIRECTORY_COUNT.toLocaleString("ar-SY");
  await expect(page.getByText(`عدد النتائج: ${totalAr}`)).toBeVisible();
  const rows = page.locator("a.store-row");
  await expect(rows).toHaveCount(20);
  await expect(page.getByText(/E2E Directory/).first()).toBeVisible();

  // 6. Real pagination: 21 rows at page size 20 → page 2 holds 1 row.
  const pager = page.getByRole("navigation", { name: /ترقيم الصفحات/ });
  await expect(pager).toBeVisible();
  const next = pager.getByRole("button", { name: "التالي" });
  const prev = pager.getByRole("button", { name: "السابق" });
  await expect(next).toBeEnabled();
  const page2Label = (2).toLocaleString("ar-SY");
  const firstPage1 = await rows.first().innerText();
  await next.click();
  await expect(
    pager.getByRole("button", { name: page2Label, exact: true })
  ).toHaveAttribute("aria-current", "page");
  await expect(rows).toHaveCount(1);
  const firstPage2 = await rows.first().innerText();
  expect(firstPage2).not.toBe(firstPage1);
  await expect(next).toBeDisabled();
  await expect(prev).toBeEnabled();
});
