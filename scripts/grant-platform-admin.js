#!/usr/bin/env node
/**
 * Grant or revoke platform-operator status.
 *
 * This is the ONLY way `User.isPlatformAdmin` is ever set, and it is a script
 * rather than an endpoint on purpose.
 *
 * Platform-operator status is the one thing in this system that crosses the
 * agency boundary every other query respects. An endpoint that granted it —
 * however well guarded — would mean the set of people who can read across every
 * ministry in the State is editable by whoever holds a session token. Requiring
 * direct database access instead means granting it needs the credentials to
 * operate the database, which is a much smaller and much more deliberate group.
 *
 * There is deliberately no bootstrap path in the application either: a fresh
 * deployment has no platform operator until somebody with database access
 * creates one.
 *
 * Usage:
 *   node scripts/grant-platform-admin.js                      # list current operators
 *   node scripts/grant-platform-admin.js <email>              # report what would change
 *   node scripts/grant-platform-admin.js <email> --apply      # grant
 *   node scripts/grant-platform-admin.js <email> --revoke --apply
 *
 * Report-first, like every other destructive script in this repository: without
 * --apply it tells you what it would do and changes nothing.
 */

const path = require('path');
const fs = require('fs');

// Load .env the same way the other scripts do — parsed as text, never executed,
// because a password containing ( ) * ! or a space is legal in a .env and a
// syntax error in a shell.
const ROOT = path.resolve(__dirname, '..');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    if (process.env[k] === undefined) {
      process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
}

const { prisma } = require('@ace/database');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const revoke = args.includes('--revoke');
const email = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase();

async function listOperators() {
  const operators = await prisma.user.findMany({
    where: { isPlatformAdmin: true },
    select: {
      id: true, email: true, fullName: true, isActive: true,
      organization: { select: { name: true } },
    },
    orderBy: { email: 'asc' },
  });

  if (operators.length === 0) {
    console.log('\nNo platform operators exist.');
    console.log('Nobody can currently see across agencies — /api/platform/* refuses every caller.\n');
    return;
  }

  console.log(`\n${operators.length} platform operator(s):\n`);
  for (const o of operators) {
    const state = o.isActive ? '' : '  [DEACTIVATED]';
    console.log(`  ${o.email}  —  ${o.fullName}  (${o.organization?.name ?? 'no agency'})${state}`);
  }
  console.log('');
}

async function main() {
  if (!email) {
    await listOperators();
    console.log('To grant:  node scripts/grant-platform-admin.js <email> --apply');
    console.log('To revoke: node scripts/grant-platform-admin.js <email> --revoke --apply\n');
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true, email: true, fullName: true, isActive: true, isPlatformAdmin: true,
      organization: { select: { name: true } },
    },
  });

  if (!user) {
    console.error(`\nNo user with email "${email}".`);
    console.error('A platform operator must already be a user of some agency — create the account first.\n');
    process.exitCode = 1;
    return;
  }

  const target = !revoke;

  console.log(`\n  user:     ${user.email}  (${user.fullName})`);
  console.log(`  agency:   ${user.organization?.name ?? 'none'}`);
  console.log(`  active:   ${user.isActive}`);
  console.log(`  operator: ${user.isPlatformAdmin}  →  ${target}`);

  if (user.isPlatformAdmin === target) {
    console.log('\nAlready in that state. Nothing to do.\n');
    return;
  }

  if (!user.isActive && target) {
    console.log('\nNOTE: this account is deactivated, so the grant will have no effect until it is');
    console.log('reactivated — JwtStrategy refuses a deactivated user before any guard runs.');
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply to make this change.\n');
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { isPlatformAdmin: target } });

  // Audited like every platform action. The actor is the script rather than a
  // user id, because this is executed by whoever holds database credentials and
  // the system cannot know which person that was.
  await prisma.auditLog.create({
    data: {
      organizationId: null,
      actor: 'system:grant-platform-admin',
      action: target ? 'platform.operator.granted' : 'platform.operator.revoked',
      targetType: 'User',
      targetId: user.id,
      previousValue: { isPlatformAdmin: user.isPlatformAdmin },
      newValue: { isPlatformAdmin: target, email: user.email },
    },
  });

  console.log(`\n${target ? 'GRANTED' : 'REVOKED'}. Takes effect on this user's next request —`);
  console.log('JwtStrategy reads the flag from the database, not from their token.\n');
}

main()
  .catch((e) => {
    if (e?.code === 'P2021') {
      console.error('\nThe users table does not exist. Run `npm run db:push` first.\n');
    } else {
      console.error('\n', e?.message ?? e, '\n');
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
