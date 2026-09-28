"use client";

import { useEffect, useState } from "react";
import { authApi } from "@/lib/api";
import type { SessionEntry } from "@/types/api";
import { authErrorMessage, getErrorCode, NETWORK_ERROR_MESSAGE } from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { RequireAuth } from "@/components/guards/RequireAuth";
import { AuthCard } from "@/components/auth/AuthCard";
import { BackButton } from "@/components/common/BackButton";
import { EmptyState } from "@/components/common/EmptyState";
import { FormError } from "@/components/auth/FormError";
import { Button } from "@/components/ui/Button";
import { Loading } from "@/components/ui/Loading";

export default function SessionsPage() {
  return (
    <RequireAuth>
      <SessionsContent />
    </RequireAuth>
  );
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ar-SY", { dateStyle: "medium", timeStyle: "short" });
}

function SessionsContent() {
  const { refresh: refreshAuth } = useAuth();
  const [sessions, setSessions] = useState<SessionEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revoked, setRevoked] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setFormError(null);
    try {
      const res = await authApi.sessions.list();
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        setFormError(authErrorMessage(res, 400));
        setSessions([]);
        return;
      }
      setSessions(res.data.sessions);
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onRevokeOne(id: string) {
    if (revokingId) return;
    setFormError(null);
    setNotice(null);
    setRevoked(null);
    setRevokingId(id);
    try {
      const res = await authApi.sessions.remove(id);
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        setFormError(authErrorMessage(res, 400));
        return;
      }
      setNotice("تم إنهاء الجلسة المحددة.");
      await load();
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setRevokingId(null);
    }
  }

  async function onLogoutOthers() {
    if (submitting) return;
    setFormError(null);
    setNotice(null);
    setRevoked(null);
    setSubmitting(true);
    try {
      const res = await authApi.logoutOthers();
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        setFormError(authErrorMessage(res, 400));
        return;
      }
      setRevoked(res.data.revoked);
      await load();
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <BackButton href="/app/settings" />
      <AuthCard
      title="الجلسات النشطة"
      subtitle="جلستك الحالية مشار إليها ولا يمكن إنهاؤها من هنا — استخدم تسجيل الخروج لإنهائها. يمكنك إنهاء أي جلسة أخرى فرادى أو جميعها دفعة واحدة."
      footer={
        <span>
          <a href="/auth/profile">العودة إلى حسابي</a>
        </span>
      }
    >
      <div className="auth-form">
        <FormError message={formError} />
        {notice && (
          <div className="auth-success" role="status">
            <i className="fas fa-check-circle" aria-hidden="true"></i>
            <span>{notice}</span>
          </div>
        )}
        {revoked !== null && (
          <div className="auth-success" role="status">
            <i className="fas fa-check-circle" aria-hidden="true"></i>
            <span>تم إنهاء {revoked} جلسة أخرى.</span>
          </div>
        )}
        {loading ? (
          <Loading text="جاري تحميل الجلسات..." />
        ) : sessions !== null && sessions.length === 0 ? (
          <EmptyState
            icon="fas fa-laptop"
            title="لا توجد جلسات أخرى"
            description="جلستك الحالية هي الجلسة النشطة الوحيدة."
          />
        ) : (
          <div className="shell-stack">
            {(sessions ?? []).map((s) => (
              <div key={s.id} className="store-row">
                <span className="store-row-icon" aria-hidden="true">
                  <i className="fas fa-laptop"></i>
                </span>
                <span className="store-row-body">
                  <span className="store-row-name">
                    {s.current ? "هذه الجلسة" : "جلسة أخرى"}
                    {s.current && (
                      <span className="sub-badge sub-badge-active" style={{ marginInlineStart: 8 }}>
                        الحالية
                      </span>
                    )}
                  </span>
                  <span className="store-row-meta">
                    <span>بدأت: {formatDateTime(s.created_at)}</span>
                    <span aria-hidden="true">·</span>
                    <span>آخر نشاط: {formatDateTime(s.last_used_at)}</span>
                  </span>
                </span>
                {!s.current && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-shell-dark btn-sm"
                    disabled={revokingId !== null}
                    onClick={() => void onRevokeOne(s.id)}
                  >
                    {revokingId === s.id ? "جاري الإنهاء..." : "إنهاء الجلسة"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <Button
          type="button"
          variant="primary"
          size="lg"
          className="btn btn-primary btn-lg auth-submit"
          onClick={onLogoutOthers}
          disabled={submitting || loading}
        >
          {submitting ? (
            <Loading size="sm" text="جاري إنهاء الجلسات الأخرى..." />
          ) : (
            "إنهاء جميع الجلسات الأخرى"
          )}
        </Button>
      </div>
    </AuthCard>
    </>
  );
}
