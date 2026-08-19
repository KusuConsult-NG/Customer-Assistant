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
 * Every provider credential this platform stores:
 *
 *   HostedAgentConfig.apiKey            ElevenLabs workspace key
 *   TelephonyConfig.authToken/apiKey/apiSecret   Twilio
 *   WhatsAppConfig.accessToken/webhookVerifyToken   Meta
 *
 * Not accountSid, phoneNumberId or whatsappBusinessId: those identify accounts
 * rather than opening them, and being able to read them in a database console
 * is worth more than hiding them.
 *
 * CalendarIntegration.accessToken/refreshToken are also plaintext columns, and
 * are deliberately left alone — no code in this repo reads or writes that model
 * at all, so encrypting it would be ceremony over a table nothing uses.
 */
const path = require('path');

require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));

const SECRET_BOX = path.join(__dirname, '..', 'packages', 'database', 'dist', 'secret-box.js');

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
    let totalTodo = 0;
    let totalUnreadable = 0;

    /**
     * One model's worth of credential columns.
     *
     * `state()` classifies without changing anything, which is what makes the
     * default run safe to point at production: the report is a read.
     */
    const state = (value) => {
      if (!isEncrypted(value)) return 'plaintext';
      const previous = process.env.ENCRYPTION_KEY_PREVIOUS;
      delete process.env.ENCRYPTION_KEY_PREVIOUS;
      try {
        decryptSecret(value, 'probe');
        return 'current';
      } catch {
        return 'other';
      } finally {
        if (previous !== undefined) process.env.ENCRYPTION_KEY_PREVIOUS = previous;
      }
    };

    const sweep = async ({ label, rows, idOf, fields, update }) => {
      const counts = { current: 0, plaintext: 0, previous: 0, unreadable: 0 };
      const todo = [];

      for (const row of rows) {
        const changes = {};
        for (const field of fields) {
          const value = row[field];
          if (!value) continue;
          const kind = state(value);
          if (kind === 'current') { counts.current++; continue; }
          if (kind === 'plaintext') { counts.plaintext++; changes[field] = value; continue; }
          // Encrypted, but not by the current key. Readable with the previous
          // one means it needs re-encrypting; readable with neither means the
          // right key is missing and the value must be LEFT ALONE — overwriting
          // would destroy a credential the correct key could still recover.
          try {
            changes[field] = decryptSecret(value, `${label} ${idOf(row)}.${field}`);
            counts.previous++;
          } catch {
            counts.unreadable++;
            console.log(
              `\n  ! ${label} ${idOf(row)}.${field} cannot be decrypted with either key.\n` +
                '    Left untouched. Find the key that wrote it, or re-enter the credential.'
            );
          }
        }
        if (Object.keys(changes).length > 0) todo.push({ row, changes });
      }

      console.log(`\n${label}`);
      console.log(`  already encrypted with the current key : ${counts.current}`);
      console.log(`  stored in the clear                    : ${counts.plaintext}`);
      console.log(`  encrypted with the PREVIOUS key        : ${counts.previous}`);
      console.log(`  unreadable with either key             : ${counts.unreadable}`);

      totalTodo += todo.length;
      totalUnreadable += counts.unreadable;

      if (apply) {
        for (const { row, changes } of todo) {
          const sealed = {};
          for (const [field, plain] of Object.entries(changes)) sealed[field] = encryptSecret(plain);
          await update(row, sealed);
        }
        if (todo.length > 0) console.log(`  → rewrote ${todo.length} row(s)`);
      }
    };

    await sweep({
      label: 'HostedAgentConfig.apiKey',
      rows: await prisma.hostedAgentConfig.findMany({ where: { apiKey: { not: null } } }),
      idOf: (r) => r.organizationId,
      fields: ['apiKey'],
      update: (row, data) =>
        prisma.hostedAgentConfig.update({ where: { organizationId: row.organizationId }, data }),
    });

    await sweep({
      label: 'TelephonyConfig (authToken, apiKey, apiSecret)',
      rows: await prisma.telephonyConfig.findMany(),
      idOf: (r) => r.id,
      fields: ['authToken', 'apiKey', 'apiSecret'],
      update: (row, data) => prisma.telephonyConfig.update({ where: { id: row.id }, data }),
    });

    await sweep({
      label: 'WhatsAppConfig (accessToken, webhookVerifyToken)',
      rows: await prisma.whatsAppConfig.findMany(),
      idOf: (r) => r.id,
      fields: ['accessToken', 'webhookVerifyToken'],
      update: (row, data) => prisma.whatsAppConfig.update({ where: { id: row.id }, data }),
    });

    console.log('');
    if (totalTodo === 0) {
      console.log('Nothing to do.\n');
    } else if (!apply) {
      console.log(`${totalTodo} row(s) would be rewritten. Re-run with --apply to do it.\n`);
    } else {
      console.log(`Done. ${totalTodo} row(s) rewritten.\n`);
      console.log('ENCRYPTION_KEY_PREVIOUS can be removed once this reports nothing to do.\n');
    }
    if (totalUnreadable > 0) {
      console.log(`${totalUnreadable} value(s) were left untouched because neither key could read them.\n`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
