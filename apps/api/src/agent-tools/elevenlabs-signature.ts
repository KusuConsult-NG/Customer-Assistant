/**
 * Verification for ElevenLabs webhook deliveries.
 *
 * The scheme is taken from the SDK's own `webhooks.constructEvent` (in
 * @elevenlabs/elevenlabs-js/wrapper/webhooks.js), which is the authoritative
 * description of what they sign:
 *
 *   header:   t=<unix seconds>,v0=<hex>
 *   message:  `${timestamp}.${rawBody}`
 *   digest:   HMAC-SHA256(secret, message), hex, prefixed "v0="
 *
 * This is implemented here rather than by calling the SDK helper, for three
 * reasons — the first two are the SDK's, and both are real:
 *
 * 1. THE SDK COMPARES SIGNATURES WITH `!==`. A plain string comparison returns
 *    as soon as two bytes differ, so the time it takes leaks how much of a
 *    guessed signature was correct. `timingSafeEqual` does not. Every other
 *    webhook in this codebase already uses it; this one should not be the
 *    exception.
 *
 * 2. THE SDK ONLY BOUNDS THE PAST. It rejects a timestamp older than 30
 *    minutes and accepts one arbitrarily far in the future — so a delivery
 *    signed with a far-future timestamp stays replayable forever. Bounding both
 *    directions costs nothing.
 *
 * 3. The SDK helper takes a string; we hold a Buffer. Concatenating buffers
 *    avoids a decode/encode round trip through UTF-8, which is identical for
 *    valid JSON and strictly safer for anything that is not.
 *
 * ── The header name is the one thing here that is NOT verified ───────────────
 *
 * `ElevenLabs-Signature` is what their documentation uses, but this was written
 * without network access to confirm it against a live delivery. So the name is
 * a constant, overridable with ELEVENLABS_SIGNATURE_HEADER, and a delivery that
 * arrives without it logs the header names it DID carry. The first real webhook
 * will therefore say what the right name is, instead of failing silently.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export const DEFAULT_SIGNATURE_HEADER = 'elevenlabs-signature';

/** Matches the SDK's tolerance. Older than this and the delivery is stale. */
export const MAX_AGE_MS = 30 * 60 * 1000;

/**
 * How far ahead of us a sender's clock may be. The SDK allows any future
 * timestamp; a bounded window means a captured delivery stops being replayable
 * at some point rather than never.
 */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function signatureHeaderName(): string {
  return (process.env.ELEVENLABS_SIGNATURE_HEADER || DEFAULT_SIGNATURE_HEADER).toLowerCase();
}

export type SignatureVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Compute the signature for a body. Exported because the tests sign payloads
 * the same way ElevenLabs would — a verifier tested only against signatures it
 * generated itself proves nothing about the scheme, but it does prove that
 * tampering is caught, which is what these tests are for.
 */
export function signPayload(rawBody: Buffer, timestampSecs: number, secret: string): string {
  const message = Buffer.concat([Buffer.from(`${timestampSecs}.`, 'utf8'), rawBody]);
  return `v0=${createHmac('sha256', secret).update(message).digest('hex')}`;
}

export function verifyElevenLabsSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  now: number = Date.now()
): SignatureVerdict {
  if (!header) return { ok: false, reason: 'missing signature header' };
  if (!secret) return { ok: false, reason: 'no webhook secret configured' };

  // Parsed by prefix rather than by position: the SDK does the same, and the
  // order of the parts is not something we should depend on.
  const parts = header.split(',').map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  const provided = parts.find((p) => p.startsWith('v0='));

  if (!timestamp || !provided) {
    return { ok: false, reason: 'signature header is not in the t=…,v0=… form' };
  }

  const signedAtMs = Number(timestamp) * 1000;
  if (!Number.isFinite(signedAtMs)) {
    return { ok: false, reason: 'signature timestamp is not a number' };
  }
  if (signedAtMs < now - MAX_AGE_MS) {
    return { ok: false, reason: 'signature timestamp is too old' };
  }
  if (signedAtMs > now + MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: 'signature timestamp is too far in the future' };
  }

  const expected = signPayload(rawBody, Number(timestamp), secret);
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, so the lengths are checked
  // first — and a length difference is not secret.
  if (a.length !== b.length) return { ok: false, reason: 'signature does not match' };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'signature does not match' };

  return { ok: true };
}
