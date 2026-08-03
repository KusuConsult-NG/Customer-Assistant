import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { JwtService } from '@nestjs/jwt';
import { prisma } from '@ace/database';

export interface AuthenticatedTenantRequest extends Request {
  tenantId?: string;
  user?: any;
}

@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly jwtService: JwtService) {}

  async use(req: AuthenticatedTenantRequest, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const payload = this.jwtService.decode(token) as any;
        if (payload && payload.organizationId) {
          req.tenantId = payload.organizationId;
          req.user = payload;

          // Set PostgreSQL session variable for Row-Level Security
          try {
            await (prisma as any).$executeRawUnsafe(
              `SET LOCAL app.current_organization_id = '${payload.organizationId}';`
            );
          } catch {
            // Ignore RLS session error if database user has superuser privileges
          }
        }
      } catch {
        // Token invalid or unparseable, continue as unauthenticated
      }
    }
    next();
  }
}
