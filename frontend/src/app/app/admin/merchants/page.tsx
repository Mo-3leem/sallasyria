"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { adminApi } from "@/lib/api";
import type { MerchantAccount } from "@/types/api";
import { authErrorMessage, getErrorCode } from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { EmptyState } from "@/components/common/EmptyState";

/** Admin merchants: search by email or phone, open merchant details. */
function AdminMerchantsBody({ initialQuery }: { initialQuery: string }) {
  const { refresh: refreshAuth } = useAuth();
  const [query, setQuery] = useState(initialQuery);
  const [merchants, setMerchants] = useState<MerchantAccount[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(q: string, initial: boolean) {
    if (initial) setLoading(true);
    else setSearching(true);
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
      setSearching(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => {
      void load(query, merchants === null);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const detailHref = (m: MerchantAccount) =>
    query.trim() === ""
      ? `/app/admin/merchants/${encodeURIComponent(m.id)}`
      : `/app/admin/merchants/${encodeURIComponent(m.id)}?q=${encodeURIComponent(query.trim())}`;

  return (
    <>
      <div className="shell-page-head">
        <h1>
          التجار
          {merchants !== null && !loading && (
            <span className="sub-badge sub-badge-unknown" style={{ marginInlineStart: 10 }}>
              {merchants.length.toLocaleString("ar-SY")}
            </span>
          )}
        </h1>
        <p>بحث وعرض وإدارة حسابات التجار — تعديل البيانات، إعادة تعيين كلمات المرور، وحذف الحسابات.</p>
      </div>

      <div className="shell-card">
        <div className="auth-field" style={{ marginBottom: 8 }}>
          <label className="auth-label" htmlFor="merchant-search">
            البحث بالبريد الإلكتروني أو رقم الهاتف
          </label>
          <div className="admin-search-wrap">
            <i className="fas fa-search" aria-hidden="true"></i>
            <input
              id="merchant-search"
              className="auth-input"
              dir="ltr"
              placeholder="merchant@example.com أو 0991234567"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
            {query !== "" && (
              <button
                type="button"
                className="admin-search-clear"
                aria-label="مسح البحث"
                title="مسح البحث"
                onClick={() => setQuery("")}
              >
                <i className="fas fa-times" aria-hidden="true"></i>
              </button>
            )}
          </div>
        </div>
        <p className="shell-note" style={{ marginBottom: 16 }} role="status">
          {loading
            ? "جاري التحميل..."
            : searching
              ? "جاري البحث..."
              : merchants !== null
                ? `عدد النتائج: ${merchants.length.toLocaleString("ar-SY")}`
                : ""}
        </p>

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
              <button type="button" className="btn btn-outline" onClick={() => void load(query, true)}>
                إعادة المحاولة
              </button>
            }
          />
        ) : merchants !== null && merchants.length === 0 ? (
          query.trim() === "" ? (
            <EmptyState
              icon="fas fa-store"
              title="لا يوجد تجار مسجلون"
              description="لم يتم إنشاء أي حساب تاجر بعد."
            />
          ) : (
            <EmptyState
              icon="fas fa-search"
              title="لا توجد نتائج مطابقة"
              description={`لا يوجد تاجر يطابق «${query.trim()}». جرّب بريداً أو رقماً مختلفاً.`}
              action={
                <button type="button" className="btn btn-outline" onClick={() => setQuery("")}>
                  مسح البحث
                </button>
              }
            />
          )
        ) : (
          <div className="shell-stack">
            {(merchants ?? []).map((m) => {
              const active = (m.is_active ?? 1) === 1;
              return (
                <Link
                  key={m.id}
                  href={detailHref(m)}
                  className="store-row"
                  aria-label={`فتح التاجر ${m.name}`}
                >
                  <span className="store-row-icon" aria-hidden="true">
                    <i className="fas fa-store"></i>
                  </span>
                  <span className="store-row-body">
                    <span className="store-row-name">
                      {m.name}
                      <span className={`sub-badge ${active ? "sub-badge-active" : "sub-badge-inactive"}`}>
                        {active ? "نشط" : "معطّل"}
                      </span>
                    </span>
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
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

export default function AdminMerchantsPage() {
  return (
    <Suspense
      fallback={
        <div className="shell-loading">
          <span className="shell-spinner" aria-hidden="true"></span>
          جاري التحميل...
        </div>
      }
    >
      <AdminMerchantsWithQuery />
    </Suspense>
  );
}

function AdminMerchantsWithQuery() {
  const searchParams = useSearchParams();
  return <AdminMerchantsBody initialQuery={searchParams.get("q") ?? ""} />;
}
