/**
 * Time-based one-time passwords (RFC 6238, the scheme every authenticator app
 * speaks: Google Authenticator, Microsoft Authenticator, Authy, 1Password).
 *
 * Written here rather than pulled in as a dependency because it is forty
 * lines of HMAC and the parameters are fixed: SHA-1, 6 digits, 30 seconds —
 * the defaults every app assumes when it scans an otpauth:// QR code. A
 * different digest or period is not something an officer's phone will
 * negotiate; it would just show the wrong code.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = ALPHABET.indexOf(c);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 random bits, the size RFC 4226 recommends for SHA-1. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(secret: string, step: number): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', key).update(counter).digest();
  const offset = h[h.length - 1] & 0x0f;
  const code = ((h.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS).toString();
  return code.padStart(DIGITS, '0');
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_PERIOD);
}

/**
 * The step a code matches, allowing one step of clock drift either way, or
 * null. The caller rejects a step at or before the last one used, so a code
 * read over someone's shoulder cannot be replayed inside its window.
 */
export function matchTotp(secret: string, code: string, now = Date.now()): number | null {
  const given = (code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    const expected = Buffer.from(totpAt(secret, s));
    if (timingSafeEqual(expected, Buffer.from(given))) return s;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** Eight single-use recovery codes, shown once. Only their hashes are kept. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: 8 }, () => {
    const hex = randomBytes(5).toString('hex');
    return `${hex.slice(0, 5)}-${hex.slice(5)}`;
  });
}
