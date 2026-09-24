"use client";

import { useRef, useState, type FormEvent } from "react";
import { authApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { RequireAuth } from "@/components/guards/RequireAuth";
import { AuthCard } from "@/components/auth/AuthCard";
import { BackButton } from "@/components/common/BackButton";
import { TextField } from "@/components/auth/TextField";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { FormError } from "@/components/auth/FormError";
import { Button } from "@/components/ui/Button";
import { Loading } from "@/components/ui/Loading";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ProfilePage() {
  return (
    <RequireAuth>
      <ProfileContent />
    </RequireAuth>
  );
}

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_ACCEPT = "image/jpeg,image/png,image/webp";

function ProfileContent() {
  const { user, refresh, logout } = useAuth();
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [logoutOthers, setLogoutOthers] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function clearPreview() {
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    if (fileRef.current) fileRef.current.value = "";
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarError(null);
    if (!file.type.startsWith("image/")) {
      setAvatarError("الملف المختار ليس صورة مدعومة.");
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError("حجم الصورة كبير جداً (الحد الأقصى 5 م.ب).");
      return;
    }
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  }

  async function onSaveAvatar() {
    const file = fileRef.current?.files?.[0];
    if (!file || avatarBusy) return;
    setAvatarError(null);
    setAvatarBusy(true);
    try {
      const res = await authApi.uploadAvatar(file);
      if (!res.ok) {
        const code = (res as { error?: { code?: string } }).error?.code;
        setAvatarError(
          code === "body_too_large"
            ? "حجم الصورة كبير جداً (الحد الأقصى 5 م.ب)."
            : code === "invalid_image"
              ? "الملف المختار ليس صورة مدعومة."
              : code === "storage_unavailable"
                ? "خدمة تخزين الصور غير مفعّلة حالياً."
                : NETWORK_ERROR_MESSAGE
        );
        return;
      }
      clearPreview();
      await refresh();
    } catch {
      setAvatarError(NETWORK_ERROR_MESSAGE);
    } finally {
      setAvatarBusy(false);
    }
  }

  async function onDeleteAvatar() {
    if (avatarBusy) return;
    setAvatarError(null);
    setAvatarBusy(true);
    try {
      const res = await authApi.deleteAvatar();
      if (!res.ok) {
        setAvatarError(NETWORK_ERROR_MESSAGE);
        return;
      }
      await refresh();
    } catch {
      setAvatarError(NETWORK_ERROR_MESSAGE);
    } finally {
      setAvatarBusy(false);
    }
  }

  if (!user) return null;
  const curName = name ?? user.name;
  const curEmail = email ?? user.email ?? "";
  const curPhone = phone ?? user.phone;
  const emailChanged = curEmail.trim() !== (user.email ?? "");
  const phoneChanged = curPhone.trim() !== user.phone;
  const identityChanged = emailChanged || phoneChanged;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFieldErrors({});
    setFormError(null);
    setSaved(false);

    const local: Record<string, string> = {};
    if (!curName.trim()) local.name = "الاسم مطلوب.";
    if (emailChanged && !EMAIL_RE.test(curEmail.trim()))
      local.email = "أدخل بريداً إلكترونياً صالحاً.";
    if (!curPhone.trim()) local.phone = "رقم الهاتف مطلوب.";
    // Backend contract: email/phone changes require the current password.
    if (identityChanged && !currentPassword)
      local.current_password = "كلمة المرور الحالية مطلوبة لتغيير البريد أو الهاتف.";
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      return;
    }

    setSubmitting(true);
    try {
      const res = await authApi.updateProfile({
        name: curName.trim(),
        email: curEmail.trim() === "" ? null : curEmail.trim(),
        phone: curPhone.trim(),
        ...(identityChanged ? { current_password: currentPassword } : {}),
        // Explicit opt-in, default false: the calling session always survives.
        logout_other_sessions: logoutOthers,
      });
      if (!res.ok) {
        const code = getErrorCode(res);
        const fields = getFieldErrors(res);
        if (code === "email_taken") fields.email = fields.email || "هذا البريد مسجّل مسبقاً.";
        if (code === "phone_taken") fields.phone = fields.phone || "هذا الرقم مسجّل مسبقاً.";
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        setFormError(authErrorMessage(res, 400));
        return;
      }
      await refresh();
      setCurrentPassword("");
      setLogoutOthers(false);
      setSaved(true);
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
      title="حسابي"
      subtitle="بياناتك الأساسية في سلة سوريا."
      footer={
        <>
          <span>
            <a href="/auth/change-password">تغيير كلمة المرور</a>
            {" · "}
            <a href="/auth/sessions">الجلسات النشطة</a>
          </span>
          <span>
            <a
              href="/auth/login"
              onClick={async (e) => {
                e.preventDefault();
                setLoggingOut(true);
                await logout();
              }}
            >
              {loggingOut ? "جاري تسجيل الخروج..." : "تسجيل الخروج"}
            </a>
          </span>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, marginBottom: 20 }}>
        {preview ? (
          <img src={preview} alt="معاينة الصورة الشخصية" className="auth-avatar-img" />
        ) : user.avatar_url ? (
          <img src={user.avatar_url} alt="الصورة الشخصية الحالية" className="auth-avatar-img" />
        ) : (
          <span className="auth-avatar-fallback" aria-hidden="true">
            {(user.name.trim()[0] ?? "م").toUpperCase()}
          </span>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={AVATAR_ACCEPT}
          hidden
          aria-label="اختيار صورة شخصية"
          onChange={onPickFile}
        />
        {avatarError && (
          <p className="auth-field-error" role="alert">{avatarError}</p>
        )}
        {preview ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-primary" disabled={avatarBusy} onClick={onSaveAvatar}>
              {avatarBusy ? "جاري الحفظ..." : "حفظ"}
            </button>
            <button type="button" className="btn btn-outline" disabled={avatarBusy} onClick={clearPreview}>
              إلغاء
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            <button type="button" className="btn btn-outline" disabled={avatarBusy} onClick={() => fileRef.current?.click()}>
              تغيير الصورة الشخصية
            </button>
            {user.avatar_url && (
              <button type="button" className="btn btn-outline" disabled={avatarBusy} onClick={onDeleteAvatar}>
                {avatarBusy ? "جاري الحذف..." : "حذف الصورة"}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="auth-form" style={{ marginBottom: 20 }}>
        <div className="auth-profile-row">
          <span className="key">الدور</span>
          <span className="value">
            <span className={`auth-badge${user.role === "admin" ? " auth-badge-admin" : ""}`}>
              {user.role === "admin" ? "مدير المنصة" : "تاجر"}
            </span>
          </span>
        </div>
        <div className="auth-profile-row">
          <span className="key">توثيق البريد</span>
          <span className="value">{user.email_verified === 1 ? "موثّق" : "غير موثّق"}</span>
        </div>
      </div>

      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <FormError message={formError} />
        {saved && (
          <div className="auth-success" role="status">
            <i className="fas fa-check-circle" aria-hidden="true"></i>
            <span>تم حفظ بياناتك بنجاح.</span>
          </div>
        )}
        <TextField
          label="الاسم"
          autoComplete="name"
          value={curName}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
          error={fieldErrors.name}
        />
        <TextField
          label="البريد الإلكتروني"
          type="email"
          dir="ltr"
          autoComplete="email"
          value={curEmail}
          onChange={(e) => {
            setEmail(e.target.value);
            setSaved(false);
          }}
          error={fieldErrors.email}
        />
        <TextField
          label="رقم الهاتف"
          type="tel"
          dir="ltr"
          autoComplete="tel"
          value={curPhone}
          onChange={(e) => {
            setPhone(e.target.value);
            setSaved(false);
          }}
          error={fieldErrors.phone}
        />
        {identityChanged && (
          <>
            <div className="auth-notice" role="status">
              <i className="fas fa-shield-alt" aria-hidden="true"></i>
              <span>تغيير البريد أو الهاتف يتطلب كلمة المرور الحالية.</span>
            </div>
            <PasswordInput
              label="كلمة المرور الحالية"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              error={fieldErrors.current_password}
            />
            <label className="auth-check">
              <input
                type="checkbox"
                checked={logoutOthers}
                onChange={(e) => setLogoutOthers(e.target.checked)}
              />
              <span>تسجيل الخروج من جميع الجلسات الأخرى (جلستك الحالية تبقى)</span>
            </label>
          </>
        )}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="btn btn-primary btn-lg auth-submit"
          disabled={submitting}
        >
          {submitting ? <Loading size="sm" text="جاري الحفظ..." /> : "حفظ التغييرات"}
        </Button>
      </form>
    </AuthCard>
    </>
  );
}
