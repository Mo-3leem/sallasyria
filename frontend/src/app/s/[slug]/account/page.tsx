"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ShopPage } from "@/components/shop/ShopPage";
import { useBuyer } from "@/hooks/useBuyer";
import { buyerApi, type BuyerAddress, type BuyerOrderSummary } from "@/lib/api";
import { orderStatusLabel, paymentStatusLabel } from "@/lib/orders";
import { GOVERNORATES } from "@/lib/governorates";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";

/** Buyer account home: profile, order history, address book, logout. */
export default function BuyerAccountPage({ params }: { params: { slug: string } }) {
  const { slug } = params;
  return (
    <ShopPage slug={slug} title="حسابي">
      {() => <AccountBody slug={slug} />}
    </ShopPage>
  );
}

function AccountBody({ slug }: { slug: string }) {
  const router = useRouter();
  const { buyerFor, refresh, logout, updateName } = useBuyer();
  const buyer = buyerFor(slug);
  const [orders, setOrders] = useState<BuyerOrderSummary[] | null>(null);
  const [addresses, setAddresses] = useState<BuyerAddress[] | null>(null);
  const [name, setName] = useState("");
  const [nameSaved, setNameSaved] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refresh(slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    if (buyer === undefined) return;
    if (buyer === null) {
      router.replace(`/s/${encodeURIComponent(slug)}/account/login`);
      return;
    }
    setName(buyer.name);
    let live = true;
    buyerApi.orders(slug).then((res) => {
      if (live && res.ok) setOrders(res.data.orders);
    });
    buyerApi.addresses.list(slug).then((res) => {
      if (live && res.ok) setAddresses(res.data.addresses);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buyer, slug]);

  if (buyer === undefined) {
    return (
      <div className="shell-card">
        <div className="shell-loading" role="status">
          <span className="shell-spinner" aria-hidden="true"></span>
          جاري تحميل الحساب...
        </div>
      </div>
    );
  }
  if (buyer === null) return null;

  async function onSaveName(e: FormEvent) {
    e.preventDefault();
    if (savingName) return;
    setError(null);
    setNameSaved(false);
    if (name.trim().length < 1) {
      setError("الاسم مطلوب.");
      return;
    }
    setSavingName(true);
    try {
      const okSaved = await updateName(slug, name.trim());
      if (okSaved) setNameSaved(true);
      else setError("تعذّر حفظ الاسم.");
    } finally {
      setSavingName(false);
    }
  }

  return (
    <>
      <div className="shell-card">
        <h2 className="shell-card-title">البيانات</h2>
        <FormError message={error} />
        <div className="info-row">
          <span className="key">الهاتف</span>
          <span className="value" dir="ltr">{buyer.phone}</span>
        </div>
        <div className="info-row">
          <span className="key">البريد</span>
          <span className="value" dir="ltr">
            {buyer.email ?? "—"}
            {buyer.email && (buyer.email_verified ? " (مؤكد)" : " (غير مؤكد)")}
          </span>
        </div>
        <form className="auth-form mt-12" onSubmit={onSaveName} noValidate>
          <TextField label="الاسم" id="ba-name" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn btn-outline" disabled={savingName}>
            {savingName ? "جاري الحفظ..." : "حفظ الاسم"}
          </button>
          {nameSaved && <p className="shell-success">تم الحفظ.</p>}
        </form>
        <div className="mt-12">
          <button
            type="button"
            className="btn btn-ghost btn-shell-dark btn-sm"
            onClick={async () => {
              await logout(slug);
              router.replace(`/s/${encodeURIComponent(slug)}`);
            }}
          >
            تسجيل الخروج
          </button>
        </div>
      </div>

      <div className="shell-card" id="settings">
        <h2 className="shell-card-title">إعدادات الحساب</h2>
        <div className="shell-stack">
          <Link
            href={`/s/${encodeURIComponent(slug)}/account/change-password`}
            className="store-row"
          >
            <span className="store-row-icon" aria-hidden="true">
              <i className="fas fa-key"></i>
            </span>
            <span className="store-row-body">
              <span className="store-row-name">تغيير كلمة المرور</span>
              <span className="store-row-meta">تتطلب كلمة المرور الحالية؛ جلستك تبقى سارية</span>
            </span>
            <i className="fas fa-chevron-left" aria-hidden="true" style={{ color: "var(--gray-3)" }}></i>
          </Link>
        </div>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">طلباتي</h2>
        {orders === null ? (
          <div className="shell-loading" role="status">
            <span className="shell-spinner" aria-hidden="true"></span>
            جاري التحميل...
          </div>
        ) : orders.length === 0 ? (
          <p className="shell-note">
            لا توجد طلبات بعد.{" "}
            <Link href={`/s/${encodeURIComponent(slug)}`}>تصفح المنتجات</Link>
          </p>
        ) : (
          orders.map((o) => (
            <div key={o.id} className="info-row">
              <span className="key" dir="ltr">#{o.order_number}</span>
              <span className="value">
                {orderStatusLabel(o.status)} · {paymentStatusLabel(o.payment_status)} · {o.total.toLocaleString("ar-SY")} قرش
              </span>
            </div>
          ))
        )}
      </div>

      <AddressBook slug={slug} addresses={addresses} setAddresses={setAddresses} />
    </>
  );
}

function AddressBook({
  slug,
  addresses,
  setAddresses,
}: {
  slug: string;
  addresses: BuyerAddress[] | null;
  setAddresses: (v: BuyerAddress[] | null) => void;
}) {
  const [recipient, setRecipient] = useState("");
  const [phone, setPhone] = useState("");
  const [governorate, setGovernorate] = useState<string>(GOVERNORATES[0]);
  const [city, setCity] = useState("");
  const [line, setLine] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    const res = await buyerApi.addresses.list(slug);
    if (res.ok) setAddresses(res.data.addresses);
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setFormError(null);
    if (!recipient.trim() || !phone.trim() || !line.trim()) {
      setFormError("المستلم والهاتف والعنوان مطلوبة.");
      return;
    }
    setBusy(true);
    try {
      const res = await buyerApi.addresses.create(slug, {
        recipient_name: recipient.trim(),
        phone: phone.trim(),
        governorate,
        city: city.trim() === "" ? null : city.trim(),
        address_line: line.trim(),
      });
      if (!res.ok) {
        setFormError("تعذّر إضافة العنوان.");
        return;
      }
      setRecipient("");
      setPhone("");
      setCity("");
      setLine("");
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(id: string) {
    const res = await buyerApi.addresses.remove(slug, id);
    if (res.ok) await reload();
  }

  async function onDefault(id: string) {
    const res = await buyerApi.addresses.makeDefault(slug, id);
    if (res.ok) await reload();
  }

  return (
    <div className="shell-card">
      <h2 className="shell-card-title">دفتر العناوين</h2>
      {addresses === null ? (
        <div className="shell-loading" role="status">
          <span className="shell-spinner" aria-hidden="true"></span>
          جاري التحميل...
        </div>
      ) : (
        addresses.map((a) => (
          <div key={a.id} className="info-row">
            <span className="key">
              {a.recipient_name} · {a.governorate}
              {a.is_default === 1 && " (افتراضي)"}
            </span>
            <span className="value">
              {a.is_default !== 1 && (
                <button type="button" className="btn btn-ghost btn-shell-dark btn-sm" onClick={() => onDefault(a.id)}>
                  افتراضي
                </button>
              )}{" "}
              <button type="button" className="btn btn-ghost btn-shell-dark btn-sm" onClick={() => onRemove(a.id)}>
                حذف
              </button>
            </span>
          </div>
        ))
      )}
      {addresses !== null && addresses.length === 0 && (
        <p className="shell-note">لا توجد عناوين محفوظة.</p>
      )}
      <form className="auth-form mt-12" onSubmit={onAdd} noValidate>
        <h3 className="shell-card-title">عنوان جديد</h3>
        <FormError message={formError} />
        <TextField label="اسم المستلم" id="ba-recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
        <TextField label="الهاتف" id="ba-phone" dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <div className="auth-field">
          <label className="auth-label" htmlFor="ba-gov">المحافظة</label>
          <select id="ba-gov" className="auth-input" value={governorate} onChange={(e) => setGovernorate(e.target.value)}>
            {GOVERNORATES.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </div>
        <TextField label="المدينة (اختياري)" id="ba-city" value={city} onChange={(e) => setCity(e.target.value)} />
        <TextField label="العنوان" id="ba-line" value={line} onChange={(e) => setLine(e.target.value)} />
        <button type="submit" className="btn btn-outline" disabled={busy}>
          {busy ? "جاري الإضافة..." : "إضافة العنوان"}
        </button>
      </form>
    </div>
  );
}
