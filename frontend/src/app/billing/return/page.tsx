"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { billingApi } from "@/lib/api";
import { getErrorCode, NETWORK_ERROR_MESSAGE } from "@/lib/auth-errors";
import { Loading } from "@/components/ui/Loading";

type PollState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; status: string };

// Build-baked environment gate: the stub simulator exists ONLY in
// non-production builds. Production bundles (NODE_ENV === "production")
// never render the buttons, so stub success is unreachable outside
// development — the backend additionally fails closed there (503 /
// unknown provider), never fake success.
const STUB_SIMULATE_ENABLED = process.env.NODE_ENV !== "production";

const STUB_ONLY_DEV_MESSAGE =
  "المحاكاة التجريبية تعمل في بيئة التطوير فقط — للتفعيل على هذا الموقع استخدم بوابة الدفع أو التواصل مع الإدارة";

/**
 * Provider return landing: polls the intent row after the hosted flow.
 * Never fabricates outcomes — every state comes from GET intent.
 * Stub only: buttons simulate the provider callback through the real
 * webhook path (success / failure); real providers call back server-side.
 */
function ReturnContent() {
  const searchParams = useSearchParams();
  const storeId = searchParams.get("store") ?? "";
  const intentId = searchParams.get("intent") ?? "";
  const stubToken = searchParams.get("stub_token");
  const [state, setState] = useState<PollState>({ kind: "loading" });
  const [simulating, setSimulating] = useState<string | null>(null);
  const attempts = useRef(0);

  async function pollOnce(): Promise<string | null> {
    try {
      const res = await billingApi.getIntent(storeId, intentId);
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          setState({ kind: "error", message: "يجب تسجيل الدخول أولاً." });
          return "stop";
        }
        setState({
          kind: "error",
          message: "تعذّر العثور على عملية الدفع.",
        });
        return "stop";
      }
      const status = res.data.intent.status;
      setState({ kind: "ready", status });
      return status === "pending" ? "pending" : "done";
    } catch {
      setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
      return "stop";
    }
  }

  useEffect(() => {
    if (!storeId || !intentId) {
      setState({ kind: "error", message: "رابط العودة غير مكتمل." });
      return;
    }
    let cancelled = false;
    attempts.current = 0;
    const tick = async () => {
      if (cancelled) return;
      attempts.current += 1;
      const outcome = await pollOnce();
      if (cancelled || outcome !== "pending" || attempts.current >= 30) return;
      window.setTimeout(tick, 2000);
    };
    tick();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, intentId]);

  async function simulate(result: "success" | "failed") {
    if (!stubToken || simulating) return;
    setSimulating(result);
    try {
      // Stub provider callback through the REAL webhook endpoint — the
      // same path a production provider would hit server-to-server.
      const res = await billingApi.stubCallback({
        intent_id: intentId,
        stub_token: stubToken,
        result,
      });
      if (!res.ok) {
        // Stub path failed closed (e.g. non-development backend): say so
        // honestly. The mount poll above keeps running untouched, so a
        // genuine provider callback still resolves through it.
        setState({ kind: "error", message: STUB_ONLY_DEV_MESSAGE });
        return;
      }
      await pollOnce();
    } catch {
      setState({ kind: "error", message: STUB_ONLY_DEV_MESSAGE });
    } finally {
      setSimulating(null);
    }
  }

  return (
    <div className="shell-card" style={{ maxWidth: 560, margin: "48px auto" }}>
      <h1 className="shell-card-title">نتيجة الدفع</h1>
      {state.kind === "loading" && (
        <div className="shell-loading">
          <Loading text="بانتظار تأكيد الدفع..." />
        </div>
      )}
      {state.kind === "error" && (
        <div className="shell-error" role="alert">
          <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
          <span>{state.message}</span>
        </div>
      )}
      {state.kind === "ready" && (
        <>
          {state.status === "succeeded" && (
            <div className="shell-success" role="status">
              <i className="fas fa-check-circle" aria-hidden="true"></i>
              <span>تم تفعيل الاشتراك بنجاح. يمكنك العودة إلى متجرك.</span>
            </div>
          )}
          {state.status === "failed" && (
            <div className="shell-error" role="alert">
              <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
              <span>
                فشلت عملية الدفع ولم يُفعَّل شيء.{" "}
                <Link href={storeId ? `/app/stores/${encodeURIComponent(storeId)}` : "/app"}>
                  أنشئ عملية جديدة من صفحة الفوترة
                </Link>
                .
              </span>
            </div>
          )}
          {state.status === "pending" && !STUB_SIMULATE_ENABLED && !stubToken ? (
            <div className="shell-notice" role="status">
              <i className="fas fa-info-circle" aria-hidden="true"></i>
              <span>
                عملية الدفع قيد الانتظار — سيتم التفعيل تلقائياً عند تأكيد بوابة الدفع.{" "}
                <Link href="/app/billing">العودة إلى صفحة الفوترة</Link>
              </span>
            </div>
          ) : (
            state.status === "pending" && (
              <div className="shell-notice" role="status">
                <i className="fas fa-hourglass-half" aria-hidden="true"></i>
                <span>عملية الدفع قيد الانتظار — نتحقق تلقائياً كل ثانيتين.</span>
              </div>
            )
          )}
          {state.status === "expired" && (
            <div className="shell-error" role="alert">
              <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
              <span>انتهت مهلة عملية الدفع. أنشئ عملية جديدة من صفحة الفوترة.</span>
            </div>
          )}
          {STUB_SIMULATE_ENABLED &&
            stubToken &&
            (state.status === "pending" || state.status === "failed") && (
            <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={simulating !== null}
                onClick={() => simulate("success")}
              >
                {simulating === "success" ? "جاري..." : "محاكاة نجاح الدفع (تجريبي)"}
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={simulating !== null}
                onClick={() => simulate("failed")}
              >
                {simulating === "failed" ? "جاري..." : "محاكاة فشل الدفع (تجريبي)"}
              </button>
            </div>
          )}
          {state.status === "succeeded" && storeId && (
            <div style={{ marginTop: 16 }}>
              <Link
                href={`/app/stores/${encodeURIComponent(storeId)}`}
                className="btn btn-primary"
              >
                العودة إلى المتجر
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function BillingReturnPage() {
  return (
    <Suspense
      fallback={
        <div className="shell-loading">
          <Loading text="جاري التحميل..." />
        </div>
      }
    >
      <ReturnContent />
    </Suspense>
  );
}
