#!/usr/bin/env node
/**
 * Apply each agency's retention period (PRD §18 "retention/deletion schedules").
 *
 *   node scripts/apply-retention.js            # report only: what WOULD be removed
 *   node scripts/apply-retention.js --apply    # remove it
 *
 * For every agency with `retentionDays` set, message text, call transcripts and
 * call recordings older than that many days are REMOVED — replaced with a
 * marker, not deleted as rows — so the record that a conversation or call
 * happened (and every dashboard and report built on it) survives, while what
 * the citizen said does not. An agency with no period set is left alone.
 *
 * Deliberately a script, report-first, like contacts:dedupe and
 * secrets:encrypt: removing citizens' words is irreversible and should be an
 * act somebody chose to perform, with the counts in front of them, not a
 * nightly side effect nobody looked at. Schedule it once the report has been
 * read and the period agreed with the agency's data-protection officer.
 *
 * Every applied run writes an AuditLog entry per agency with the counts.
 */
const path = require('path');
require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));
const { PrismaClient } = require('@prisma/client');

const MARKER = '[removed under the agency’s retention policy]';

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  try {
    const orgs = await prisma.organization.findMany({
      where: { retentionDays: { not: null } },
      select: { id: true, name: true, retentionDays: true },
    });
    if (!orgs.length) {
      console.log('No agency has a retention period set. Nothing to do.');
      return;
    }
    let total = 0;
    for (const org of orgs) {
      const cutoff = new Date(Date.now() - org.retentionDays * 86_400_000);
      const msgWhere = { conversation: { organizationId: org.id }, sentAt: { lt: cutoff }, NOT: { content: MARKER } };
      const callWhere = {
        organizationId: org.id,
        startedAt: { lt: cutoff },
        OR: [{ transcript: { not: null } }, { recordingUrl: { not: null } }],
      };
      const [messages, calls] = await Promise.all([prisma.message.count({ where: msgWhere }), prisma.callLog.count({ where: callWhere })]);
      total += messages + calls;
      console.log(`${org.name}: keep ${org.retentionDays} days (before ${cutoff.toISOString().slice(0, 10)}) — ${messages} message(s), ${calls} call transcript/recording(s)`);
      if (!apply || messages + calls === 0) continue;
      await prisma.$transaction([
        prisma.message.updateMany({ where: msgWhere, data: { content: MARKER, mediaUrl: null } }),
        prisma.callLog.updateMany({ where: callWhere, data: { transcript: null, recordingUrl: null } }),
        prisma.auditLog.create({
          data: {
            organizationId: org.id,
            actor: 'system:retention',
            action: 'retention.applied',
            targetType: 'Organization',
            targetId: org.id,
            newValue: { retentionDays: org.retentionDays, cutoff: cutoff.toISOString(), messages, calls },
          },
        }),
      ]);
      console.log('  applied.');
    }
    if (!apply && total > 0) console.log('\nReport only. Re-run with --apply to remove the above.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
