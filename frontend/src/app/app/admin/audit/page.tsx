"use client";

import { useEffect, useState } from "react";
import { adminApi, type PageMeta } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { usePaging } from "@/hooks/usePaging";
import { EmptyState } from "@/components/common/EmptyState";
import { Pagination } from "@/components/common/Pagination";
import type { AuditEvent } from "@/types/api";

/**
 * Admin audit trail viewer: persistent audit_logs rows (ids and outcomes
 * only — the backend never stores tokens, hashes, or bodies). Filters are
 * server-side; changing any filter resets to page 1.
 */
export default function AdminAuditPage() {
  const { refresh: refreshAuth } = useAuth();
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [store, setStore] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const { page, setPage } = usePaging(`${action}:${actor}:${store}:${since}:${until}`);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [pagination, setPagination] = useState<PageMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(targetPage: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.auditLog.list(
        {
          action: action.trim() === "" ? undefined : action.trim(),
          actor: actor.trim() === "" ? undefined : actor.trim(),
          store: store.trim() === "" ? undefined : store.trim(),
          since: since.trim() === "" ? undefined : since.trim(),
          until: until.trim() === "" ? undefined : until.trim(),
        },
        { page: targetPage }
      );
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        setError(authErrorMessage(res, 400));
        setEvents([]);
        setPagination(null);
        return;
      }
      setEvents(res.data.events);
      setPagination(res.data.pagination);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
      setEvents([]);
      setPagination(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => {
      void load(page);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, actor, store, since, until, page]);

  function clearFilters() {
    setAction("");
    setActor("");
    setStore("");
    setSince("");
    setUntil("");
  }

  return (
    <>
      <div className="shell-page-head">
        <h1>سجل التدقيق</h1>
        <p>أحداث الإدارة والأمان المسجلة على الخادم — معرفات ونتائج فقط.</p>
        <p className="shell-note">
          ملاحظة: كل زيارة لهذه الصفحة تُسجَّل هي نفسها كحدث `admin.audit.read` — وهذا مقصود.
        </p>
      </div>

      <div className="shell-card">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <input
            className="auth-input"
            dir="ltr"
            placeholder="الإجراء (مثال: admin.merchant.delete)"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            autoComplete="off"
            aria-label="تصفية حسب الإجراء"
            style={{ flex: "2 1 220px" }}
          />
          <input
            className="auth-input"
            dir="ltr"
            placeholder="معرف الفاعل"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            autoComplete="off"
            aria-label="تصفية حسب الفاعل"
            style={{ flex: "1 1 160px" }}
          />
          <input
            className="auth-input"
            dir="ltr"
            placeholder="معرف المتجر"
            value={store}
            onChange={(e) => setStore(e.target.value)}
            autoComplete="off"
            aria-label="تصفية حسب المتجر"
            style={{ flex: "1 1 160px" }}
          />
          <input
            className="auth-input"
            dir="ltr"
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            aria-label="من تاريخ"
            style={{ flex: "1 1 140px" }}
          />
          <input
            className="auth-input"
            dir="ltr"
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            aria-label="إلى تاريخ"
            style={{ flex: "1 1 140px" }}
          />
          <button type="button" className="btn btn-outline btn-sm" onClick={clearFilters}>
            مسح الفلاتر
          </button>
        </div>

        {loading ? (
          <div className="shell-loading">
            <span className="shell-spinner" aria-hidden="true"></span>
            جاري تحميل السجل...
          </div>
        ) : error ? (
          <EmptyState
            icon="fas fa-exclamation-triangle"
            title="تعذّر تحميل السجل"
            description={error}
            action={
              <button type="button" className="btn btn-outline" onClick={() => void load(page)}>
                إعادة المحاولة
              </button>
            }
          />
        ) : events !== null && events.length === 0 ? (
          <EmptyState
            icon="fas fa-clipboard-list"
            title="لا توجد أحداث مطابقة"
            description="جرّب توسيع الفلاتر أو إزالتها."
          />
        ) : (
          <div className="shell-stack">
            {(events ?? []).map((e) => (
              <div key={e.id} className="store-row">
                <span className="store-row-icon" aria-hidden="true">
                  <i className="fas fa-clipboard-list"></i>
                </span>
                <span className="store-row-body">
                  <span className="store-row-name" dir="ltr">{e.action}</span>
                  <span className="store-row-meta">
                    <span dir="ltr">{e.created_at}</span>
                    <span aria-hidden="true">·</span>
                    <span dir="ltr">{e.actor_id}</span>
                    {e.store_id && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span dir="ltr">{e.store_id}</span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span dir="ltr">{e.result}</span>
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
        {pagination !== null && !loading && !error && (
          <Pagination
            page={pagination.page}
            totalPages={pagination.total_pages}
            onPage={(p) => setPage(p)}
          />
        )}
      </div>
    </>
  );
}
