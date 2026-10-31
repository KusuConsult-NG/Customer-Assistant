import { Controller, Get, Post, Patch, Delete, Body, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CatalogueService, type OptionInput, type LocationInput } from './catalogue.service';
import { AuthUser } from '@ace/shared-types';
import { actorFrom } from '../common/actor';

/**
 * The agency's own services and locations.
 *
 * Reading is open to any signed-in member — an officer taking a call needs to
 * know what the agency offers. Writing is OWNER/ADMIN: these rows decide what
 * the AI offers citizens and where it sends them, which is not a change an
 * agent should make mid-conversation.
 *
 * Guard order is load-bearing: RolesGuard reads request.user, so JwtAuthGuard
 * must run first. Nest runs them global → controller → route.
 */
@Controller('api/catalogue')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  /** The State's LGAs, so the editor offers them instead of free text. */
  @Get('lgas')
  lgas() {
    return this.catalogue.lgas();
  }

  // ── Services ──────────────────────────────────────────────────────────────

  @Get('services')
  listServices(@Req() req: { user: AuthUser }) {
    return this.catalogue.listOptions(req.user.organizationId);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('services')
  createService(@Req() req: { user: AuthUser }, @Body() body: OptionInput) {
    return this.catalogue.createOption(req.user.organizationId, body);
  }

  @Roles('OWNER', 'ADMIN')
  @Patch('services/:id')
  updateService(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: Partial<OptionInput>
  ) {
    return this.catalogue.updateOption(req.user.organizationId, id, body);
  }

  @Roles('OWNER', 'ADMIN')
  @Delete('services/:id')
  deleteService(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.catalogue.deleteOption(req.user.organizationId, id, actorFrom(req));
  }

  // ── Locations ─────────────────────────────────────────────────────────────

  @Get('locations')
  listLocations(@Req() req: { user: AuthUser }) {
    return this.catalogue.listLocations(req.user.organizationId);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('locations')
  createLocation(@Req() req: { user: AuthUser }, @Body() body: LocationInput) {
    return this.catalogue.createLocation(req.user.organizationId, body);
  }

  @Roles('OWNER', 'ADMIN')
  @Patch('locations/:id')
  updateLocation(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: Partial<LocationInput>
  ) {
    return this.catalogue.updateLocation(req.user.organizationId, id, body);
  }

  @Roles('OWNER', 'ADMIN')
  @Delete('locations/:id')
  deleteLocation(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.catalogue.deleteLocation(req.user.organizationId, id, actorFrom(req));
  }
}
