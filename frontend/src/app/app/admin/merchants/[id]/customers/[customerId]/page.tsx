"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { adminApi } from "@/lib/api";
import type { Customer } from "@/types/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { BackButton } from "@/components/common/BackButton";
import { EmptyState } from "@/components/common/EmptyState";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type LoadState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; customer: Customer };

/** Admin customer detail: view/edit/delete within the merchant's store. */
function AdminCustomerBody({
  merchantId,
  customerId,
}: {
  merchantId: string;
  customerId: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const storeId = searchParams.get("store") ?? "";
  const { refresh: refreshAuth } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const base = `/app/admin/merchants/${encodeURIComponent(merchantId)}`;
  const backQuery = searchParams.get("q") ?? "";
  const backHref =
    backQuery.trim() === ""
      ? base
      : `${base}?q=${encodeURIComponent(backQuery.trim())}`;

  async function load() {
    if (storeId === "") {
      setState({ kind: "missing" });
      return;
    }
    setState({ kind: "loading" });
    setActionError(null);
    try {
      const res = await adminApi.storeCustomers.get(storeId, customerId);
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        setState({ kind: "missing" });
        return;
      }
      setName(res.data.customer.name);
      setEmail(res.data.customer.email ?? "");
      setPhone(res.data.customer.phone);
      setState({ kind: "ready", customer: res.data.customer });
    } catch {
      setState({ kind: "missing" });
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, customerId]);

  if (state.kind === "loading") {
    return (
      <div className="shell-loading">
        <span className="shell-spinner" aria-hidden="true"></span>
        جاري تحميل العميل...
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <div className="shell-card">
          <EmptyState
            icon="fas fa-user-slash"
            title="العميل غير موجود"
            action={
              <Link href={backHref} className="btn btn-primary">
                العودة إلى التاجر
              </Link>
            }
          />
      </div>
    );
  }

  const { customer } = state;
  const confirmIdentity = customer.email ?? customer.phone;

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
    const diff: { name?: string; email?: string | null; phone?: string } = {};
    if (name.trim() !== customer.name) diff.name = name.trim();
    if ((email.trim() === "" ? null : email.trim()) !== customer.email)
      diff.email = email.trim() === "" ? null : email.trim();
    if (phone.trim() !== customer.phone) diff.phone = phone.trim();
    if (Object.keys(diff).length === 0) {
      setSaved(true);
      return;
    }
    setSaving(true);
    try {
      const res = await adminApi.storeCustomers.update(storeId, customerId, diff);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        const fields = getFieldErrors(res);
        if (code === "phone_taken") fields.phone = fields.phone || "هذا الرقم مستخدم من عميل آخر.";
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

  async function onDelete() {
    if (deleting) return;
    setDeleting(true);
    setActionError(null);
    try {
      const res = await adminApi.storeCustomers.remove(storeId, customerId);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "customer_has_orders") {
          setActionError("لا يمكن حذف هذا العميل لأن لديه سجل طلبات. سجل الطلبات محفوظ ولا يُحذف.");
        } else {
          setActionError(authErrorMessage(res, 400));
        }
        setConfirmDelete(false);
        return;
      }
      router.replace(base);
    } catch {
      setActionError(NETWORK_ERROR_MESSAGE);
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <BackButton href={backHref} label="العودة إلى التاجر" />
      <div className="shell-page-head">
        <h1>{customer.name}</h1>
        <p>
          <Link href={backHref}>التاجر</Link>
          {" / "}
          تفاصيل العميل
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
          <span className="value" dir="ltr">{customer.email ?? "—"}</span>
        </div>
        <div className="auth-profile-row">
          <span className="key">الهاتف</span>
          <span className="value" dir="ltr">{customer.phone}</span>
        </div>

        <form onSubmit={onSave} noValidate aria-label="تعديل بيانات العميل" style={{ marginTop: 16 }}>
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
          <button type="submit" className="btn btn-primary auth-submit" disabled={saving}>
            {saving ? "جاري الحفظ..." : "حفظ التغييرات"}
          </button>
        </form>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">حذف العميل</h2>
        <p className="shell-note" style={{ marginBottom: 12 }}>
          الحذف نهائي ولا يمكن التراجع عنه. يُمنع الحذف إذا كان للعميل سجل طلبات.
        </p>
        <button type="button" className="btn btn-outline" onClick={() => setConfirmDelete(true)}>
          <i className="fas fa-trash" aria-hidden="true"></i>
          حذف العميل نهائياً
        </button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="حذف العميل نهائياً؟"
        description={`سيتم حذف حساب «${customer.name}» (${confirmIdentity}) نهائياً ولا يمكن التراجع. إذا كان لديه طلبات، سيُرفض الحذف للحفاظ على السجل.`}
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

export default function AdminCustomerRoute({
  params,
}: {
  params: { id: string; customerId: string };
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
      <AdminCustomerBody merchantId={params.id} customerId={params.customerId} />
    </Suspense>
  );
}
