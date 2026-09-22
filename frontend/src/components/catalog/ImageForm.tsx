"use client";

import { useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";

export interface ImageFormValues {
  url: string;
  alt_text: string | null;
  sort_order: number;
}

/**
 * Attach/edit a product image by https URL (MVP only — no R2 upload).
 * The url is sent exactly as typed; the backend enforces https + length.
 */
export function ImageForm({
  initial,
  submitLabel,
  submitting,
  fieldErrors = {},
  formError = null,
  onSubmit,
}: {
  initial: ImageFormValues;
  submitLabel: string;
  submitting: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string | null;
  onSubmit: (values: ImageFormValues) => void;
}) {
  const [url, setUrl] = useState(initial.url);
  const [alt, setAlt] = useState(initial.alt_text ?? "");
  const [sortOrder, setSortOrder] = useState(String(initial.sort_order));
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
    const trimmed = url.trim();
    if (!trimmed.startsWith("https://"))
      local.url = "الرابط يجب أن يبدأ بـ https://";
    if (trimmed.length > 2048) local.url = "الرابط طويل جداً.";
    if (alt.trim().length > 500) local.alt_text = "الوصف طويل جداً (500 حرف كحد أقصى).";
    const sort = Number(sortOrder);
    if (!Number.isInteger(sort)) local.sort_order = "الترتيب يجب أن يكون رقماً صحيحاً.";
    setLocalErrors(local);
    if (Object.keys(local).length > 0) return;
    onSubmit({
      url: trimmed,
      alt_text: alt.trim() === "" ? null : alt.trim(),
      sort_order: sort,
    });
  }

  const err = (key: string) => localErrors[key] ?? fieldErrors[key];

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <FormError message={formError} />
      <TextField
        label="رابط الصورة (https)"
        id="field-url"
        dir="ltr"
        placeholder="https://cdn.example.com/a.jpg"
        maxLength={2048}
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          clearLocal("url");
        }}
        error={err("url")}
      />
      <TextField
        label="وصف الصورة (اختياري)"
        id="field-alt"
        placeholder="مثال: الواجهة الأمامية"
        maxLength={500}
        value={alt}
        onChange={(e) => {
          setAlt(e.target.value);
          clearLocal("alt_text");
        }}
        error={err("alt_text")}
      />
      <TextField
        label="الترتيب"
        id="field-sort"
        dir="ltr"
        inputMode="numeric"
        value={sortOrder}
        onChange={(e) => {
          setSortOrder(e.target.value);
          clearLocal("sort_order");
        }}
        error={err("sort_order")}
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
