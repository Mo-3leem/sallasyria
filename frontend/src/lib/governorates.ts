/**
 * Frozen 14 Syrian governorates — exact mirror of the backend
 * src/lib/governorates.ts (same strings, same order) and the DDL CHECKs.
 * The backend validates too; this list only constrains the dropdown.
 */
export const GOVERNORATES = [
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
] as const;

export type Governorate = (typeof GOVERNORATES)[number];
