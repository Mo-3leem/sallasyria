"use client";

import { useState } from "react";
import { ColorRow, Group, SegmentRow, TextRow, ToggleRow } from "@/components/design/DesignControls";
import type { Selection } from "@/components/design/selection";
import {
  defaultSectionTitle,
  type StoreTheme,
  type ThemeSection,
} from "@/lib/theme-design";

/** Left-side properties panel: controls for the current selection. */
export function PropsPanel({
  draft,
  selection,
  onSelect,
  patch,
  moveSection,
  updateSectionAt,
}: {
  draft: StoreTheme;
  selection: Selection;
  onSelect: (s: Selection) => void;
  patch: (mut: (d: StoreTheme) => StoreTheme) => void;
  moveSection: (from: number, to: number) => void;
  updateSectionAt: (index: number, mut: (s: ThemeSection) => ThemeSection) => void;
}) {
  if (selection === null) {
    return (
      <div className="builder-panel">
        <h2 className="builder-panel-title">الخصائص</h2>
        <p className="builder-hint">
          اختر عنصراً من المعاينة (الترويسة أو أي قسم أو التذييل) أو من قائمة الأقسام لعرض خصائصه هنا.
        </p>
        <button type="button" className="btn btn-outline btn-sm builder-full" onClick={() => onSelect("appearance")}>
          خيارات المظهر العام
        </button>
      </div>
    );
  }

  if (selection === "appearance") {
    const names: { key: keyof StoreTheme["palette"]; label: string }[] = [
      { key: "primary", label: "اللون الأساسي" },
      { key: "secondary", label: "اللون الثانوي" },
      { key: "background", label: "لون الخلفية" },
      { key: "accent", label: "اللون المميز" },
      { key: "text", label: "لون النص" },
      { key: "button", label: "لون الأزرار" },
    ];
    return (
      <div className="builder-panel">
        <h2 className="builder-panel-title">المظهر العام</h2>
        <Group title="الألوان">
          {names.map((n) => (
            <ColorRow
              key={n.key}
              id={`props-${n.key}`}
              label={n.label}
              value={draft.palette[n.key]}
              onChange={(v) => patch((d) => ({ ...d, palette: { ...d.palette, [n.key]: v } }))}
            />
          ))}
        </Group>
        <Group title="الخط">
          <SegmentRow
            id="props-font"
            label="عائلة الخط"
            options={[
              { value: "cairo", label: "القاهرة" },
              { value: "system", label: "النظام" },
            ]}
            value={draft.font}
            onChange={(v) => patch((d) => ({ ...d, font: v }))}
          />
        </Group>
      </div>
    );
  }

  if (selection === "header") {
    const h = draft.header;
    const toggle = (key: "show_name" | "show_nav" | "show_cart" | "show_account") => (v: boolean) =>
      patch((d) => ({ ...d, header: { ...d.header, [key]: v ? 1 : 0 } }));
    return (
      <div className="builder-panel">
        <h2 className="builder-panel-title">الترويسة</h2>
        <TextRow
          id="props-logo"
          label="رابط الشعار (https)"
          value={draft.logo}
          dir="ltr"
          placeholder="https://..."
          onChange={(v) => patch((d) => ({ ...d, logo: v.trim() }))}
        />
        <ToggleRow id="props-h-name" label="إظهار اسم المتجر" checked={h.show_name === 1} onChange={toggle("show_name")} />
        <ToggleRow id="props-h-nav" label="إظهار التنقل" checked={h.show_nav === 1} onChange={toggle("show_nav")} />
        <ToggleRow id="props-h-cart" label="إظهار السلة" checked={h.show_cart === 1} onChange={toggle("show_cart")} />
        <ToggleRow id="props-h-account" label="إظهار الحساب" checked={h.show_account === 1} onChange={toggle("show_account")} />
        <ColorRow
          id="props-h-bg"
          label="خلفية الترويسة"
          value={h.background ?? "#ffffff"}
          allowClear
          onClear={() => patch((d) => ({ ...d, header: { ...d.header, background: null } }))}
          onChange={(v) => patch((d) => ({ ...d, header: { ...d.header, background: v } }))}
        />
      </div>
    );
  }

  if (selection === "footer") {
    const f = draft.footer;
    return (
      <div className="builder-panel">
        <h2 className="builder-panel-title">التذييل</h2>
        <ToggleRow
          id="props-f-visible"
          label="إظهار التذييل"
          checked={f.visible === 1}
          onChange={(v) => patch((d) => ({ ...d, footer: { ...d.footer, visible: v ? 1 : 0 } }))}
        />
        <ColorRow
          id="props-f-bg"
          label="خلفية التذييل"
          value={f.background ?? "#ffffff"}
          allowClear
          onClear={() => patch((d) => ({ ...d, footer: { ...d.footer, background: null } }))}
          onChange={(v) => patch((d) => ({ ...d, footer: { ...d.footer, background: v } }))}
        />
        <TextRow
          id="props-f-text"
          label="نص التذييل (فارغ = الافتراضي)"
          value={f.text}
          maxLength={300}
          onChange={(v) => patch((d) => ({ ...d, footer: { ...d.footer, text: v } }))}
        />
      </div>
    );
  }

  const match = selection.match(/^section:(\d+)$/);
  const index = match ? Number(match[1]) : -1;
  const ordered = [...draft.sections].sort((a, b) => a.order - b.order);
  const section = index >= 0 ? ordered[index] : undefined;
  if (!section) {
    return (
      <div className="builder-panel">
        <h2 className="builder-panel-title">الخصائص</h2>
        <p className="builder-hint">القسم المحدد لم يعد موجوداً. اختر قسماً آخر.</p>
      </div>
    );
  }

  function move(delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;
    moveSection(index, target);
    onSelect(`section:${target}`);
  }

  return (
    <div className="builder-panel">
      <h2 className="builder-panel-title">
        {section.title && section.title !== "" ? section.title : defaultSectionTitle(section.type)}
      </h2>
      <Group title="العرض">
        <TextRow
          id="props-sec-title"
          label="عنوان القسم (فارغ = الافتراضي)"
          value={section.title ?? ""}
          maxLength={200}
          onChange={(v) =>
            updateSectionAt(index, (s) => ({ ...s, title: v.trim() === "" ? undefined : v }))
          }
        />
        <ToggleRow
          id="props-sec-visible"
          label="إظهار القسم"
          checked={section.is_visible === 1}
          onChange={(v) => updateSectionAt(index, (s) => ({ ...s, is_visible: v ? 1 : 0 }))}
        />
        <div className="builder-field">
          <span className="builder-label">ترتيب القسم</span>
          <div className="builder-prop-movers" role="group" aria-label="تحريك القسم">
            <button
              type="button"
              className="btn btn-ghost btn-shell-dark btn-sm"
              disabled={index === 0}
              onClick={() => move(-1)}
            >
              <i className="fas fa-arrow-up" aria-hidden="true"></i>
              للأعلى
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-shell-dark btn-sm"
              disabled={index === ordered.length - 1}
              onClick={() => move(1)}
            >
              <i className="fas fa-arrow-down" aria-hidden="true"></i>
              للأسفل
            </button>
          </div>
        </div>
      </Group>

      {section.type === "hero" && <HeroFields draft={draft} patch={patch} />}
      {section.type === "products" && (
        <>
          <ToggleRow
            id="props-p-names"
            label="إظهار أسماء المنتجات"
            checked={draft.products.show_names === 1}
            onChange={(v) => patch((d) => ({ ...d, products: { ...d.products, show_names: v ? 1 : 0 } }))}
          />
          <ToggleRow
            id="props-p-prices"
            label="إظهار الأسعار"
            checked={draft.products.show_prices === 1}
            onChange={(v) => patch((d) => ({ ...d, products: { ...d.products, show_prices: v ? 1 : 0 } }))}
          />
        </>
      )}
      {section.type === "banner" && <BannerFields draft={draft} patch={patch} />}
    </div>
  );
}

  function HeroFields({
  draft,
  patch,
}: {
  draft: StoreTheme;
  patch: (mut: (d: StoreTheme) => StoreTheme) => void;
}) {
  const h = draft.hero;
  return (
    <>
      <Group title="المحتوى">
        <TextRow
          id="props-hero-title"
          label="العنوان (فارغ = ترحيب تلقائي)"
          value={h.title}
          maxLength={200}
          onChange={(v) => patch((d) => ({ ...d, hero: { ...d.hero, title: v } }))}
        />
        <TextRow
          id="props-hero-desc"
          label="الوصف"
          value={h.description}
          maxLength={500}
          onChange={(v) => patch((d) => ({ ...d, hero: { ...d.hero, description: v } }))}
        />
        <TextRow
          id="props-hero-cta"
          label="نص الزر"
          value={h.cta_text}
          maxLength={100}
          onChange={(v) => patch((d) => ({ ...d, hero: { ...d.hero, cta_text: v } }))}
        />
        <ToggleRow
          id="props-hero-cta-v"
          label="إظهار الزر"
          checked={h.cta_visible === 1}
          onChange={(v) => patch((d) => ({ ...d, hero: { ...d.hero, cta_visible: v ? 1 : 0 } }))}
        />
        <TextRow
          id="props-hero-image"
          label="رابط الصورة (https)"
          value={h.image ?? ""}
          dir="ltr"
          placeholder="https://..."
          onChange={(v) => patch((d) => ({ ...d, hero: { ...d.hero, image: v.trim() === "" ? null : v.trim() } }))}
        />
      </Group>
      <Group title="التخطيط">
        <SegmentRow
          id="props-hero-align"
          label="المحاذاة"
          options={[
            { value: "right", label: "يمين" },
            { value: "center", label: "وسط" },
            { value: "left", label: "يسار" },
          ]}
          value={h.align}
          onChange={(v) => patch((d) => ({ ...d, hero: { ...d.hero, align: v } }))}
        />
        <ColorRow
          id="props-hero-bg"
          label="خلفية القسم"
          value={h.background ?? "#ffffff"}
          allowClear
          onClear={() => patch((d) => ({ ...d, hero: { ...d.hero, background: null } }))}
          onChange={(v) => patch((d) => ({ ...d, hero: { ...d.hero, background: v } }))}
        />
      </Group>
    </>
  );
}

