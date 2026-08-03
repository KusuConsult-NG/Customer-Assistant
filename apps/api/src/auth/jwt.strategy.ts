import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthUser } from '@ace/shared-types';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'super_secret_ace_platform_jwt_key_2026_change_in_prod',
    });
  }

  async validate(payload: any): Promise<AuthUser> {
    if (!payload.userId || !payload.organizationId) {
      throw new UnauthorizedException('Invalid JWT payload');
    }
    return {
      userId: payload.userId,
      organizationId: payload.organizationId,
      email: payload.email,
      fullName: payload.fullName,
      role: payload.role,
    };
  }
}
