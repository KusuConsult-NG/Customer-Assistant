#!/usr/bin/env node
/**
 * Collapse contacts that are the same person under a different phone format.
 *
 *   node scripts/merge-duplicate-contacts.js            # report only
 *   node scripts/merge-duplicate-contacts.js --apply    # merge them
 *
 * Lookups now match across every shape a number might be stored in, so the
 * platform behaves correctly WITHOUT running this — a caller is found whether
 * their row says `+2348012345678` or `2348012345678`. What it cannot do on its
 * own is decide which of two matching rows is the real one, and `findFirst`
 * will happily return the empty duplicate while the bookings sit on the other.
 *
 * That is what this fixes, and why it is a separate deliberate step rather than
 * something the application does quietly at runtime: merging customer records
 * destroys one of them, and nothing that destructive should happen as a side
 * effect of somebody answering a phone.
 *
 * ── How a survivor is chosen ────────────────────────────────────────────────
 *
 * The oldest row wins. It is the one most likely to be referenced by other
 * systems, exports and links, and it is the one whose id anybody who has looked
 * at this customer before already has. Its `fullName` and `email` are kept
 * unless they are empty and a duplicate has one — a placeholder like
 * "WhatsApp Contact (···5678)" loses to a real name.
 *
 * ── What moves ─────────────────────────────────────────────────────────────
 *
 * Everything: leads, deals, tickets, conversations, call logs, bookings,
 * reservations, notes and selfie requests. A merge that leaves a booking
 * pointing at a deleted contact is worse than the duplicate.
 *
 * Conversations are the awkward one — `@@unique([organizationId, contactId,
 * channel])` means the survivor may already have a thread on the same channel.
 * Those get their MESSAGES moved into the survivor's thread and the empty
 * duplicate conversation removed, so no history is lost and no constraint is
 * violated.
 */
const path = require('path');

require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));

const DB = path.join(__dirname, '..', 'packages', 'database', 'dist', 'index.js');
let normalizePhoneNumber;
try {
  ({ normalizePhoneNumber } = require(DB));
} catch (err) {
  console.error(
    'Could not load @ace/database. Build it first:\n\n' +
      '  npx turbo run build --filter=@ace/database\n\n' +
      `(${err.message})`
  );
  process.exit(1);
}

const { PrismaClient } = require('@prisma/client');

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();

  try {
    const contacts = await prisma.contact.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        organizationId: true,
        phoneNumber: true,
        fullName: true,
        email: true,
        createdAt: true,
      },
    });

    // Group by tenant + canonical number. Two rows in the same group are the
    // same human recorded twice.
    const groups = new Map();
    for (const contact of contacts) {
      const canonical = normalizePhoneNumber(contact.phoneNumber);
      const key = `${contact.organizationId}::${canonical}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(contact);
    }

    const duplicates = [...groups.entries()].filter(([, rows]) => rows.length > 1);

    console.log(`\n${contacts.length} contact(s) across all organizations`);
    console.log(`${duplicates.length} number(s) recorded more than once\n`);

    if (duplicates.length === 0) {
      console.log('Nothing to merge.\n');
      return;
    }

    for (const [key, rows] of duplicates) {
      const canonical = key.split('::')[1];
      const [survivor, ...losers] = rows; // oldest first, from the orderBy
      console.log(`  ${canonical}`);
      console.log(`    keep  ${survivor.id}  ${survivor.phoneNumber}  "${survivor.fullName}"`);
      for (const loser of losers) {
        console.log(`    merge ${loser.id}  ${loser.phoneNumber}  "${loser.fullName}"`);
      }
    }

    if (!apply) {
      console.log(`\nReport only. Re-run with --apply to merge.\n`);
      return;
    }

    let merged = 0;
    for (const [, rows] of duplicates) {
      const [survivor, ...losers] = rows;

      for (const loser of losers) {
        await prisma.$transaction(async (tx) => {
          // Conversations first: the unique constraint on
          // [organizationId, contactId, channel] means a straight reassign can
          // collide with a thread the survivor already has.
          const survivorThreads = await tx.conversation.findMany({
            where: { contactId: survivor.id },
            select: { id: true, channel: true },
          });
          const byChannel = new Map(survivorThreads.map((c) => [c.channel, c.id]));

          for (const thread of await tx.conversation.findMany({
            where: { contactId: loser.id },
            select: { id: true, channel: true },
          })) {
            const existing = byChannel.get(thread.channel);
            if (existing) {
              // Move the messages, then drop the now-empty thread. Losing a
              // customer's messages to a constraint would be the worst possible
              // outcome of a tidy-up.
              await tx.message.updateMany({
                where: { conversationId: thread.id },
                data: { conversationId: existing },
              });
              await tx.conversation.delete({ where: { id: thread.id } });
            } else {
              await tx.conversation.update({
                where: { id: thread.id },
                data: { contactId: survivor.id },
              });
              byChannel.set(thread.channel, thread.id);
            }
          }

          for (const model of [
            'lead',
            'deal',
            'ticket',
            'callLog',
            'booking',
            'reservation',
            'note',
            'selfieRequest',
          ]) {
            await tx[model].updateMany({
              where: { contactId: loser.id },
              data: { contactId: survivor.id },
            });
          }

          // A real name beats a generated placeholder.
          const looksGenerated = (name) =>
            !name || /^(Caller|WhatsApp Contact|Valued Customer)\b/.test(name);
          const data = {};
          if (looksGenerated(survivor.fullName) && !looksGenerated(loser.fullName)) {
            data.fullName = loser.fullName;
          }
          if (!survivor.email && loser.email) data.email = loser.email;
          if (Object.keys(data).length > 0) {
            await tx.contact.update({ where: { id: survivor.id }, data });
          }

          await tx.contact.delete({ where: { id: loser.id } });
        });
        merged++;
      }

      // Finally put the survivor on the canonical number, so the next lookup
      // hits it directly rather than through the variant list.
      const canonical = normalizePhoneNumber(survivor.phoneNumber);
      if (canonical !== survivor.phoneNumber) {
        await prisma.contact
          .update({ where: { id: survivor.id }, data: { phoneNumber: canonical } })
          .catch((err) => {
            // A collision here means another contact already holds the
            // canonical number in this org — report it rather than failing the
            // whole run, since every merge before this one is already done.
            console.log(
              `  ! could not canonicalise ${survivor.id}: ${err.code ?? err.message}`
            );
          });
      }
    }

    console.log(`\nMerged ${merged} duplicate contact(s).\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
