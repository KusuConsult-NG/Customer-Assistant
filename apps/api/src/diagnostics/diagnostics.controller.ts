import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser } from '@ace/shared-types';
import { ProviderHealthService } from './provider-health.service';

/**
 * Whether the providers this platform depends on actually answer.
 *
 * OWNER/ADMIN: the responses name which services are configured and quote
 * what each provider said when it refused. No credential value is returned
 * and nothing is written anywhere, but a refusal message can carry account
 * detail, so it is not for every member.
 *
 * It makes one outbound request per provider. That is the point — a check
 * that reads environment variables cannot tell a working key from a revoked
 * one, and every surface in this codebase was doing exactly that.
 */
@Controller('api/diagnostics')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DiagnosticsController {
  constructor(private readonly providers: ProviderHealthService) {}

  @Roles('OWNER', 'ADMIN')
  @Get('providers')
  async providerHealth(@Req() req: { user: AuthUser }) {
    return this.providers.check(req.user.organizationId);
  }
}
