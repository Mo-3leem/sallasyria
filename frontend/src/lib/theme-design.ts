/**
 * Shared store-theme model: one TypeScript source for the builder, the
 * public storefront, and the guest preview. Draft JSON is untrusted input
 * (merchant-authored, and published snapshots render to the public), so
 * every field is coerced defensively here before render.
 */

export type AlignOption = "right" | "center" | "left";
export type FontOption = "cairo" | "system";
export type SectionType = "hero" | "categories" | "products" | "banner" | "text";

export interface ThemePalette {
  primary: string;
  secondary: string;
  background: string;
  accent: string;
  text: string;
  button: string;
}

export interface ThemeHeader {
  show_name: 0 | 1;
  show_nav: 0 | 1;
  show_cart: 0 | 1;
  show_account: 0 | 1;
  background: string | null;
}

export interface ThemeHero {
  title: string;
  description: string;
  cta_text: string;
  cta_visible: 0 | 1;
  align: AlignOption;
  background: string | null;
  image: string | null;
}

export interface ThemeBanner {
  image: string;
  title: string;
}

export interface ThemeSection {
  type: SectionType;
  order: number;
  is_visible: 0 | 1;
  title?: string;
}

export interface ThemeProducts {
  show_names: 0 | 1;
  show_prices: 0 | 1;
}

export interface ThemeFooter {
  visible: 0 | 1;
  background: string | null;
  text: string;
}

export interface StoreTheme {
  palette: ThemePalette;
  font: FontOption;
  logo: string;
  header: ThemeHeader;
  hero: ThemeHero;
  banners: ThemeBanner[];
  sections: ThemeSection[];
  products: ThemeProducts;
  footer: ThemeFooter;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const SECTION_TYPES: SectionType[] = ["hero", "categories", "products", "banner", "text"];

export const DEFAULT_THEME: StoreTheme = {
  palette: {
    primary: "#16a34a",
    secondary: "#15803d",
    background: "#ffffff",
    accent: "#22c55e",
    text: "#0f172a",
    button: "#16a34a",
  },
  font: "cairo",
  logo: "",
  header: { show_name: 1, show_nav: 1, show_cart: 1, show_account: 1, background: null },
  hero: {
    title: "",
    description: "",
    cta_text: "تسوّق الآن",
    cta_visible: 0,
    align: "center",
    background: null,
    image: null,
  },
  banners: [],
  sections: [
    { type: "hero", order: 0, is_visible: 1 },
    { type: "categories", order: 1, is_visible: 1 },
    { type: "products", order: 2, is_visible: 1 },
    { type: "banner", order: 3, is_visible: 1 },
    { type: "text", order: 4, is_visible: 0 },
  ],
  products: { show_names: 1, show_prices: 1 },
  footer: { visible: 1, background: null, text: "" },
};

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function color(v: unknown, fallback: string): string {
  return typeof v === "string" && HEX_RE.test(v) ? v : fallback;
}

function flag(v: unknown, fallback: 0 | 1): 0 | 1 {
  return v === 0 ? 0 : v === 1 ? 1 : fallback;
}

function text(v: unknown, fallback: string, max = 500): string {
  if (typeof v !== "string") return fallback;
  const t = v.trim();
  return t === "" ? fallback : t.slice(0, max);
}

/** Image URLs render into <img> tags (published snapshots reach the
 * public), so only https URLs survive coercion — same rule as banners. */
function httpsUrl(v: unknown): string | null {
  return typeof v === "string" && v.startsWith("https://") && v.length <= 2048
    ? v
    : null;
}

function nullableColor(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return typeof v === "string" && HEX_RE.test(v) ? v : null;
}

/** Coerce untrusted draft/published JSON into a renderable theme. */
export function coerceTheme(raw: unknown): StoreTheme {
  const d = asRecord(raw);
  const palette = asRecord(d.palette);
  const header = asRecord(d.header);
  const hero = asRecord(d.hero);
  const products = asRecord(d.products);
  const footer = asRecord(d.footer);
  const banners = Array.isArray(d.banners)
    ? d.banners
        .filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
        .slice(0, 5)
        .map((b) => ({
          image: typeof b.image === "string" ? b.image : "",
          title: typeof b.title === "string" ? b.title.slice(0, 200) : "",
        }))
    : [];
  const sections = Array.isArray(d.sections)
    ? d.sections
        .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
        .slice(0, 20)
        .map((s, i): ThemeSection => ({
          type: SECTION_TYPES.includes(s.type as SectionType)
            ? (s.type as SectionType)
            : "text",
          order: typeof s.order === "number" ? s.order : i,
          is_visible: s.is_visible === 0 ? 0 : 1,
          ...(typeof s.title === "string" && s.title.trim() !== ""
            ? { title: s.title.trim().slice(0, 200) }
            : {}),
        }))
    : DEFAULT_THEME.sections.map((s) => ({ ...s }));
  return {
    palette: {
      primary: color(palette.primary, DEFAULT_THEME.palette.primary),
      secondary: color(palette.secondary, DEFAULT_THEME.palette.secondary),
      background: color(palette.background, DEFAULT_THEME.palette.background),
      accent: color(palette.accent, DEFAULT_THEME.palette.accent),
      text: color(palette.text, DEFAULT_THEME.palette.text),
      button: color(palette.button, DEFAULT_THEME.palette.button),
    },
    font: d.font === "system" ? "system" : "cairo",
    logo: httpsUrl(d.logo) ?? "",
    header: {
      show_name: flag(header.show_name, 1),
      show_nav: flag(header.show_nav, 1),
      show_cart: flag(header.show_cart, 1),
      show_account: flag(header.show_account, 1),
      background: nullableColor(header.background),
    },
    hero: {
      title: typeof hero.title === "string" ? hero.title.trim().slice(0, 200) : "",
      description: typeof hero.description === "string" ? hero.description.trim().slice(0, 500) : "",
      cta_text: text(hero.cta_text, DEFAULT_THEME.hero.cta_text, 100),
      cta_visible: flag(hero.cta_visible, 0),
      align:
        hero.align === "right" || hero.align === "center" || hero.align === "left"
          ? hero.align
          : "center",
      background: nullableColor(hero.background),
      image: httpsUrl(hero.image),
    },
    banners,
    sections,
    products: {
      show_names: flag(products.show_names, 1),
      show_prices: flag(products.show_prices, 1),
    },
    footer: {
      visible: flag(footer.visible, 1),
      background: nullableColor(footer.background),
      text: typeof footer.text === "string" ? footer.text.trim().slice(0, 300) : "",
    },
  };
}

/** Serialize a theme back to the whitelisted PATCH body (unknown keys 400). */
export function themeToPayload(t: StoreTheme): Record<string, unknown> {
  return {
    palette: { ...t.palette },
    font: t.font,
    logo: t.logo === "" ? null : t.logo,
    header: { ...t.header },
    hero: { ...t.hero },
    banners: t.banners.map((b) => ({
      image: b.image,
      ...(b.title !== "" ? { title: b.title } : {}),
    })),
    sections: t.sections.map((s) => ({
      type: s.type,
      order: s.order,
      is_visible: s.is_visible,
      ...(s.title !== undefined ? { title: s.title } : {}),
    })),
    products: { ...t.products },
    footer: { ...t.footer },
  };
}

/** Default section titles per type (overridable per section). */
export function defaultSectionTitle(type: SectionType): string {
  switch (type) {
    case "hero":
      return "الواجهة";
    case "categories":
      return "التصنيفات";
    case "products":
      return "المنتجات";
    case "banner":
      return "مختارات";
    case "text":
      return "نص ترحيبي";
  }
}
