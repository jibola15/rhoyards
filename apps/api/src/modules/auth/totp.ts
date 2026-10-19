import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238) as used by Google Authenticator, Microsoft Authenticator and others:
 * HMAC-SHA1, 6 digits, 30-second steps.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
/** Accept the previous and next step too, for clock drift and typing time. */
const DRIFT_STEPS = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
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

/** A new 160-bit secret, base32 (what the user's app stores). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export const timeStep = (at: Date = new Date()) => Math.floor(at.getTime() / 1000 / STEP_SECONDS);

/** The code for one time step (HOTP, RFC 4226). */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(binary).padStart(DIGITS, '0');
}

/**
 * Checks a code against the steps around `at`. Returns the matching step, or null. Steps at or before `lastUsedStep`
 * are refused, so a code (even one seen over someone's shoulder) works only once.
 */
export function verifyTotp(secret: string, code: string, at: Date, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = timeStep(at);
  let matched: number | null = null;
  // Check every candidate (no early exit) so timing does not reveal which step matched.
  for (let step = now - DRIFT_STEPS; step <= now + DRIFT_STEPS; step += 1) {
    const ok = timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code));
    if (ok && (lastUsedStep === null || step > lastUsedStep) && matched === null) matched = step;
  }
  return matched;
}

/** The URI an authenticator app reads from the QR code. */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
