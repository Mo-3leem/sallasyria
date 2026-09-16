import { describe, expect, it } from "vitest";
import { AppError } from "../src/http/errors.js";
import {
  r2FileFromUrl,
  r2KeyFromUrl,
  r2UrlFor,
  resolveImageUrl,
  sanitizeImage,
  signImageUrl,
  signingSecretOrThrow,
  sniffImageMime,
  verifyImageUrl,
} from "../src/lib/uploads.js";

function u8(...bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

function hasBytes(hay: Uint8Array, needle: number[]): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

describe("sniffImageMime", () => {
  it("identifies real types and rejects everything else", () => {
    expect(sniffImageMime(u8(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageMime(u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(
      sniffImageMime(u8(0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))
    ).toBe("image/webp");
    expect(sniffImageMime(u8(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif");
    expect(sniffImageMime(u8(0x25, 0x50, 0x44, 0x46))).toBeNull(); // %PDF
    expect(sniffImageMime(u8(0x4d, 0x5a))).toBeNull(); // MZ executable
    expect(sniffImageMime(u8())).toBeNull();
    // renamed executable: EXE bytes with .jpg name would still be rejected
    expect(sniffImageMime(u8(0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0))).toBeNull();
  });
});

describe("sanitizeImage", () => {
  it("strips JPEG APP1, keeps the image", () => {
    const jpeg = u8(
      0xff, 0xd8,
      0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66, // APP1 "Exif"
      0xff, 0xdb, 0x00, 0x04, 0x43, 0x44, // DQT (kept)
      0xff, 0xda, 0x00, 0x02, 0x99, // SOS + scan
      0xff, 0xd9
    );
    const { bytes, stripped } = sanitizeImage(jpeg, "image/jpeg");
    expect(stripped).toBe(true);
    expect(hasBytes(bytes, [0x45, 0x78, 0x69, 0x66])).toBe(false);
    expect(hasBytes(bytes, [0xff, 0xdb, 0x00, 0x04, 0x43, 0x44])).toBe(true);
    expect(hasBytes(bytes, [0xff, 0xd9])).toBe(true);
  });

  it("passes clean JPEG through byte-identical", () => {
    const jpeg = u8(0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x43, 0x44, 0xff, 0xda, 0x00, 0x02, 0x99, 0xff, 0xd9);
    const { bytes, stripped } = sanitizeImage(jpeg, "image/jpeg");
    expect(stripped).toBe(false);
    expect(bytes).toEqual(jpeg);
  });

  it("rejects truncated JPEG", () => {
    expect(() => sanitizeImage(u8(0xff, 0xd8), "image/jpeg")).toThrow(AppError);
  });

  it("strips PNG textual chunks, keeps image chunks", () => {
    const ihdr = [0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 9, 9, 9, 9];
    const text = [0x00, 0x00, 0x00, 0x05, 0x74, 0x45, 0x58, 0x74, 0x41, 0x42, 0x43, 0x44, 0x45, 8, 8, 8, 8];
    const iend = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 7, 7, 7, 7];
    const png = u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...text, ...iend);
    const { bytes, stripped } = sanitizeImage(png, "image/png");
    expect(stripped).toBe(true);
    expect(hasBytes(bytes, [0x74, 0x45, 0x58, 0x74])).toBe(false);
    expect(hasBytes(bytes, [0x49, 0x48, 0x44, 0x52])).toBe(true);
    expect(hasBytes(bytes, [0x49, 0x45, 0x4e, 0x44])).toBe(true);
  });

  it("strips GIF comment blocks", () => {
    const gif = u8(
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
      0x21, 0xfe, 0x03, 0x41, 0x42, 0x43, 0x00, // comment "ABC"
      0x3b
    );
    const { bytes, stripped } = sanitizeImage(gif, "image/gif");
    expect(stripped).toBe(true);
    expect(hasBytes(bytes, [0x41, 0x42, 0x43])).toBe(false);
    expect(bytes[bytes.length - 1]).toBe(0x3b);
  });

  it("strips WebP EXIF and repairs the RIFF size", () => {
    // RIFF(12) + VP8(8+4) + EXIF(8+6) ; total 38, size field 30
    const webp = u8(
      0x52, 0x49, 0x46, 0x46, 0x1e, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x20, 0x04, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x01,
      0x45, 0x58, 0x49, 0x46, 0x06, 0, 0, 0, 0x49, 0x49, 0x2a, 0, 1, 2
    );
    const { bytes, stripped } = sanitizeImage(webp, "image/webp");
    expect(stripped).toBe(true);
    expect(hasBytes(bytes, [0x45, 0x58, 0x49, 0x46])).toBe(false);
    expect(hasBytes(bytes, [0x56, 0x50, 0x38, 0x20])).toBe(true);
    const size = bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24);
    expect(size).toBe(bytes.length - 8);
  });
});

describe("signed image URLs", () => {
  const SECRET = "test-signing-secret";
  const STORE = "store-1";
  const FILE = "file-abc123.jpg";

  it("round-trips sign/verify and rejects misuse", async () => {
    const exp = Math.floor(Date.now() / 1000) + 900;
    const url = await signImageUrl(SECRET, STORE, FILE, exp);
    expect(url).toContain(`/stores/${STORE}/product-images/file/${FILE}`);
    const q = new URL(url, "https://x.test");
    const sig = q.searchParams.get("sig")!;
    expect(await verifyImageUrl(SECRET, STORE, FILE, exp, sig)).toBe(true);
    expect(await verifyImageUrl(SECRET, "other-store", FILE, exp, sig)).toBe(false);
    expect(await verifyImageUrl(SECRET, STORE, FILE, exp, `${sig.slice(0, -2)}xx`)).toBe(false);
    expect(await verifyImageUrl(SECRET, STORE, FILE, Math.floor(Date.now() / 1000) - 10, sig)).toBe(false);
    expect(await verifyImageUrl(SECRET, STORE, "../../evil", exp, sig)).toBe(false);
  });

  it("resolves r2:// references and passes legacy URLs through", async () => {
    const signed = await resolveImageUrl(r2UrlFor(`${STORE}/${FILE}`), STORE, SECRET);
    expect(signed).toContain("/product-images/file/");
    expect(signed).toContain("sig=");
    expect(await resolveImageUrl("https://cdn.example.com/old.jpg", STORE, SECRET)).toBe(
      "https://cdn.example.com/old.jpg"
    );
  });

  it("refuses cross-store embedded references", async () => {
    await expect(resolveImageUrl(r2UrlFor(`other/${FILE}`), STORE, SECRET)).rejects.toMatchObject({
      code: "image_not_found",
    });
    expect(r2KeyFromUrl("https://x/evil")).toBeNull();
    expect(r2FileFromUrl("r2://images/noslash")).toBeNull();
  });

  it("signingSecretOrThrow fails closed without a secret", () => {
    expect(signingSecretOrThrow({ URL_SIGNING_SECRET: "s" })).toBe("s");
    try {
      signingSecretOrThrow({});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toMatchObject({ code: "url_signing_misconfigured" });
    }
  });
});
