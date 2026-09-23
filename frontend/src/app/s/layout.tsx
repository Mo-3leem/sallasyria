import type { ReactNode } from "react";
import { BuyerProvider } from "@/hooks/useBuyer";
import { CartProvider } from "@/hooks/useCart";
import "./storefront.css";

/** Public buyer area: no auth guard, buyer identity + server cart state. */
export default function StorefrontLayout({ children }: { children: ReactNode }) {
  return (
    <BuyerProvider>
      <CartProvider>
        <div className="shop">{children}</div>
      </CartProvider>
    </BuyerProvider>
  );
}
