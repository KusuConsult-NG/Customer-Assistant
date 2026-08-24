#!/usr/bin/env node
/**
 * Lists coverage that was activated without a verified payment.
 *
 *   node scripts/audit-unverified-enrollments.js
 *
 * READ-ONLY. There is no `--apply`, on purpose. This reports on people's health
 * insurance and on money they may or may not have paid; deciding what to do
 * about any given row is not something a script should do unattended, and the
 * rows it finds are not all fraud — see below.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Until #49, `POST /api/public/pay/confirm` was unauthenticated, unscoped
 * across tenants, and took the payment reference and the amount from the
 * request body. It contacted no payment gateway at all: the reference was
 * minted in the browser as `PAY-PLS-${Date.now()}-${Math.random()}` and the
 * server wrote `paymentStatus: 'PAID'` and `enrollmentStatus:
 * 'ENROLLED_ACTIVE'` on the strength of it. See PRODUCTION_READINESS_AUDIT.md,
 * DEF-01.
 *
 * So for every enrollment made through that path there is, by construction, no
 * transaction to reconcile against — not because the money went missing, but
 * because nothing ever asked a gateway. This script produces that population.
 *
 * ── Read the output correctly ──────────────────────────────────────────────
 *
 * A row here is NOT evidence that somebody cheated. Legitimate enrollees who
 * paid at a desk, or who went through the broken online path in good faith,
 * appear exactly the same as someone who called the endpoint directly — that
 * indistinguishability IS the defect. What the list gives you is the complete
 * set of coverage whose payment cannot be confirmed from our own records, which
 * is the population to reconcile against PLASCHEMA's bank and Paystack
 * settlement reports.
 *
 * ── Running it against production is the point ──────────────────────────────
 *
 * Unlike the test harness and `scripts/verify-all.sh`, this does not refuse a
 * hosted DATABASE_URL. Those refuse because they WRITE — they create real
 * organizations through the real API, and once left 358 test organizations in
 * the live CRM. This only reads, and the live CRM is the only place the answer
 * exists.
 */
const path = require('path');

require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));

const { PrismaClient } = require('@prisma/client');

/** References the browser used to mint. None of these has a gateway transaction. */
const BROWSER_MINTED = /^(PAY|EQUITY)-PLS-\d+-\d+$/;

const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`;

async function main() {
  const prisma = new PrismaClient();
  let paymentsTableExists = true;

  try {
    // Does the post-#49 schema exist here at all? The Render build runs
    // `prisma generate` but not `db push`, so a deployment can be running the
    // new code against a database that has neither table. That is worth
    // reporting as its own finding rather than crashing on.
    try {
      await prisma.payment.count();
    } catch (err) {
      if (err?.code === 'P2021' || /does not exist/i.test(err?.message ?? '')) {
        paymentsTableExists = false;
      } else {
        throw err;
      }
    }

    const contacts = await prisma.contact.findMany({
      where: { tags: { hasSome: ['paid-enrollee', 'enrolled-active'] } },
      select: {
        id: true,
        organizationId: true,
        fullName: true,
        phoneNumber: true,
        tags: true,
        metadata: true,
        createdAt: true,
        organization: { select: { name: true, slug: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Every reference we can actually prove, in one query rather than per row.
    const verified = new Set();
    if (paymentsTableExists) {
      const rows = await prisma.payment.findMany({
        where: { status: 'SUCCEEDED' },
        select: { gatewayReference: true },
      });
      for (const r of rows) verified.add(r.gatewayReference);
    }

    const unverified = [];
    let confirmed = 0;

    for (const c of contacts) {
      const meta = c.metadata || {};
      const ref = meta.paymentReference || meta.lastPaymentReference || null;

      if (ref && verified.has(ref)) {
        confirmed += 1;
        continue;
      }

      unverified.push({
        contact: c,
        reference: ref,
        amount: meta.paidAmount ?? null,
        paidAt: meta.paidAt ?? null,
        status: meta.paymentStatus ?? null,
        reason: !ref
          ? 'marked enrolled with no payment reference at all'
          : BROWSER_MINTED.test(ref)
            ? 'reference was generated in the browser — no gateway transaction exists'
            : 'reference has no matching settled payment',
      });
    }

    // ── Report ────────────────────────────────────────────────────────────
    console.log('');
    console.log('Coverage activated without a verifiable payment');
    console.log('═'.repeat(72));

    if (!paymentsTableExists) {
      console.log('');
      console.log('  ⚠  The `payments` table does not exist in this database.');
      console.log('     `npm run db:push` has not been run here since #49, so there is no');
      console.log('     record any enrollment could be reconciled against, and the new');
      console.log('     payment path would fail outright if a citizen used it.');
    }

    if (contacts.length === 0) {
      console.log('');
      console.log('  No contact is tagged paid-enrollee or enrolled-active.');
      console.log('  Nothing was enrolled through the online path on this database.');
      console.log('');
      return;
    }

    const byOrg = new Map();
    for (const u of unverified) {
      const key = u.contact.organization?.slug || u.contact.organizationId;
      if (!byOrg.has(key)) byOrg.set(key, []);
      byOrg.get(key).push(u);
    }

    for (const [slug, rows] of byOrg) {
      const org = rows[0].contact.organization;
      console.log('');
      console.log(`  ${org?.name ?? slug}  (${slug})`);
      console.log('  ' + '─'.repeat(70));
      for (const r of rows) {
        console.log(`    ${r.contact.fullName || '(no name)'}  ${r.contact.phoneNumber}`);
        console.log(`      contact    ${r.contact.id}`);
        console.log(`      reference  ${r.reference ?? '(none)'}`);
        console.log(`      claimed    ${r.amount == null ? '(not recorded)' : naira(r.amount)}   ${r.paidAt ?? ''}`);
        console.log(`      why        ${r.reason}`);
      }
    }

    const claimed = unverified.reduce((sum, u) => sum + Number(u.amount || 0), 0);

    console.log('');
    console.log('═'.repeat(72));
    console.log(`  enrolled contacts examined     ${contacts.length}`);
    console.log(`  payment confirmed by gateway   ${confirmed}`);
    console.log(`  NOT confirmed                  ${unverified.length}`);
    console.log(`  total claimed but unverified   ${naira(claimed)}`);
    console.log('');

    if (unverified.length > 0) {
      console.log('  These are not proof that anyone cheated. Somebody who paid at a desk');
      console.log('  and somebody who called the endpoint directly look identical here —');
      console.log('  that indistinguishability is the defect. Reconcile this list against');
      console.log('  PLASCHEMA\'s bank records and the Paystack settlement report before');
      console.log('  treating any single row as anything.');
      console.log('');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('');
  console.error('  Could not complete the audit:', err.message);
  console.error('');
  console.error('  If this is a missing-table error, build and generate first:');
  console.error('    npx turbo run build && npm run db:generate');
  console.error('');
  process.exit(1);
});
