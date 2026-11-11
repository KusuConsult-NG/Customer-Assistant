import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { AuthUser } from '@ace/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { actorFrom } from '../common/actor';
import { BudgetService } from './budget.service';

export class CreateBudgetDocumentDto {
  @IsString() @MaxLength(300) title!: string;
  @IsIn([
    'APPROPRIATION_LAW', 'PROPOSED_BUDGET', 'SUPPLEMENTARY_BUDGET', 'REVISED_APPROPRIATION',
    'CITIZENS_BUDGET', 'IMPLEMENTATION_REPORT', 'AUDITED_STATEMENT', 'PROCUREMENT_PLAN', 'OTHER',
  ])
  documentType!: string;
  @Type(() => Number) @IsInt() @Min(1990) @Max(2100) fiscalYear!: number;
  @IsOptional() @IsString() @MaxLength(1000) sourceUrl?: string;
  @IsOptional() @IsString() publishedAt?: string;
  @IsOptional() @IsString() @MaxLength(60) reportingPeriod?: string;
  @IsOptional() @IsString() @MaxLength(40) declaredTotal?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

export class CsvImportDto {
  /** CSV text, header row first. 5 MB is far beyond any budget's line items. */
  @IsString() @MaxLength(5_000_000) csv!: string;
}

export class WithdrawDto {
  @IsString() @MaxLength(1000) reason!: string;
}

/**
 * Budget documents and the project register.
 *
 * Reading is open to any member: an officer on a call needs the figure the
 * citizen is about to hear. Writing and approving are OWNER/ADMIN, and the
 * service refuses approval by the uploader.
 */
@Controller('api/budget')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BudgetController {
  constructor(private readonly budget: BudgetService) {}

  @Get('documents')
  list(@Req() req: { user: AuthUser }) {
    return this.budget.listDocuments(req.user.organizationId);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('documents')
  create(@Req() req: { user: AuthUser }, @Body() body: CreateBudgetDocumentDto) {
    return this.budget.createDocument(req.user.organizationId, req.user.userId, body);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('documents/:id/lines')
  importLines(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: CsvImportDto) {
    return this.budget.importLines(req.user.organizationId, id, body.csv);
  }

  @Get('documents/:id/validation')
  validate(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.budget.validate(req.user.organizationId, id);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('documents/:id/approve')
  approve(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.budget.approve(req.user.organizationId, id, actorFrom(req));
  }

  @Roles('OWNER', 'ADMIN')
  @Post('documents/:id/withdraw')
  withdraw(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: WithdrawDto) {
    return this.budget.withdraw(req.user.organizationId, id, actorFrom(req), body.reason);
  }

  @Get('facets')
  facets(@Req() req: { user: AuthUser }) {
    return this.budget.facets(req.user.organizationId);
  }

  @Get('query')
  query(
    @Req() req: { user: AuthUser },
    @Query('year') year: string,
    @Query('stage') stage?: string,
    @Query('mda') mda?: string,
    @Query('sector') sector?: string,
  ) {
    return this.budget.query(req.user.organizationId, { year: Number(year), stage, mda, sector });
  }

  // ── Projects ─────────────────────────────────────────────────────────────

  @Get('projects')
  projects(@Req() req: { user: AuthUser }) {
    return this.budget.listProjects(req.user.organizationId);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('projects/import')
  importProjects(@Req() req: { user: AuthUser }, @Body() body: CsvImportDto) {
    return this.budget.importProjects(req.user.organizationId, req.user.userId, body.csv);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('projects/:id/approve')
  approveProject(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.budget.approveProject(req.user.organizationId, id, actorFrom(req));
  }

  @Get('observations')
  observations(@Req() req: { user: AuthUser }) {
    return this.budget.listObservations(req.user.organizationId);
  }

  @Roles('OWNER', 'ADMIN', 'AGENT')
  @Post('observations/:id/referred')
  referred(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.budget.markObservationReferred(req.user.organizationId, id);
  }
}
