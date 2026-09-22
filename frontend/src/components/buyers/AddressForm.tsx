"use client";

import { useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";
import { GOVERNORATES } from "@/lib/governorates";

export interface AddressFormValues {
  recipient_name: string;
  phone: string;
  governorate: string;
  city: string | null;
  address_line: string;
}

/**
 * Saved-address edit form. customer_id and is_default are immutable by
 * backend contract — never rendered, never sent (defaults change only via
 * the make-default endpoint).
 */
export function AddressForm({
  initial,
  submitLabel,
  submitting,
  fieldErrors = {},
  formError = null,
  onSubmit,
}: {
  initial: AddressFormValues;
  submitLabel: string;
  submitting: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string | null;
  onSubmit: (values: AddressFormValues) => void;
}) {
  const [recipient, setRecipient] = useState(initial.recipient_name);
  const [phone, setPhone] = useState(initial.phone);
  const [governorate, setGovernorate] = useState(initial.governorate);
  const [city, setCity] = useState(initial.city ?? "");
  const [line, setLine] = useState(initial.address_line);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});

  function clearLocal(key: string) {
    setLocalErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (recipient.trim().length < 1) local.recipient_name = "اسم المستلم مطلوب.";
    if (recipient.trim().length > 200) local.recipient_name = "الاسم طويل جداً.";
    if (phone.trim().length < 1) local.phone = "رقم الهاتف مطلوب.";
    if (phone.trim().length > 64) local.phone = "الرقم طويل جداً.";
    if (!GOVERNORATES.includes(governorate as (typeof GOVERNORATES)[number]))
      local.governorate = "اختر محافظة من القائمة.";
    if (city.trim().length > 200) local.city = "اسم المدينة طويل جداً.";
    if (line.trim().length < 1) local.address_line = "العنوان مطلوب.";
    if (line.trim().length > 500) local.address_line = "العنوان طويل جداً.";
    setLocalErrors(local);
    if (Object.keys(local).length > 0) return;
    onSubmit({
      recipient_name: recipient.trim(),
      phone: phone.trim(),
      governorate,
      city: city.trim() === "" ? null : city.trim(),
      address_line: line.trim(),
    });
  }

  const err = (key: string) => localErrors[key] ?? fieldErrors[key];

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <FormError message={formError} />
      <TextField
        label="اسم المستلم"
        id="field-recipient"
        placeholder="مثال: ليلى حداد"
        maxLength={200}
        value={recipient}
        onChange={(e) => {
          setRecipient(e.target.value);
          clearLocal("recipient_name");
        }}
        error={err("recipient_name")}
      />
      <TextField
        label="رقم الهاتف"
        id="field-phone"
        dir="ltr"
        inputMode="tel"
        maxLength={64}
        value={phone}
        onChange={(e) => {
          setPhone(e.target.value);
          clearLocal("phone");
        }}
        error={err("phone")}
      />
      <div className="auth-field">
        <label className="auth-label" htmlFor="field-governorate">
          المحافظة
        </label>
        <select
          id="field-governorate"
          className="auth-input"
          value={governorate}
          onChange={(e) => {
            setGovernorate(e.target.value);
            clearLocal("governorate");
          }}
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
        id="field-city"
        maxLength={200}
        value={city}
        onChange={(e) => {
          setCity(e.target.value);
          clearLocal("city");
        }}
        error={err("city")}
      />
      <TextField
        label="العنوان"
        id="field-address"
        placeholder="الشارع، البناء، الشقة..."
        maxLength={500}
        value={line}
        onChange={(e) => {
          setLine(e.target.value);
          clearLocal("address_line");
        }}
        error={err("address_line")}
      />
      <button
        type="submit"
        className="btn btn-primary btn-lg auth-submit"
        disabled={submitting}
      >
        {submitting ? "جاري الحفظ..." : submitLabel}
      </button>
    </form>
  );
}
