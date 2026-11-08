/**
 * Encryption for credentials held at rest.
 *
 * The failures worth testing here are not "does AES work" — Node's crypto is
 * not on trial. They are the ways a system ends up *believing* it encrypts
 * secrets while storing them in the clear, or ends up unable to read back a
 * credential it still holds:
 *
 *   - a missing key quietly degrading to plaintext
 *   - a short passphrase being stretched into something that looks like a key
 *   - a tampered ciphertext decrypting to something rather than failing
 *   - a key rotation making every stored credential unreadable at once
 *   - the same input always producing the same ciphertext, which leaks that two
 *     tenants configured the same key
 */

import {
  decryptSecret,
  encryptSecret,
  encryptionAvailable,
  EncryptionKeyError,
  SecretUnreadableError,
  isEncrypted,
  secretFingerprint,
} from '@ace/database';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');
const SECRET = 'sk_elevenlabs_workspace_key_value';

describe('secret box', () => {
  const saved = {
    key: process.env.ENCRYPTION_KEY,
    previous: process.env.ENCRYPTION_KEY_PREVIOUS,
  };

  const useKeys = (current?: string, previous?: string) => {
    if (current === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = current;
    if (previous === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS;
    else process.env.ENCRYPTION_KEY_PREVIOUS = previous;
  };

  beforeEach(() => useKeys(KEY_A));

  afterAll(() => useKeys(saved.key, saved.previous));

  describe('round trip', () => {
    it('returns exactly what was put in', () => {
      expect(decryptSecret(encryptSecret(SECRET), 'test')).toBe(SECRET);
    });

    it('accepts a hex key as readily as a base64 one', () => {
      useKeys(Buffer.alloc(32, 9).toString('hex'));
      expect(decryptSecret(encryptSecret(SECRET), 'test')).toBe(SECRET);
    });

    it('produces a different ciphertext every time', () => {
      const a = encryptSecret(SECRET);
      const b = encryptSecret(SECRET);
      // A fresh IV per encryption. Deterministic ciphertext would reveal that
      // two tenants had configured the same workspace key, without decrypting
      // anything.
      expect(a).not.toBe(b);
      expect(decryptSecret(a, 'test')).toBe(decryptSecret(b, 'test'));
    });

    it('marks its own output so a legacy plaintext is distinguishable', () => {
      expect(isEncrypted(encryptSecret(SECRET))).toBe(true);
      expect(isEncrypted(SECRET)).toBe(false);
    });
  });

  describe('refusing to store plaintext', () => {
    it('throws when no key is configured instead of writing the secret as-is', () => {
      useKeys(undefined);
      // The alternative — store it plaintext and log a warning — is exactly how
      // a system reports "encrypted at rest" while being nothing of the kind.
      expect(() => encryptSecret(SECRET)).toThrow(EncryptionKeyError);
      expect(() => encryptSecret(SECRET)).toThrow(/ENCRYPTION_KEY is not set/);
    });

    it('reports that encryption is unavailable rather than pretending', () => {
      useKeys(undefined);
      expect(encryptionAvailable()).toBe(false);
      useKeys(KEY_A);
      expect(encryptionAvailable()).toBe(true);
    });

    it('refuses an empty secret', () => {
      expect(() => encryptSecret('')).toThrow(/empty/i);
    });
  });

  describe('rejecting a key that is not a key', () => {
    it.each([
      ['a short passphrase', 'hunter2'],
      ['31 bytes', Buffer.alloc(31, 7).toString('base64')],
      ['33 bytes', Buffer.alloc(33, 7).toString('base64')],
      ['63 hex characters', 'a'.repeat(63)],
    ])('refuses %s rather than stretching it', (_label, value) => {
      useKeys(value);
      // Hashing a weak passphrase into 32 bytes would make it look like a
      // strong key in every log and every review.
      expect(() => encryptSecret(SECRET)).toThrow(EncryptionKeyError);
      expect(() => encryptSecret(SECRET)).toThrow(/32-byte key/);
    });

    it('says how to make a correct one', () => {
      useKeys('nope');
      expect(() => encryptSecret(SECRET)).toThrow(/openssl rand -base64 32/);
    });
  });

  describe('tampering', () => {
    it('fails rather than decrypting an altered ciphertext', () => {
      const sealed = encryptSecret(SECRET);
      const [v, iv, tag, data] = sealed.split('.');
      const flipped = Buffer.from(data, 'base64');
      flipped[0] ^= 0xff;

      // The GCM tag is what makes this a failure instead of plausible rubbish.
      expect(() =>
        decryptSecret([v, iv, tag, flipped.toString('base64')].join('.'), 'test')
      ).toThrow(/Could not decrypt/);
    });

    it('fails when the auth tag is replaced', () => {
      const [v, iv, , data] = encryptSecret(SECRET).split('.');
      const wrongTag = Buffer.alloc(16, 0).toString('base64');
      expect(() => decryptSecret([v, iv, wrongTag, data].join('.'), 'test')).toThrow(
        /Could not decrypt/
      );
    });

    it('reports a truncated value as malformed', () => {
      expect(() => decryptSecret('v1.onlyonepart', 'test')).toThrow(/malformed/i);
    });
  });

  describe('key rotation', () => {
    it('reads a value written with the previous key', () => {
      const sealed = encryptSecret(SECRET);
      // Rotate: the new key cannot read it, the retired one still can.
      useKeys(KEY_B, KEY_A);
      expect(decryptSecret(sealed, 'test')).toBe(SECRET);
    });

    it('cannot read it once the previous key is gone', () => {
      const sealed = encryptSecret(SECRET);
      useKeys(KEY_B);
      // Not silent, and not a wrong value — the operator is told the key
      // changed, which is recoverable, rather than handed garbage.
      expect(() => decryptSecret(sealed, 'gatekipa')).toThrow(/gatekipa/);
      expect(() => decryptSecret(sealed, 'gatekipa')).toThrow(/key has changed/);
    });

    it('explains that an encrypted value is not lost when no key is set', () => {
      const sealed = encryptSecret(SECRET);
      useKeys(undefined);
      expect(() => decryptSecret(sealed, 'test')).toThrow(/encrypted, not lost/);
    });
  });

  describe('legacy plaintext', () => {
    it('reads it back unchanged so existing tenants keep working', () => {
      // Turning encryption on must not break every row written before it.
      expect(decryptSecret('sk_written_before_encryption', 'legacy-row')).toBe(
        'sk_written_before_encryption'
      );
    });

    it('reads it even with no key configured at all', () => {
      useKeys(undefined);
      expect(decryptSecret('sk_plain', 'legacy-row')).toBe('sk_plain');
    });
  });

  describe('fingerprints', () => {
    it('shows enough to tell two keys apart and no more', () => {
      const printed = secretFingerprint('sk_abcdefghijklmnop');
      expect(printed).toBe('••••mnop');
      expect(printed).not.toContain('abcdefghijkl');
    });

    it('is empty for an absent secret', () => {
      expect(secretFingerprint('')).toBe('');
    });
  });
});

/**
 * An unreadable credential must say so, not answer "an unexpected error".
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * Found by probing the live deployment. Two unrelated endpoints answered
 *
 *   {"statusCode":500,"error":"Internal Server Error",
 *    "message":"An unexpected error occurred."}
 *
 * at the same time: Meta's webhook verification handshake, and the screen an
 * operator would use to diagnose it. One cause — a stored credential that
 * could not be decrypted — and from outside it was invisible.
 *
 * `decryptSecret` throws on three different faults, and over twenty
 * `with*Credentials` read sites do not guard it. That is the right design: a
 * path that cannot read its credential cannot continue. What was wrong is
 * what the caller was told. So the throw is a NAMED class and the catch-all
 * filter translates it once, rather than twenty try blocks each having to
 * remember to.
 */
describe('a credential that cannot be read', () => {
  const saved: Record<string, string | undefined> = {};
  const setKey = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const keyA = Buffer.alloc(32, 1).toString('base64');
  const keyB = Buffer.alloc(32, 2).toString('base64');

  it('throws SecretUnreadableError when no key is configured', () => {
    setKey('ENCRYPTION_KEY', keyA);
    const sealed = encryptSecret('EAAtoken');
    setKey('ENCRYPTION_KEY', undefined);
    setKey('ENCRYPTION_KEY_PREVIOUS', undefined);

    expect(() => decryptSecret(sealed, 'WhatsAppConfig abc.accessToken')).toThrow(SecretUnreadableError);
    // The subclass is kept, so existing callers that distinguish "no key"
    // from "wrong key" still can.
    expect(() => decryptSecret(sealed, 'WhatsAppConfig abc.accessToken')).toThrow(EncryptionKeyError);
  });

  it('throws SecretUnreadableError when the key has CHANGED', () => {
    setKey('ENCRYPTION_KEY', keyA);
    const sealed = encryptSecret('EAAtoken');
    setKey('ENCRYPTION_KEY', keyB);
    setKey('ENCRYPTION_KEY_PREVIOUS', undefined);

    expect(() => decryptSecret(sealed, 'WhatsAppConfig abc.accessToken')).toThrow(SecretUnreadableError);
    // NOT the key-missing subclass: a key is configured, it is the wrong one,
    // and those send an operator to different places.
    expect(() => decryptSecret(sealed, 'WhatsAppConfig abc.accessToken')).not.toThrow(EncryptionKeyError);
  });

  it('throws SecretUnreadableError on a malformed value', () => {
    setKey('ENCRYPTION_KEY', keyA);
    expect(() => decryptSecret('v1.only.two', 'WhatsAppConfig abc.accessToken')).toThrow(SecretUnreadableError);
  });

  it('still reads with ENCRYPTION_KEY_PREVIOUS after a rotation', () => {
    // The whole point of the previous key: a rotation must not black out
    // every credential at once.
    setKey('ENCRYPTION_KEY', keyA);
    const sealed = encryptSecret('EAAtoken');
    setKey('ENCRYPTION_KEY', keyB);
    setKey('ENCRYPTION_KEY_PREVIOUS', keyA);

    expect(decryptSecret(sealed, 'WhatsAppConfig abc.accessToken')).toBe('EAAtoken');
  });

  it('names the ROW in the message, and no secret material', () => {
    // The label is what tells an operator which credential to repair, and it
    // travels to the client in the 503. It must carry the model, the id and
    // the field — and never the key, the ciphertext or the plaintext.
    setKey('ENCRYPTION_KEY', keyA);
    const sealed = encryptSecret('EAAsupersecrettoken');
    setKey('ENCRYPTION_KEY', keyB);
    setKey('ENCRYPTION_KEY_PREVIOUS', undefined);

    let message = '';
    try {
      decryptSecret(sealed, 'WhatsAppConfig cfg_123.accessToken');
    } catch (err: any) {
      message = String(err?.message ?? '');
    }

    expect(message).toContain('WhatsAppConfig cfg_123.accessToken');
    expect(message).toMatch(/ENCRYPTION_KEY/);
    expect(message).not.toContain('EAAsupersecrettoken');
    expect(message).not.toContain(keyA);
    expect(message).not.toContain(keyB);
    expect(message).not.toContain(sealed);
  });
});
