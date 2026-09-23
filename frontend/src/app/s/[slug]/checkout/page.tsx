"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ShopPage } from "@/components/shop/ShopPage";
import { useBuyer } from "@/hooks/useBuyer";
import { useCart } from "@/hooks/useCart";
import { storefrontApi, type CheckoutResult, type ServerCartItem } from "@/lib/api";
import { getErrorCode, getFieldErrors, NETWORK_ERROR_MESSAGE } from "@/lib/auth-errors";
import { GOVERNORATES } from "@/lib/governorates";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";
import { TurnstileWidget, TURNSTILE_READY } from "@/components/auth/TurnstileWidget";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Buyer checkout (P4): the cart lives on the server — this page submits
 * cart_id (claimed CAS, single-attempt) and never sends lines. Guest
 * checkout always works; a logged-in buyer gets their profile prefilled and
 * the order linked to their account. Totals come ONLY from the server.
 */
export default function ShopCheckoutPage({
  params,
}: {
  params: { slug: string };
}) {
  const { slug } = params;
  const { cartFor, setQuantity, forgetGuestCart, ensure, notice } = useCart();
  const { buyerFor } = useBuyer();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [prefilled, setPrefilled] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [shipPhone, setShipPhone] = useState("");
  const [governorate, setGovernorate] = useState<string>(GOVERNORATES[0]);
  const [city, setCity] = useState("");
  const [addressLine, setAddressLine] = useState("");
  const [method, setMethod] = useState("cod");
  const [reference, setReference] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<CheckoutResult | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);

  function retryCaptcha() {
    setCaptchaToken(null);
    setCaptchaKey((k) => k + 1);
  }

  useEffect(() => {
    ensure(slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  return (
    <ShopPage slug={slug}>
      {({ store }) => {
        const cart = cartFor(slug);
        const lines: ServerCartItem[] = cart?.items ?? [];
        const buyer = buyerFor(slug);
        return (
          <CheckoutBody
            slug={slug}
            storeId={store.id}
            storeName={store.name}
            cartId={cart?.id ?? null}
            lines={lines}
            buyerName={buyer?.name ?? null}
            buyerPhone={buyer?.phone ?? null}
            buyerEmail={buyer?.email ?? null}
            state={{
              name, setName, phone, setPhone, email, setEmail,
              prefilled, setPrefilled,
              recipient, setRecipient, shipPhone, setShipPhone,
              governorate, setGovernorate, city, setCity,
              addressLine, setAddressLine, method, setMethod,
              reference, setReference, fieldErrors, setFieldErrors,
              formError, setFormError, submitting, setSubmitting,
              done, setDone, key, setKey,
              captchaToken, captchaKey, retryCaptcha, setCaptchaToken,
            }}
            setQuantity={setQuantity}
            forgetGuestCart={forgetGuestCart}
            notice={notice}
          />
        );
      }}
    </ShopPage>
  );
}

function CheckoutBody(props: {
  slug: string;
  storeId: string;
  storeName: string;
  cartId: string | null;
  lines: ServerCartItem[];
  buyerName: string | null;
  buyerPhone: string | null;
  buyerEmail: string | null;
  state: {
    name: string; setName: (v: string) => void;
    phone: string; setPhone: (v: string) => void;
    email: string; setEmail: (v: string) => void;
    prefilled: boolean; setPrefilled: (v: boolean) => void;
    recipient: string; setRecipient: (v: string) => void;
    shipPhone: string; setShipPhone: (v: string) => void;
    governorate: string; setGovernorate: (v: string) => void;
    city: string; setCity: (v: string) => void;
    addressLine: string; setAddressLine: (v: string) => void;
    method: string; setMethod: (v: string) => void;
    reference: string; setReference: (v: string) => void;
    fieldErrors: Record<string, string>; setFieldErrors: (v: Record<string, string>) => void;
    formError: string | null; setFormError: (v: string | null) => void;
    submitting: boolean; setSubmitting: (v: boolean) => void;
    done: CheckoutResult | null; setDone: (v: CheckoutResult | null) => void;
    key: string | null; setKey: (v: string | null) => void;
    captchaToken: string | null; captchaKey: number; retryCaptcha: () => void;
    setCaptchaToken: (v: string | null) => void;
  };
  setQuantity: (slug: string, itemId: string, quantity: number) => Promise<boolean>;
  forgetGuestCart: (slug: string) => void;
  notice: string | null;
}) {
  const { slug, storeId, storeName, cartId, lines, state: s } = props;

  // Prefill once from the buyer profile (the server still owns the final
  // customer block when a session is present; guests type freely).
  useEffect(() => {
    if (s.prefilled) return;
    if (props.buyerName) {
      s.setName(props.buyerName);
      s.setPhone(props.buyerPhone ?? "");
      s.setEmail(props.buyerEmail ?? "");
      s.setRecipient(props.buyerName);
      s.setShipPhone(props.buyerPhone ?? "");
      s.setPrefilled(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.buyerName, s.prefilled]);

  const signature = useMemo(
    () => JSON.stringify([cartId, lines.map((l) => [l.product_id, l.quantity])]),
    [cartId, lines]
  );

  // New idempotency key per cart snapshot; retries of the same snapshot
  // reuse it (safe replay), any cart change mints a fresh one.
  useEffect(() => {
    s.setKey(newKey());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (s.submitting || lines.length === 0 || !cartId) return;
    s.setFieldErrors({});
    s.setFormError(null);
    const local: Record<string, string> = {};
    if (s.name.trim().length < 1) local.name = "الاسم مطلوب.";
    if (s.phone.trim().length < 1) local.phone = "رقم الهاتف مطلوب.";
    if (s.email.trim() !== "" && !EMAIL_RE.test(s.email.trim()))
      local.email = "بريد غير صالح.";
    if (s.recipient.trim().length < 1) local.recipient = "اسم المستلم مطلوب.";
    if (s.shipPhone.trim().length < 1) local.shipPhone = "هاتف التوصيل مطلوب.";
    if (s.addressLine.trim().length < 1) local.address = "العنوان مطلوب.";
    if (s.method !== "cod" && s.reference.trim() === "")
      local.reference = "المرجع مطلوب لغير الدفع نقداً.";
    if (Object.keys(local).length > 0) {
      s.setFieldErrors(local);
      return;
    }
    if (TURNSTILE_READY && !s.captchaToken) {
      s.setFormError("أكمل التحقق الأمني أولاً.");
      return;
    }
    const attemptKey = s.key ?? newKey();
    s.setKey(attemptKey);
    s.setSubmitting(true);
    try {
      const res = await storefrontApi.checkout(
        storeId,
        {
          customer: {
            name: s.name.trim(),
            phone: s.phone.trim(),
            email: s.email.trim() === "" ? null : s.email.trim(),
          },
          cart_id: cartId,
          shipping: {
            recipient_name: s.recipient.trim(),
            phone: s.shipPhone.trim(),
            governorate: s.governorate,
            city: s.city.trim() === "" ? null : s.city.trim(),
            address_line: s.addressLine.trim(),
          },
          payment: {
            method: s.method,
            reference: s.reference.trim() === "" ? null : s.reference.trim(),
          },
        },
        attemptKey,
        s.captchaToken ?? undefined
      );
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "turnstile_required") {
          s.setFormError("أكمل التحقق الأمني أولاً.");
          return;
        }
        if (code === "turnstile_failed") {
          s.setFormError("فشل التحقق الأمني. حاول مجدداً.");
          s.retryCaptcha();
          return;
        }
        if (code === "cart_not_found") {
          s.setFormError("انتهت صلاحية السلة أو استُخدمت. أعد إضافة الأصناف وحاول مجدداً.");
          props.forgetGuestCart(slug);
          return;
        }
        if (code === "product_unavailable") {
          s.setFormError("أحد الأصناف لم يعد متاحاً. حدّث السلة وحاول مجدداً.");
          return;
        }
        const fields = getFieldErrors(res);
        if (Object.keys(fields).length > 0) s.setFieldErrors(fields);
        else if (res.error.message) s.setFormError(res.error.message);
        else s.setFormError("تعذّر إتمام الطلب. حاول مجدداً.");
        return;
      }
      props.forgetGuestCart(slug);
      s.setDone(res.data);
    } catch {
      s.setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      s.setSubmitting(false);
    }
  }

  if (s.done) {
    const order = s.done.order;
    return (
      <>
        <div className="shop-hero">
          <h1>شكراً لك! تم استلام طلبك.</h1>
          <p>
            رقم الطلب <strong dir="ltr">#{order.order_number.toLocaleString("ar-SY")}</strong>
            {s.done.replayed && " (طلب مكرر — لم يُنشأ طلب جديد)"}
          </p>
        </div>
        <div className="shell-card">
          <h2 className="shell-card-title">ملخص الطلب (من الخادم)</h2>
          <div className="info-row">
            <span className="key">المجموع الفرعي</span>
            <span className="value">{order.subtotal.toLocaleString("ar-SY")} قرش</span>
          </div>
          <div className="info-row">
            <span className="key">الشحن</span>
            <span className="value">{order.shipping_cost.toLocaleString("ar-SY")} قرش</span>
          </div>
          <div className="info-row">
            <span className="key">الإجمالي</span>
            <span className="value">{order.total.toLocaleString("ar-SY")} قرش</span>
          </div>
          <div style={{ marginTop: 16 }}>
            <Link href={`/s/${encodeURIComponent(slug)}`} className="btn btn-primary">
              العودة إلى {storeName}
            </Link>
          </div>
        </div>
      </>
    );
  }

  if (lines.length === 0) {
    return (
      <div className="shell-card">
        <p className="shell-note">
          السلة فارغة.{" "}
          <Link href={`/s/${encodeURIComponent(slug)}`}>تصفح المنتجات</Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="shop-hero">
        <h1>إتمام الشراء</h1>
      </div>
      {props.notice && (
        <div className="shell-notice" role="alert">
          <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
          <span>{props.notice}</span>
        </div>
      )}
      <div className="shell-card">
        <h2 className="shell-card-title">السلة</h2>
        {lines.map((l) => (
          <div key={l.id} className="shop-cart-line">
            <span className="grow">{l.product_name}</span>
            <span className="shop-cart-price" dir="ltr">{l.unit_price.toLocaleString("ar-SY")}</span>
            <span className="shop-qty" style={{ margin: 0 }}>
              <button
                type="button"
                aria-label="إنقاص"
                onClick={() => props.setQuantity(slug, l.id, l.quantity - 1)}
              >
                −
              </button>
              <span>{l.quantity.toLocaleString("ar-SY")}</span>
              <button
                type="button"
                aria-label="زيادة"
                onClick={() => props.setQuantity(slug, l.id, l.quantity + 1)}
              >
                +
              </button>
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-shell-dark btn-sm"
              onClick={() => props.setQuantity(slug, l.id, 0)}
            >
              إزالة
            </button>
          </div>
        ))}
        <p className="shell-note" style={{ marginTop: 12 }}>
          الأسعار والإجمالي النهائي تُحسب على الخادم عند تأكيد الطلب.
        </p>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">بياناتك والتوصيل</h2>
        <form className="auth-form" onSubmit={onSubmit} noValidate>
          <FormError message={s.formError} />
          <TextField label="الاسم" id="co-name" value={s.name} onChange={(e) => s.setName(e.target.value)} error={s.fieldErrors.name} />
          <TextField label="رقم الهاتف" id="co-phone" dir="ltr" inputMode="tel" value={s.phone} onChange={(e) => s.setPhone(e.target.value)} error={s.fieldErrors.phone} />
          <TextField label="البريد (اختياري)" id="co-email" dir="ltr" value={s.email} onChange={(e) => s.setEmail(e.target.value)} error={s.fieldErrors.email} />
          <TextField label="اسم المستلم" id="co-recipient" value={s.recipient} onChange={(e) => s.setRecipient(e.target.value)} error={s.fieldErrors.recipient} />
          <TextField label="هاتف التوصيل" id="co-ship-phone" dir="ltr" inputMode="tel" value={s.shipPhone} onChange={(e) => s.setShipPhone(e.target.value)} error={s.fieldErrors.shipPhone} />
          <div className="auth-field">
            <label className="auth-label" htmlFor="co-gov">المحافظة</label>
            <select id="co-gov" className="auth-input" value={s.governorate} onChange={(e) => s.setGovernorate(e.target.value)}>
              {GOVERNORATES.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>
          <TextField label="المدينة (اختياري)" id="co-city" value={s.city} onChange={(e) => s.setCity(e.target.value)} />
          <TextField label="العنوان" id="co-address" value={s.addressLine} onChange={(e) => s.setAddressLine(e.target.value)} error={s.fieldErrors.address} />
          <div className="auth-field">
            <label className="auth-label" htmlFor="co-pay">طريقة الدفع</label>
            <select id="co-pay" className="auth-input" value={s.method} onChange={(e) => s.setMethod(e.target.value)}>
              <option value="cod">الدفع عند الاستلام</option>
              <option value="bank_transfer">تحويل بنكي</option>
              <option value="wallet">محفظة إلكترونية</option>
            </select>
          </div>
          {s.method !== "cod" && (
            <TextField label="مرجع الدفع" id="co-ref" dir="ltr" value={s.reference} onChange={(e) => s.setReference(e.target.value)} error={s.fieldErrors.reference} />
          )}
          <TurnstileWidget key={s.captchaKey} onToken={s.setCaptchaToken} />
          <button type="submit" className="btn btn-primary btn-lg auth-submit" disabled={s.submitting}>
            {s.submitting ? "جاري إرسال الطلب..." : "تأكيد الطلب"}
          </button>
        </form>
      </div>
    </>
  );
}
