/**
 * Encryption for third-party credentials held in our database.
 *
 * What this protects: every third-party credential this platform stores on a
 * tenant's behalf — the ElevenLabs workspace key, Twilio auth tokens and API
 * secrets, WhatsApp access tokens. Between them they can read every call
 * transcript, place calls the tenant is billed for, and send messages as the
 * business. A database backup, a leaked read replica, or a SQL-injection read
 * anywhere in the app hands all of that over in plaintext.
 *
 * It lives in @ace/database rather than in the API because the columns it
 * guards live here, and because the orchestrator package reads some of them
 * too — a helper the API alone could import would leave that path decrypting
 * nothing.
 *
 * ── The shape on disk ───────────────────────────────────────────────────────
 *
 *   v1.<iv>.<authTag>.<ciphertext>      (each part base64)
 *
 * AES-256-GCM, a fresh 96-bit IV per encryption, and the GCM tag kept alongside
 * so a tampered value fails to decrypt rather than decrypting to garbage. The
 * version prefix is what makes a future algorithm change a detectable migration
 * instead of a mystery decryption failure — and it is also how a legacy
 * plaintext value is recognised: it simply has no prefix.
 *
 * ── Three deliberate refusals ───────────────────────────────────────────────
 *
 * 1. WITH NO KEY CONFIGURED, WRITING THROWS. It would be easy to fall back to
 *    storing plaintext with a warning, and that is exactly how a system ends up
 *    believing it encrypts secrets while storing them in the clear. A refused
 *    write is visible; a warning in a log is not.
 *
 * 2. READING A PLAINTEXT VALUE IS ALLOWED, AND SAYS SO EVERY TIME. Rows written
 *    before this existed must keep working, or turning encryption on breaks
 *    every live tenant. But the tolerance is loud and names the row, so the
 *    migration is finite rather than permanent. Run scripts/encrypt-secrets.js
 *    and the warnings stop.
 *
 * 3. A KEY THAT IS NOT 32 BYTES IS REJECTED, not stretched. Silently hashing a
 *    short passphrase into a key makes a weak secret look like a strong one.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is defined for
const KEY_BYTES = 32;

export class EncryptionKeyError extends Error {}

/**
 * Read a 32-byte key from an environment variable.
 *
 * Accepts hex (64 chars) or base64 (44 chars) so an operator can paste whatever
 * their generator produced, and rejects anything else with the command that
 * makes a correct one.
 */
function readKey(varName: string): Buffer | null {
  const raw = process.env[varName]?.trim();
  if (!raw) return null;

  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === KEY_BYTES) key = decoded;
  }

  if (!key || key.length !== KEY_BYTES) {
    throw new EncryptionKeyError(
      `${varName} must be a 32-byte key, as 64 hex characters or base64. Generate one with: openssl rand -base64 32`
    );
  }
  return key;
}

/** The key new values are encrypted with. */
function currentKey(): Buffer | null {
  return readKey('ENCRYPTION_KEY');
}

/**
 * The key retired at the last rotation, tried only on decrypt.
 *
 * Without this, rotating means every stored credential becomes unreadable at
 * the same instant — so nobody rotates. Keep the old key here until
 * scripts/encrypt-secrets.js has re-encrypted everything, then remove it.
 */
function previousKey(): Buffer | null {
  return readKey('ENCRYPTION_KEY_PREVIOUS');
}

export function encryptionAvailable(): boolean {
  try {
    return currentKey() !== null;
  } catch {
    return false;
  }
}

/** True when the stored value is one of ours, rather than a legacy plaintext. */
export function isEncrypted(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(`${VERSION}.`);
}

export function encryptSecret(plaintext: string): string {
  const key = currentKey();
  if (!key) {
    // Refusing rather than storing plaintext: see refusal 1 above.
    throw new EncryptionKeyError(
      'ENCRYPTION_KEY is not set, so this credential cannot be stored. Set it (openssl rand -base64 32) and try again — storing it unencrypted is not an option this system offers.'
    );
  }
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Refusing to encrypt an empty secret.');
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

/**
 * Decrypt a stored credential.
 *
 * `label` identifies the row in logs — it must never be the secret itself.
 */
export function decryptSecret(stored: string, label: string): string {
  if (!isEncrypted(stored)) {
    // Legacy plaintext. Allowed, and said out loud every time: see refusal 2.
    // console, not a framework logger: this module lives in @ace/database so
    // that the API, the orchestrator and the worker can all reach it, and it
    // must not drag a web framework into a package that only talks to Postgres.
    console.warn(
      `[SecretBox] unencrypted_secret_at_rest label=${label} — stored in the clear. Run \`npm run secrets:encrypt -- --apply\` to fix this permanently.`
    );
    return stored;
  }

  const [, ivB64, tagB64, dataB64] = stored.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error(`Stored secret for ${label} is malformed and cannot be decrypted.`);
  }

  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  // Current key first, then the retired one. A GCM tag mismatch throws, which
  // is what makes "try the other key" safe: a wrong key cannot decrypt to
  // plausible-looking rubbish, it fails.
  const keys = [currentKey(), previousKey()].filter((k): k is Buffer => k !== null);
  if (keys.length === 0) {
    throw new EncryptionKeyError(
      `ENCRYPTION_KEY is not set, so the stored credential for ${label} cannot be read. It is encrypted, not lost — set the key that wrote it.`
    );
  }

  for (const key of keys) {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      continue;
    }
  }

  throw new Error(
    `Could not decrypt the stored credential for ${label} with ENCRYPTION_KEY${
      previousKey() ? ' or ENCRYPTION_KEY_PREVIOUS' : ''
    }. The key has changed, or the value was tampered with.`
  );
}

/**
 * What is safe to show a human: enough to tell two keys apart, not enough to
 * use one. Never return the credential itself to a client.
 */
export function secretFingerprint(plaintext: string): string {
  if (!plaintext) return '';
  return `••••${plaintext.slice(-4)}`;
}
