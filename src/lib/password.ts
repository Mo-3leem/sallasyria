import { scrypt } from "@noble/hashes/scrypt.js";
import {
  bytesToHex,
  hexToBytes,
  randomBytes,
} from "@noble/hashes/utils.js";

// B2-A DECISION (verified, not assumed):
//  1. Static inspection of @noble/hashes@1.8.2: zero `node:` imports, zero
//     Buffer/process usage — pure JS over globalThis.crypto.getRandomValues.
//     Only comments mention Buffer.
//  2. Functional in Node 22 WebCrypto: scrypt N=16384 ~66ms, N=32768 ~106ms;
//     PBKDF2-SHA256 x300k ~93ms.
//  3. Decisive proof is runtime: B2 login integration tests execute this exact
//     code inside real workerd (wrangler dev) against local D1 — a scrypt
//     incompatibility fails those tests loudly instead of shipping silently.
// PRIMARY: noble scrypt, N=16384, r=8, p=1, dkLen=32, 16-byte salt
//   (~64-100ms per hash: memory-hard, login-frequency cost only).
// FALLBACK (documented, not implemented): WebCrypto PBKDF2-SHA256 x300k if
//   scrypt ever proves too slow on a target runtime. The `s1$` version prefix
//   in the format below exists precisely to allow that migration: verifiers
//   dispatch on prefix, so old and new hashes coexist during rotation.
// NEVER: plain SHA-256, custom schemes (both rejected at review).

const VERSION = "s1";
const N = 16384;
const R = 8;
const P = 1;
const DKLEN = 32;
const SALT_LEN = 16;
const MAX_PASSWORD_CHARS = 256;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scrypt(BufferFromString(password), salt, {
    N,
    r: R,
    p: P,
    dkLen: DKLEN,
  });
  return `${VERSION}$${N}$${R}$${P}$${bytesToHex(salt)}$${bytesToHex(hash)}`;
}

function BufferFromString(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Constant-time equality over decoded bytes. Fail-closed: any malformed
// input (wrong shape, bad hex, unknown version) returns false, never throws.
export function verifyPassword(password: string, stored: string): boolean {
  try {
    if (password.length === 0 || password.length > MAX_PASSWORD_CHARS) {
      return false;
    }
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== VERSION) return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
      return false;
    }
    if (n !== N || r !== R || p !== P) return false;
    const salt = hexToBytes(parts[4]!);
    const expected = hexToBytes(parts[5]!);
    if (salt.length !== SALT_LEN || expected.length !== DKLEN) return false;
    const actual = scrypt(BufferFromString(password), salt, {
      N: n,
      r,
      p,
      dkLen: expected.length,
    });
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

// Precomputed valid hash used ONLY to equalize timing when the account does
// not exist (or is inactive): callers run verifyPassword(anything, DUMMY)
// so unknown-phone and wrong-password take the same code path. Lazily built
// once per isolate to avoid taxing every cold start.
let dummy: string | null = null;

export function dummyHash(): string {
  if (dummy === null) {
    dummy = hashPassword(`dummy-${bytesToHex(randomBytes(16))}`);
  }
  return dummy;
}

export const PASSWORD_RULES = {
  version: VERSION,
  n: N,
  r: R,
  p: P,
  dkLen: DKLEN,
  saltLen: SALT_LEN,
  maxChars: MAX_PASSWORD_CHARS,
  // Minimum length for NEWLY CHOSEN passwords (change/reset flows). Login
  // verification accepts any length up to maxChars so pre-policy hashes keep
  // working; only selection is gated.
  minNewChars: 8,
} as const;
