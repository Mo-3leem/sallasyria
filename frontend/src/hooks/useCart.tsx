"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { buyerApi, cartApi, type ServerCart, type ServerCartItem } from "@/lib/api";
import { useBuyer } from "@/hooks/useBuyer";

export type { ServerCartItem };

interface CartState {
  cartFor: (slug: string) => ServerCart | null;
  countFor: (slug: string) => number;
  loadingFor: (slug: string) => boolean;
  notice: string | null;
  /** Machine-readable code of the last failed mutation (e.g. turnstile_required). */
  lastCode: string | null;
  ensure: (slug: string) => Promise<void>;
  refresh: (slug: string) => Promise<void>;
  mergeGuest: (slug: string) => Promise<boolean>;
  add: (slug: string, productId: string, quantity?: number, captchaToken?: string) => Promise<boolean>;
  setQuantity: (slug: string, itemId: string, quantity: number, captchaToken?: string) => Promise<boolean>;
  removeByProduct: (slug: string, productId: string, captchaToken?: string) => Promise<boolean>;
  forgetGuestCart: (slug: string) => void;
}

const CartContext = createContext<CartState | null>(null);

// Guest cart ids are capability references (unguessable uuids), never
// credentials: persisting them in localStorage is safe. They map per shop
// slug; the server resolves the store and enforces TTL + ownership.
const STORAGE_KEY = "salla-syria-cart-v2";

function loadIds(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function saveIds(ids: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage blocked: guest cart simply doesn't persist.
  }
}

