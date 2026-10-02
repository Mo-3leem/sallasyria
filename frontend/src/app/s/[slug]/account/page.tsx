"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ShopPage } from "@/components/shop/ShopPage";
import { BuyerAddressBook } from "@/components/shop/BuyerAddressBook";
import { useBuyer } from "@/hooks/useBuyer";
import { buyerApi, type BuyerAddress, type BuyerOrderSummary } from "@/lib/api";
import { orderStatusLabel, paymentStatusLabel } from "@/lib/orders";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";
import { EmptyState } from "@/components/common/EmptyState";

/** Buyer account home: overview, order history, profile, address book, logout. */
export default function BuyerAccountPage({ params }: { params: { slug: string } }) {
  const { slug } = params;
  return (
    <ShopPage slug={slug} title="حسابي">
      {() => <AccountBody slug={slug} />}
    </ShopPage>
  );
}

const NAV_ITEMS = [
  { href: "#overview", label: "نظرة عامة", icon: "fas fa-th-large" },
  { href: "#orders", label: "طلباتي", icon: "fas fa-receipt" },
  { href: "#profile", label: "البيانات", icon: "fas fa-user" },
  { href: "#addresses", label: "العناوين", icon: "fas fa-location-dot" },
  { href: "#settings", label: "الأمان", icon: "fas fa-key" },
];

/** Presentational status badges — labels come from the shared order maps. */
function orderBadgeClass(status: string): string {
  switch (status) {
    case "delivered":
      return "account-badge is-green";
    case "cancelled":
      return "account-badge is-red";
    case "confirmed":
    case "processing":
    case "shipped":
      return "account-badge is-blue";
    default:
      return "account-badge is-amber";
  }
}

function paymentBadgeClass(status: string): string {
  switch (status) {
    case "paid":
      return "account-badge is-green";
    case "failed":
      return "account-badge is-red";
    case "refunded":
      return "account-badge is-gray";
    default:
      return "account-badge is-amber";
  }
}

