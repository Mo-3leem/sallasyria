"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ShopPage } from "@/components/shop/ShopPage";
import { buyerApi } from "@/lib/api";
import { FormError } from "@/components/auth/FormError";

/** Buyer email verification (link from the registration email). */
export default function BuyerVerifyPage({ params }: { params: { slug: string } }) {
  return (
    <ShopPage slug={params.slug} title="تأكيد البريد">
      {() => (
        <Suspense fallback={<div className="shell-card"><p className="shell-note">جاري التأكيد...</p></div>}>
          <VerifyBody slug={params.slug} />
        </Suspense>
      )}
    </ShopPage>
  );
}

function VerifyBody({ slug }: { slug: string }) {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [state, setState] = useState<"working" | "done" | "bad">("working");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState("bad");
      return;
    }
    let live = true;
    buyerApi.verifyEmail(slug, token).then((res) => {
      if (!live) return;
      if (res.ok) setState("done");
      else {
        setState("bad");
        setError("الرابط غير صالح أو انتهت صلاحيته.");
      }
    }).catch(() => {
      if (!live) return;
      setState("bad");
      setError("تعذّر الاتصال بالخادم.");
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, token]);

  return (
    <div className="shell-card">
      {state === "working" && (
        <div className="shell-loading">
          <span className="shell-spinner" aria-hidden="true"></span>
          جاري تأكيد بريدك...
        </div>
      )}
      {state === "done" && (
        <p className="shell-success">
          تم تأكيد بريدك بنجاح.{" "}
          <Link href={`/s/${encodeURIComponent(slug)}/account`}>العودة إلى حسابي</Link>
        </p>
      )}
      {state === "bad" && (
        <>
          <FormError message={error} />
          <p className="shell-note">
            <Link href={`/s/${encodeURIComponent(slug)}/account/login`}>تسجيل الدخول</Link>
          </p>
        </>
      )}
    </div>
  );
}
