import { describe, expect, it } from "vitest";
import { GOVERNORATES } from "./governorates.js";

describe("GOVERNORATES", () => {
  it("is the frozen 14-governorate mirror of the backend list", () => {
    expect([...GOVERNORATES]).toEqual([
      "Damascus",
      "Rif Dimashq",
      "Aleppo",
      "Homs",
      "Hama",
      "Latakia",
      "Idlib",
      "Al-Hasakah",
      "Deir ez-Zor",
      "Raqqa",
      "Daraa",
      "As-Suwayda",
      "Quneitra",
      "Tartus",
    ]);
  });

  it("has no duplicates or blanks", () => {
    expect(new Set(GOVERNORATES).size).toBe(GOVERNORATES.length);
    for (const g of GOVERNORATES) {
      expect(g.trim().length).toBeGreaterThan(0);
    }
  });
});
