"use client";

import { useEffect, useState, type FormEvent } from "react";
import { adminApi, type PageMeta } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { usePaging } from "@/hooks/usePaging";
import { TextField } from "@/components/auth/TextField";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { FormError } from "@/components/auth/FormError";
import { EmptyState } from "@/components/common/EmptyState";
import { Pagination } from "@/components/common/Pagination";
import type { MerchantAccount } from "@/types/api";

type RoleFilter = "" | "admin" | "merchant";

/**
 * Admin user accounts: role-inclusive directory (search + role filter +
 * pagination) above the existing assisted password-reset form. Read-only
 * directory — lifecycle stays merchant-scoped; admin rows are never
 * editable here (backend refuses peer-admin writes).
 */
export default function AdminUsersPage() {

  // --- Directory state (search + role filter + pagination) ---
  const [dirQuery, setDirQuery] = useState("");
  const [dirRole, setDirRole] = useState<RoleFilter>("");
  const { page: dirPage, setPage: setDirPage } = usePaging(`${dirQuery}:${dirRole}`);
  const [dirUsers, setDirUsers] = useState<MerchantAccount[]>([]);
  const [dirPagination, setDirPagination] = useState<PageMeta | null>(null);
  const [dirLoading, setDirLoading] = useState(true);
  const [dirError, setDirError] = useState<string | null>(null);

  async function loadDirectory(q: string, role: RoleFilter, targetPage: number) {
    setDirLoading(true);
    setDirError(null);
    try {
      const res = await adminApi.users.list(
        q.trim() === "" ? undefined : q.trim(),
        { page: targetPage },
        role === "" ? undefined : role
      );
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        setDirError(authErrorMessage(res, 400));
        setDirUsers([]);
        setDirPagination(null);
        return;
      }
      setDirUsers(res.data.users);
      setDirPagination(res.data.pagination);
    } catch {
      setDirError(NETWORK_ERROR_MESSAGE);
      setDirUsers([]);
      setDirPagination(null);
    } finally {
      setDirLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => {
      void loadDirectory(dirQuery, dirRole, dirPage);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirQuery, dirRole, dirPage]);

  const { refresh: refreshAuth } = useAuth();
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFieldErrors({});
    setFormError(null);
    setDone(null);
    const local: Record<string, string> = {};
    if (!userId.trim()) local.userId = "معرف المستخدم مطلوب.";
    if (password.length < 8) local.password = "كلمة المرور 8 أحرف على الأقل.";
    if (password.length > 256) local.password = "كلمة المرور طويلة جداً.";
    if (confirm !== password) local.confirm = "التأكيد غير مطابق.";
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      return;
    }
    if (!window.confirm(`تأكيد إعادة تعيين كلمة المرور للمستخدم ${userId.trim()}؟ سيتم إنهاء جميع جلساته.`)) {
      return;
    }
    setSubmitting(true);
    try {
      const res = await adminApi.resetUserPassword(userId.trim(), password);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "forbidden") {
          setFormError("لا يمكن إعادة تعيين كلمة مرور مدير آخر.");
          return;
        }
        if (code === "user_not_found") {
          setFormError("المستخدم غير موجود — تحقق من المعرف.");
          return;
        }
        setFormError(authErrorMessage(res, 400));
        return;
      }
      setDone(`تمت إعادة التعيين للمستخدم ${userId.trim()} وأُنهيت جميع جلساته.`);
      setUserId("");
      setPassword("");
      setConfirm("");
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
    <div className="shell-card" style={{ marginBottom: 16 }}>
      <h2 className="shell-card-title">دليل حسابات المستخدمين</h2>
      <p className="shell-note" style={{ marginBottom: 16 }}>
        يعرض التجار والمديرين معاً. الصق المعرف في نموذج إعادة التعيين أدناه عند الحاجة.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <input
          className="auth-input"
          dir="ltr"
          placeholder="merchant@example.com أو 0991234567"
          value={dirQuery}
          onChange={(e) => setDirQuery(e.target.value)}
          autoComplete="off"
          aria-label="البحث في الدليل"
          style={{ flex: "2 1 220px" }}
        />
        <select
          className="auth-input"
          value={dirRole}
          onChange={(e) => setDirRole(e.target.value as RoleFilter)}
          aria-label="تصفية حسب الدور"
          style={{ flex: "1 1 140px" }}
        >
          <option value="">كل الأدوار</option>
          <option value="merchant">تاجر</option>
          <option value="admin">مدير</option>
        </select>
      </div>
      {dirLoading ? (
        <div className="shell-loading">
          <span className="shell-spinner" aria-hidden="true"></span>
          جاري تحميل الدليل...
        </div>
      ) : dirError ? (
        <EmptyState
          icon="fas fa-exclamation-triangle"
          title="تعذّر تحميل الدليل"
          description={dirError}
          action={
            <button type="button" className="btn btn-outline" onClick={() => void loadDirectory(dirQuery, dirRole, dirPage)}>
              إعادة المحاولة
            </button>
          }
        />
      ) : dirUsers.length === 0 ? (
        <EmptyState
          icon="fas fa-users"
          title="لا توجد حسابات مطابقة"
          description="جرّب بريداً أو رقماً مختلفاً."
        />
      ) : (
        <div className="shell-stack">
          {dirUsers.map((u) => (
            <div key={u.id} className="store-row">
              <span className="store-row-icon" aria-hidden="true">
                <i className={`fas ${u.role === "admin" ? "fa-user-shield" : "fa-store"}`}></i>
              </span>
              <span className="store-row-body">
                <span className="store-row-name">
                  {u.name}
                  <span className={`sub-badge ${u.role === "admin" ? "sub-badge-admin" : "sub-badge-active"}`}>
                    {u.role === "admin" ? "مدير" : "تاجر"}
                  </span>
                </span>
                <span className="store-row-meta">
                  {u.email && (
                    <>
                      <span dir="ltr">{u.email}</span>
                      <span aria-hidden="true">·</span>
                    </>
                  )}
                  <span dir="ltr">{u.phone}</span>
                  <span aria-hidden="true">·</span>
                  <span dir="ltr">{u.id}</span>
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      {dirPagination !== null && !dirLoading && !dirError && (
        <Pagination
          page={dirPagination.page}
          totalPages={dirPagination.total_pages}
          onPage={(p) => setDirPage(p)}
        />
      )}
    </div>
    <div className="shell-card">
      <h2 className="shell-card-title">إعادة تعيين كلمة مرور مستخدم</h2>
      <p className="shell-note" style={{ marginBottom: 16 }}>
        للتجار فقط — محاولة استهداف مدير آخر مرفوضة من الخادم. الصق معرف
        المستخدم (يظهر مثلاً في بيانات المتاجر). الإجراء مسجّل تدقيقياً.
      </p>
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <FormError message={formError} />
        {done && (
          <div className="shell-success" role="status">
            <i className="fas fa-check-circle" aria-hidden="true"></i>
            <span>{done}</span>
          </div>
        )}
        <TextField
          label="معرف المستخدم"
          id="field-user-id"
          dir="ltr"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          error={fieldErrors.userId}
        />
        <PasswordInput
          label="كلمة المرور الجديدة"
          id="field-admin-new-password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
        />
        <PasswordInput
          label="تأكيد كلمة المرور"
          id="field-admin-confirm-password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={fieldErrors.confirm}
        />
        <button
          type="submit"
          className="btn btn-primary btn-lg auth-submit"
          disabled={submitting}
        >
          {submitting ? "جاري التنفيذ..." : "إعادة التعيين"}
        </button>
      </form>
    </div>
    </>
  );
}
