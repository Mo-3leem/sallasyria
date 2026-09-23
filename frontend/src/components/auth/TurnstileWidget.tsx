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
// Stall guard: filtered networks often hang instead of failing, which would
// otherwise leave the widget area blank forever with no message.
const LOAD_TIMEOUT_MS = 15000;
// One automatic retry: transient blocks resolve, hard blocks surface fast.
const MAX_ATTEMPTS = 2;

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

// Dashboard pastes routinely carry a trailing newline, which makes the key
// invalid (render throws, zero widget box). Keys never legitimately contain
// surrounding whitespace, so trim once and treat blank as absent.
const SITE_KEY = TURNSTILE_SITE_KEY.trim();

/** True when a usable key is baked in (what the widget actually renders on). */
export const TURNSTILE_READY = SITE_KEY !== "";

type LoadState = "loading" | "ready" | "blocked" | "failed";

/**
 * Cloudflare Turnstile widget (buyer flows). Renders only when a site key
 * is baked in; otherwise renders nothing and the backend dev bypass covers
 * local development. One automatic retry on load failure, then a terminal
 * message that distinguishes a stalled/filtered network ("blocked") from a
 * hard load/render failure ("failed"). Parents remount via `key` to retry
 * after a 403.
 */
export function TurnstileWidget({ onToken }: { onToken: (token: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [attempt, setAttempt] = useState(0);
  const cb = useRef(onToken);
  cb.current = onToken;

  useEffect(() => {
    if (!SITE_KEY) return;
    let live = true;
    let settled = false;
    let widgetId: string | null = null;
    const fail = (next: "blocked" | "failed") => {
      if (!live || settled) return;
      settled = true;
      if (attempt < MAX_ATTEMPTS - 1) setAttempt((a) => a + 1);
      else setState(next);
    };
    const timer = window.setTimeout(() => fail("blocked"), LOAD_TIMEOUT_MS);
    loadScript().then(() => {
      if (!live || settled) return;
      try {
        if (!ref.current || !window.turnstile) throw new Error("turnstile unavailable");
        widgetId = window.turnstile.render(ref.current, {
          sitekey: SITE_KEY,
          callback: (token: string) => cb.current(token),
          "expired-callback": () => cb.current(null),
          "error-callback": () => cb.current(null),
        });
      } catch {
        fail("failed");
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      if (live) setState("ready");
    }).catch(() => fail("failed"));
    return () => {
      live = false;
      window.clearTimeout(timer);
      if (widgetId && window.turnstile?.remove) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // Best-effort teardown only.
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  if (!SITE_KEY) return null;
  return (
    <div className="turnstile-wrap">
      <div ref={ref} />
      {state === "loading" && (
        <p className="shell-note">جاري تحميل التحقق الأمني...</p>
      )}
      {state === "blocked" && (
        <p className="shell-note" role="alert">
          تعذّر الوصول إلى خدمة التحقق الأمني. تحقق من اتصالك أو جرّب شبكة أخرى.
        </p>
      )}
      {state === "failed" && (
        <p className="shell-note" role="alert">
          تعذّر تحميل التحقق الأمني. حدّث الصفحة وحاول مجدداً.
        </p>
      )}
    </div>
  );
}
