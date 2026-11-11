import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, timingSafeEqual } from 'crypto';
import { prisma, encryptSecret, decryptSecret, recordAgencyAuditBestEffort } from '@ace/database';
import { matchTotp, newRecoveryCodes, newTotpSecret, otpauthUrl } from './totp';

export type MfaPurpose = 'mfa-login' | 'mfa-setup';

const sha256 = (s: string) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

/**
 * Multi-factor authentication for privileged users (PRD §17).
 *
 * ── The step token ──────────────────────────────────────────────────────────
 *
 * A correct password with MFA on does NOT produce a session. It produces a
 * ten-minute `mfa-login` token that can do exactly one thing: be exchanged,
 * with a code, for a session. It carries no organizationId, so both
 * JwtStrategy and the socket authenticator reject it as an access token, and
 * it carries tokenVersion, so signing out everywhere kills a half-finished
 * sign-in too.
 *
 * An agency that requires MFA gives its OWNER/ADMIN an `mfa-setup` token
 * instead until they enrol — enforcement at the door, not a banner they can
 * dismiss.
 *
 * ── Codes ───────────────────────────────────────────────────────────────────
 *
 * A TOTP code is accepted once: the step it matched is stored and anything at
 * or before it is refused, so a code read over a shoulder cannot be replayed
 * inside its 30 seconds. Wrong codes count toward the same account lockout as
 * wrong passwords. Recovery codes are stored only as hashes and are spent on
 * use. The secret is encrypted at rest with ENCRYPTION_KEY like every other
 * credential.
 */
@Injectable()
export class MfaService {
  constructor(private readonly jwt: JwtService) {}

  stepToken(user: { id: string; tokenVersion: number }, purpose: MfaPurpose): string {
    return this.jwt.sign({ userId: user.id, purpose, tokenVersion: user.tokenVersion }, { expiresIn: '10m' });
  }

  /** The user a step token names, if it is valid for `purpose`. */
  async userFromStepToken(token: string, purpose: MfaPurpose) {
    let payload: any;
    try {
      payload = this.jwt.verify(token);
    } catch {
      throw new UnauthorizedException('This sign-in has expired. Enter your email and password again.');
    }
    if (payload?.purpose !== purpose || !payload.userId) {
      throw new UnauthorizedException('This sign-in step is not valid. Enter your email and password again.');
    }
    const user = await prisma.user.findUnique({ where: { id: payload.userId }, include: { organization: true } });
    if (!user || !user.isActive || (payload.tokenVersion ?? 0) !== user.tokenVersion) {
      throw new UnauthorizedException('This sign-in is no longer valid. Enter your email and password again.');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('Too many failed attempts. Try again later, or reset your password.');
    }
    return user;
  }

  /**
   * Check a code (TOTP or recovery) for a user with MFA ON. Spends whatever it
   * matched. Returns false — never throws — so the caller counts the failure.
   */
  async consumeCode(user: { id: string; mfaSecret: string | null; mfaLastStep: number | null; mfaRecoveryHashes: string[] }, code: string): Promise<boolean> {
    if (!user.mfaSecret) return false;
    const secret = decryptSecret(user.mfaSecret, `User ${user.id}.mfaSecret`);
    const step = matchTotp(secret, code);
    if (step !== null) {
      // Conditional on the last step so two concurrent submissions of the same
      // code cannot both succeed.
      const { count } = await prisma.user.updateMany({
        where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
        data: { mfaLastStep: step },
      });
      return count === 1;
    }
    const hash = sha256(code);
    const match = user.mfaRecoveryHashes.find((h) => timingSafeEqual(Buffer.from(h), Buffer.from(hash)));
    if (!match) return false;
    await prisma.user.update({
      where: { id: user.id },
      data: { mfaRecoveryHashes: user.mfaRecoveryHashes.filter((h) => h !== match) },
    });
    return true;
  }

  async status(userId: string) {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { mfaEnabledAt: true, mfaRecoveryHashes: true, role: true, organization: { select: { requireAdminMfa: true } } },
    });
    return {
      enabled: !!u?.mfaEnabledAt,
      enabledAt: u?.mfaEnabledAt ?? null,
      recoveryCodesLeft: u?.mfaRecoveryHashes.length ?? 0,
      requiredByAgency: !!u?.organization.requireAdminMfa && (u?.role === 'OWNER' || u?.role === 'ADMIN'),
    };
  }

  /** Start enrolment: a new secret, held as PENDING until a code proves the app has it. */
  async beginEnrolment(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { organization: { select: { name: true } } } });
    if (!user) throw new UnauthorizedException();
    if (user.mfaEnabledAt) throw new BadRequestException('Two-step sign-in is already on. Turn it off first to change your authenticator.');
    const secret = newTotpSecret();
    await prisma.user.update({ where: { id: userId }, data: { mfaPendingSecret: encryptSecret(secret) } });
    return {
      secret,
      otpauthUrl: otpauthUrl(secret, user.email, `Citizen Care (${user.organization.name})`.slice(0, 60)),
    };
  }

  /** Finish enrolment with a code from the app. Returns recovery codes ONCE. */
  async completeEnrolment(userId: string, code: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mfaPendingSecret) throw new BadRequestException('Start setting up two-step sign-in first.');
    const secret = decryptSecret(user.mfaPendingSecret, `User ${user.id}.mfaPendingSecret`);
    const step = matchTotp(secret, code);
    if (step === null) throw new BadRequestException('That code does not match. Check the time on your phone is set automatically, and try the newest code.');
    const codes = newRecoveryCodes();
    await prisma.user.update({
      where: { id: userId },
      data: {
        mfaSecret: user.mfaPendingSecret,
        mfaPendingSecret: null,
        mfaEnabledAt: new Date(),
        mfaLastStep: step,
        mfaRecoveryHashes: codes.map(sha256),
      },
    });
    await recordAgencyAuditBestEffort({ userId, ipAddress: null }, user.organizationId, {
      action: 'auth.mfa.enabled',
      targetType: 'User',
      targetId: userId,
    });
    return { enabled: true, recoveryCodes: codes };
  }

  /** Turn it off — with a current code, and never while the agency requires it. */
  async disable(userId: string, code: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { organization: { select: { requireAdminMfa: true } } } });
    if (!user?.mfaEnabledAt) throw new BadRequestException('Two-step sign-in is not on.');
    if (user.organization.requireAdminMfa && (user.role === 'OWNER' || user.role === 'ADMIN')) {
      throw new ForbiddenException('Your agency requires two-step sign-in for administrators, so it cannot be turned off.');
    }
    if (!(await this.consumeCode(user, code))) throw new BadRequestException('That code does not match.');
    await prisma.user.update({
      where: { id: userId },
      data: { mfaSecret: null, mfaPendingSecret: null, mfaEnabledAt: null, mfaLastStep: null, mfaRecoveryHashes: [], tokenVersion: { increment: 1 } },
    });
    await recordAgencyAuditBestEffort({ userId, ipAddress: null }, user.organizationId, {
      action: 'auth.mfa.disabled',
      targetType: 'User',
      targetId: userId,
    });
    return { enabled: false };
  }
}
