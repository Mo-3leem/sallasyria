"use client";

import { useState, type FormEvent } from "react";
import { buyerApi, type BuyerAddress } from "@/lib/api";
import { GOVERNORATES } from "@/lib/governorates";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";

export interface AddressValues {
  recipient: string;
  phone: string;
  governorate: string;
  city: string;
  line: string;
}

const EMPTY_VALUES: AddressValues = {
  recipient: "",
  phone: "",
  governorate: GOVERNORATES[0],
  city: "",
  line: "",
};

/**
 * Customer address book: list, add, edit, remove, make-default.
 * All mutations use the existing buyer address endpoints; the list is
 * reloaded after every successful mutation.
 */
export function BuyerAddressBook({
  slug,
  addresses,
  setAddresses,
  loadError,
  onRetry,
}: {
  slug: string;
  addresses: BuyerAddress[] | null;
  setAddresses: (v: BuyerAddress[] | null) => void;
  loadError: boolean;
  onRetry: () => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addKey, setAddKey] = useState(0);

  async function reload(): Promise<boolean> {
    const res = await buyerApi.addresses.list(slug);
    if (res.ok) {
      setAddresses(res.data.addresses);
      return true;
    }
    return false;
  }

  async function handleAdd(values: AddressValues): Promise<string | null> {
    const res = await buyerApi.addresses.create(slug, {
      recipient_name: values.recipient,
      phone: values.phone,
      governorate: values.governorate,
      city: values.city === "" ? null : values.city,
      address_line: values.line,
    });
    if (!res.ok) return "تعذّر إضافة العنوان.";
    setAddKey((k) => k + 1);
    if (!(await reload())) return "تمت الإضافة، لكن تعذّر تحديث القائمة.";
    return null;
  }

  async function handleEdit(id: string, values: AddressValues): Promise<string | null> {
    const res = await buyerApi.addresses.update(slug, id, {
      recipient_name: values.recipient,
      phone: values.phone,
      governorate: values.governorate,
      city: values.city === "" ? null : values.city,
      address_line: values.line,
    });
    if (!res.ok) return "تعذّر حفظ العنوان.";
    setEditingId(null);
    if (!(await reload())) return "تم الحفظ، لكن تعذّر تحديث القائمة.";
    return null;
  }

  async function onRemove(id: string) {
    setActionError(null);
    const res = await buyerApi.addresses.remove(slug, id);
    if (!res.ok || !(await reload())) {
      setActionError("تعذّر حذف العنوان. حاول مجددًا.");
    }
  }

  async function onDefault(id: string) {
    setActionError(null);
    const res = await buyerApi.addresses.makeDefault(slug, id);
    if (!res.ok || !(await reload())) {
      setActionError("تعذّر تعيين العنوان الافتراضي. حاول مجددًا.");
    }
  }

  return (
    <section className="account-section" aria-labelledby="addresses-heading">
      <h2 className="account-section-title" id="addresses-heading">
        <i className="fas fa-location-dot" aria-hidden="true"></i>
        دفتر العناوين
        {addresses !== null && addresses.length > 0 && (
          <span className="count">{addresses.length.toLocaleString("ar-SY")}</span>
        )}
      </h2>
      <FormError message={actionError} />
      {addresses === null ? (
        loadError ? (
          <div className="account-error" role="alert">
            <i className="fas fa-exclamation-triangle" aria-hidden="true"></i>
            <span>تعذّر تحميل العناوين.</span>
            <button type="button" className="btn btn-outline btn-sm" onClick={onRetry}>
              <i className="fas fa-rotate-right" aria-hidden="true"></i>
              إعادة المحاولة
            </button>
          </div>
        ) : (
          <div className="account-skeleton-list" role="status" aria-label="جاري تحميل العناوين">
            <span className="account-skeleton" style={{ height: 76 }}></span>
            <span className="account-skeleton" style={{ height: 76 }}></span>
          </div>
        )
      ) : addresses.length === 0 ? (
        <p className="account-hint">لا توجد عناوين محفوظة بعد — أضف عنوانك الأول لتسريع الطلبات القادمة.</p>
      ) : (
        <div className="account-address-grid">
          {addresses.map((a) =>
            editingId === a.id ? (
              <div key={a.id} className="account-address-card is-editing">
                <AddressForm
                  idPrefix={`edit-${a.id}`}
                  initial={{
                    recipient: a.recipient_name,
                    phone: a.phone,
                    governorate: a.governorate,
                    city: a.city ?? "",
                    line: a.address_line,
                  }}
                  submitLabel="حفظ العنوان"
                  onCancel={() => setEditingId(null)}
                  onSubmit={(values) => handleEdit(a.id, values)}
                />
              </div>
            ) : (
              <div key={a.id} className="account-address-card">
                <span className="account-address-icon" aria-hidden="true">
                  <i className="fas fa-location-dot"></i>
                </span>
                <span className="account-address-body">
                  <span className="account-address-name">
                    {a.recipient_name}
                    {a.is_default === 1 && <span className="account-badge is-green">افتراضي</span>}
                  </span>
                  <span className="account-address-meta">
                    {a.governorate}
                    {a.city ? ` · ${a.city}` : ""} · {a.address_line}
                  </span>
                  <span className="account-address-meta" dir="ltr">
                    {a.phone}
                  </span>
                </span>
                <span className="account-address-actions">
                  {a.is_default !== 1 && (
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => onDefault(a.id)}>
                      اجعله افتراضيًا
                    </button>
                  )}
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setEditingId(a.id)}>
                    <i className="fas fa-pen" aria-hidden="true"></i>
                    تعديل
                  </button>
                  <button type="button" className="btn btn-outline btn-sm is-danger" onClick={() => onRemove(a.id)}>
                    <i className="fas fa-trash" aria-hidden="true"></i>
                    حذف
                  </button>
                </span>
              </div>
            )
          )}
        </div>
      )}
      <details className="account-add">
        <summary>
          <span className="account-add-icon" aria-hidden="true">
            <i className="fas fa-plus"></i>
          </span>
          إضافة عنوان جديد
          <i className="fas fa-chevron-left chev" aria-hidden="true"></i>
        </summary>
        <div className="account-add-body">
          <AddressForm
            key={addKey}
            idPrefix="add"
            initial={EMPTY_VALUES}
            submitLabel="إضافة العنوان"
            onSubmit={handleAdd}
          />
        </div>
      </details>
    </section>
  );
}

