"use client";

import { useState } from "react";
import { ColorRow, SegmentRow } from "@/components/design/DesignControls";
import type { Selection } from "@/components/design/selection";
import {
  defaultSectionTitle,
  type StoreTheme,
} from "@/lib/theme-design";

/**
 * Right-side tools panel: appearance shortcuts + the ordered section list
 * (select, show/hide, drag-and-drop reorder, touch movers).
 */
export function ToolsPanel({
  draft,
  selection,
  onSelect,
  patch,
  moveSection,
}: {
  draft: StoreTheme;
  selection: Selection;
  onSelect: (s: Selection) => void;
  patch: (mut: (d: StoreTheme) => StoreTheme) => void;
  moveSection: (from: number, to: number) => void;
}) {
  const [tab, setTab] = useState<"sections" | "appearance">("sections");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const ordered = [...draft.sections].sort((a, b) => a.order - b.order);

  function toggleSection(index: number) {
    patch((d) => {
      const current = [...d.sections].sort((a, b) => a.order - b.order);
      const target = current[index];
      if (!target) return d;
      return {
        ...d,
        sections: d.sections.map((s) =>
          s === target ? { ...s, is_visible: (s.is_visible === 1 ? 0 : 1) as 0 | 1 } : s
        ),
      };
    });
  }

  return (
    <div className="builder-panel">
      <div className="builder-tabs" role="tablist" aria-label="أدوات التصميم">
        {(
          [
            { value: "sections", label: "الأقسام" },
            { value: "appearance", label: "المظهر" },
          ] as const
        ).map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            className={`builder-tab${tab === t.value ? " is-active" : ""}`}
            onClick={() => setTab(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "appearance" && (
        <div className="builder-panel-body">
          <ColorRow
            id="tools-primary"
            label="اللون الأساسي"
            value={draft.palette.primary}
            onChange={(v) => patch((d) => ({ ...d, palette: { ...d.palette, primary: v } }))}
          />
          <ColorRow
            id="tools-bg"
            label="لون الخلفية"
            value={draft.palette.background}
            onChange={(v) => patch((d) => ({ ...d, palette: { ...d.palette, background: v } }))}
          />
          <ColorRow
            id="tools-text"
            label="لون النص"
            value={draft.palette.text}
            onChange={(v) => patch((d) => ({ ...d, palette: { ...d.palette, text: v } }))}
          />
          <SegmentRow
            id="tools-font"
            label="الخط"
            options={[
              { value: "cairo", label: "القاهرة" },
              { value: "system", label: "النظام" },
            ]}
            value={draft.font}
            onChange={(v) => patch((d) => ({ ...d, font: v }))}
          />
          <button
            type="button"
            className="btn btn-outline btn-sm builder-full"
            onClick={() => onSelect("appearance")}
          >
            كل خيارات المظهر
            <i className="fas fa-chevron-left" aria-hidden="true"></i>
          </button>
        </div>
      )}

      {tab === "sections" && (
        <div className="builder-panel-body">
          <button
            type="button"
            className={`builder-entry${selection === "header" ? " is-selected" : ""}`}
            onClick={() => onSelect("header")}
          >
            <i className="fas fa-window-maximize" aria-hidden="true"></i>
            الترويسة
          </button>
          <p className="builder-hint">اسحب الأقسام لإعادة ترتيبها. الترتيب هنا هو ترتيب العرض.</p>
          <div className="builder-sections">
            {ordered.map((s, i) => {
              const key = `section:${i}` as const;
              const selected = selection === key;
              const dragging = dragIndex === i;
              const droppable = dropIndex === i && dragIndex !== null && dragIndex !== i;
              return (
                <div
                  key={`${s.type}-${s.order}`}
                  className={`builder-section-row${selected ? " is-selected" : ""}${dragging ? " is-dragging" : ""}${droppable ? " is-drop" : ""}`}
                  onDragOver={(e) => {
                    if (dragIndex === null || dragIndex === i) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDropIndex(i);
                  }}
                  onDragLeave={() => {
                    if (dropIndex === i) setDropIndex(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIndex === null) return;
                    moveSection(dragIndex, i);
                    setDragIndex(null);
                    setDropIndex(null);
                  }}
                >
                  <span
                    className="builder-grip"
                    aria-hidden="true"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", String(i));
                      e.dataTransfer.effectAllowed = "move";
                      setDragIndex(i);
                    }}
                    onDragEnd={() => {
                      setDragIndex(null);
                      setDropIndex(null);
                    }}
                  >
                    <i className="fas fa-grip-vertical" aria-hidden="true"></i>
                  </span>
                  <button
                    type="button"
                    className="builder-section-name"
                    onClick={() => onSelect(key)}
                    aria-pressed={selected}
                  >
                    <span>{s.title && s.title !== "" ? s.title : defaultSectionTitle(s.type)}</span>
                    <small>{defaultSectionTitle(s.type)}</small>
                  </button>
                  <span className="builder-row-movers" role="group" aria-label="تحريك القسم">
                    <button
                      type="button"
                      className="btn btn-ghost btn-shell-dark btn-sm"
                      aria-label="تحريك للأعلى"
                      disabled={i === 0}
                      onClick={() => moveSection(i, i - 1)}
                    >
                      <i className="fas fa-chevron-up" aria-hidden="true"></i>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-shell-dark btn-sm"
                      aria-label="تحريك للأسفل"
                      disabled={i === ordered.length - 1}
                      onClick={() => moveSection(i, i + 1)}
                    >
                      <i className="fas fa-chevron-down" aria-hidden="true"></i>
                    </button>
                  </span>
                  <button
                    type="button"
                    className={`builder-eye${s.is_visible === 1 ? " is-on" : ""}`}
                    aria-pressed={s.is_visible === 1}
                    aria-label={s.is_visible === 1 ? "إخفاء القسم" : "إظهار القسم"}
                    onClick={() => toggleSection(i)}
                  >
                    <i className={s.is_visible === 1 ? "fas fa-eye" : "fas fa-eye-slash"} aria-hidden="true"></i>
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className={`builder-entry${selection === "footer" ? " is-selected" : ""}`}
            onClick={() => onSelect("footer")}
          >
            <i className="fas fa-window-minimize" aria-hidden="true"></i>
            التذييل
          </button>
        </div>
      )}
    </div>
  );
}
