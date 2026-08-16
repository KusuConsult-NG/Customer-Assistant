import { Injectable, UnauthorizedException, ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { prisma } from '@ace/database';
import { UserRole, IndustryType } from '@ace/shared-types';
import * as bcrypt from 'bcryptjs';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { Resend } from 'resend';

/**
 * bcrypt work factor. Kept in one place so every password write path (register,
 * invite, reset, change) uses the same cost — they previously ranged from 10 to 12.
 */
const BCRYPT_ROUNDS = 12;

/** Verification / invite / reset tokens live for this long. */
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;   // 24 hours
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;      // 30 minutes
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;     // 7 days

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class AuthService {
  constructor(private jwtService: JwtService) {}

  /**
   * Sends an email via Resend, returning whether it actually went out.
   * Returns false (and logs) when RESEND_API_KEY is unset so callers never report
   * "check your inbox" for mail that was never sent.
   */
  private async sendEmail(to: string, subject: string, html: string): Promise<boolean> {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      console.warn(`[AuthService] RESEND_API_KEY is not set — "${subject}" email to ${to} was NOT sent.`);
      return false;
    }
    try {
      await new Resend(resendKey).emails.send({
        from: process.env.EMAIL_FROM || 'Customer Care Agent <noreply@kusuconsult.com>',
        to,
        subject,
        html,
      });
      return true;
    } catch (err: any) {
      console.error(`[AuthService] Failed to send "${subject}" email:`, err?.message ?? err);
      return false;
    }
  }

  async registerOrganization(dto: {
    organizationName: string;
    industry: IndustryType;
    email: string;
    password: string;
    fullName: string;
    phone?: string;
    country?: string;
  }) {
    const email = dto.email.trim().toLowerCase();

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new ConflictException('A user with this email already exists.');
    }

    const slug = await this.generateUniqueSlug(dto.organizationName);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const rawToken = randomBytes(32).toString('hex');

    const organization = await prisma.organization.create({
      data: {
        name: dto.organizationName,
        slug,
        industry: dto.industry,
        phone: dto.phone,
        ...(dto.country ? { country: dto.country } : {}),
        aiPersonaPrompt: `You are the lead AI customer service representative for ${dto.organizationName}, operating in Nigeria. Be polite, professional, and speak clear Nigerian English.`,
        welcomeMessage: `Hello! Welcome to ${dto.organizationName}. How may I assist you today?`,
        users: {
          create: {
            email,
            passwordHash,
            fullName: dto.fullName,
            role: UserRole.OWNER,
            emailVerifyToken: sha256(rawToken),
            emailVerifyExpiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
          },
        },
      },
      include: { users: true },
    });

    const user = organization.users[0];

    const verifyUrl = `${process.env.WEB_BASE_URL || 'http://localhost:3000'}/verify-email?token=${rawToken}`;
    const emailSent = await this.sendEmail(
      user.email,
      'Verify your email for Customer Care Agent',
      `<p>Hi ${user.fullName},</p>
       <p>Please confirm your email address by clicking <a href="${verifyUrl}">this link</a>. It expires in 24 hours.</p>`
    );

    // Report what actually happened. Telling the user to "check your email" when no
    // mail provider is configured is the kind of silent failure that makes an
    // otherwise working sign-up look broken.
    return {
      message: emailSent
        ? 'Registration successful. Check your email to verify your account.'
        : 'Registration successful. Email delivery is not configured on this deployment, so no verification email was sent — you can sign in now.',
      emailSent,
      ...(emailSent || process.env.NODE_ENV === 'production' ? {} : { verifyUrl }),
    };
  }

  /**
   * Organization slugs are `@unique`. Deriving one from the name plus 4 digits of
   * Date.now() collides roughly once every 10 000 signups in the same millisecond
   * window and then throws a raw Prisma P2002. Retry with fresh entropy instead.
   */
  private async generateUniqueSlug(organizationName: string): Promise<string> {
    const base =
      organizationName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'org';

    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `${base}-${randomBytes(3).toString('hex')}`;
      const clash = await prisma.organization.findUnique({ where: { slug: candidate } });
      if (!clash) return candidate;
    }
    return `${base}-${randomBytes(8).toString('hex')}`;
  }

  async login(email: string, password: string) {
    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { organization: true },
    });

    // Per-account lockout.
    //
    // The IP rate limit on this route is a blunt ceiling: it cannot stop distributed
    // credential stuffing (which rotates addresses) and it penalises everyone behind
    // a shared NAT. Locking the *account* after repeated failures is the control that
    // actually matches the threat.
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      const seconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new UnauthorizedException(
        `Too many failed sign-in attempts. Try again in ${seconds} second${seconds === 1 ? '' : 's'}, ` +
        `or reset your password.`
      );
    }

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      if (user) await this.registerFailedLogin(user.id, user.failedLoginAttempts);
      // Identical message whether the account exists or the password is wrong.
      throw new UnauthorizedException('Invalid email or password credentials');
    }

    if (!user.isActive) throw new UnauthorizedException('Your account has been deactivated. Contact your organization admin.');

    // Successful sign-in clears the counter.
    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }

    const tokens = this.generateTokens(user, user.tokenVersion);

    const response: any = {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        organizationId: user.organizationId,
        organizationName: user.organization.name,
      },
      ...tokens,
    };

    if (!user.emailVerifiedAt && (Date.now() - user.createdAt.getTime()) > 5 * 60 * 1000) {
      response.warning = 'Please verify your email address.';
    }

    return response;
  }

  /**
   * Records a failed sign-in and applies progressive lockout.
   *
   * Thresholds are deliberately generous for the first few attempts — people
   * genuinely mistype passwords — then escalate sharply, so an online guessing
   * attack is reduced to a handful of tries per hour while a real user who fumbles
   * their password twice notices nothing.
   */
  private async registerFailedLogin(userId: string, currentAttempts: number): Promise<void> {
    const attempts = currentAttempts + 1;

    // attempts →   lockout
    //   1–4    →   none
    //   5      →   1 minute
    //   6      →   5 minutes
    //   7      →   15 minutes
    //   8+     →   1 hour
    let lockMs = 0;
    if (attempts >= 8) lockMs = 60 * 60_000;
    else if (attempts === 7) lockMs = 15 * 60_000;
    else if (attempts === 6) lockMs = 5 * 60_000;
    else if (attempts === 5) lockMs = 60_000;

    await prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: attempts,
        ...(lockMs > 0 ? { lockedUntil: new Date(Date.now() + lockMs) } : {}),
      },
    }).catch(() => {
      // Never let bookkeeping failure turn a 401 into a 500.
    });
  }

  /**
   * `tokenVersion` is embedded in both tokens and checked by JwtStrategy. Bumping the
   * column (logout, password change/reset) instantly invalidates every token already
   * issued for that user — previously /logout returned "Logged out successfully" while
   * the stolen or shared token stayed valid for its full 1-day / 7-day lifetime.
   */
  private generateTokens(
    user: { id: string; organizationId: string; email: string; fullName: string; role: string },
    tokenVersion: number
  ) {
    const payload = {
      userId: user.id,
      organizationId: user.organizationId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      tokenVersion,
    };
    const accessToken = this.jwtService.sign(payload, {
      expiresIn: process.env.JWT_ACCESS_TTL || '1d',
    });
    const refreshToken = this.jwtService.sign(payload, {
      secret: this.refreshSecret(),
      expiresIn: process.env.JWT_REFRESH_TTL || '7d',
    });

    return { accessToken, refreshToken };
  }

  /**
   * JWT_REFRESH_SECRET is a required variable (see config/env.validation.ts), so a
   * hardcoded fallback would only ever be reachable in a misconfigured build — where
   * it would silently make every deployment share the same signing key.
   */
  private refreshSecret(): string {
    const secret = process.env.JWT_REFRESH_SECRET;
    if (!secret) {
      throw new UnauthorizedException('Refresh tokens are not configured on this server.');
    }
    return secret;
  }

  async verifyEmail(token: string) {
    if (!token?.trim()) throw new BadRequestException('Verification token is required');

    const user = await prisma.user.findFirst({
      where: {
        emailVerifyToken: sha256(token),
        OR: [
          { emailVerifyExpiresAt: null },
          { emailVerifyExpiresAt: { gt: new Date() } },
        ],
      },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date(), emailVerifyToken: null, emailVerifyExpiresAt: null },
    });

    return { message: 'Email verified successfully.' };
  }

  async resendVerification(email: string) {
    const SAFE_RESPONSE = { message: 'If an account exists, a verification email has been sent.' };

    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || user.emailVerifiedAt) return SAFE_RESPONSE;

    const rawToken = randomBytes(32).toString('hex');

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifyToken: sha256(rawToken),
        emailVerifyExpiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
      },
    });

    const verifyUrl = `${process.env.WEB_BASE_URL || 'http://localhost:3000'}/verify-email?token=${rawToken}`;
    await this.sendEmail(
      user.email,
      'Verify your email for Customer Care Agent',
      `<p>Hi ${user.fullName},</p>
       <p>Please confirm your email address by clicking <a href="${verifyUrl}">this link</a>. It expires in 24 hours.</p>`
    );

    return SAFE_RESPONSE;
  }

  async refreshToken(refreshTokenStr: string) {
    try {
      const payload = this.jwtService.verify(refreshTokenStr, { secret: this.refreshSecret() });
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        include: { organization: true },
      });
      if (!user) throw new UnauthorizedException('User no longer exists');
      if (!user.isActive) throw new UnauthorizedException('Your account has been deactivated. Contact your organization admin.');
      if ((payload.tokenVersion ?? 0) !== user.tokenVersion) {
        throw new UnauthorizedException('This session has been signed out. Please log in again.');
      }

      const tokens = this.generateTokens(user, user.tokenVersion);
      return {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          organizationId: user.organizationId,
          organizationName: user.organization.name,
        },
        ...tokens,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  /**
   * Forgot Password — Send Reset Email
   *
   * Security properties:
   *  1. Always returns the same message whether or not the email exists (prevents user enumeration).
   *  2. Generates a 32-byte cryptographically random token (256 bits — unguessable).
   *  3. Stores only the SHA-256 HASH of the token in DB — never the raw token.
   *     If the DB is ever breached, the raw tokens cannot be extracted from hashes.
   *  4. Token expires in 30 minutes.
   *  5. Email is sent via Resend (RESEND_API_KEY in .env). Falls back gracefully if not configured.
   */
  async forgotPassword(email: string) {
    const SAFE_RESPONSE = { message: 'If an account exists for this email, password reset instructions have been sent.' };

    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user) return SAFE_RESPONSE;

    // Generate secure token
    const rawToken = randomBytes(32).toString('hex');

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: sha256(rawToken),
        passwordResetExpiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    });

    const resetUrl = `${process.env.WEB_BASE_URL ?? 'http://localhost:3000'}/reset-password?token=${rawToken}`;

    const sent = await this.sendEmail(
      user.email,
      'Reset your Customer Care Agent password',
      `
        <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px;">
          <h2 style="color:#3b82f6;">Reset your password</h2>
          <p>Hi ${user.fullName},</p>
          <p>We received a request to reset your Customer Care Agent password. Click the button below to set a new password. This link expires in <strong>30 minutes</strong>.</p>
          <a href="${resetUrl}"
             style="display:inline-block;background:#3b82f6;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">
            Reset Password
          </a>
          <p style="color:#6b7280;font-size:14px;">If you didn't request this, ignore this email — your password won't change.</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
          <p style="color:#9ca3af;font-size:12px;">ACE Customer Intelligence Platform</p>
        </div>
      `
    );

    if (!sent && process.env.NODE_ENV !== 'production') {
      console.warn(`[DEV] Password reset link (email delivery unavailable):\n${resetUrl}`);
    }

    return SAFE_RESPONSE;
  }

  /**
   * Reset Password — Consume the reset token and set a new password.
   *
   * The token is the credential: it is 256 bits of CSPRNG entropy stored only as a
   * SHA-256 hash, so the lookup is by hash alone. Requiring a matching `email` in
   * addition (as the previous version did) added no security but broke every reset
   * link whose email had different casing or URL-encoding than the stored address.
   * When an email is supplied it is still cross-checked.
   *
   * Clears the token fields and bumps tokenVersion so a password reset also signs
   * out every existing session — which is the whole point of resetting a password
   * you believe was compromised.
   */
  async resetPassword(token: string, newPassword: string, email?: string) {
    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: sha256(token),
        passwordResetExpiresAt: { gt: new Date() }, // not expired
      },
    });

    if (!user || (email && user.email !== email.trim().toLowerCase())) {
      throw new BadRequestException('Invalid or expired password reset token. Please request a new reset link.');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS),
        passwordResetToken: null,
        passwordResetExpiresAt: null,
        tokenVersion: { increment: 1 },
        // Resetting the password is the documented way out of a lockout, so it must
        // actually clear one.
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    return { message: 'Password reset successfully. You can now log in with your new password.' };
  }

  /**
   * Completes account setup for an invited team member.
   *
   * OrganizationsService.addTeamMember creates the user with an unusable random
   * password and a 7-day invite token (stored in passwordResetToken), then emails a
   * /setup-account?token=… link. Until now there was no endpoint behind that link,
   * so invited members could never sign in at all.
   *
   * Setting a password here also marks the address verified — clicking a link that
   * was only delivered to that mailbox proves control of it.
   */
  async setupAccount(token: string, password: string) {
    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: sha256(token),
        passwordResetExpiresAt: { gt: new Date() },
      },
      include: { organization: true },
    });

    if (!user) {
      throw new BadRequestException(
        'This invitation link is invalid or has expired. Ask an administrator to re-send your invite.'
      );
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        passwordResetToken: null,
        passwordResetExpiresAt: null,
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        isActive: true,
        tokenVersion: { increment: 1 },
      },
    });

    const tokens = this.generateTokens(updated, updated.tokenVersion);

    return {
      message: 'Account activated successfully.',
      user: {
        id: updated.id,
        email: updated.email,
        fullName: updated.fullName,
        role: updated.role,
        organizationId: updated.organizationId,
        organizationName: user.organization.name,
      },
      ...tokens,
    };
  }

  /** Invalidates every access and refresh token previously issued to this user. */
  async logout(userId: string) {
    await prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    return { message: 'Logged out successfully.' };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS),
        tokenVersion: { increment: 1 },
      },
    });

    // Changing a password signs out other sessions, so hand the caller fresh tokens
    // rather than logging them out of the tab they are currently using.
    return {
      message: 'Password changed successfully. All other sessions have been signed out.',
      ...this.generateTokens(updated, updated.tokenVersion),
    };
  }

  /** Invite TTL, exported for OrganizationsService so both sides agree. */
  static readonly INVITE_TTL_MS = INVITE_TTL_MS;
}
