"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { authApi } from "@/lib/api";
import { authErrorMessage, NETWORK_ERROR_MESSAGE } from "@/lib/auth-errors";
import { AuthCard } from "@/components/auth/AuthCard";
import { Loading } from "@/components/ui/Loading";

type Status =
  | { kind: "missing" }
  | { kind: "verifying" }
  | { kind: "success" }
  | { kind: "failed"; message: string };

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [status, setStatus] = useState<Status>(
    token ? { kind: "verifying" } : { kind: "missing" }
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        // Single-use token: unknown / expired / already-used → identical 400.
        const res = await authApi.verifyEmail(token);
        if (!cancelled) {
          setStatus(
            res.ok
              ? { kind: "success" }
              : { kind: "failed", message: authErrorMessage(res, 400) }
          );
        }
      } catch {
        if (!cancelled) setStatus({ kind: "failed", message: NETWORK_ERROR_MESSAGE });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (status.kind === "verifying") {
    return (
      <AuthCard title="تفعيل البريد الإلكتروني">
        <div className="auth-loading" style={{ minHeight: 0 }}>
          <Loading text="جاري تفعيل بريدك..." />
        </div>
      </AuthCard>
    );
  }

  if (status.kind === "success") {
    return (
      <AuthCard
        title="تم تفعيل بريدك"
        footer={
          <span>
            <a href="/auth/login">سجّل الدخول الآن</a>
          </span>
        }
      >
        <div className="auth-success" role="status">
          <i className="fas fa-check-circle" aria-hidden="true"></i>
          <span>تم توثيق بريدك الإلكتروني بنجاح. يمكنك الآن تسجيل الدخول.</span>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="تعذّر التفعيل"
      footer={
        <span>
          <a href="/auth/login">العودة لتسجيل الدخول</a>
        </span>
      }
    >
      <div className="auth-form-error" role="alert">
        <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
        <span>
          {status.kind === "missing"
            ? "رابط التفعيل غير مكتمل (لا يوجد رمز). افتح الرابط الكامل من بريدك."
            : status.message}
        </span>
      </div>
    </AuthCard>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <AuthCard title="تفعيل البريد الإلكتروني">
          <div className="auth-loading" style={{ minHeight: 0 }}>
            <Loading text="جاري التحميل..." />
          </div>
        </AuthCard>
      }
    >
      <VerifyEmailContent />
    </Suspense>
  );
}
