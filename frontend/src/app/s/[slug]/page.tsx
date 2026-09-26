"use client";

import { ShopPage } from "@/components/shop/ShopPage";
import { StoreHomeSections } from "@/components/shop/StoreHomeSections";
import { coerceTheme } from "@/lib/theme-design";

/** Buyer home: hero + categories + all published products (published theme). */
export default function ShopHomePage({
  params,
}: {
  params: { slug: string };
}) {
  const { slug } = params;
  return (
    <ShopPage slug={slug}>
      {({ store, categories, products, theme }) => (
        <StoreHomeSections
          slug={slug}
          storeName={store.name}
          categories={categories}
          products={products}
          theme={coerceTheme(theme)}
          live
        />
      )}
    </ShopPage>
  );
}
