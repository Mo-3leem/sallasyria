"use client";

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback?: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
        }
      ) => string;
      remove?: (id: string) => void;
    };
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof document === "undefined") return Promise.reject(new Error("no document"));
  if (document.querySelector(`script[src="${SCRIPT_SRC}"]`) && window.turnstile) {
    return Promise.resolve();
  }
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const el = document.createElement("script");
      el.src = SCRIPT_SRC;
      el.async = true;
      el.defer = true;
      el.onload = () => resolve();
      el.onerror = () => {
        scriptPromise = null;
        reject(new Error("turnstile script failed"));
      };
      document.head.appendChild(el);
    });
  }
  return scriptPromise;
}

/** Build-time site key. Absent in local dev (backend bypasses there). */
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

/**
 * Cloudflare Turnstile widget (buyer flows). Renders only when a site key
 * is baked in; otherwise renders nothing and the backend dev bypass covers
 * local development. Parents remount via `key` to retry after a 403.
 */
export function TurnstileWidget({ onToken }: { onToken: (token: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const cb = useRef(onToken);
  cb.current = onToken;

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let live = true;
    let widgetId: string | null = null;
    loadScript().then(() => {
      if (!live || !ref.current || !window.turnstile) {
        if (live) setFailed(true);
        return;
      }
      widgetId = window.turnstile.render(ref.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token: string) => cb.current(token),
        "expired-callback": () => cb.current(null),
        "error-callback": () => cb.current(null),
      });
    }).catch(() => {
      if (live) setFailed(true);
    });
    return () => {
      live = false;
      if (widgetId && window.turnstile?.remove) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // Best-effort teardown only.
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!TURNSTILE_SITE_KEY) return null;
  return (
    <div className="turnstile-wrap">
      <div ref={ref} />
      {failed && (
        <p className="shell-note" role="alert">
          تعذّر تحميل التحقق الأمني. حدّث الصفحة وحاول مجدداً.
        </p>
      )}
    </div>
  );
}
