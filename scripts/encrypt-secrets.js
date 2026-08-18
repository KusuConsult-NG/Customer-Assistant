#!/usr/bin/env node
/**
 * Encrypt credentials that are still stored in the clear.
 *
 *   node scripts/encrypt-secrets.js            # report only, changes nothing
 *   node scripts/encrypt-secrets.js --apply    # rewrite them
 *
 * Every read path already tolerates a plaintext value and warns about it on
 * every single read, so nothing breaks before this runs — but the warnings do
 * not stop until it does. That is deliberate: an unencrypted credential should
 * be noisy, and the noise should be finite.
 *
 * ── Rotation ────────────────────────────────────────────────────────────────
 *
 * This also re-encrypts anything readable only by ENCRYPTION_KEY_PREVIOUS. To
 * rotate: set ENCRYPTION_KEY to the new key, move the old one to
 * ENCRYPTION_KEY_PREVIOUS, run this with --apply, then remove the previous key.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 *
 * Only HostedAgentConfig.apiKey today. TelephonyConfig.authToken/apiSecret and
 * WhatsAppConfig.accessToken are also plaintext and also worth encrypting, but
 * they sit on the live telephony and messaging paths — moving them is its own
 * change, with its own way of breaking a tenant's phone line, and it is not
 * something to fold in quietly here.
 */
const path = require('path');

require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));

const SECRET_BOX = path.join(__dirname, '..', 'apps', 'api', 'dist', 'common', 'secret-box.js');

let box;
try {
  box = require(SECRET_BOX);
} catch (err) {
  console.error(
    'Could not load the encryption helper. Build the API first:\n\n' +
      '  npx turbo run build --filter=@ace/api...\n\n' +
      `(${err.message})`
  );
  process.exit(1);
}

const { encryptSecret, decryptSecret, isEncrypted, encryptionAvailable } = box;
const { PrismaClient } = require('@prisma/client');

async function main() {
  const apply = process.argv.includes('--apply');

  if (!encryptionAvailable()) {
    console.error(
      'ENCRYPTION_KEY is not set, so nothing can be encrypted.\n\n' +
        '  Generate one:  openssl rand -base64 32\n\n' +
        'Set it in the environment this API runs in, then re-run. Keep it — a\n' +
        'lost key means the stored credentials cannot be read back, and every\n' +
        'affected tenant needs a fresh key from ElevenLabs.'
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const configs = await prisma.hostedAgentConfig.findMany({
      where: { apiKey: { not: null } },
      select: { organizationId: true, apiKey: true, organization: { select: { slug: true } } },
    });

    const plaintext = [];
    const staleKey = [];
    const unreadable = [];

    for (const config of configs) {
      if (!isEncrypted(config.apiKey)) {
        plaintext.push(config);
        continue;
      }
      // Readable with the current key? Then it is already where it should be.
      // Readable only with the previous key? Then it needs re-encrypting.
      try {
        const previous = process.env.ENCRYPTION_KEY_PREVIOUS;
        delete process.env.ENCRYPTION_KEY_PREVIOUS;
        try {
          decryptSecret(config.apiKey, config.organizationId);
        } finally {
          if (previous !== undefined) process.env.ENCRYPTION_KEY_PREVIOUS = previous;
        }
      } catch {
        try {
          decryptSecret(config.apiKey, config.organizationId);
          staleKey.push(config);
        } catch {
          unreadable.push(config);
        }
      }
    }

    console.log(`\nHostedAgentConfig.apiKey — ${configs.length} row(s) with a key set\n`);
    console.log(`  already encrypted with the current key : ${
      configs.length - plaintext.length - staleKey.length - unreadable.length
    }`);
    console.log(`  stored in the clear                    : ${plaintext.length}`);
    console.log(`  encrypted with the PREVIOUS key        : ${staleKey.length}`);
    console.log(`  unreadable with either key             : ${unreadable.length}`);

    for (const config of unreadable) {
      // Reported, never "fixed". Overwriting an unreadable value would destroy
      // a credential that the right key could still recover.
      console.log(
        `\n  ! ${config.organization?.slug ?? config.organizationId} has a key that neither\n` +
          `    ENCRYPTION_KEY nor ENCRYPTION_KEY_PREVIOUS can decrypt. Left untouched —\n` +
          `    find the key that wrote it, or replace the credential via\n` +
          `    POST /api/agent-provisioning/credentials.`
      );
    }

    const todo = [...plaintext, ...staleKey];
    if (todo.length === 0) {
      console.log('\nNothing to do.\n');
      return;
    }

    if (!apply) {
      console.log(`\n${todo.length} row(s) would be rewritten. Re-run with --apply to do it.\n`);
      return;
    }

    let done = 0;
    for (const config of todo) {
      const value = isEncrypted(config.apiKey)
        ? decryptSecret(config.apiKey, config.organizationId)
        : config.apiKey;

      await prisma.hostedAgentConfig.update({
        where: { organizationId: config.organizationId },
        data: { apiKey: encryptSecret(value) },
      });
      done++;
    }

    console.log(`\nRewrote ${done} row(s).\n`);
    if (staleKey.length > 0) {
      console.log('ENCRYPTION_KEY_PREVIOUS can now be removed from the environment.\n');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
