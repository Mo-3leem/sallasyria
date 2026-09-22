"use client";

import { useState, type FormEvent } from "react";
import { adminApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { TextField } from "@/components/auth/TextField";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { FormError } from "@/components/auth/FormError";

/**
 * Assisted password reset for non-admin users. There is no user directory
 * endpoint — the target id is pasted in (e.g. a store owner's id from the
 * stores list). Peer-admin resets are refused by the backend (403).
 * Revokes every session of the target, audited server-side.
 */
export default function AdminUsersPage() {
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
  );
}
