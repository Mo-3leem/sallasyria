"use client";

import { useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";
import { SlugField, isValidSlug } from "@/components/store/SlugField";
import type { Category } from "@/types/api";

export interface ProductFormValues {
  name: string;
  slug: string;
  category_id: string | null;
  description: string | null;
  price: number;
  stock_quantity: number | null;
  is_active: 0 | 1;
}

/** Parse a minor-units price string; null when invalid. */
export function parsePriceMinor(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Shared product create/edit form. Price is entered in minor units
 * (qirsh); stock empty means untracked (null).
 */
export function ProductForm({
  initial,
  categories,
  submitLabel,
  submitting,
  fieldErrors = {},
  formError = null,
  onSubmit,
}: {
  initial: ProductFormValues;
  categories: Category[];
  submitLabel: string;
  submitting: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string | null;
  onSubmit: (values: ProductFormValues) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [slug, setSlug] = useState(initial.slug);
  const [description, setDescription] = useState(initial.description ?? "");
  const [categoryId, setCategoryId] = useState<string>(initial.category_id ?? "");
  const [price, setPrice] = useState(String(initial.price));
  const [stock, setStock] = useState(
    initial.stock_quantity === null ? "" : String(initial.stock_quantity)
  );
  const [isActive, setIsActive] = useState<boolean>(initial.is_active === 1);
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
    if (name.trim().length < 1) local.name = "اسم المنتج مطلوب.";
    if (name.trim().length > 200) local.name = "الاسم طويل جداً (200 حرف كحد أقصى).";
    if (description.trim().length > 2000)
      local.description = "الوصف طويل جداً (2000 حرف كحد أقصى).";
    if (!isValidSlug(slug.trim()))
      local.slug = "الرابط غير صالح: حروف صغيرة وأرقام وشرطات فقط.";
    const priceNum = parsePriceMinor(price);
    if (priceNum === null) local.price = "السعر يجب أن يكون رقماً صحيحاً ≥ 0 بالقرش.";
    let stockNum: number | null = null;
    if (stock.trim() !== "") {
      if (!/^\d+$/.test(stock.trim()) || !Number.isSafeInteger(Number(stock.trim()))) {
        local.stock_quantity = "المخزون رقم صحيح ≥ 0، أو اتركه فارغاً.";
      } else {
        stockNum = Number(stock.trim());
      }
    }
    setLocalErrors(local);
    if (Object.keys(local).length > 0 || priceNum === null) return;
    onSubmit({
      name: name.trim(),
      slug: slug.trim(),
      category_id: categoryId === "" ? null : categoryId,
      description: description.trim() === "" ? null : description.trim(),
      price: priceNum,
      stock_quantity: stockNum,
      is_active: isActive ? 1 : 0,
    });
  }

  const err = (key: string) => localErrors[key] ?? fieldErrors[key];

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <FormError message={formError} />
      <TextField
        label="اسم المنتج"
        id="field-name"
        placeholder="مثال: هاتف X"
        maxLength={200}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          clearLocal("name");
        }}
        error={err("name")}
      />
      <SlugField
        value={slug}
        label="رابط المنتج"
        placeholder="مثال: phone-x"
        onChange={(v) => {
          setSlug(v);
          clearLocal("slug");
        }}
        error={err("slug")}
      />
      <div className="auth-field">
        <label className="auth-label" htmlFor="field-description">
          الوصف (اختياري)
        </label>
        <textarea
          id="field-description"
          className="auth-input"
          placeholder="اكتب وصفًا مختصرًا للمنتج..."
          rows={4}
          maxLength={2000}
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            clearLocal("description");
          }}
          aria-invalid={err("description") ? "true" : "false"}
        />
        {err("description") && (
          <p className="auth-field-error">{err("description")}</p>
        )}
      </div>
      <div className="auth-field">
        <label className="auth-label" htmlFor="field-category">
          التصنيف (اختياري)
        </label>
        <select
          id="field-category"
          className="auth-input"
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value);
            clearLocal("category_id");
          }}
        >
          <option value="">بدون تصنيف</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <TextField
        label="السعر (بالقرش)"
        id="field-price"
        dir="ltr"
        inputMode="numeric"
        placeholder="150000"
        value={price}
        onChange={(e) => {
          setPrice(e.target.value);
          clearLocal("price");
        }}
        error={err("price")}
        hint="رقم صحيح ≥ 0 بالوحدات الصغرى."
      />
      <TextField
        label="المخزون (فارغ = غير متتبع)"
        id="field-stock"
        dir="ltr"
        inputMode="numeric"
        placeholder="اتركه فارغاً لعدم التتبع"
        value={stock}
        onChange={(e) => {
          setStock(e.target.value);
          clearLocal("stock_quantity");
        }}
        error={err("stock_quantity")}
      />
      <label className="auth-check">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        <span>نشط (يظهر للعملاء)</span>
      </label>
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
