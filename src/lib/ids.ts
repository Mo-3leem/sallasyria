// UUIDv7 (RFC 9562) generation using only WebCrypto — no Node APIs, no
// dependencies, safe in the Workers runtime. All DB ids are TEXT UUIDv7/ULID
// generated in application code (DB never generates ids).

const HEX = "0123456789abcdef";

function hexByte(b: number): string {
  return HEX[(b >> 4) & 0xf]! + HEX[b & 0xf]!;
}

export function uuidv7(nowMs: number = Date.now()): string {
  const rand = crypto.getRandomValues(new Uint8Array(10));
  const timeHex = Math.floor(nowMs).toString(16).padStart(12, "0");

  // 48-bit unix_ts_ms | 4-bit ver (0111) | 12-bit rand_a |
  // 2-bit var (10) | 62-bit rand_b
  const randA = ((rand[0]! << 8) | rand[1]!) & 0x0fff;
  const b0 = 0x70 | ((randA >> 8) & 0x0f);
  const b1 = randA & 0xff;
  const c0 = 0x80 | (rand[2]! & 0x3f);

  const p =
    timeHex.slice(0, 8) +
    timeHex.slice(8, 12) +
    hexByte(b0) +
    hexByte(b1) +
    hexByte(c0) +
    Array.from(rand.slice(3), hexByte).join("");

  return (
    `${p.slice(0, 8)}-${p.slice(8, 12)}-${p.slice(12, 16)}-` +
    `${p.slice(16, 20)}-${p.slice(20, 32)}`
  );
}

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidv7(value: string): boolean {
  return UUIDV7_RE.test(value);
}
