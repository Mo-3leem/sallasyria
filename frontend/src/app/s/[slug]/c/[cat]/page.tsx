"use client";

import Link from "next/link";
import { ShopPage } from "@/components/shop/ShopPage";
import { EmptyState } from "@/components/common/EmptyState";

/** Buyer category page: products of one published category. */
export default function ShopCategoryPage({
  params,
}: {
  params: { slug: string; cat: string };
}) {
  const { slug, cat } = params;
  return (
    <ShopPage slug={slug}>
      {({ categories, products }) => {
        const category = categories.find((c) => c.slug === cat);
        if (!category) {
          return (
            <div className="shell-card">
              <EmptyState
                icon="fas fa-tags"
                title="التصنيف غير موجود"
                action={
                  <Link href={`/s/${encodeURIComponent(slug)}`} className="btn btn-outline">
                    العودة إلى المتجر
                  </Link>
                }
              />
            </div>
          );
        }
        const lines = products.filter((p) => p.category_id === category.id);
        return (
          <>
            <div className="shop-hero">
              <h1>{category.name}</h1>
            </div>
            {lines.length === 0 ? (
              <div className="shell-card">
                <EmptyState
                  icon="fas fa-box-open"
                  title="لا توجد منتجات"
                  description="لا توجد منتجات في هذا التصنيف حالياً."
                  action={
                    <Link href={`/s/${encodeURIComponent(slug)}`} className="btn btn-outline">
                      العودة إلى المتجر
                    </Link>
                  }
                />
              </div>
            ) : (
              <div className="shop-grid">
                {lines.map((p) => (
                  <Link
                    key={p.id}
                    href={`/s/${encodeURIComponent(slug)}/p/${encodeURIComponent(p.slug)}`}
                    className="shop-card"
                  >
                    <span className="shop-card-name">{p.name}</span>
                    <span className="shop-card-price">
                      {p.price.toLocaleString("ar-SY")} قرش
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </>
        );
      }}
    </ShopPage>
  );
}
