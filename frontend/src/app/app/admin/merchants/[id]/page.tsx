"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { adminApi } from "@/lib/api";
import type { Customer, MerchantAccount, Store } from "@/types/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { EmptyState } from "@/components/common/EmptyState";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { TextField } from "@/components/auth/TextField";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { FormError } from "@/components/auth/FormError";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type LoadState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; merchant: MerchantAccount; stores: Store[] };

/** Admin merchant detail: view/edit, password reset, delete, customers. */
export default function AdminMerchantPage({
  params,
}: {
  params: { id: string };
}) {
  const { id } = params;
  const router = useRouter();
  const { refresh: refreshAuth } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  // Edit form
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // Password reset
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);
  const [pwWorking, setPwWorking] = useState(false);

  // Delete
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Customers
  const [storeId, setStoreId] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [customersLoading, setCustomersLoading] = useState(false);

  async function load() {
    setState({ kind: "loading" });
    setActionError(null);
    try {
      const res = await adminApi.merchants.get(id);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        setState({ kind: "missing" });
        return;
      }
      const { merchant, stores } = res.data;
      setName(merchant.name);
      setEmail(merchant.email ?? "");
      setPhone(merchant.phone);
      setIsActive(merchant.is_active !== 0);
      setState({ kind: "ready", merchant, stores });
      if (stores.length > 0) setStoreId((prev) => prev === "" ? stores[0]!.id : prev);
    } catch {
      setState({ kind: "missing" });
    }
  }

  async function loadCustomers(sid: string, q: string) {
    if (sid === "") {
      setCustomers(null);
      return;
    }
    setCustomersLoading(true);
    try {
      const res = await adminApi.storeCustomers.list(sid, q.trim() === "" ? undefined : q.trim());
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        setCustomers([]);
        return;
      }
      setCustomers(res.data.customers);
    } catch {
      setCustomers([]);
    } finally {
      setCustomersLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const t = setTimeout(() => {
      void loadCustomers(storeId, customerQuery);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, customerQuery]);

  if (state.kind === "loading") {
    return (
      <div className="shell-loading">
        <span className="shell-spinner" aria-hidden="true"></span>
        جاري تحميل التاجر...
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <div className="shell-card">
        <EmptyState
          icon="fas fa-store-slash"
          title="التاجر غير موجود"
          action={
            <Link href="/app/admin/merchants" className="btn btn-primary">
              العودة إلى التجار
            </Link>
          }
        />
      </div>
    );
  }

  const { merchant, stores } = state;
  const confirmIdentity = merchant.email ?? merchant.phone;

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setFieldErrors({});
    setFormError(null);
    setSaved(false);
    const local: Record<string, string> = {};
    if (!name.trim()) local.name = "الاسم مطلوب.";
    if (email.trim() !== "" && !EMAIL_RE.test(email.trim()))
      local.email = "أدخل بريداً إلكترونياً صالحاً.";
    if (!phone.trim()) local.phone = "رقم الهاتف مطلوب.";
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      return;
    }
    const diff: { name?: string; email?: string | null; phone?: string; is_active?: 0 | 1 } = {};
    if (name.trim() !== merchant.name) diff.name = name.trim();
    if ((email.trim() === "" ? null : email.trim()) !== merchant.email)
      diff.email = email.trim() === "" ? null : email.trim();
    if (phone.trim() !== merchant.phone) diff.phone = phone.trim();
    if ((isActive ? 1 : 0) !== (merchant.is_active ?? 1)) diff.is_active = isActive ? 1 : 0;
    if (Object.keys(diff).length === 0) {
      setSaved(true);
      return;
    }
    setSaving(true);
    try {
      const res = await adminApi.merchants.update(id, diff);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        const fields = getFieldErrors(res);
        if (code === "email_taken") fields.email = fields.email || "هذا البريد مسجّل مسبقاً.";
        if (code === "phone_taken") fields.phone = fields.phone || "هذا الرقم مسجّل مسبقاً.";
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        setFormError(authErrorMessage(res, 400));
        return;
      }
      setSaved(true);
      await load();
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  async function onResetPassword(e: FormEvent) {
    e.preventDefault();
    if (pwWorking) return;
    setPwError(null);
    setPwDone(false);
    if (newPassword.length < 8) {
      setPwError("كلمة المرور 8 أحرف على الأقل.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError("التأكيد غير مطابق.");
      return;
    }
    if (!window.confirm(`تأكيد إعادة تعيين كلمة المرور للتاجر ${merchant.name}؟ سيتم إنهاء جميع جلساته.`)) {
      return;
    }
    setPwWorking(true);
    try {
      const res = await adminApi.resetUserPassword(id, newPassword);
      if (!res.ok) {
        setPwError(authErrorMessage(res, 400));
        return;
      }
      setPwDone(true);
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      setPwError(NETWORK_ERROR_MESSAGE);
    } finally {
      setPwWorking(false);
    }
  }

  async function onDelete() {
    if (deleting) return;
    setDeleting(true);
    setActionError(null);
    try {
      const res = await adminApi.merchants.remove(id);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "merchant_has_stores") {
          setActionError(
            "لا يمكن حذف هذا التاجر لأنه يملك متاجر. احذف المتاجر أو انقل ملكيتها أولاً — لا تُحذف بيانات الأعمال تلقائياً."
          );
        } else {
          setActionError(authErrorMessage(res, 400));
        }
        setConfirmDelete(false);
        return;
      }
      router.replace("/app/admin/merchants");
    } catch {
      setActionError(NETWORK_ERROR_MESSAGE);
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="shell-page-head">
        <h1>{merchant.name}</h1>
        <p>
          <Link href="/app/admin/merchants">التجار</Link>
          {" / "}
          تفاصيل التاجر
        </p>
      </div>

      {actionError && (
        <div className="shell-error" role="alert">
          <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
          <span>{actionError}</span>
        </div>
      )}

      <div className="shell-card">
        <h2 className="shell-card-title">بيانات الحساب</h2>
        <div className="auth-profile-row">
          <span className="key">البريد</span>
          <span className="value" dir="ltr">{merchant.email ?? "—"}</span>
        </div>
        <div className="auth-profile-row">
          <span className="key">الهاتف</span>
          <span className="value" dir="ltr">{merchant.phone}</span>
        </div>
        <div className="auth-profile-row">
          <span className="key">توثيق البريد</span>
          <span className="value">{merchant.email_verified === 1 ? "موثّق" : "غير موثّق"}</span>
        </div>
        <div className="auth-profile-row">
          <span className="key">الحالة</span>
          <span className="value">{(merchant.is_active ?? 1) === 1 ? "نشط" : "معطّل"}</span>
        </div>
        <div className="auth-profile-row">
          <span className="key">المتاجر</span>
          <span className="value">{stores.length.toLocaleString("ar-SY")}</span>
        </div>

        <form onSubmit={onSave} noValidate aria-label="تعديل بيانات التاجر" style={{ marginTop: 16 }}>
          <FormError message={formError} />
          {saved && (
            <div className="shell-success" role="status" style={{ marginBottom: 16 }}>
              <i className="fas fa-check-circle" aria-hidden="true"></i>
              <span>تم الحفظ.</span>
            </div>
          )}
          <TextField label="الاسم" value={name} onChange={(e) => setName(e.target.value)} error={fieldErrors.name} />
          <TextField label="البريد الإلكتروني" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} error={fieldErrors.email} />
          <TextField label="رقم الهاتف" type="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} error={fieldErrors.phone} />
          <label className="auth-check">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            <span>الحساب نشط (إلغاء التحديد يعطّل الدخول)</span>
          </label>
          <button type="submit" className="btn btn-primary auth-submit" disabled={saving}>
            {saving ? "جاري الحفظ..." : "حفظ التغييرات"}
          </button>
        </form>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">تغيير كلمة المرور</h2>
        <p className="shell-note" style={{ marginBottom: 12 }}>
          تُعاد تعيين كلمة المرور فوراً وتُنهى جميع جلسات التاجر. لا يظهر لك أي رمز حالي.
        </p>
        <form onSubmit={onResetPassword} noValidate>
          <FormError message={pwError} />
          {pwDone && (
            <div className="shell-success" role="status" style={{ marginBottom: 16 }}>
              <i className="fas fa-check-circle" aria-hidden="true"></i>
              <span>تمت إعادة التعيين وأُنهيت جميع جلسات التاجر.</span>
            </div>
          )}
          <PasswordInput label="كلمة المرور الجديدة" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          <PasswordInput label="تأكيد كلمة المرور" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
          <button type="submit" className="btn btn-outline auth-submit" disabled={pwWorking}>
            {pwWorking ? "جاري التنفيذ..." : "إعادة تعيين كلمة المرور"}
          </button>
        </form>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">حذف التاجر</h2>
        <p className="shell-note" style={{ marginBottom: 12 }}>
          الحذف نهائي ولا يمكن التراجع عنه. يُمنع الحذف إذا كان التاجر يملك متاجر — لحماية سجل الأعمال.
        </p>
        <button type="button" className="btn btn-outline" onClick={() => setConfirmDelete(true)}>
          <i className="fas fa-trash" aria-hidden="true"></i>
          حذف التاجر نهائياً
        </button>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">عملاء التاجر</h2>
        {stores.length === 0 ? (
          <p className="shell-note">لا يملك هذا التاجر أي متجر بعد.</p>
        ) : (
          <>
            <div className="auth-field" style={{ marginBottom: 12 }}>
              <label className="auth-label" htmlFor="admin-store">المتجر</label>
              <select
                id="admin-store"
                className="auth-input"
                value={storeId}
                onChange={(e) => {
                  setStoreId(e.target.value);
                  setCustomerQuery("");
                }}
              >
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.slug})
                  </option>
                ))}
              </select>
            </div>
            <div className="auth-field" style={{ marginBottom: 12 }}>
              <label className="auth-label" htmlFor="admin-customer-search">
                البحث بالبريد الإلكتروني أو رقم الهاتف
              </label>
              <input
                id="admin-customer-search"
                className="auth-input"
                dir="ltr"
                value={customerQuery}
                onChange={(e) => setCustomerQuery(e.target.value)}
                autoComplete="off"
              />
            </div>
            {customersLoading ? (
              <div className="shell-loading">
                <span className="shell-spinner" aria-hidden="true"></span>
                جاري تحميل العملاء...
              </div>
            ) : customers !== null && customers.length === 0 ? (
              <p className="shell-note">لا يوجد عملاء مطابقون في هذا المتجر.</p>
            ) : (
              <div className="shell-stack">
                {(customers ?? []).map((c) => (
                  <Link
                    key={c.id}
                    href={`/app/admin/merchants/${encodeURIComponent(id)}/customers/${encodeURIComponent(c.id)}?store=${encodeURIComponent(storeId)}`}
                    className="store-row"
                  >
                    <span className="store-row-icon" aria-hidden="true">
                      <i className="fas fa-user"></i>
                    </span>
                    <span className="store-row-body">
                      <span className="store-row-name">{c.name}</span>
                      <span className="store-row-meta">
                        {c.email && (
                          <>
                            <span dir="ltr">{c.email}</span>
                            <span aria-hidden="true">·</span>
                          </>
                        )}
                        <span dir="ltr">{c.phone}</span>
                      </span>
                    </span>
                    <i className="fas fa-chevron-left" aria-hidden="true" style={{ color: "var(--gray-3)" }}></i>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="حذف التاجر نهائياً؟"
        description={`سيتم حذف حساب «${merchant.name}» (${confirmIdentity}) نهائياً ولا يمكن التراجع. إذا كان يملك متاجر، سيُرفض الحذف لحماية سجل الأعمال.`}
        confirmLabel="حذف نهائي"
        confirming={deleting}
        requireConfirmText={confirmIdentity}
        requireConfirmPlaceholder={confirmIdentity}
        onClose={() => setConfirmDelete(false)}
        onConfirm={onDelete}
      />
    </>
  );
}