function AccountBody({ slug }: { slug: string }) {
  const router = useRouter();
  const { buyerFor, refresh, logout, updateName } = useBuyer();
  const buyer = buyerFor(slug);
  const [orders, setOrders] = useState<BuyerOrderSummary[] | null>(null);
  const [ordersCursor, setOrdersCursor] = useState<string | null>(null);
  const [ordersMore, setOrdersMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [addresses, setAddresses] = useState<BuyerAddress[] | null>(null);
  const [ordersError, setOrdersError] = useState(false);
  const [addressesError, setAddressesError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
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
    setOrders(null);
    setOrdersCursor(null);
    setOrdersMore(false);
    setAddresses(null);
    setOrdersError(false);
    setAddressesError(false);
    let live = true;
    // Cursor pages accumulate: first page on load, older pages on demand.
    buyerApi.orders(slug).then(
      (res) => {
        if (!live) return;
        if (res.ok) {
          setOrders(res.data.orders);
          setOrdersCursor(res.data.pagination.next_cursor);
          setOrdersMore(res.data.pagination.next_cursor !== null);
        } else setOrdersError(true);
      },
      () => {
        if (live) setOrdersError(true);
      }
    );
    buyerApi.addresses.list(slug).then(
      (res) => {
        if (!live) return;
        if (res.ok) setAddresses(res.data.addresses);
        else setAddressesError(true);
      },
      () => {
        if (live) setAddressesError(true);
      }
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buyer, slug, reloadKey]);

  if (buyer === undefined) {
    return (
      <div className="account-wrap" aria-label="جاري تحميل الحساب">
        <div className="account-skeleton-list" role="status">
          <span className="account-skeleton" style={{ height: 120 }}></span>
          <span className="account-skeleton" style={{ height: 64 }}></span>
          <span className="account-skeleton" style={{ height: 220 }}></span>
        </div>
      </div>
    );
  }
  if (buyer === null) return null;

  const defaultAddress =
    addresses?.find((a) => a.is_default === 1) ?? addresses?.[0] ?? null;
  const recentOrders = orders?.slice(0, 3) ?? [];
  const initial = buyer.name.trim().slice(0, 1) || "م";

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

  async function onLogout() {
    await logout(slug);
    router.replace(`/s/${encodeURIComponent(slug)}`);
  }

  async function onLoadMoreOrders() {
    if (loadingMore || ordersCursor === null || orders === null) return;
    setLoadingMore(true);
    try {
      const res = await buyerApi.orders(slug, { cursor: ordersCursor });
      if (!res.ok) {
        setOrdersError(true);
        return;
      }
      setOrders([...orders, ...res.data.orders]);
      setOrdersCursor(res.data.pagination.next_cursor);
      setOrdersMore(res.data.pagination.next_cursor !== null);
    } catch {
      setOrdersError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  function onRetry() {
    setReloadKey((k) => k + 1);
  }

  return (
    <div className="account-wrap">
      <div className="account-hero">
        <span className="account-avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="account-hero-body">
          <span className="account-hero-name">{buyer.name}</span>
          <span className="account-hero-meta">
            <span dir="ltr">{buyer.phone}</span>
            {buyer.email && (
              <>
                <span aria-hidden="true">·</span>
                <span dir="ltr">{buyer.email}</span>
              </>
            )}
          </span>
          <span className="account-hero-badges">
            <span className="account-badge">حساب عميل</span>
            {buyer.email && (
              <span className={`account-badge ${buyer.email_verified ? "is-green" : "is-amber"}`}>
                {buyer.email_verified ? "بريد مؤكد" : "بريد غير مؤكد"}
              </span>
            )}
          </span>
        </span>
        <Link href={`/s/${encodeURIComponent(slug)}`} className="btn btn-outline account-hero-cta">
          <i className="fas fa-store" aria-hidden="true"></i>
          متابعة التسوق
        </Link>
      </div>

      <nav className="account-tabs" aria-label="أقسام الحساب">
        {NAV_ITEMS.map((item) => (
          <a key={item.href} href={item.href} className="account-tab">
            <i className={item.icon} aria-hidden="true"></i>
            {item.label}
            {item.href === "#orders" && orders !== null && orders.length > 0 && (
              <span className="account-tab-count">{orders.length.toLocaleString("ar-SY")}</span>
            )}
          </a>
        ))}
      </nav>

      <div className="account-layout">
        <aside className="account-side">
          <nav className="account-nav" aria-label="أقسام الحساب">
            {NAV_ITEMS.map((item) => (
              <a key={item.href} href={item.href} className="account-nav-item">
                <i className={item.icon} aria-hidden="true"></i>
                {item.label}
                {item.href === "#orders" && orders !== null && orders.length > 0 && (
                  <span className="count">{orders.length.toLocaleString("ar-SY")}</span>
                )}
              </a>
            ))}
          </nav>
          <Link href={`/s/${encodeURIComponent(slug)}`} className="account-back-link">
            <i className="fas fa-arrow-right" aria-hidden="true"></i>
            عودة إلى المتجر
          </Link>
        </aside>

        <div className="account-main">
          <section className="account-section" id="overview" aria-labelledby="overview-heading">
            <h2 className="account-section-title" id="overview-heading">
              <i className="fas fa-th-large" aria-hidden="true"></i>
              نظرة عامة
            </h2>
            {ordersError || addressesError ? (
              <div className="account-error" role="alert">
                <i className="fas fa-exclamation-triangle" aria-hidden="true"></i>
                <span>تعذّر تحميل بعض بيانات الحساب.</span>
                <button type="button" className="btn btn-outline btn-sm" onClick={onRetry}>
                  <i className="fas fa-rotate-right" aria-hidden="true"></i>
                  إعادة المحاولة
                </button>
              </div>
            ) : (
              <>
                <div className="account-stats">
                  <div className="account-stat">
                    <span className="account-stat-icon" aria-hidden="true">
                      <i className="fas fa-receipt"></i>
                    </span>
                    <span className="account-stat-body">
                      <span className="account-stat-value">
                        {orders === null ? (
                          <span className="account-skeleton account-skeleton-inline" aria-label="جاري التحميل"></span>
                        ) : (
                          orders.length.toLocaleString("ar-SY")
                        )}
                      </span>
                      <span className="account-stat-label">طلباتي</span>
                    </span>
                  </div>
                  <div className="account-stat">
                    <span className="account-stat-icon" aria-hidden="true">
                      <i className="fas fa-location-dot"></i>
                    </span>
                    <span className="account-stat-body">
                      <span className="account-stat-value">
                        {addresses === null ? (
                          <span className="account-skeleton account-skeleton-inline" aria-label="جاري التحميل"></span>
                        ) : (
                          addresses.length.toLocaleString("ar-SY")
                        )}
                      </span>
                      <span className="account-stat-label">عناوين محفوظة</span>
                    </span>
                  </div>
                  <div className="account-stat">
                    <span className="account-stat-icon" aria-hidden="true">
                      <i className="fas fa-truck"></i>
                    </span>
                    <span className="account-stat-body">
                      <span className="account-stat-value account-stat-text">
                        {addresses === null ? (
                          <span className="account-skeleton account-skeleton-inline" aria-label="جاري التحميل"></span>
                        ) : defaultAddress ? (
                          `${defaultAddress.governorate}${defaultAddress.city ? ` · ${defaultAddress.city}` : ""}`
                        ) : (
                          "لا يوجد عنوان"
                        )}
                      </span>
                      <span className="account-stat-label">عنوان التوصيل</span>
                    </span>
                  </div>
                </div>
                {orders !== null && orders.length > 0 && (
                  <div className="account-recent">
                    <h3 className="account-recent-title">أحدث الطلبات</h3>
                    {recentOrders.map((o) => (
                      <div key={o.id} className="account-order-line">
                        <span className="account-order-num" dir="ltr">
                          #{o.order_number}
                        </span>
                        <span className={orderBadgeClass(o.status)}>{orderStatusLabel(o.status)}</span>
                        <span className="account-order-total">
                          {o.total.toLocaleString("ar-SY")} قرش
                        </span>
                      </div>
                    ))}
                    {orders.length > recentOrders.length && (
                      <a href="#orders" className="account-more-link">
                        عرض كل الطلبات
                        <i className="fas fa-chevron-left" aria-hidden="true"></i>
                      </a>
                    )}
                  </div>
                )}
              </>
            )}
          </section>

          <section className="account-section" id="orders" aria-labelledby="orders-heading">
            <h2 className="account-section-title" id="orders-heading">
              <i className="fas fa-receipt" aria-hidden="true"></i>
              طلباتي
              {orders !== null && orders.length > 0 && (
                <span className="count">{orders.length.toLocaleString("ar-SY")}</span>
              )}
            </h2>
            {orders === null ? (
              ordersError ? (
                <div className="account-error" role="alert">
                  <i className="fas fa-exclamation-triangle" aria-hidden="true"></i>
                  <span>تعذّر تحميل الطلبات.</span>
                  <button type="button" className="btn btn-outline btn-sm" onClick={onRetry}>
                    <i className="fas fa-rotate-right" aria-hidden="true"></i>
                    إعادة المحاولة
                  </button>
                </div>
              ) : (
                <div className="account-skeleton-list" role="status" aria-label="جاري تحميل الطلبات">
                  <span className="account-skeleton" style={{ height: 92 }}></span>
                  <span className="account-skeleton" style={{ height: 92 }}></span>
                  <span className="account-skeleton" style={{ height: 92 }}></span>
                </div>
              )
            ) : orders.length === 0 ? (
              <EmptyState
                icon="fas fa-receipt"
                title="لا توجد طلبات بعد"
                description="ابدأ التسوق لاكتشاف منتجات هذا المتجر — ستظهر طلباتك هنا مع حالتها وإجماليها."
                action={
                  <Link href={`/s/${encodeURIComponent(slug)}`} className="btn btn-primary">
                    تصفح المنتجات
                  </Link>
                }
              />
            ) : (
              <div className="account-order-list">
                {orders.map((o) => (
                  <article key={o.id} className="account-order-card">
                    <div className="account-order-top">
                      <span className="account-order-icon" aria-hidden="true">
                        <i className="fas fa-receipt"></i>
                      </span>
                      <span className="account-order-body">
                        <span className="account-order-num" dir="ltr">
                          #{o.order_number}
                        </span>
                        <span className="account-order-badges">
                          <span className={orderBadgeClass(o.status)}>{orderStatusLabel(o.status)}</span>
                          <span className={paymentBadgeClass(o.payment_status)}>
                            {paymentStatusLabel(o.payment_status)}
                          </span>
                        </span>
                      </span>
                    </div>
                    <div className="account-order-bottom">
                      <span className="account-order-total-label">الإجمالي</span>
                      <span className="account-order-total">
                        {o.total.toLocaleString("ar-SY")} قرش
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {ordersMore && orders !== null && orders.length > 0 && (
              <div style={{ marginTop: 12, textAlign: "center" }}>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  disabled={loadingMore}
                  onClick={onLoadMoreOrders}
                >
                  {loadingMore ? "جاري التحميل..." : "عرض طلبات أقدم"}
                </button>
              </div>
            )}
          </section>

          <section className="account-section" id="profile" aria-labelledby="profile-heading">
            <h2 className="account-section-title" id="profile-heading">
              <i className="fas fa-user" aria-hidden="true"></i>
              البيانات الشخصية
            </h2>
            <FormError message={error} />
            <dl className="account-fields">
              <div className="account-field">
                <dt>الهاتف</dt>
                <dd dir="ltr">{buyer.phone}</dd>
              </div>
              <div className="account-field">
                <dt>البريد الإلكتروني</dt>
                <dd dir="ltr">
                  {buyer.email ?? "—"}
                  {buyer.email && (
                    <span className={`account-badge ${buyer.email_verified ? "is-green" : "is-amber"}`}>
                      {buyer.email_verified ? "مؤكد" : "غير مؤكد"}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
            <form onSubmit={onSaveName} noValidate aria-label="تعديل الاسم" className="account-edit-form">
              <TextField
                label="الاسم"
                id="ba-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <div className="account-form-actions">
                <button type="submit" className="btn btn-primary" disabled={savingName}>
                  {savingName ? "جاري الحفظ..." : "حفظ الاسم"}
                </button>
                {nameSaved && (
                  <span className="account-saved" role="status">
                    <i className="fas fa-check-circle" aria-hidden="true"></i>
                    تم الحفظ.
                  </span>
                )}
              </div>
            </form>
          </section>

          <div id="addresses">
            <BuyerAddressBook
              slug={slug}
              addresses={addresses}
              setAddresses={setAddresses}
              loadError={addressesError}
              onRetry={onRetry}
            />
          </div>

          <section className="account-section" id="settings" aria-labelledby="settings-heading">
            <h2 className="account-section-title" id="settings-heading">
              <i className="fas fa-key" aria-hidden="true"></i>
              الأمان والجلسة
            </h2>
            <Link
              href={`/s/${encodeURIComponent(slug)}/account/change-password`}
              className="account-link-row"
            >
              <span className="account-link-icon" aria-hidden="true">
                <i className="fas fa-key"></i>
              </span>
              <span className="account-link-body">
                <span className="account-link-name">تغيير كلمة المرور</span>
                <span className="account-link-meta">تتطلب كلمة المرور الحالية؛ جلستك تبقى سارية</span>
              </span>
              <i className="fas fa-chevron-left" aria-hidden="true"></i>
            </Link>
            <button type="button" className="btn btn-outline account-logout" onClick={onLogout}>
              <i className="fas fa-sign-out-alt" aria-hidden="true"></i>
              تسجيل الخروج
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
