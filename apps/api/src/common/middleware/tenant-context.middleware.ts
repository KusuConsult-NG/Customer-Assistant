import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { JwtService } from '@nestjs/jwt';
import { prisma } from '@ace/database';

export interface AuthenticatedTenantRequest extends Request {
  tenantId?: string;
  user?: any;
}

/**
 * TenantContextMiddleware — sets req.tenantId (and a PostgreSQL RLS session
 * variable) from the caller's JWT.
 *
 * NOT currently applied to any module (no consumer calls
 * `configure(consumer)` with it). It is kept because it documents the intended
 * Row-Level Security design, but two landmines in the original version are
 * fixed so future wiring can't resurrect them:
 *
 *  1. It used jwtService.decode() — decode does NOT verify the signature, so
 *     any self-crafted token could impersonate any organizationId.
 *     → now uses verify() with the configured JWT secret.
 *
 *  2. It string-interpolated organizationId into $executeRawUnsafe — a SQL
 *     injection vector (the value came from an unverified token, see #1).
 *     → now uses a parameterized set_config() call.
 *
 * NOTE for future RLS work: SET LOCAL only lasts for the current transaction,
 * and Prisma runs queries on a pooled connection — setting a session variable
 * here does NOT reliably scope subsequent queries. Real RLS enforcement needs
 * prisma.$transaction wrapping (set_config + query inside one transaction) or
 * a Prisma client extension. Until then, tenant scoping is enforced in
 * application code via organizationId WHERE clauses.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly jwtService: JwtService) {}

  async use(req: AuthenticatedTenantRequest, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        // verify(), not decode(): decode() skips signature validation entirely.
        const payload = this.jwtService.verify(token) as any;
        if (payload && payload.organizationId) {
          req.tenantId = payload.organizationId;
          req.user = payload;

          // Parameterized — never interpolate token-derived values into SQL.
          try {
            await prisma.$executeRaw`SELECT set_config('app.current_organization_id', ${payload.organizationId}, true)`;
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
