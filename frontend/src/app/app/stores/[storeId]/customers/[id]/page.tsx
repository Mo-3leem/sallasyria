"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { customerAddressesApi, customersApi } from "@/lib/api";
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
import {
  AddressForm,
  type AddressFormValues,
} from "@/components/buyers/AddressForm";
import type { Customer, CustomerAddress } from "@/types/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; customer: Customer; addresses: CustomerAddress[] };

/**
 * Customer detail + saved addresses. Address creation is a public buyer
 * flow (no merchant create UI); merchants edit/delete/make-default here.
 * make-default calls the public endpoint WITHOUT a Turnstile header — it
 * works under the development bypass and fails honestly (403/503) where
 * enforcement is on.
 */
export default function CustomerDetailPage({
  params,
}: {
  params: { storeId: string; id: string };
}) {
  const { storeId, id } = params;
  const { refresh: refreshAuth } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [editing, setEditing] = useState<CustomerAddress | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CustomerAddress | null>(null);
  const [imgFields, setImgFields] = useState<Record<string, string>>({});
  const [imgError, setImgError] = useState<string | null>(null);
  const [imgBusy, setImgBusy] = useState(false);
  const [defaultBusyId, setDefaultBusyId] = useState<string | null>(null);

  const base = `/app/stores/${encodeURIComponent(storeId)}`;

  async function load() {
    setState({ kind: "loading" });
    try {
      const [got, addrs] = await Promise.all([
        customersApi.get(storeId, id),
        customerAddressesApi.list(storeId, id),
      ]);
      for (const res of [got, addrs]) {
        if (!res.ok && getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
      }
      if (!got.ok) {
        const code = getErrorCode(got);
        if (code === "store_not_found" || code === "customer_not_found") {
          setState({ kind: "missing" });
          return;
        }
        setState({
          kind: "error",
          message: got.error.message || "تعذّر تحميل العميل.",
        });
        return;
      }
      setState({
        kind: "ready",
        customer: got.data.customer,
        addresses: addrs.ok ? addrs.data.addresses : [],
      });
    } catch {
      setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, id]);

  async function refreshAddresses(): Promise<boolean> {
    try {
      const res = await customerAddressesApi.list(storeId, id);
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return false;
        }
        setImgError(authErrorMessage(res, 400));
        return false;
      }
      setState((prev) =>
        prev.kind === "ready" ? { ...prev, addresses: res.data.addresses } : prev
      );
      return true;
    } catch {
      setImgError(NETWORK_ERROR_MESSAGE);
      return false;
    }
  }

  async function onEdit(address: CustomerAddress, values: AddressFormValues) {
    if (imgBusy) return;
    setImgFields({});
    setImgError(null);
    setImgBusy(true);
    try {
      // customer_id/is_default never sent (backend 400s them).
      const res = await customerAddressesApi.update(storeId, address.id, values);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (
          code === "store_not_found" ||
          code === "customer_not_found" ||
          code === "address_not_found"
        ) {
          setImgError("العنوان غير موجود — حدّث الصفحة وحاول مجدداً.");
          await refreshAddresses();
          return;
        }
        if (code === "subscription_inactive") {
          setImgError(
            "تعديل بيانات العملاء يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
          );
          return;
        }
        const fields = getFieldErrors(res);
        if (Object.keys(fields).length > 0) setImgFields(fields);
        setImgError(authErrorMessage(res, 400));
        return;
      }
      setEditing(null);
      await refreshAddresses();
    } catch {
      setImgError(NETWORK_ERROR_MESSAGE);
    } finally {
      setImgBusy(false);
    }
  }

  async function doDelete(address: CustomerAddress) {
    setImgBusy(true);
    setImgError(null);
    try {
      const res = await customerAddressesApi.remove(storeId, address.id);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "subscription_inactive") {
          setImgError(
            "تعديل بيانات العملاء يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
          );
          return;
        }
        setImgError(authErrorMessage(res, 400));
        return;
      }
      setPendingDelete(null);
      await refreshAddresses();
    } catch {
      setImgError(NETWORK_ERROR_MESSAGE);
    } finally {
      setImgBusy(false);
    }
  }

  async function doMakeDefault(address: CustomerAddress) {
    if (address.is_default === 1 || defaultBusyId) return;
    setDefaultBusyId(address.id);
    setImgError(null);
    try {
      // No Turnstile header: dev bypass lets it through; enforced
      // environments answer 403/503, surfaced honestly below.
      const res = await customerAddressesApi.makeDefault(storeId, address.id);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "turnstile_failed" || code === "turnstile_required") {
          setImgError("التحقق البشري غير مهيأ — تعيين الافتراضي يتطلب مسار المشتري.");
          return;
        }
        if (code === "turnstile_misconfigured") {
          setImgError("التحقق البشري غير مهيأ على الخادم — تعذّر تعيين الافتراضي.");
          return;
        }
        setImgError(authErrorMessage(res, 400));
        return;
      }
      await refreshAddresses();
    } catch {
      setImgError(NETWORK_ERROR_MESSAGE);
    } finally {
      setDefaultBusyId(null);
    }
  }

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
          icon="fas fa-store-slash"
          title="العميل غير موجود أو لا تملك صلاحية الوصول إليه."
          action={
            <Link href={`${base}/customers`} className="btn btn-primary">
              العودة إلى العملاء
            </Link>
          }
        />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="shell-card">
        <EmptyState
          icon="fas fa-exclamation-triangle"
          title="تعذّر تحميل العميل"
          description={state.message}
          action={
            <Link href={`${base}/customers`} className="btn btn-outline">
              العودة إلى العملاء
            </Link>
          }
        />
      </div>
    );
  }

  const { customer, addresses } = state;

  return (
    <>
      <BackButton href={`${base}/customers`} />
      <div className="shell-page-head">
        <h1>{customer.name}</h1>
        <p>
          <Link href={`${base}/customers`}>العملاء</Link>
          {" / "}
          <span dir="ltr">{customer.phone}</span>
        </p>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">بيانات العميل</h2>
        <div className="info-row">
          <span className="key">الهاتف</span>
          <span className="value" dir="ltr">{customer.phone}</span>
        </div>
        <div className="info-row">
          <span className="key">البريد الإلكتروني</span>
          <span className="value" dir="ltr">{customer.email ?? "—"}</span>
        </div>
        <div style={{ marginTop: 16 }}>
          <Link
            href={`${base}/customers/${encodeURIComponent(customer.id)}/edit`}
            className="btn btn-outline"
          >
            تعديل العميل
          </Link>
        </div>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">العناوين المحفوظة</h2>
        {imgError && (
          <div className="shell-error" role="alert">
            <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
            <span>{imgError}</span>
          </div>
        )}
        {addresses.length === 0 ? (
          <EmptyState
            icon="fas fa-map-marker-alt"
            title="لا توجد عناوين محفوظة"
            description="تُحفظ العناوين عند الشراء؛ لا يمكن إنشاؤها من هنا."
          />
        ) : (
          <div className="shell-stack">
            {addresses.map((address) => {
              const isEditing = editing?.id === address.id;
              const isDefault = address.is_default === 1;
              return (
                <div key={address.id} className="store-row">
                  <span className="store-row-icon" aria-hidden="true">
                    <i className="fas fa-map-marker-alt"></i>
                  </span>
                  <span className="store-row-body">
                    <span className="store-row-name">
                      {address.recipient_name}{" "}
                      {isDefault && (
                        <span className="sub-badge sub-badge-active">افتراضي</span>
                      )}
                    </span>
                    <span className="store-row-meta">
                      <span dir="ltr">{address.phone}</span>
                      <span>·</span>
                      <span>{address.governorate}</span>
                      {address.city && (
                        <>
                          <span>·</span>
                          <span>{address.city}</span>
                        </>
                      )}
                    </span>
                    <span className="store-row-meta">{address.address_line}</span>
                    {isEditing && (
                      <span style={{ marginTop: 12, display: "block" }}>
                        <AddressForm
                          initial={{
                            recipient_name: address.recipient_name,
                            phone: address.phone,
                            governorate: address.governorate,
                            city: address.city,
                            address_line: address.address_line,
                          }}
                          submitLabel="حفظ العنوان"
                          submitting={imgBusy}
                          fieldErrors={imgFields}
                          formError={null}
                          onSubmit={(v) => onEdit(address, v)}
                        />
                        <button
                          type="button"
                          className="btn btn-ghost btn-shell-dark btn-sm"
                          style={{ marginTop: 8 }}
                          onClick={() => {
                            setEditing(null);
                            setImgFields({});
                          }}
                        >
                          إلغاء التعديل
                        </button>
                      </span>
                    )}
                  </span>
                  {!isEditing && (
                    <span className="store-card-links">
                      {!isDefault && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-shell-dark btn-sm"
                          disabled={defaultBusyId !== null || imgBusy}
                          onClick={() => doMakeDefault(address)}
                        >
                          {defaultBusyId === address.id
                            ? "جاري التعيين..."
                            : "اجعل افتراضياً"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-shell-dark btn-sm"
                        disabled={imgBusy}
                        onClick={() => {
                          setImgFields({});
                          setImgError(null);
                          setEditing(address);
                        }}
                      >
                        تعديل
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-shell-dark btn-sm"
                        onClick={() => setPendingDelete(address)}
                      >
                        حذف
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="حذف العنوان؟"
        description="سيتم حذف عنوان التوصيل نهائياً. طلبات سابقة تحتفظ بنسختها الخاصة."
        confirmLabel="حذف"
        confirming={imgBusy}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            const addr = pendingDelete;
            setPendingDelete(null);
            doDelete(addr);
          }
        }}
      />
    </>
  );
}
