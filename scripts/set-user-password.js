#!/usr/bin/env node
/**
 * Set a staff password directly at the database. The break-glass path.
 *
 * ── Why this has to exist ───────────────────────────────────────────────────
 *
 * Every route back into an account goes through EMAIL:
 *
 *   · `POST /api/auth/forgot-password` writes a reset token and emails the link;
 *   · `addTeamMember` creates an invited officer with an unusable password and
 *     emails a `/setup-account?token=…` link;
 *   · both tokens are stored only as SHA-256 hashes, so the raw token exists
 *     nowhere after the send.
 *
 * All of that is correct, and all of it depends on `RESEND_API_KEY` being set.
 * It is declared OPTIONAL in `env.validation.ts`, so a deployment boots
 * perfectly without it — and then nobody can register, be invited, verify an
 * address, or reset a password, while every one of those endpoints answers 200.
 * Nothing in the product can repair that, because the repair is itself an
 * email.
 *
 * So the recovery is bounded by who holds database credentials, exactly like
 * `npm run platform:grant`. That is a much smaller and much more deliberate
 * group than whoever can reach the login page.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   npm run user:password                          # list accounts — who can sign in
 *   npm run user:password -- <email>               # report what would change
 *   npm run user:password -- <email> --apply       # set a generated password
 *   echo -n 'the password' | npm run user:password -- <email> --apply --stdin
 *
 * Report-first, like every destructive script here: without --apply it changes
 * nothing. With --stdin the password is read from standard input rather than
 * argv, so it stays out of the process list and the shell history.
 */

const path = require('path');
const crypto = require('crypto');

require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 12;
const MIN_LENGTH = 8;

/** Readable, and well past guessing. Printed once, because nothing stores it. */
function generatePassword() {
  // No ambiguous glyphs: an operator reads this off a terminal and types it.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(24);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  // A symbol and a digit, so it satisfies any policy added later.
  return `${out.slice(0, 8)}-${out.slice(8, 16)}-${out.slice(16, 24)}`;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
    if (process.stdin.isTTY) resolve('');
  });
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const fromStdin = args.includes('--stdin');
  const email = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase();

  const prisma = new PrismaClient();

  try {
    if (!email) {
      // The listing is the point when an operator does not know WHICH account
      // to sign in as, which is the state a fresh deployment leaves them in.
      const users = await prisma.user.findMany({
        select: {
          email: true, fullName: true, role: true, isActive: true,
          emailVerifiedAt: true, isPlatformAdmin: true, lockedUntil: true,
          passwordResetToken: true, createdAt: true,
          organization: { select: { name: true, slug: true, suspendedAt: true } },
        },
        orderBy: [{ organizationId: 'asc' }, { createdAt: 'asc' }],
      });

      if (users.length === 0) {
        console.log('No users exist in this database.');
        console.log('');
        console.log('Register the first agency through the dashboard, or create one with');
        console.log('the platform tier. Nothing here can sign in yet.');
        return;
      }

      console.log(`${users.length} account(s):\n`);
      let currentOrg = null;
      for (const u of users) {
        const orgLabel = `${u.organization.name} (${u.organization.slug})${u.organization.suspendedAt ? ' — SUSPENDED' : ''}`;
        if (orgLabel !== currentOrg) {
          currentOrg = orgLabel;
          console.log(`── ${orgLabel}`);
        }
        const flags = [
          u.role,
          u.isActive ? 'active' : 'DEACTIVATED',
          u.emailVerifiedAt ? 'verified' : 'unverified',
          u.isPlatformAdmin ? 'PLATFORM OPERATOR' : null,
          u.lockedUntil && u.lockedUntil > new Date() ? 'LOCKED OUT' : null,
          // An invited officer who never completed setup cannot sign in with
          // any password, because the stored hash is of random bytes.
          u.passwordResetToken ? 'INVITE PENDING — cannot sign in yet' : null,
        ].filter(Boolean);
        console.log(`   ${u.email}  [${flags.join(', ')}]`);
      }
      console.log('');
      console.log('To set one of these passwords:');
      console.log('  npm run user:password -- <email>            # report');
      console.log('  npm run user:password -- <email> --apply    # set a generated one');
      return;
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true, email: true, fullName: true, role: true, isActive: true,
        emailVerifiedAt: true, lockedUntil: true, failedLoginAttempts: true,
        passwordResetToken: true,
        organization: { select: { name: true, slug: true, suspendedAt: true } },
      },
    });

    if (!user) {
      // Named plainly: this is an operator at a terminal with database
      // credentials, not an anonymous caller who must not learn whether an
      // address exists.
      console.error(`No account with the email ${email}.`);
      console.error('Run with no arguments to list every account in this database.');
      process.exitCode = 1;
      return;
    }

    console.log(`${user.email} — ${user.fullName}`);
    console.log(`  agency:   ${user.organization.name} (${user.organization.slug})`);
    console.log(`  role:     ${user.role}`);
    console.log(`  active:   ${user.isActive ? 'yes' : 'NO — login is refused regardless of password'}`);
    console.log(`  verified: ${user.emailVerifiedAt ? 'yes' : 'no (login still works; it only warns)'}`);
    if (user.organization.suspendedAt) {
      console.log('  agency is SUSPENDED — every request from its members is refused on arrival.');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      console.log(`  locked out until ${user.lockedUntil.toISOString()} — this clears it.`);
    }
    if (user.passwordResetToken) {
      console.log('  an invite or reset is outstanding — this consumes it.');
    }
    console.log('');

    let password;
    if (fromStdin) {
      password = await readStdin();
      if (!password) {
        console.error('--stdin was given but nothing arrived on standard input.');
        process.exitCode = 1;
        return;
      }
      if (password.length < MIN_LENGTH) {
        console.error(`That password is ${password.length} characters. The API requires at least ${MIN_LENGTH}.`);
        process.exitCode = 1;
        return;
      }
    } else {
      password = generatePassword();
    }

    if (!apply) {
      console.log('Report only — nothing was changed. To set the password:');
      console.log(`  npm run user:password -- ${email} --apply`);
      console.log(`  echo -n 'your password' | npm run user:password -- ${email} --apply --stdin`);
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        // Every outstanding session dies. Setting a password out of band is
        // what you do when you do not know who else holds one.
        tokenVersion: { increment: 1 },
        // An outstanding invite or reset token is spent: leaving it live means
        // a link in somebody's mailbox can still change this password.
        passwordResetToken: null,
        passwordResetExpiresAt: null,
        // Resetting is the documented way out of a lockout, so it must clear one.
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    console.log('Password set. Every existing session for this account is signed out.');
    if (!fromStdin) {
      console.log('');
      console.log(`  ${user.email}`);
      console.log(`  ${password}`);
      console.log('');
      console.log('Nothing stores this — it is a bcrypt hash in the database and this line');
      console.log('is the only copy. Sign in, change it, and clear your scrollback.');
    }
    if (!user.isActive) {
      console.log('');
      console.log('NOTE: this account is DEACTIVATED, so login is still refused. Reactivate it');
      console.log('from Settings → Team with an administrator account.');
    }
    if (user.organization.suspendedAt) {
      console.log('');
      console.log('NOTE: the agency is SUSPENDED, so every request is refused on arrival.');
      console.log('A platform operator lifts that; see `npm run platform:grant`.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('user:password failed:', err.message);
  process.exit(1);
});
