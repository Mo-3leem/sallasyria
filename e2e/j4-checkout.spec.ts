import { test, expect } from "@playwright/test";
import { E2E_BACKEND_BASE, startE2E, stopE2E } from "./helpers.mjs";
import {
  E2E_CO_GUEST,
  E2E_CO_PRODUCT,
  E2E_CO_RATE,
  E2E_CO_STORE,
  readE2ECheckoutOrder,
  seedE2ECheckout,
} from "./fixtures.mjs";

// J4 guest checkout smoke: real storefront → product → cart → checkout →
// real order in D1. No API mocks, no cookie/token injection, no response
// stubbing. The E2E frontend build carries NEXT_PUBLIC_E2E_ALLOW_MISSING_
// TURNSTILE=1 (documented in frontend/.env.example); the backend stays on
// its existing local dev behavior. Single submit, fresh idempotency key.
const QTY = 2;

let ctx: { stop?: () => void } | null = null;

test.beforeAll(async () => {
  ctx = {};
  await startE2E({ seed: false }, ctx);
  await seedE2ECheckout(E2E_BACKEND_BASE);
});

test.afterAll(async () => {
  await stopE2E(ctx);
  ctx = null;
});

test("J4: guest completes checkout and the order persists", async ({ page }) => {
  const shop = `/s/${E2E_CO_STORE.slug}`;

  // 1. Real storefront renders the seeded published store + product.
  await page.goto(shop);
  await expect(page.locator(".shop-brand")).toContainText(E2E_CO_STORE.name);
  const productCard = page.getByRole("link", { name: new RegExp(E2E_CO_PRODUCT.name) }).first();
  await expect(productCard).toBeVisible();

  // 2. Real product page with details.
  await productCard.click();
  await page.waitForURL(`**/s/${E2E_CO_STORE.slug}/p/${E2E_CO_PRODUCT.slug}`);
  await expect(page.getByRole("heading", { name: E2E_CO_PRODUCT.name })).toBeVisible();

  // 3. Real add-to-cart (guest server cart) with quantity 2.
  await page.getByRole("button", { name: /زيادة الكمية/ }).click();
  await page.getByRole("button", { name: /أضف إلى السلة/ }).click();
  await expect(page.getByText(/أُضيف إلى السلة\./)).toBeVisible();

  // 4. Real navigation to checkout through the UI link.
  await page.getByRole("link", { name: /إتمام الشراء/ }).click();
  await page.waitForURL(`**/s/${E2E_CO_STORE.slug}/checkout`);
  await expect(page.getByRole("heading", { name: /إتمام الشراء/ })).toBeVisible();
  const cartLine = page.locator(".shop-cart-line", { hasText: E2E_CO_PRODUCT.name });
  await expect(cartLine).toBeVisible();

  // 5. Real guest form (stable co-* ids audited in the checkout page).
  await page.locator("#co-name").fill(E2E_CO_GUEST.name);
  await page.locator("#co-phone").fill(E2E_CO_GUEST.phone);
  await page.locator("#co-email").fill(E2E_CO_GUEST.email);
  await page.locator("#co-recipient").fill(E2E_CO_GUEST.name);
  await page.locator("#co-ship-phone").fill(E2E_CO_GUEST.phone);
  await page.locator("#co-address").fill(E2E_CO_GUEST.address);
  // Seeded Damascus rate is the default governorate: assert it explicitly.
  await expect(page.locator("#co-gov")).toHaveValue(E2E_CO_RATE.governorate);

  // 6. Confirm enabled proves the shipping rate resolved (rateState ready)
  // and the E2E Turnstile gate passes without a widget token.
  const confirm = page.locator('button.checkout-confirm[type="submit"]');
  await expect(confirm).toBeEnabled();

  // 7. Real submit through Browser → Next rewrite → Hono → D1.
  await confirm.click();
  await expect(
    page.getByRole("heading", { name: /شكراً لك! تم استلام طلبك\./ })
  ).toBeVisible();
  const orderRef = page.getByText(/رقم الطلب/);
  await expect(orderRef).toBeVisible();
  // UI formats the number in Arabic-Indic digits; normalize to compare
  // against the backend row below.
  const uiNumber = ((await orderRef.innerText()).replace(/[^٠-٩0-9]/g, "") ?? "").replace(
    /[٠-٩]/g,
    (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))
  );

  // 8. Backend proof: the order really exists with the submitted data.
  const { order, items, customers, stock } = readE2ECheckoutOrder();
  expect(order).not.toBeNull();
  expect(String(order!.order_number)).toBe(uiNumber);
  expect(order!.status).toBe("pending");
  expect(order!.payment_status).toBe("pending");
  expect(order!.customer_name).toBe(E2E_CO_GUEST.name);
  expect(order!.customer_phone).toBe(E2E_CO_GUEST.phone);
  expect(order!.shipping_governorate).toBe(E2E_CO_RATE.governorate);
  expect(order!.shipping_method).toBe(E2E_CO_RATE.shipping_method);
  expect(order!.shipping_cost).toBe(E2E_CO_RATE.cost);
  // Backend composes "recipient, address (phone)" from the submitted block.
  expect(order!.shipping_address).toBe(
    `${E2E_CO_GUEST.name}, ${E2E_CO_GUEST.address} (${E2E_CO_GUEST.phone})`
  );
  expect(items).toHaveLength(1);
  expect(items[0]!.product_id).toBe(E2E_CO_PRODUCT.id);
  expect(items[0]!.quantity).toBe(QTY);
  expect(items[0]!.unit_price).toBe(E2E_CO_PRODUCT.price);
  expect(items[0]!.line_total).toBe(E2E_CO_PRODUCT.price * QTY);
  expect(order!.subtotal).toBe(E2E_CO_PRODUCT.price * QTY);
  expect(order!.total).toBe(order!.subtotal + order!.shipping_cost);
  // Guest customer row + synchronous stock decrement.
  expect(customers).toHaveLength(1);
  expect(customers[0]!.phone).toBe(E2E_CO_GUEST.phone);
  expect(customers[0]!.email).toBe(E2E_CO_GUEST.email);
  expect(stock).toBe(E2E_CO_PRODUCT.stock - QTY);
});
