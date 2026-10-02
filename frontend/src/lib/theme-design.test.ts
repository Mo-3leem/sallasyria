import { describe, expect, it } from "vitest";
import {
  coerceTheme,
  DEFAULT_THEME,
  defaultSectionTitle,
  themeToPayload,
} from "./theme-design.js";

describe("coerceTheme", () => {
  it("maps garbage input to the default theme", () => {
    for (const bad of [null, undefined, "junk", 42, [], true]) {
      expect(coerceTheme(bad)).toEqual(DEFAULT_THEME);
    }
  });

  it("falls back per field instead of rejecting the draft", () => {
    const t = coerceTheme({
      palette: { primary: "not-a-color", secondary: "#111111" },
      font: "comic-sans",
      logo: "http://cdn.example.com/logo.png",
      header: { show_name: 7 },
      hero: { align: "diagonal", title: "  Hi  ", image: "http://x/y.png" },
      banners: [{ image: "https://cdn.example.com/b.png" }, null, "x", {}, {}, {}, {}],
      sections: [{ type: "nope" }, { type: "hero", order: 9, is_visible: 5, title: "  T  " }],
      footer: { visible: 2, text: 1 },
    });
    expect(t.palette.primary).toBe(DEFAULT_THEME.palette.primary);
    expect(t.palette.secondary).toBe("#111111");
    expect(t.font).toBe("cairo");
    expect(t.logo).toBe("");
    expect(t.header.show_name).toBe(1);
    expect(t.hero.align).toBe("center");
    expect(t.hero.title).toBe("Hi");
    expect(t.hero.image).toBeNull();
    expect(t.banners).toHaveLength(5);
    expect(t.sections[0]?.type).toBe("text");
    expect(t.sections[1]).toMatchObject({ order: 9, is_visible: 1, title: "T" });
    expect(t.footer.visible).toBe(1);
  });

  it("keeps valid https values", () => {
    const t = coerceTheme({
      logo: "https://cdn.example.com/logo.png",
      hero: { image: "https://cdn.example.com/h.png" },
      font: "system",
    });
    expect(t.logo).toBe("https://cdn.example.com/logo.png");
    expect(t.hero.image).toBe("https://cdn.example.com/h.png");
    expect(t.font).toBe("system");
  });
});

describe("themeToPayload", () => {
  it("sends null for a cleared logo and drops empty banner titles", () => {
    const payload = themeToPayload({
      ...DEFAULT_THEME,
      logo: "",
      banners: [
        { image: "https://cdn.example.com/a.png", title: "" },
        { image: "https://cdn.example.com/b.png", title: "Sale" },
      ],
      sections: [{ type: "hero", order: 0, is_visible: 1 }],
    });
    expect((payload.logo as null)).toBeNull();
    expect(payload.banners).toEqual([
      { image: "https://cdn.example.com/a.png" },
      { image: "https://cdn.example.com/b.png", title: "Sale" },
    ]);
    expect(payload.sections).toEqual([{ type: "hero", order: 0, is_visible: 1 }]);
  });
});

describe("defaultSectionTitle", () => {
  it("covers every section type", () => {
    expect(defaultSectionTitle("hero")).toBe("الواجهة");
    expect(defaultSectionTitle("categories")).toBe("التصنيفات");
    expect(defaultSectionTitle("products")).toBe("المنتجات");
    expect(defaultSectionTitle("banner")).toBe("مختارات");
    expect(defaultSectionTitle("text")).toBe("نص ترحيبي");
  });
});
