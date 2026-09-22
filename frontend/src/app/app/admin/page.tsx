"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { adminApi, storesApi } from "@/lib/api";
import { isApiError } from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { StatCard } from "@/components/common/StatCard";
import { EmptyState } from "@/components/common/EmptyState";
import type { Store, Subscription } from "@/types/api";

/** Admin overview: platform counts + latest subscriptions (client-computed). */
export default function AdminOverviewPage() {
  const { refresh: refreshAuth } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, u] = await Promise.all([
          storesApi.list(),
          adminApi.subscriptions.list(),
        ]);
        if (cancelled) return;
        for (const res of [s, u]) {
          if (!res.ok && isApiError(res) && res.error.code === "unauthorized") {
            await refreshAuth();
            return;
          }
        }
        if (!s.ok || !u.ok) {
          setError("تعذّر تحميل بيانات المنصة.");
          return;
        }
        setStores(s.data.stores);
        setSubs(u.data.subscriptions);
      } catch {
        if (!cancelled) setError("تعذّر الاتصال بالخادم.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshAuth]);

  if (loading) {
    return (
      <div className="shell-loading">
        <span className="shell-spinner" aria-hidden="true"></span>
        جاري تحميل بيانات المنصة...
      </div>
    );
  }

  if (error) {
    return (
      <div className="shell-card">
        <EmptyState
          icon="fas fa-exclamation-triangle"
          title="تعذّر التحميل"
          description={error}
        />
      </div>
    );
  }

  const active = subs.filter((s) => s.status === "active").length;

  return (
    <>
      <div className="shell-grid">
        <StatCard
          title="متاجر المنصة"
          value={stores.length.toLocaleString("ar-SY")}
          icon="fas fa-store"
        />
        <StatCard
          title="اشتراكات نشطة"
          value={active.toLocaleString("ar-SY")}
          icon="fas fa-badge-check"
          hint={`من أصل ${subs.length.toLocaleString("ar-SY")} فترة مسجلة`}
        />
        <StatCard
          title="فترات الاشتراك الكلية"
          value={subs.length.toLocaleString("ar-SY")}
          icon="fas fa-history"
          hint="السجل تراكمي لا يُحذف"
        />
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">أحدث الاشتراكات</h2>
        {subs.length === 0 ? (
          <EmptyState
            icon="fas fa-file-contract"
            title="لا توجد اشتراكات بعد"
            description="فعّل اشتراكاً من صفحة الاشتراكات."
            action={
              <Link href="/app/admin/subscriptions" className="btn btn-primary">
                إدارة الاشتراكات
              </Link>
            }
          />
        ) : (
          <div className="shell-stack">
            {subs.slice(0, 5).map((sub) => (
              <div key={sub.id} className="store-row">
                <span className="store-row-icon" aria-hidden="true">
                  <i className="fas fa-file-contract"></i>
                </span>
                <span className="store-row-body">
                  <span className="store-row-name" dir="ltr">{sub.id}</span>
                  <span className="store-row-meta">
                    <span>{sub.status}</span>
                    <span>·</span>
                    <span>{sub.billing_period}</span>
                  </span>
                </span>
                <Link
                  href="/app/admin/subscriptions"
                  className="btn btn-ghost btn-shell-dark btn-sm"
                >
                  التفاصيل
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
