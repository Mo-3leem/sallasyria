"use client";

import Link from "next/link";
import { ShopPage } from "@/components/shop/ShopPage";
import { EmptyState } from "@/components/common/EmptyState";

/** Buyer home: hero + categories + all published products. */
export default function ShopHomePage({
  params,
}: {
  params: { slug: string };
}) {
  const { slug } = params;
  return (
    <ShopPage slug={slug}>
      {({ store, categories, products }) => (
        <>
          <div className="shop-hero">
            <h1>أهلاً بك في {store.name}</h1>
            <p>تسوّق منتجاتنا المختارة بعناية.</p>
          </div>
          {categories.length > 0 && (
            <>
              <h2 className="shop-section-title">التصنيفات</h2>
              <div className="shop-grid">
                {categories.map((c) => (
                  <Link
                    key={c.id}
                    href={`/s/${encodeURIComponent(slug)}/c/${encodeURIComponent(c.slug)}`}
                    className="shop-card"
                  >
                    <span className="shop-card-name">{c.name}</span>
                    <span className="shop-card-meta">تصفح المنتجات ←</span>
                  </Link>
                ))}
              </div>
            </>
          )}
          <h2 className="shop-section-title">المنتجات</h2>
          {products.length === 0 ? (
            <div className="shell-card">
              <EmptyState
                icon="fas fa-box-open"
                title="لا توجد منتجات"
                description="لا توجد منتجات متاحة حالياً. عُد قريباً."
              />
            </div>
          ) : (
            <div className="shop-grid">
              {products.map((p) => (
                <Link
                  key={p.id}
                  href={`/s/${encodeURIComponent(slug)}/p/${encodeURIComponent(p.slug)}`}
                  className="shop-card"
                >
                  <span className="shop-card-name">{p.name}</span>
                  <span className="shop-card-price">
                    {p.price.toLocaleString("ar-SY")} قرش
                  </span>
                  {p.stock_quantity !== null && p.stock_quantity <= 0 && (
                    <span className="shop-card-meta">نفد المخزون</span>
                  )}
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </ShopPage>
  );
}
