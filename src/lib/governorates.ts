// Frozen 14 Syrian governorates — the SAME list as the DDL CHECKs
// (customer_addresses.governorate, shipping_rates.governorate,
// orders.shipping_governorate). Single source for app-side validation so the
// two layers can never disagree on spelling. Exact strings, exact order.

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

export function isGovernorate(value: string): value is Governorate {
  return (GOVERNORATES as readonly string[]).includes(value);
}
