import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthUser } from '@ace/shared-types';
import { prisma } from '@ace/database';

/**
 * JWT_SECRET is validated as required at startup (config/env.validation.ts).
 * Reading it once here — with no fallback — guarantees that a deployment which
 * somehow bypasses that check fails loudly instead of quietly signing every
 * token with a publicly-known default string.
 */
function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set. Refusing to start the JWT strategy with a default secret.');
  }
  return secret;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret(),
    });
  }

  /**
   * The signature and expiry are already verified by passport-jwt at this point.
   * We additionally re-check the user against the database on every request so that:
   *
   *   - deactivating a member (isActive=false) takes effect immediately rather than
   *     whenever their token happens to expire, up to a day later;
   *   - logout / password change / password reset genuinely revoke outstanding
   *     tokens, via the tokenVersion counter;
   *   - a token naming a deleted user cannot keep addressing that organization.
   *
   * This is one primary-key lookup per authenticated request.
   */
  async validate(payload: any): Promise<AuthUser> {
    if (!payload?.userId || !payload?.organizationId) {
      throw new UnauthorizedException('Invalid JWT payload');
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        organizationId: true,
        tokenVersion: true,
      },
    });

    if (!user) throw new UnauthorizedException('User no longer exists');
    if (!user.isActive) throw new UnauthorizedException('Your account has been deactivated.');
    if ((payload.tokenVersion ?? 0) !== user.tokenVersion) {
      throw new UnauthorizedException('This session has been signed out. Please log in again.');
    }

    // Source role and organization from the database, not from the token: a role
    // change must take effect at once, and it must not be possible to widen access
    // by holding on to a token minted before a demotion.
    return {
      userId: user.id,
      organizationId: user.organizationId,
      email: user.email,
      fullName: user.fullName,
      role: user.role as AuthUser['role'],
    };
  }
}
