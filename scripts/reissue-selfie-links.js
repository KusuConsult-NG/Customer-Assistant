#!/usr/bin/env node
/**
 * Re-issue selfie upload links that were stored in the clear.
 *
 *   node scripts/reissue-selfie-links.js            # report only, changes nothing
 *   node scripts/reissue-selfie-links.js --apply    # re-mint them
 *
 * ── Why these links must be replaced, not just protected ────────────────────
 *
 * `SelfieRequest.tokenHash` holds a SHA-256 so that reading the table does not
 * yield a working link. `uploadUrl` beside it held the whole link — and the
 * link ENDS IN THE RAW TOKEN, so hashing the token back out of the stored URL
 * reproduced the stored hash exactly. Anyone who could read that table held a
 * working one-time upload link for every pending request.
 *
 * That column is encrypted now. Encryption protects links written AFTER the
 * fix; it does nothing for the ones already written, whose tokens have been
 * sitting in a readable column for as long as they have existed. Those have to
 * be replaced.
 *
 * ── What re-minting does ────────────────────────────────────────────────────
 *
 * For each affected row: a fresh token, its hash, and the new URL encrypted.
 * The OLD token stops working the moment the hash changes — that is the point,
 * and it is also the cost: whoever holds the old link can no longer use it.
 *
 * So this does NOT deliver the new link. Delivery needs the tenant's own
 * WhatsApp or Twilio credentials and belongs on the tested path that mints and
 * sends together — `POST /api/onboarding/selfie-requests` — which supersedes
 * the pending request and messages the customer. This script's job is to make
 * the exposed tokens useless and to tell you exactly who now needs a new link.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 *
 * PENDING rows only, with a plaintext `uploadUrl`.
 *
 *   - already encrypted (`v1.…`) → written after the fix, nothing to do
 *   - CANCELLED / EXPIRED / COMPLETED → the token is already dead; re-minting
 *     would churn rows for no gain and lose the record of what was sent
 *
 * A row with no uploadUrl at all is untouched: nothing was ever stored to leak.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'apps/api/dist/config/load-env.js'));

const { randomBytes } = require('crypto');
const {
  prisma,
  hashSelfieToken,
  selfieUploadUrl,
  sealUploadUrl,
  encryptionAvailable,
} = require(path.join(ROOT, 'packages/database/dist/index.js'));

const APPLY = process.argv.includes('--apply');

const C = { b: '\x1b[1m', dim: '\x1b[2m', g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', x: '\x1b[0m' };

async function main() {
  console.log(`\n${C.b}Selfie links stored in the clear${C.x}`);
  console.log(
    `${C.dim}${APPLY ? 'Re-minting' : 'Report only — pass --apply to re-mint'}${C.x}\n`
  );

  if (APPLY && !encryptionAvailable()) {
    console.error(
      `${C.r}ENCRYPTION_KEY is not set (or is not 32 bytes).${C.x}\n` +
      `Re-minting without it would write the replacement links in the clear too — ` +
      `which is the problem this exists to fix. Refusing.\n`
    );
    process.exit(1);
  }

  // Plaintext is anything that is not our `v1.<iv>.<tag>.<ciphertext>` envelope.
  const exposed = await prisma.selfieRequest.findMany({
    where: {
      status: 'PENDING',
      uploadUrl: { not: null },
      NOT: { uploadUrl: { startsWith: 'v1.' } },
    },
    select: {
      id: true,
      organizationId: true,
      contactId: true,
      channel: true,
      createdAt: true,
      expiresAt: true,
      contact: { select: { fullName: true, phoneNumber: true } },
      organization: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (exposed.length === 0) {
    console.log(`${C.g}Nothing to do — no pending request has a plaintext upload link.${C.x}\n`);
    return;
  }

  console.log(`${exposed.length} pending request(s) whose token has been readable in the database:\n`);

  let reminted = 0;
  const stillNeedALink = [];

  for (const row of exposed) {
    const age = Math.floor((Date.now() - row.createdAt.getTime()) / 86_400_000);
    const who = `${row.contact?.fullName ?? 'unknown'} ${C.dim}(${row.contact?.phoneNumber ?? 'no number'})${C.x}`;
    const where = row.organization?.name ?? row.organizationId;

    if (!APPLY) {
      console.log(`  ${C.y}would re-mint${C.x}  ${who}  ${C.dim}${where} · ${row.channel} · ${age}d old${C.x}`);
      stillNeedALink.push(row);
      continue;
    }

    const token = randomBytes(32).toString('base64url');
    try {
      await prisma.selfieRequest.update({
        where: { id: row.id },
        data: {
          tokenHash: hashSelfieToken(token),
          uploadUrl: sealUploadUrl(selfieUploadUrl(token)),
        },
      });
      reminted++;
      stillNeedALink.push(row);
      console.log(`  ${C.g}re-minted${C.x}     ${who}  ${C.dim}${where} · ${row.channel} · ${age}d old${C.x}`);
    } catch (err) {
      console.log(`  ${C.r}FAILED${C.x}        ${who}  ${C.dim}${err.message}${C.x}`);
    }
  }

  console.log();
  if (APPLY) {
    console.log(`${C.g}${reminted} link(s) re-minted. The old tokens no longer resolve.${C.x}`);
  } else {
    console.log(`${C.y}Nothing was changed.${C.x}`);
  }

  // The part that is easy to skip and must not be.
  console.log(
    `\n${C.b}These people are now holding a link that does not work.${C.x}\n` +
    `${C.dim}Re-minting makes the exposed token useless; it does not tell anyone.\n` +
    `Send each of them a fresh link through the path that mints AND delivers:\n\n` +
    `  POST /api/onboarding/selfie-requests  { "contactId": "…" }\n\n` +
    `That supersedes the pending request and messages the customer on their channel.${C.x}\n`
  );

  for (const row of stillNeedALink) {
    console.log(`  contactId=${row.contactId}  ${C.dim}${row.contact?.fullName ?? ''} · ${row.channel}${C.x}`);
  }
  console.log();
}

main()
  .catch((err) => {
    console.error(`\n${C.r}${err.stack || err.message}${C.x}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