function AddressForm({
  idPrefix,
  initial,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  idPrefix: string;
  initial: AddressValues;
  submitLabel: string;
  onCancel?: () => void;
  onSubmit: (values: AddressValues) => Promise<string | null>;
}) {
  const [recipient, setRecipient] = useState(initial.recipient);
  const [phone, setPhone] = useState(initial.phone);
  const [governorate, setGovernorate] = useState(initial.governorate);
  const [city, setCity] = useState(initial.city);
  const [line, setLine] = useState(initial.line);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setFormError(null);
    if (!recipient.trim() || !phone.trim() || !line.trim()) {
      setFormError("المستلم والهاتف والعنوان مطلوبة.");
      return;
    }
    setBusy(true);
    try {
      const err = await onSubmit({
        recipient: recipient.trim(),
        phone: phone.trim(),
        governorate,
        city: city.trim(),
        line: line.trim(),
      });
      setFormError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <FormError message={formError} />
      <TextField
        label="اسم المستلم"
        id={`ba-${idPrefix}-recipient`}
        value={recipient}
        onChange={(e) => setRecipient(e.target.value)}
      />
      <TextField
        label="الهاتف"
        id={`ba-${idPrefix}-phone`}
        dir="ltr"
        inputMode="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
      />
      <div className="auth-field">
        <label className="auth-label" htmlFor={`ba-${idPrefix}-gov`}>
          المحافظة
        </label>
        <select
          id={`ba-${idPrefix}-gov`}
          className="auth-input"
          value={governorate}
          onChange={(e) => setGovernorate(e.target.value)}
        >
          {GOVERNORATES.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </div>
      <TextField
        label="المدينة (اختياري)"
        id={`ba-${idPrefix}-city`}
        value={city}
        onChange={(e) => setCity(e.target.value)}
      />
      <TextField
        label="العنوان"
        id={`ba-${idPrefix}-line`}
        value={line}
        onChange={(e) => setLine(e.target.value)}
      />
      <div className="account-form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "جاري الحفظ..." : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-outline" disabled={busy} onClick={onCancel}>
            إلغاء
          </button>
        )}
      </div>
    </form>
  );
}
