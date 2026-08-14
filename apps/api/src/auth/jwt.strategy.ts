import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { prisma } from '@ace/database';
import { AuthUser } from '@ace/shared-types';
import { getJwtSecret } from './jwt-secrets';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(),
    });
  }

  /**
   * Runs on every authenticated request after signature/expiry verification.
   *
   * Rechecks the user in the database so account state changes take effect
   * immediately instead of at token expiry (up to 24h later):
   *   - deactivated users (isActive=false) lose access on their next request,
   *   - role changes (e.g. ADMIN demoted to AGENT) apply on the next request —
   *     the DB role wins over whatever the token was minted with,
   *   - deleted users are rejected outright.
   *
   * Cost: one indexed primary-key SELECT per request. If this ever shows up in
   * profiles, replace with a short-TTL in-memory cache or a tokenVersion claim —
   * do not remove the staleness check itself.
   */
  async validate(payload: any): Promise<AuthUser> {
    if (!payload.userId || !payload.organizationId) {
      throw new UnauthorizedException('Invalid JWT payload');
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, organizationId: true, email: true, fullName: true, role: true, isActive: true },
    });

    if (!user) throw new UnauthorizedException('User no longer exists');
    if (!user.isActive) {
      throw new UnauthorizedException('Your account has been deactivated. Contact your organization admin.');
    }

    return {
      userId: user.id,
      organizationId: user.organizationId,
      email: user.email,
      fullName: user.fullName,
      role: user.role as any,
    };
  }
}
