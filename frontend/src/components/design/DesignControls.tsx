"use client";

import { useState } from "react";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Small controlled inputs shared by the builder panels. */
export function ColorRow({
  id,
  label,
  value,
  onChange,
  allowClear = false,
  onClear,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  allowClear?: boolean;
  onClear?: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? value;
  return (
    <div className="builder-field">
      <label className="builder-label" htmlFor={id}>
        {label}
      </label>
      <div className="builder-color-row">
        <input
          id={id}
          type="color"
          className="builder-color"
          value={HEX_RE.test(shown) ? shown : "#16a34a"}
          onChange={(e) => {
            setText(null);
            onChange(e.target.value);
          }}
          aria-label={label}
        />
        <input
          className="auth-input builder-hex"
          dir="ltr"
          value={shown}
          maxLength={7}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            if (HEX_RE.test(v)) {
              setText(null);
              onChange(v);
            }
          }}
          onBlur={() => setText(null)}
          aria-label={`${label} (hex)`}
        />
        {allowClear && (
          <button type="button" className="btn btn-ghost btn-shell-dark btn-sm" onClick={onClear}>
            افتراضي
          </button>
        )}
      </div>
    </div>
  );
}

export function TextRow({
  id,
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  dir,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  dir?: "ltr" | "rtl";
}) {
  return (
    <div className="builder-field">
      <label className="builder-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="auth-input"
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        dir={dir}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function ToggleRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="builder-check" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function SegmentRow<T extends string>({
  id,
  label,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="builder-field">
      <span className="builder-label" id={id}>
        {label}
      </span>
      <div className="builder-segment" role="group" aria-labelledby={id}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`builder-segment-btn${value === o.value ? " is-active" : ""}`}
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
