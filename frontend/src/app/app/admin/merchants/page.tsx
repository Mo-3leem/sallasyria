"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { adminApi } from "@/lib/api";
import type { MerchantAccount } from "@/types/api";
import { authErrorMessage, getErrorCode } from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { EmptyState } from "@/components/common/EmptyState";

/** Admin merchants: search by email or phone, open merchant details. */
export default function AdminMerchantsPage() {
  const { refresh: refreshAuth } = useAuth();
  const [query, setQuery] = useState("");
  const [merchants, setMerchants] = useState<MerchantAccount[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(q: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.merchants.list(q.trim() === "" ? undefined : q.trim());
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        setError(authErrorMessage(res, 400));
        setMerchants([]);
        return;
      }
      setMerchants(res.data.merchants);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
      setMerchants([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => {
      void load(query);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <>
      <div className="shell-page-head">
        <h1>التجار</h1>
        <p>بحث وعرض وإدارة حسابات التجار.</p>
      </div>

      <div className="shell-card">
        <div className="auth-field" style={{ marginBottom: 16 }}>
          <label className="auth-label" htmlFor="merchant-search">
            البحث بالبريد الإلكتروني أو رقم الهاتف
          </label>
          <input
            id="merchant-search"
            className="auth-input"
            dir="ltr"
            placeholder="merchant@example.com أو 0991234567"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
        </div>

        {loading ? (
          <div className="shell-loading">
            <span className="shell-spinner" aria-hidden="true"></span>
            جاري تحميل التجار...
          </div>
        ) : error ? (
          <EmptyState
            icon="fas fa-exclamation-triangle"
            title="تعذّر تحميل التجار"
            description={error}
            action={
              <button type="button" className="btn btn-outline" onClick={() => void load(query)}>
                إعادة المحاولة
              </button>
            }
          />
        ) : merchants !== null && merchants.length === 0 ? (
          <EmptyState
            icon="fas fa-store-slash"
            title="لا يوجد تجار مطابقون"
            description="جرّب بريداً أو رقماً مختلفاً."
          />
        ) : (
          <div className="shell-stack">
            {(merchants ?? []).map((m) => (
              <Link
                key={m.id}
                href={`/app/admin/merchants/${encodeURIComponent(m.id)}`}
                className="store-row"
              >
                <span className="store-row-icon" aria-hidden="true">
                  <i className="fas fa-store"></i>
                </span>
                <span className="store-row-body">
                  <span className="store-row-name">{m.name}</span>
                  <span className="store-row-meta">
                    {m.email && (
                      <>
                        <span dir="ltr">{m.email}</span>
                        <span aria-hidden="true">·</span>
                      </>
                    )}
                    <span dir="ltr">{m.phone}</span>
                  </span>
                </span>
                <i className="fas fa-chevron-left" aria-hidden="true" style={{ color: "var(--gray-3)" }}></i>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
