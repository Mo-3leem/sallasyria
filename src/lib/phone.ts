// Syrian phone normalization (roadmap B5). Single choke point: services
// normalize before every customers/address write, so "+963991234567",
// "0991234567", "963 991 234 567" and "(+963) 991-234-567" all address the
// SAME customer row (and the same UNIQUE slot). Un-normalizable input throws
// AppError 400 — never stored raw, so uniqueness can never be dodged with
// formatting variants (including Unicode confusables, which are rejected).

import { AppError } from "../http/errors.js";

const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_INDIC_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

function foldDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const a = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (a !== -1) {
      out += String(a);
      continue;
    }
    const e = EASTERN_INDIC_DIGITS.indexOf(ch);
    if (e !== -1) {
      out += String(e);
      continue;
    }
    out += ch;
  }
  return out;
}

export function normalizePhone(raw: string): string {
  if (typeof raw !== "string") {
    throw new AppError("invalid_phone", 400, "Invalid phone number.");
  }
  // Keep a leading +, drop every other non-digit (spaces, dashes, parens).
  const folded = foldDigits(raw).trim();
  const hasPlus = folded.startsWith("+");
  const digits = folded.replace(/\D/g, "");
  let national: string;
  if (hasPlus && digits.startsWith("963")) {
    national = digits.slice(3);
  } else if (!hasPlus && digits.startsWith("963")) {
    national = digits.slice(3);
  } else if (!hasPlus && digits.startsWith("0")) {
    national = digits.slice(1);
  } else if (!hasPlus) {
    national = digits;
  } else {
    throw new AppError("invalid_phone", 400, "Invalid phone number.");
  }
  // E.164-ish shape guard: +963 + 6..9 national digits covers Syrian mobiles
  // (9) and landlines (6-9 by governorate) without pretending to know every
  // valid prefix. Uniqueness enforcement happens on this canonical form.
  if (!/^\d{6,9}$/.test(national)) {
    throw new AppError("invalid_phone", 400, "Invalid phone number.");
  }
  return `+963${national}`;
}
