"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { buyerApi, type BuyerAccount } from "@/lib/api";

interface BuyerState {
  buyerFor: (slug: string) => BuyerAccount | null | undefined;
  login: (slug: string, identity: string, password: string, turnstileToken?: string) => Promise<{ ok: true } | { ok: false; code: string }>;
  register: (
    slug: string,
    data: { name: string; phone: string; email?: string | null; password: string },
    turnstileToken?: string
  ) => Promise<{ ok: true; converted: boolean } | { ok: false; code: string }>;
  logout: (slug: string) => Promise<void>;
  refresh: (slug: string) => Promise<void>;
  updateName: (slug: string, name: string) => Promise<boolean>;
}

const BuyerContext = createContext<BuyerState | null>(null);

function codeOf(res: { ok: boolean; error?: { code?: string } }): string {
  if (res.ok) return "";
  return (res as { error?: { code?: string } }).error?.code ?? "request_failed";
}

/**
 * Buyer accounts (P4): per-shop identity, independent of the merchant
 * AuthProvider. undefined = not yet checked, null = guest. Sessions ride
 * the ss_buyer cookie; the server binds each session to its store.
 */
export function BuyerProvider({ children }: { children: ReactNode }) {
  const [buyers, setBuyers] = useState<Record<string, BuyerAccount | null>>({});

  const buyerFor = useCallback(
    (slug: string) => (slug in buyers ? (buyers[slug] as BuyerAccount | null) : undefined),
    [buyers]
  );

  const refresh = useCallback(async (slug: string) => {
    try {
      const res = await buyerApi.me(slug);
      setBuyers((prev) => ({ ...prev, [slug]: res.ok ? res.data.buyer : null }));
    } catch {
      setBuyers((prev) => ({ ...prev, [slug]: null }));
    }
  }, []);

  const login = useCallback(
    async (slug: string, identity: string, password: string, turnstileToken?: string) => {
      try {
        const res = await buyerApi.login(slug, { identity, password }, turnstileToken);
        if (!res.ok) return { ok: false as const, code: codeOf(res) };
        setBuyers((prev) => ({ ...prev, [slug]: res.data.buyer }));
        return { ok: true as const };
      } catch {
        return { ok: false as const, code: "network_error" };
      }
    },
    []
  );

  const register = useCallback(
    async (
      slug: string,
      data: { name: string; phone: string; email?: string | null; password: string },
      turnstileToken?: string
    ) => {
      try {
        const res = await buyerApi.register(slug, data, turnstileToken);
        if (!res.ok) return { ok: false as const, code: codeOf(res) };
        setBuyers((prev) => ({ ...prev, [slug]: res.data.buyer }));
        return { ok: true as const, converted: res.data.converted };
      } catch {
        return { ok: false as const, code: "network_error" };
      }
    },
    []
  );

  const logout = useCallback(async (slug: string) => {
    try {
      await buyerApi.logout(slug);
    } catch {
      // Cookie cleared server-side best-effort; local state drops regardless.
    }
    setBuyers((prev) => ({ ...prev, [slug]: null }));
  }, []);

  const updateName = useCallback(async (slug: string, name: string) => {
    try {
      const res = await buyerApi.updateName(slug, name);
      if (!res.ok) return false;
      setBuyers((prev) => ({ ...prev, [slug]: res.data.buyer }));
      return true;
    } catch {
      return false;
    }
  }, []);

  const value = useMemo(
    () => ({ buyerFor, login, register, logout, refresh, updateName }),
    [buyerFor, login, register, logout, refresh, updateName]
  );

  return <BuyerContext.Provider value={value}>{children}</BuyerContext.Provider>;
}

export function useBuyer(): BuyerState {
  const ctx = useContext(BuyerContext);
  if (!ctx) throw new Error("useBuyer must be used inside <BuyerProvider>");
  return ctx;
}