function BannerFields({
  draft,
  patch,
}: {
  draft: StoreTheme;
  patch: (mut: (d: StoreTheme) => StoreTheme) => void;
}) {
  const [img, setImg] = useState("");
  const [title, setTitle] = useState("");
  return (
    <>
      <div className="builder-field">
        <span className="builder-label">اللافتات ({draft.banners.length}/5)</span>
        {draft.banners.map((b, i) => (
          <div key={i} className="builder-banner-row">
            <span className="builder-banner-name">{b.title !== "" ? b.title : "لافتة"}</span>
            <button
              type="button"
              className="btn btn-ghost btn-shell-dark btn-sm"
              aria-label={`حذف اللافتة ${i + 1}`}
              onClick={() => patch((d) => ({ ...d, banners: d.banners.filter((_, j) => j !== i) }))}
            >
              <i className="fas fa-trash" aria-hidden="true"></i>
            </button>
          </div>
        ))}
      </div>
      {draft.banners.length < 5 && (
        <>
          <TextRow
            id="props-banner-img"
            label="رابط صورة جديدة (https)"
            value={img}
            dir="ltr"
            placeholder="https://..."
            onChange={setImg}
          />
          <TextRow
            id="props-banner-title"
            label="عنوان اللافتة"
            value={title}
            maxLength={200}
            onChange={setTitle}
          />
          <button
            type="button"
            className="btn btn-outline btn-sm builder-full"
            disabled={img.trim() === ""}
            onClick={() => {
              patch((d) => ({
                ...d,
                banners: [...d.banners, { image: img.trim(), title: title.trim() }],
              }));
              setImg("");
              setTitle("");
            }}
          >
            <i className="fas fa-plus" aria-hidden="true"></i>
            إضافة لافتة
          </button>
        </>
      )}
    </>
  );
}
