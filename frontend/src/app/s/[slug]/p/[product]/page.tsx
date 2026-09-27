"use client";

import Link from "next/link";
import { useState } from "react";
import { ShopPage } from "@/components/shop/ShopPage";
import { useCart } from "@/hooks/useCart";
import { EmptyState } from "@/components/common/EmptyState";

/** Buyer product page: details + quantity + add to cart. */
export default function ShopProductPage({
  params,
}: {
  params: { slug: string; product: string };
}) {
  const { slug, product: productSlug } = params;
  const { add, notice } = useCart();
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [photo, setPhoto] = useState(0);

  return (
    <ShopPage slug={slug}>
      {({ categories, products }) => {
        const product = products.find((p) => p.slug === productSlug);
        if (!product) {
          return (
            <div className="shell-card">
              <EmptyState
                icon="fas fa-box"
                title="المنتج غير موجود"
                description="ربما نُفد أو أُخفي من المتجر."
                action={
                  <Link href={`/s/${encodeURIComponent(slug)}`} className="btn btn-outline">
                    العودة إلى المتجر
                  </Link>
                }
              />
            </div>
          );
        }
        const category = categories.find((c) => c.id === product.category_id);
        const soldOut =
          product.stock_quantity !== null && product.stock_quantity <= 0;
        // Gallery arrives pre-ordered (sort_order); the first image is the
        // cover, exactly like the merchant dashboard ordering.
        const photos = product.images ?? [];
        const current = photos[Math.min(photo, Math.max(photos.length - 1, 0))];
        return (
          <div className="shop-detail">
            <div>
              <div className="shop-detail-visual" aria-hidden={photos.length > 0}>
                {current ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={current.url}
                    alt={current.alt_text ?? product.name}
                    loading="lazy"
                  />
                ) : (
                  <i className="fas fa-box" aria-hidden="true"></i>
                )}
              </div>
              {photos.length > 1 && (
                <div className="shop-detail-thumbs" role="group" aria-label="صور المنتج">
                  {photos.map((img, i) => (
                    <button
                      key={img.id}
                      type="button"
                      className={img.id === current.id ? "is-active" : undefined}
                      aria-label={`صورة ${i + 1}`}
                      aria-pressed={img.id === current.id}
                      onClick={() => setPhoto(i)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.url}
                        alt=""
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="shop-detail-info">
              <h1>{product.name}</h1>
              {category && <p className="shop-card-meta">{category.name}</p>}
              <p className="shop-detail-price">
                {product.price.toLocaleString("ar-SY")} قرش
              </p>
              {soldOut ? (
                <p className="shell-note">نفد المخزون حالياً.</p>
              ) : (
                <>
                  <div className="shop-qty">
                    <button
                      type="button"
                      aria-label="إنقاص الكمية"
                      onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                    >
                      −
                    </button>
                    <span aria-live="polite">{quantity.toLocaleString("ar-SY")}</span>
                    <button
                      type="button"
                      aria-label="زيادة الكمية"
                      onClick={() => setQuantity((q) => Math.min(999, q + 1))}
                    >
                      +
                    </button>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary btn-lg"
                    disabled={adding}
                    onClick={async () => {
                      setAdding(true);
                      const okAdded = await add(slug, product.id, quantity);
                      setAdding(false);
                      if (okAdded) setAdded(true);
                    }}
                  >
                    <i className="fas fa-cart-plus" aria-hidden="true"></i>
                    {adding ? "جاري الإضافة..." : "أضف إلى السلة"}
                  </button>
                  {notice && !added && (
                    <p className="shell-error mt-12" role="alert">
                      {notice}
                    </p>
                  )}
                  {added && (
                    <p className="shell-success mt-12">
                      أُضيف إلى السلة.{" "}
                      <Link href={`/s/${encodeURIComponent(slug)}/checkout`}>
                        إتمام الشراء
                      </Link>
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        );
      }}
    </ShopPage>
  );
}
