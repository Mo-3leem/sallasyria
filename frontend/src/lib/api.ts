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
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
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