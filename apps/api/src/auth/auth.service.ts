import { Injectable, UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { prisma } from '@ace/database';
import { UserRole, IndustryType } from '@ace/shared-types';
import * as bcrypt from 'bcryptjs';
import { randomBytes, createHash } from 'crypto';
import { Resend } from 'resend';

@Injectable()
export class AuthService {
  constructor(private jwtService: JwtService) {}

  async registerOrganization(dto: {
    organizationName: string;
    industry: IndustryType;
    email: string;
    password: string;
    fullName: string;
    phone?: string;
  }) {
    const existingUser = await prisma.user.findUnique({ where: { email: dto.email } });
    if (existingUser) {
      throw new ConflictException('A user with this email already exists.');
    }

    const slug = dto.organizationName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now().toString().slice(-4);
    const passwordHash = await bcrypt.hash(dto.password, 10);

    const organization = await prisma.organization.create({
      data: {
        name: dto.organizationName,
        slug,
        industry: dto.industry,
        phone: dto.phone,
        aiPersonaPrompt: `You are the lead AI customer service representative for ${dto.organizationName}, operating in Nigeria. Be polite, professional, and speak clear Nigerian English.`,
        welcomeMessage: `Hello! Welcome to ${dto.organizationName}. How may I assist you today?`,
        users: {
          create: {
            email: dto.email,
            passwordHash,
            fullName: dto.fullName,
            role: UserRole.OWNER,
          },
        },
      },
      include: { users: true },
    });

    const user = organization.users[0];
    const tokens = this.generateTokens(user.id, organization.id, user.email, user.fullName, user.role as any);

    return {
      organization: { id: organization.id, name: organization.name, slug: organization.slug },
      user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
      ...tokens,
    };
  }

  async login(email: string, password: string) {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { organization: true },
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password credentials');
    }

    const tokens = this.generateTokens(user.id, user.organizationId, user.email, user.fullName, user.role as any);

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
  }

  private generateTokens(userId: string, organizationId: string, email: string, fullName: string, role: UserRole) {
    const payload = { userId, organizationId, email, fullName, role };
    const accessToken = this.jwtService.sign(payload, { expiresIn: '1d' });
    const refreshToken = this.jwtService.sign(payload, {
      secret: process.env.JWT_REFRESH_SECRET || 'super_secret_ace_platform_refresh_key_2026',
      expiresIn: '7d',
    });

    return { accessToken, refreshToken };
  }

  async refreshToken(refreshTokenStr: string) {
    try {
      const payload = this.jwtService.verify(refreshTokenStr, {
        secret: process.env.JWT_REFRESH_SECRET || 'super_secret_ace_platform_refresh_key_2026',
      });
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        include: { organization: true },
      });
      if (!user) throw new UnauthorizedException('User no longer exists');

      const tokens = this.generateTokens(user.id, user.organizationId, user.email, user.fullName, user.role as any);
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

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return SAFE_RESPONSE;

    // Generate secure token
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: tokenHash,
        passwordResetExpiresAt: expiresAt,
      },
    });

    const resetUrl = `${process.env.WEB_BASE_URL ?? 'http://localhost:3000'}/reset-password?token=${rawToken}&email=${encodeURIComponent(email)}`;

    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      // In development, log the reset URL to the console if Resend is not configured.
      console.warn(`[DEV] Password reset link (no email sent — add RESEND_API_KEY to .env):\n${resetUrl}`);
      return SAFE_RESPONSE;
    }

    const resend = new Resend(resendKey);
    await resend.emails.send({
      from: process.env.EMAIL_FROM ?? 'ACE Platform <noreply@yourace.com>',
      to: email,
      subject: 'Reset your ACE Platform password',
      html: `
        <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px;">
          <h2 style="color:#3b82f6;">Reset your password</h2>
          <p>Hi ${user.fullName},</p>
          <p>We received a request to reset your ACE Platform password. Click the button below to set a new password. This link expires in <strong>30 minutes</strong>.</p>
          <a href="${resetUrl}"
             style="display:inline-block;background:#3b82f6;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">
            Reset Password
          </a>
          <p style="color:#6b7280;font-size:14px;">If you didn't request this, ignore this email — your password won't change.</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
          <p style="color:#9ca3af;font-size:12px;">ACE Customer Intelligence Platform</p>
        </div>
      `,
    }).catch((err: any) => {
      console.error('Failed to send password reset email via Resend:', err?.message ?? err);
    });

    return SAFE_RESPONSE;
  }

  /**
   * Reset Password — Consume the reset token and set a new password.
   *
   * Validates token hash match + expiry before allowing password change.
   * Clears the token fields after successful reset (single-use token).
   */
  async resetPassword(email: string, token: string, newPassword: string) {
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const user = await prisma.user.findFirst({
      where: {
        email,
        passwordResetToken: tokenHash,
        passwordResetExpiresAt: { gt: new Date() }, // not expired
      },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired password reset token. Please request a new reset link.');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetToken: null,
        passwordResetExpiresAt: null,
      },
    });

    return { message: 'Password reset successfully. You can now log in with your new password.' };
  }
}
