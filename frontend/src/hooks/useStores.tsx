"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { storesApi } from "@/lib/api";
import { isApiError } from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import type { Store } from "@/types/api";

/**
 * Shared store list (GET /stores; merchants see own stores, admins all).
 * Single fetch shared by StoreSwitcher, dashboard, and store pages —
 * refresh() after create/edit propagates everywhere. URL stays the source
 * of truth for the active store; this cache never selects one.
 * On 401 the auth state refreshes so RequireAuth redirects to login.
 */
export interface StoresState {
  stores: Store[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const StoresContext = createContext<StoresState | null>(null);

export function StoresProvider({ children }: { children: ReactNode }) {
  const { refresh: refreshAuth } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await storesApi.list();
      if (!res.ok) {
        if (isApiError(res) && res.error.code === "unauthorized") {
          await refreshAuth();
          return;
        }
        setError(
          isApiError(res) && res.error.message
            ? res.error.message
            : "تعذّر تحميل المتاجر. حاول مجدداً."
        );
        return;
      }
      setStores(res.data.stores);
    } catch {
      setError("تعذّر الاتصال بالخادم. تحقق من اتصالك وحاول مجدداً.");
    } finally {
      setLoading(false);
    }
  }, [refreshAuth]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ stores, loading, error, refresh }),
    [stores, loading, error, refresh]
  );

  return (
    <StoresContext.Provider value={value}>{children}</StoresContext.Provider>
  );
}

export function useStores(): StoresState {
  const ctx = useContext(StoresContext);
  if (!ctx) throw new Error("useStores must be used inside <StoresProvider>");
  return ctx;
}
