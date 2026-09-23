import type {
  ApiResponse,
  ApiError,
  Category,
  Customer,
  CustomerAddress,
  Order,
  OrderItem,
  Plan,
  Product,
  ProductImage,
  ShippingRate,
  Store,
  Subscription,
} from "@/types/api";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787";

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const url = `${API_BASE_URL}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    credentials: "include",
  });

  const data = await response.json();

  if (!response.ok || data.ok === false) {
    return data as ApiError;
  }

  return data as ApiResponse<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body: unknown, headers?: Record<string, string>) =>
    request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
      ...(headers ? { headers } : {}),
    }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export const authApi = {
  register: (data: {
    email: string;
    phone: string;
    password: string;
    name: string;
  }) => api.post<{ user: { id: string; phone: string; email: string | null; name: string; role: string; email_verified: number } }>("/auth/register", data),

  login: (data: { email: string; password: string }) =>
    api.post<{ user: { id: string; phone: string; email: string | null; name: string; role: string; email_verified: number }; must_rotate: boolean }>("/auth/login", data),

  logout: () => api.post<{ loggedOut: boolean }>("/auth/logout", {}),

  logoutOthers: () => api.post<{ revoked: number }>("/auth/logout-others", {}),

  me: () => api.get<{ user: { id: string; phone: string; email: string | null; name: string; role: string; email_verified: number } }>("/auth/me"),

  updateProfile: (data: {
    name?: string;
    email?: string | null;
    phone?: string;
    current_password?: string;
    logout_other_sessions?: boolean;
  }) =>
    api.patch<{ user: { id: string; phone: string; email: string | null; name: string; role: string; email_verified: number }; reauth_required: boolean }>("/auth/me", data),

  changePassword: (data: {
    current_password: string;
    new_password: string;
    logout_other_sessions?: boolean;
  }) => api.post<{ changed: boolean }>("/auth/change-password", data),

  verifyEmail: (token: string) =>
    api.post<{ verified: boolean }>("/auth/verify-email", { token }),

  resendVerification: (email: string) =>
    api.post<{ emailed: boolean }>("/auth/resend-verification", { email }),

  forgotPassword: (email: string) =>
    api.post<{ emailed: boolean }>("/auth/forgot-password", { email }),

  resetPassword: (data: {
    token: string;
    new_password: string;
    logout_other_sessions?: boolean;
  }) => api.post<{ reset: boolean }>("/auth/reset-password", data),
};

export const storesApi = {
  /** Own stores (all stores for admins). */
  list: () => api.get<{ stores: Store[] }>("/stores"),

  /** One store (owner or admin; foreign/missing ids are 404). */
  get: (storeId: string) =>
    api.get<{ store: Store | null }>(
      `/stores/${encodeURIComponent(storeId)}`
    ),

  /**
   * Create a store. Owner comes from the session — never send
   * store_id/id/owner_id (the backend 400s them).
   */
  create: (data: { name: string; slug: string; currency?: string }) =>
    api.post<{ store: Store }>("/stores", data),

  /** Partial update of name/slug/currency only. */
  update: (
    storeId: string,
    data: { name?: string; slug?: string; currency?: string }
  ) =>
    api.patch<{ store: Store | null }>(
      `/stores/${encodeURIComponent(storeId)}`,
      data
    ),
};

export const plansApi = {
  /** Public plan catalog (no authentication). */
  list: () => api.get<{ plans: Plan[] }>("/plans"),
};

function storePath(storeId: string, rest: string): string {
  return `/stores/${encodeURIComponent(storeId)}${rest}`;
}

export const categoriesApi = {
  list: (storeId: string) =>
    api.get<{ categories: Category[] }>(storePath(storeId, "/categories")),
  get: (storeId: string, id: string) =>
    api.get<{ category: Category }>(
      storePath(storeId, `/categories/${encodeURIComponent(id)}`)
    ),
  create: (
    storeId: string,
    data: {
      name: string;
      slug: string;
      parent_id?: string | null;
      sort_order?: number;
      is_active?: 0 | 1;
    }
  ) =>
    api.post<{ category: Category }>(storePath(storeId, "/categories"), data),
  update: (
    storeId: string,
    id: string,
    data: {
      name?: string;
      slug?: string;
      parent_id?: string | null;
      sort_order?: number;
      is_active?: 0 | 1;
    }
  ) =>
    api.patch<{ category: Category }>(
      storePath(storeId, `/categories/${encodeURIComponent(id)}`),
      data
    ),
  /**
   * Hard delete. Without detach while products/children reference the
   * category the backend answers 409 has_dependents; detach=true unassigns
   * them atomically first.
   */
  remove: (storeId: string, id: string, detach = false) =>
    api.delete<{ deleted: string }>(
      storePath(storeId, `/categories/${encodeURIComponent(id)}`) +
        (detach ? "?detach=true" : "")
    ),
};

export const productsApi = {
  list: (storeId: string) =>
    api.get<{ products: Product[] }>(storePath(storeId, "/products")),
  get: (storeId: string, id: string) =>
    api.get<{ product: Product }>(
      storePath(storeId, `/products/${encodeURIComponent(id)}`)
    ),
  create: (
    storeId: string,
    data: {
      name: string;
      slug: string;
      category_id?: string | null;
      price: number;
      stock_quantity?: number | null;
      is_active?: 0 | 1;
    }
  ) => api.post<{ product: Product }>(storePath(storeId, "/products"), data),
  update: (
    storeId: string,
    id: string,
    data: {
      name?: string;
      slug?: string;
      category_id?: string | null;
      price?: number;
      stock_quantity?: number | null;
      is_active?: 0 | 1;
    }
  ) =>
    api.patch<{ product: Product }>(
      storePath(storeId, `/products/${encodeURIComponent(id)}`),
      data
    ),
  /** Soft retire (idempotent, releases the slug). */
  remove: (storeId: string, id: string) =>
    api.delete<{ product: Product }>(
      storePath(storeId, `/products/${encodeURIComponent(id)}`)
    ),
  restore: (storeId: string, id: string) =>
    api.post<{ product: Product }>(
      storePath(storeId, `/products/${encodeURIComponent(id)}/restore`),
      {}
    ),
};

export const productImagesApi = {
  /** product_id query is required by the backend (400 without it). */
  list: (storeId: string, productId: string) =>
    api.get<{ images: ProductImage[] }>(
      storePath(storeId, "/product-images") +
        `?product_id=${encodeURIComponent(productId)}`
    ),
  get: (storeId: string, id: string) =>
    api.get<{ image: ProductImage }>(
      storePath(storeId, `/product-images/${encodeURIComponent(id)}`)
    ),
  /** MVP: attach an external https URL (no R2 upload in this phase). */
  create: (
    storeId: string,
    data: {
      product_id: string;
      url: string;
      alt_text?: string | null;
      sort_order?: number;
    }
  ) => api.post<{ image: ProductImage }>(storePath(storeId, "/product-images"), data),
  update: (
    storeId: string,
    id: string,
    data: { url?: string; alt_text?: string | null; sort_order?: number }
  ) =>
    api.patch<{ image: ProductImage }>(
      storePath(storeId, `/product-images/${encodeURIComponent(id)}`),
      data
    ),
  /** Soft retire (idempotent). */
  remove: (storeId: string, id: string) =>
    api.delete<{ image: ProductImage }>(
      storePath(storeId, `/product-images/${encodeURIComponent(id)}`)
    ),
  restore: (storeId: string, id: string) =>
    api.post<{ image: ProductImage }>(
      storePath(storeId, `/product-images/${encodeURIComponent(id)}/restore`),
      {}
    ),
};

export const customersApi = {
  list: (storeId: string) =>
    api.get<{ customers: Customer[] }>(storePath(storeId, "/customers")),
  get: (storeId: string, id: string) =>
    api.get<{ customer: Customer }>(
      storePath(storeId, `/customers/${encodeURIComponent(id)}`)
    ),
  /**
   * Merchant-private update only (creation is a public buyer upsert —
   * deliberately no create helper here). Diff-only at the call site.
   */
  update: (
    storeId: string,
    id: string,
    data: { name?: string; phone?: string; email?: string | null }
  ) =>
    api.patch<{ customer: Customer }>(
      storePath(storeId, `/customers/${encodeURIComponent(id)}`),
      data
    ),
  /** 409 customer_has_orders while orders reference the customer. */
  remove: (storeId: string, id: string) =>
    api.delete<{ deleted: string }>(
      storePath(storeId, `/customers/${encodeURIComponent(id)}`)
    ),
};

export const customerAddressesApi = {
  /** customer_id query is required by the backend (400 without it). */
  list: (storeId: string, customerId: string) =>
    api.get<{ addresses: CustomerAddress[] }>(
      storePath(storeId, "/customer-addresses") +
        `?customer_id=${encodeURIComponent(customerId)}`
    ),
  get: (storeId: string, id: string) =>
    api.get<{ address: CustomerAddress }>(
      storePath(storeId, `/customer-addresses/${encodeURIComponent(id)}`)
    ),
  /**
   * Partial update; is_default and customer_id are immutable (400) —
   * defaults change only via makeDefault.
   */
  update: (
    storeId: string,
    id: string,
    data: {
      recipient_name?: string;
      phone?: string;
      governorate?: string;
      city?: string | null;
      address_line?: string;
    }
  ) =>
    api.patch<{ address: CustomerAddress }>(
      storePath(storeId, `/customer-addresses/${encodeURIComponent(id)}`),
      data
    ),
  remove: (storeId: string, id: string) =>
    api.delete<{ deleted: string }>(
      storePath(storeId, `/customer-addresses/${encodeURIComponent(id)}`)
    ),
  /**
   * Set the default address. Backend route is public + Turnstile-guarded:
   * works under the development bypass, fails 403/503 without a buyer
   * token where enforcement is on — callers must handle that honestly.
   */
  makeDefault: (storeId: string, id: string) =>
    api.post<{ address: CustomerAddress }>(
      storePath(storeId, `/customer-addresses/${encodeURIComponent(id)}/make-default`),
      {}
    ),
};

export const shippingRatesApi = {
  list: (storeId: string) =>
    api.get<{ rates: ShippingRate[] }>(storePath(storeId, "/shipping-rates")),
  get: (storeId: string, id: string) =>
    api.get<{ rate: ShippingRate }>(
      storePath(storeId, `/shipping-rates/${encodeURIComponent(id)}`)
    ),
  create: (
    storeId: string,
    data: {
      governorate: string;
      shipping_method: string;
      cost: number;
      is_active?: 0 | 1;
    }
  ) =>
    api.post<{ rate: ShippingRate }>(
      storePath(storeId, "/shipping-rates"),
      data
    ),
  /** Partial update; governorate is immutable (400) — delete+recreate. */
  update: (
    storeId: string,
    id: string,
    data: { shipping_method?: string; cost?: number; is_active?: 0 | 1 }
  ) =>
    api.patch<{ rate: ShippingRate }>(
      storePath(storeId, `/shipping-rates/${encodeURIComponent(id)}`),
      data
    ),
  remove: (storeId: string, id: string) =>
    api.delete<{ deleted: string }>(
      storePath(storeId, `/shipping-rates/${encodeURIComponent(id)}`)
    ),
};

export const ordersApi = {
  /** All orders of the store, newest first (reads need no subscription). */
  list: (storeId: string) =>
    api.get<{ orders: Order[] }>(storePath(storeId, "/orders")),
  /** Full order with frozen item snapshots + server-computed totals. */
  get: (storeId: string, id: string) =>
    api.get<{ order: Order; items: OrderItem[] }>(
      storePath(storeId, `/orders/${encodeURIComponent(id)}`)
    ),
  /**
   * Stepwise lifecycle only (pending→confirmed→processing→shipped→
   * delivered; cancel until courier handover). Anything else is 409.
   */
  transitionStatus: (storeId: string, id: string, status: string) =>
    api.patch<{ order: Order }>(
      storePath(storeId, `/orders/${encodeURIComponent(id)}/status`),
      { status }
    ),
  /** pending→paid|failed; paid→refunded; failed→paid. Else 409. */
  transitionPayment: (storeId: string, id: string, payment_status: string) =>
    api.patch<{ order: Order }>(
      storePath(storeId, `/orders/${encodeURIComponent(id)}/payment`),
      { payment_status }
    ),
};

export interface BillingIntent {
  id: string;
  store_id: string;
  plan_id: string;
  billing_period: string;
  amount: number;
  currency: string;
  status: string;
  provider: string;
  expires_at: string | null;
}

export interface ThemeData {
  store_id: string;
  draft: Record<string, unknown>;
  published_snapshot: Record<string, unknown> | null;
  published_at: string | null;
  updated_at: string;
}

/**
 * Merchant theme designer (draft autosave + audited publish + preview
 * tokens). Draft bodies are whitelisted server-side; unknown keys 400.
 */
export const themeApi = {
  get: (storeId: string) =>
    api.get<{ theme: ThemeData }>(storePath(storeId, "/theme")),
  update: (storeId: string, draft: Record<string, unknown>) =>
    api.patch<{ theme: ThemeData }>(storePath(storeId, "/theme"), draft),
  publish: (storeId: string) =>
    api.post<{ theme: ThemeData }>(storePath(storeId, "/theme/publish"), {}),
  issuePreview: (storeId: string) =>
    api.post<{ token: string; expires_at: string }>(
      storePath(storeId, "/theme/preview"),
      {}
    ),
};

export interface PreviewPayload {
  store: PublicStore;
  theme: ThemeData;
  categories: PublicCategory[];
  products: PublicProduct[];
}

/** Public, token-gated preview render data (no session). */
export const previewApi = {
  get: (token: string) =>
    api.get<{
      store: PublicStore;
      theme: ThemeData;
      categories: PublicCategory[];
      products: PublicProduct[];
    }>(`/s/preview/${encodeURIComponent(token)}`),
};

export interface PublicStore {
  id: string;
  slug: string;
  name: string;
  currency: string;
}

export interface PublicCategory {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  sort_order: number;
}

export interface PublicProduct {
  id: string;
  category_id: string | null;
  name: string;
  slug: string;
  price: number;
  stock_quantity: number | null;
}

export interface CheckoutResult {
  order: {
    id: string;
    order_number: number;
    status: string;
    subtotal: number;
    discount: number;
    total: number;
    payment_method: string;
    payment_status: string;
    customer_name: string;
    customer_phone: string;
    shipping_method: string;
    shipping_cost: number;
    shipping_governorate: string;
    shipping_address: string;
  };
  items: {
    id: string;
    product_name: string;
    quantity: number;
    unit_price: number;
    line_total: number;
  }[];
  replayed: boolean;
}

/**
 * Public storefront reads (no auth): published stores/rows only, drafts
 * 404 identically to missing. Rate-limited per client+store server-side.
 */
export const storefrontApi = {
  bySlug: (slug: string) =>
    api.get<{ store: PublicStore }>(
      `/stores/by-slug/${encodeURIComponent(slug)}`
    ),
  store: (storeId: string) =>
    api.get<{ store: PublicStore }>(
      storePath(storeId, "/catalog/store")
    ),
  categories: (storeId: string) =>
    api.get<{ categories: PublicCategory[] }>(
      storePath(storeId, "/catalog/categories")
    ),
  products: (storeId: string) =>
    api.get<{ products: PublicProduct[] }>(
      storePath(storeId, "/catalog/products")
    ),
  checkout: (
    storeId: string,
    data: {
      customer: { name: string; phone: string; email?: string | null };
      items?: { product_id: string; quantity: number; selected_options?: string | null }[];
      cart_id?: string;
      shipping: {
        recipient_name: string;
        phone: string;
        governorate: string;
        city?: string | null;
        address_line: string;
      };
      payment: { method: string; reference?: string | null };
    },
    idempotencyKey: string,
    turnstileToken?: string
  ) =>
    api.post<CheckoutResult>(storePath(storeId, "/checkout"), data, {
      "X-Idempotency-Key": idempotencyKey,
      ...(turnstileToken ? { "X-Turnstile-Token": turnstileToken } : {}),
    }),
};

/**
 * Self-serve billing (Phase 8). Prices always come from the server —
 * callers never send amounts. Polling reads intent rows (no secrets).
 */
export const billingApi = {
  checkout: (storeId: string, data: { plan_id: string; billing_period: string }) =>
    api.post<{ intent_id: string; redirect_url: string }>(
      storePath(storeId, "/subscriptions/checkout"),
      data
    ),
  storeSubscriptions: (storeId: string) =>
    api.get<{ subscriptions: Subscription[] }>(
      storePath(storeId, "/subscriptions")
    ),
  storeIntents: (storeId: string) =>
    api.get<{ intents: BillingIntent[] }>(
      storePath(storeId, "/billing/intents")
    ),
  getIntent: (storeId: string, id: string) =>
    api.get<{ intent: BillingIntent }>(
      storePath(storeId, `/billing/intents/${encodeURIComponent(id)}`)
    ),
  adminIntents: () => api.get<{ intents: BillingIntent[] }>("/billing/admin/intents"),
  /**
   * Stub-only provider-callback simulator (dev): drives the REAL webhook
   * endpoint so the full settle path is exercised. Production providers
   * call the webhook server-to-server instead — this helper is never used
   * for real money.
   */
  stubCallback: (data: { intent_id: string; stub_token: string; result: string }) =>
    api.post<{ processed: boolean; activated: boolean; duplicate: boolean }>(
      "/billing/webhook/stub",
      data
    ),
};

/**
 * Platform-admin endpoints (RequireAdmin in UI; backend enforces
 * requireRole on every route and audits mutations). No merchant should
 * ever call these — the UI never exposes them outside /app/admin.
 */
export const adminApi = {
  subscriptions: {
    list: () => api.get<{ subscriptions: Subscription[] }>("/admin/subscriptions"),
    get: (id: string) =>
      api.get<{ subscription: Subscription }>(
        `/admin/subscriptions/${encodeURIComponent(id)}`
      ),
    activate: (data: {
      store_id: string;
      plan_id: string;
      billing_period: string;
      starts_at?: string;
      ends_at?: string | null;
      price_amount?: number;
      payment_reference?: string | null;
    }) => api.post<{ subscription: Subscription }>("/admin/subscriptions", data),
    cancel: (id: string, data: { cancelled_at?: string }) =>
      api.post<{ subscription: Subscription }>(
        `/admin/subscriptions/${encodeURIComponent(id)}/cancel`,
        data
      ),
    renew: (
      id: string,
      data: {
        billing_period?: string;
        starts_at?: string;
        ends_at?: string | null;
        price_amount?: number;
        payment_reference?: string | null;
      }
    ) =>
      api.post<{ subscription: Subscription }>(
        `/admin/subscriptions/${encodeURIComponent(id)}/renew`,
        data
      ),
  },
  plans: {
    list: () => api.get<{ plans: Plan[] }>("/admin/plans"),
    get: (id: string) =>
      api.get<{ plan: Plan }>(`/admin/plans/${encodeURIComponent(id)}`),
    create: (data: {
      code: string;
      name: string;
      price_monthly?: number;
      price_yearly?: number;
      max_products?: number | null;
    }) => api.post<{ plan: Plan }>("/admin/plans", data),
    update: (
      id: string,
      data: {
        name?: string;
        price_monthly?: number;
        price_yearly?: number;
        max_products?: number | null;
      }
    ) =>
      api.patch<{ plan: Plan }>(
        `/admin/plans/${encodeURIComponent(id)}`,
        data
      ),
    remove: (id: string) =>
      api.delete<{ deleted: string }>(
        `/admin/plans/${encodeURIComponent(id)}`
      ),
  },
  /** Assisted reset (audited; admins cannot reset peer admins). */
  resetUserPassword: (id: string, new_password: string) =>
    api.post<{ reset: boolean }>(
      `/admin/users/${encodeURIComponent(id)}/password`,
      { new_password }
    ),
};

export interface BuyerAccount {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  email_verified: boolean;
}

export interface ServerCartItem {
  id: string;
  product_id: string;
  product_name: string;
  unit_price: number;
  quantity: number;
}

export interface ServerCart {
  id: string;
  expires_at: string;
  items: ServerCartItem[];
}

export interface BuyerAddress {
  id: string;
  customer_id: string;
  recipient_name: string;
  phone: string;
  governorate: string;
  city: string | null;
  address_line: string;
  is_default: number;
}

export interface BuyerOrderSummary {
  id: string;
  order_number: number;
  status: string;
  payment_status: string;
  total: number;
}

const buyerPath = (slug: string, rest: string) =>
  `/s/${encodeURIComponent(slug)}/account${rest}`;

// Bot-token header for Turnstile-guarded buyer mutations. Omitted when no
// token (dev bypass covers local); the backend stays the sole enforcer.
const turnstileHeaders = (token?: string): Record<string, string> | undefined =>
  token ? { "X-Turnstile-Token": token } : undefined;

/**
 * Buyer accounts + server carts (P4). Accounts are optional convenience:
 * guest checkout always works. Sessions ride the ss_buyer host-only cookie
 * (credentials:include on every call); the cookie is store-bound server-side.
 */
export const buyerApi = {
  register: (slug: string, data: { name: string; phone: string; email?: string | null; password: string }, turnstileToken?: string) =>
    api.post<{ buyer: BuyerAccount; converted: boolean }>(buyerPath(slug, "/register"), data, turnstileHeaders(turnstileToken)),
  login: (slug: string, data: { identity: string; password: string }, turnstileToken?: string) =>
    api.post<{ buyer: BuyerAccount }>(buyerPath(slug, "/login"), data, turnstileHeaders(turnstileToken)),
  logout: (slug: string) => api.post<{ logged_out: boolean }>(buyerPath(slug, "/logout"), {}),
  me: (slug: string) => api.get<{ buyer: BuyerAccount }>(buyerPath(slug, "/me")),
  updateName: (slug: string, name: string) =>
    api.patch<{ buyer: BuyerAccount }>(buyerPath(slug, "/me"), { name }),
  verifyEmail: (slug: string, token: string) =>
    api.post<{ verified: boolean }>(buyerPath(slug, "/verify-email"), { token }),
  forgotPassword: (slug: string, identity: string) =>
    api.post<{ accepted: boolean }>(buyerPath(slug, "/forgot-password"), { identity }),
  resetPassword: (slug: string, data: { token: string; password: string }) =>
    api.post<{ reset: boolean }>(buyerPath(slug, "/reset-password"), data),
  orders: (slug: string) => api.get<{ orders: BuyerOrderSummary[] }>(buyerPath(slug, "/orders")),
  addresses: {
    list: (slug: string) => api.get<{ addresses: BuyerAddress[] }>(buyerPath(slug, "/addresses")),
    create: (slug: string, data: { recipient_name: string; phone: string; governorate: string; city?: string | null; address_line: string }) =>
      api.post<{ address: BuyerAddress }>(buyerPath(slug, "/addresses"), data),
    update: (slug: string, id: string, data: Partial<{ recipient_name: string; phone: string; governorate: string; city: string | null; address_line: string }>) =>
      api.patch<{ address: BuyerAddress }>(buyerPath(slug, `/addresses/${encodeURIComponent(id)}`), data),
    remove: (slug: string, id: string) =>
      api.delete<{ deleted: string }>(buyerPath(slug, `/addresses/${encodeURIComponent(id)}`)),
    makeDefault: (slug: string, id: string) =>
      api.post<{ address: BuyerAddress }>(buyerPath(slug, `/addresses/${encodeURIComponent(id)}/make-default`), {}),
  },
  cart: {
    my: (slug: string) => api.get<{ cart: ServerCart }>(buyerPath(slug, "/cart")),
    add: (slug: string, data: { product_id: string; quantity: number }) =>
      api.post<{ cart: ServerCart }>(buyerPath(slug, "/cart/items"), data),
    setQty: (slug: string, itemId: string, quantity: number) =>
      api.patch<{ cart: ServerCart }>(buyerPath(slug, `/cart/items/${encodeURIComponent(itemId)}`), { quantity }),
    merge: (slug: string, cart_id: string) =>
      api.post<{ cart: ServerCart }>(buyerPath(slug, "/cart/merge"), { cart_id }),
  },
};

const guestCartPath = (slug: string, rest: string) =>
  `/s/${encodeURIComponent(slug)}/cart${rest}`;

export const cartApi = {
  create: (slug: string) => api.post<{ cart: ServerCart }>(guestCartPath(slug, ""), {}),
  get: (slug: string, cartId: string) =>
    api.get<{ cart: ServerCart }>(guestCartPath(slug, `/${encodeURIComponent(cartId)}`)),
  add: (slug: string, cartId: string, data: { product_id: string; quantity: number }) =>
    api.post<{ cart: ServerCart }>(guestCartPath(slug, `/${encodeURIComponent(cartId)}/items`), data),
  setQty: (slug: string, cartId: string, itemId: string, quantity: number) =>
    api.patch<{ cart: ServerCart }>(
      guestCartPath(slug, `/${encodeURIComponent(cartId)}/items/${encodeURIComponent(itemId)}`),
      { quantity }
    ),
};