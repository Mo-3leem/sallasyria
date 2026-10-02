"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { adminApi, type PageMeta } from "@/lib/api";
import type { Customer, MerchantAccount, Store, Subscription } from "@/types/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { usePaging } from "@/hooks/usePaging";
import { BackButton } from "@/components/common/BackButton";
import { EmptyState } from "@/components/common/EmptyState";
import { Pagination } from "@/components/common/Pagination";
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
  return (
    <Suspense
      fallback={
        <div className="shell-loading">
          <span className="shell-spinner" aria-hidden="true"></span>
          جاري التحميل...
        </div>
      }
    >
      <AdminMerchantDetail id={params.id} />
    </Suspense>
  );
}

function AdminMerchantDetail({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const backQuery = searchParams.get("q") ?? "";
  const backHref =
    backQuery.trim() === ""
      ? "/app/admin/merchants"
      : `/app/admin/merchants?q=${encodeURIComponent(backQuery.trim())}`;
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
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [blockedStores, setBlockedStores] = useState<Store[] | null>(null);
  const blockedRef = useRef<HTMLDivElement | null>(null);

  // Store deletion inside the blocking flow
  const [storeConfirm, setStoreConfirm] = useState<Store | null>(null);
  const [storeDeleting, setStoreDeleting] = useState(false);
  const [storeMsg, setStoreMsg] = useState<{
    kind: "success" | "error";
    storeId: string;
    storeName: string;
    text: string;
    subscriptions?: Subscription[];
  } | null>(null);

  // Customers
  const [storeId, setStoreId] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const { page: customerPage, setPage: setCustomerPage } = usePaging(`${storeId}:${customerQuery}`);
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [customersPagination, setCustomersPagination] = useState<PageMeta | null>(null);
  const [customersLoading, setCustomersLoading] = useState(false);

  async function load(): Promise<{ merchant: MerchantAccount; stores: Store[] } | null> {
    setState({ kind: "loading" });
    setActionError(null);
    try {
      const res = await adminApi.merchants.get(id);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return null;
        }
        setState({ kind: "missing" });
        return null;
      }
      const { merchant, stores } = res.data;
      setName(merchant.name);
      setEmail(merchant.email ?? "");
      setPhone(merchant.phone);
      setIsActive(merchant.is_active !== 0);
      setState({ kind: "ready", merchant, stores });
      if (stores.length > 0) setStoreId((prev) => prev === "" ? stores[0]!.id : prev);
      return { merchant, stores };
    } catch {
      setState({ kind: "missing" });
      return null;
    }
  }

  async function loadCustomers(sid: string, q: string, targetPage: number) {
    if (sid === "") {
      setCustomers(null);
      setCustomersPagination(null);
      return;
    }
    setCustomersLoading(true);
    try {
      const res = await adminApi.storeCustomers.list(sid, q.trim() === "" ? undefined : q.trim(), { page: targetPage });
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        setCustomers([]);
        setCustomersPagination(null);
        return;
      }
      setCustomers(res.data.customers);
      setCustomersPagination(res.data.pagination);
    } catch {
      setCustomers([]);
      setCustomersPagination(null);
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
      void loadCustomers(storeId, customerQuery, customerPage);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, customerQuery, customerPage]);

  useEffect(() => {
    if (blockedStores !== null) {
      blockedRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [blockedStores]);

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
  const customerHref = (c: Customer) =>
    `/app/admin/merchants/${encodeURIComponent(id)}/customers/${encodeURIComponent(c.id)}?store=${encodeURIComponent(storeId)}${backQuery.trim() === "" ? "" : `&q=${encodeURIComponent(backQuery.trim())}`}`;

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
    setDeleteError(null);
    try {
      const res = await adminApi.merchants.remove(id);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "merchant_has_stores") {
          const fresh = await load();
          setBlockedStores(fresh ? fresh.stores : stores);
        } else {
          setDeleteError(authErrorMessage(res, 400));
        }
        setConfirmDelete(false);
        return;
      }
      router.replace("/app/admin/merchants");
    } catch {
      setDeleteError(NETWORK_ERROR_MESSAGE);
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  function storeDeleteMessage(code: string | null, res: unknown): string {
    if (code === "store_has_orders")
      return "لا يمكن حذف هذا المتجر حالياً لأنه يحتوي على سجل طلبات. سجل الطلبات محفوظ ولا يُحذف — راجع طلبات المتجر أولاً.";
    if (code === "store_has_subscriptions")
      return "لا يمكن حذف هذا المتجر حالياً لأنه مرتبط باشتراكات. عالج الاشتراكات أولاً ثم أعد المحاولة.";
    if (code === "store_has_dependents")
      return "لا يمكن حذف هذا المتجر حالياً لأنه يحتوي على بيانات مرتبطة به. يجب معالجة هذه البيانات أولًا.";
    if (code === "store_not_found")
      return "المتجر غير موجود — ربما حُذف مسبقاً. حدّث الصفحة.";
    return authErrorMessage(res, 400);
  }

  async function onConfirmStoreDelete() {
    if (!storeConfirm || storeDeleting) return;
    const target = storeConfirm;
    setStoreDeleting(true);
    setStoreMsg(null);
    try {
      const res = await adminApi.merchantStores.remove(id, target.id);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_has_subscriptions") {
          setStoreMsg({
            kind: "error",
            storeId: target.id,
            storeName: target.name,
            text: storeDeleteMessage(code, res),
            subscriptions: await loadStoreSubscriptions(target.id),
          });
        } else {
          setStoreMsg({ kind: "error", storeId: target.id, storeName: target.name, text: storeDeleteMessage(code, res) });
        }
        setStoreConfirm(null);
        return;
      }
      setStoreConfirm(null);
      const fresh = await load();
      const remaining = fresh ? fresh.stores : (blockedStores ?? []).filter((s) => s.id !== target.id);
      setBlockedStores(remaining);
      setStoreMsg({ kind: "success", storeId: target.id, storeName: target.name, text: `تم حذف متجر «${target.name}» نهائياً.` });
    } catch {
      setStoreMsg({ kind: "error", storeId: target.id, storeName: target.name, text: NETWORK_ERROR_MESSAGE });
      setStoreConfirm(null);
    } finally {
      setStoreDeleting(false);
    }
  }

  async function loadStoreSubscriptions(storeId: string): Promise<Subscription[] | undefined> {
    try {
      const res = await adminApi.subscriptions.list();
      if (!res.ok) return undefined;
      return res.data.subscriptions.filter((s) => s.store_id === storeId);
    } catch {
      return undefined;
    }
  }

  return (
    <>
      <BackButton href={backHref} label="العودة إلى التجار" />
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
        {deleteError && (
          <div className="shell-error" role="alert" style={{ marginTop: 12 }}>
            <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
            <span>{deleteError}</span>
          </div>
        )}
      </div>

      {blockedStores !== null && (
        <div className="shell-card shell-card-blocking" ref={blockedRef} role="alert" aria-label="تعذّر حذف التاجر" tabIndex={-1}>
          <h2 className="blocking-title">
            <i className="fas fa-ban" aria-hidden="true"></i>
            لا يمكن حذف التاجر حاليًا
          </h2>
          <p className="blocking-reason">
            هذا التاجر لديه متاجر مرتبطة بحسابه، لذلك لا يمكن حذف حسابه قبل حذف جميع المتاجر المرتبطة به.
          </p>
          {storeMsg && storeMsg.kind === "success" && (
            <div className="shell-success" role="status" style={{ marginBottom: 12 }}>
              <i className="fas fa-check-circle" aria-hidden="true"></i>
              <span>{storeMsg.text}</span>
            </div>
          )}
          {storeMsg && storeMsg.kind === "error" && (
            <div className="shell-card-blocking-inner" role="alert" aria-label={`تعذّر حذف المتجر ${storeMsg.storeName}`}>
              <h3 className="blocking-title" style={{ fontSize: "0.95rem" }}>
                <i className="fas fa-ban" aria-hidden="true"></i>
                لا يمكن حذف المتجر «{storeMsg.storeName}»
              </h3>
              <p className="blocking-subtitle">سبب منع الحذف:</p>
              <p className="blocking-reason">{storeMsg.text}</p>
              {storeMsg.subscriptions !== undefined && (
                <>
                  {storeMsg.subscriptions.length > 0 && (
                    <>
                      <p className="blocking-subtitle">الاشتراكات المرتبطة:</p>
                      <div className="shell-stack" style={{ marginBottom: 12 }}>
                        {storeMsg.subscriptions.map((sub) => (
                          <div key={sub.id} className="store-row">
                            <span className="store-row-icon" aria-hidden="true">
                              <i className="fas fa-file-contract"></i>
                            </span>
                            <span className="store-row-body">
                              <span className="store-row-name" dir="ltr">{sub.id}</span>
                              <span className="store-row-meta">
                                <span>{sub.status}</span>
                                <span aria-hidden="true">·</span>
                                <span>{sub.billing_period}</span>
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  <p className="blocking-subtitle">الإجراء المطلوب:</p>
                  <p className="blocking-reason" style={{ marginBottom: 12 }}>
                    قم بمعالجة/إلغاء الاشتراك المرتبط بهذا المتجر، ثم ارجع إلى هذه الصفحة وحاول حذف المتجر مرة أخرى.
                  </p>
                  <Link href="/app/admin/subscriptions" className="btn btn-outline btn-sm">
                    <i className="fas fa-file-contract" aria-hidden="true"></i>
                    إدارة الاشتراك
                  </Link>
                </>
              )}
            </div>
          )}
          {blockedStores.length === 0 ? (
            <>
              <p className="shell-note" style={{ marginBottom: 12 }}>
                لا توجد متاجر مرتبطة بهذا التاجر.
              </p>
              <button type="button" className="btn btn-primary" onClick={() => setConfirmDelete(true)}>
                <i className="fas fa-trash" aria-hidden="true"></i>
                محاولة حذف التاجر مرة أخرى
              </button>
            </>
          ) : (
            <>
              <p className="blocking-subtitle">المتاجر التي تمنع حذف التاجر:</p>
              <div className="shell-stack">
                {blockedStores.map((s) => (
                  <div key={s.id} className="store-row">
                    <span className="store-row-icon" aria-hidden="true">
                      <i className="fas fa-store"></i>
                    </span>
                    <span className="store-row-body">
                      <span className="store-row-name">
                        {s.name}
                        <span className={`sub-badge ${s.is_published === 1 ? "sub-badge-active" : "sub-badge-unknown"}`}>
                          {s.is_published === 1 ? "منشور" : "مسودة"}
                        </span>
                      </span>
                      <span className="store-row-meta">
                        <span dir="ltr">{s.slug}</span>
                      </span>
                    </span>
                    <span className="store-card-links">
                      <Link
                        href={`/app/stores/${encodeURIComponent(s.id)}`}
                        className="btn btn-ghost btn-shell-dark btn-sm"
                      >
                        إدارة المتجر
                      </Link>
                      <button
                        type="button"
                        className="btn btn-ghost btn-shell-dark btn-sm"
                        disabled={storeDeleting}
                        onClick={() => setStoreConfirm(s)}
                      >
                        <i className="fas fa-trash" aria-hidden="true"></i>
                        حذف المتجر
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

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
                    href={customerHref(c)}
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
            {customersPagination !== null && !customersLoading && (
              <Pagination
                page={customersPagination.page}
                totalPages={customersPagination.total_pages}
                onPage={(p) => setCustomerPage(p)}
              />
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
        emptyErrorText="الرجاء إدخال البريد الإلكتروني للتأكيد."
        onClose={() => setConfirmDelete(false)}
        onConfirm={onDelete}
      />

      <ConfirmDialog
        open={storeConfirm !== null}
        title="حذف المتجر؟"
        description={
          storeConfirm
            ? `هل أنت متأكد من حذف متجر «${storeConfirm.name}»؟ لا يمكن التراجع عن هذا الإجراء. إذا كان المتجر يحتوي على طلبات أو اشتراكات، سيُرفض الحذف.`
            : undefined
        }
        confirmLabel="حذف المتجر"
        confirming={storeDeleting}
        requireConfirmText={storeConfirm?.slug}
        requireConfirmPlaceholder={storeConfirm?.slug}
        emptyErrorText="الرجاء إدخال رابط المتجر للتأكيد."
        onClose={() => setStoreConfirm(null)}
        onConfirm={onConfirmStoreDelete}
      />
    </>
  );
}