/**
 * Buyer cart (P4): server-side lines, guest (capability id) or account-bound.
 * Stock, prices, and totals are re-validated server-side at checkout; the
 * client snapshot is display-only. Keyed by shop slug (the server resolves
 * the store); callers never handle store ids.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const { buyerFor } = useBuyer();
  const [carts, setCarts] = useState<Record<string, ServerCart | null>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [lastCode, setLastCode] = useState<string | null>(null);
  const idsRef = useRef<Record<string, string> | null>(null);

  const ids = (): Record<string, string> => {
    if (idsRef.current === null) idsRef.current = loadIds();
    return idsRef.current;
  };

  const remember = useCallback((slug: string, cartId: string | null) => {
    const map = ids();
    if (cartId === null) delete map[slug];
    else map[slug] = cartId;
    saveIds(map);
  }, []);

  const apply = useCallback((slug: string, cart: ServerCart) => {
    setCarts((prev) => ({ ...prev, [slug]: cart }));
  }, []);

  const fail = useCallback(async (slug: string, res: unknown): Promise<false> => {
    const code = (res as { error?: { code?: string } } | null)?.error?.code;
    setLastCode(code ?? null);
    if (code === "cart_not_found") {
      // Guest cart expired/consumed server-side: drop the stale id so the
      // next operation mints a fresh cart instead of looping on a 404.
      remember(slug, null);
      setCarts((prev) => ({ ...prev, [slug]: null }));
    }
    setNotice(
      code === "product_unavailable"
        ? "هذا المنتج غير متاح حالياً."
        : code === "quantity_exceeded"
          ? "تجاوزت الكمية الحد الأقصى (999)."
          : code === "turnstile_required"
            ? "يرجى إكمال التحقق الأمني أولاً."
            : code === "turnstile_failed"
              ? "فشل التحقق الأمني. حاول مجدداً."
              : "تعذّر تحديث السلة. حاول مجدداً."
    );
    return false;
  }, [remember]);

  const fetchSnapshot = useCallback(
    async (slug: string) => {
      setLoading((prev) => ({ ...prev, [slug]: true }));
      try {
        const buyer = buyerFor(slug);
        if (buyer) {
          const res = await buyerApi.cart.my(slug);
          if (res.ok) apply(slug, res.data.cart);
          else setCarts((prev) => ({ ...prev, [slug]: null }));
        } else {
          const id = ids()[slug];
          if (!id) {
            setCarts((prev) => ({ ...prev, [slug]: null }));
          } else {
            const res = await cartApi.get(slug, id);
            if (res.ok) apply(slug, res.data.cart);
            else {
              remember(slug, null);
              setCarts((prev) => ({ ...prev, [slug]: null }));
            }
          }
        }
      } catch {
        setCarts((prev) => ({ ...prev, [slug]: null }));
      } finally {
        setLoading((prev) => ({ ...prev, [slug]: false }));
      }
    },
    [apply, buyerFor, remember]
  );

  const ensure = useCallback(
    async (slug: string) => {
      if (carts[slug] !== undefined) return;
      await fetchSnapshot(slug);
    },
    [carts, fetchSnapshot]
  );

  const refresh = useCallback(
    (slug: string) => fetchSnapshot(slug),
    [fetchSnapshot]
  );

  // Move the guest cart into the account cart after login (no-op when there
  // is no guest cart). The guest id is forgotten either way: merge deletes
  // it server-side, and there is nothing to merge when it is absent.
  const mergeGuest = useCallback(
    async (slug: string): Promise<boolean> => {
      const id = ids()[slug] ?? null;
      if (!id) {
        await fetchSnapshot(slug);
        return true;
      }
      try {
        const res = await buyerApi.cart.merge(slug, id);
        remember(slug, null);
        if (!res.ok) {
          await fetchSnapshot(slug);
          return false;
        }
        apply(slug, res.data.cart);
        return true;
      } catch {
        await fetchSnapshot(slug);
        return false;
      }
    },
    [apply, fetchSnapshot, remember]
  );

  const mutate = useCallback(
    async (
      slug: string,
      op: (cartId: string | null, authed: boolean, captchaToken?: string) => Promise<{ ok: boolean; data?: { cart: ServerCart } } | { ok: boolean; error?: { code?: string } }>,
      captchaToken?: string
    ): Promise<boolean> => {
      setNotice(null);
      setLastCode(null);
      const buyer = buyerFor(slug);
      try {
        if (buyer) {
          const res = await op(null, true);
          if (!res.ok) return fail(slug, res);
          apply(slug, (res as { data: { cart: ServerCart } }).data.cart);
          return true;
        }
        let id = ids()[slug] ?? null;
        if (!id) {
          const created = await cartApi.create(slug, captchaToken);
          if (!created.ok) return fail(slug, created);
          id = (created as { data: { cart: ServerCart } }).data.cart.id;
          remember(slug, id);
        }
        const res = await op(id, false, captchaToken);
        if (!res.ok) {
          const code = (res as { error?: { code?: string } }).error?.code;
          // Creation race / stale id: mint once more, then give up.
          if (code === "cart_not_found") {
            remember(slug, null);
            const created = await cartApi.create(slug, captchaToken);
            if (!created.ok) return fail(slug, created);
            id = (created as { data: { cart: ServerCart } }).data.cart.id;
            remember(slug, id);
            const retry = await op(id, false, captchaToken);
            if (!retry.ok) return fail(slug, retry);
            apply(slug, (retry as { data: { cart: ServerCart } }).data.cart);
            return true;
          }
          return fail(slug, res);
        }
        apply(slug, (res as { data: { cart: ServerCart } }).data.cart);
        return true;
      } catch {
        setNotice("تعذّر الاتصال بالخادم. حاول مجدداً.");
        return false;
      }
    },
    [apply, buyerFor, fail, remember]
  );

  const add = useCallback(
    (slug: string, productId: string, quantity = 1, captchaToken?: string) =>
      mutate(slug, (cartId, authed, token) =>
        authed
          ? buyerApi.cart.add(slug, { product_id: productId, quantity })
          : cartApi.add(slug, cartId as string, { product_id: productId, quantity }, token)
      , captchaToken),
    [mutate]
  );

  const setQuantity = useCallback(
    (slug: string, itemId: string, quantity: number, captchaToken?: string) =>
      mutate(slug, (cartId, authed, token) =>
        authed
          ? buyerApi.cart.setQty(slug, itemId, quantity)
          : cartApi.setQty(slug, cartId as string, itemId, quantity, token)
      , captchaToken),
    [mutate]
  );

  const removeByProduct = useCallback(
    async (slug: string, productId: string, captchaToken?: string) => {
      const cart = carts[slug];
      const line = cart?.items.find((l) => l.product_id === productId) ?? null;
      if (!line) return true;
      return setQuantity(slug, line.id, 0, captchaToken);
    },
    [carts, setQuantity]
  );

  const forgetGuestCart = useCallback(
    (slug: string) => {
      remember(slug, null);
      setCarts((prev) => ({ ...prev, [slug]: null }));
    },
    [remember]
  );

  const cartFor = useCallback((slug: string) => carts[slug] ?? null, [carts]);
  const countFor = useCallback(
    (slug: string) => (carts[slug]?.items ?? []).reduce((n, l) => n + l.quantity, 0),
    [carts]
  );
  const loadingFor = useCallback((slug: string) => loading[slug] ?? false, [loading]);

  const value = useMemo(
    () => ({ cartFor, countFor, loadingFor, notice, lastCode, ensure, refresh, mergeGuest, add, setQuantity, removeByProduct, forgetGuestCart }),
    [cartFor, countFor, loadingFor, notice, lastCode, ensure, refresh, mergeGuest, add, setQuantity, removeByProduct, forgetGuestCart]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartState {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside <CartProvider>");
  return ctx;
}
