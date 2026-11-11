import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser } from '@ace/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { actorFrom } from '../common/actor';
import { CasesService } from './cases.service';

export class MoveStageDto {
  @IsIn(['RECEIVED', 'CLASSIFIED', 'ASSIGNED', 'UNDER_REVIEW', 'ACTION_IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED'])
  stage!: string;
  @IsOptional() @IsString() @MaxLength(4000) outcome?: string;
  @IsOptional() @IsString() @MaxLength(4000) note?: string;
}
export class AssignDto {
  @IsOptional() @IsString() userId?: string | null;
}
export class ClassifyDto {
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsString() @MaxLength(60) lga?: string;
  @IsOptional() @IsString() @MaxLength(120) ward?: string;
  @IsOptional() @IsString() @MaxLength(120) community?: string;
  @IsOptional() @IsString() @MaxLength(200) responsibleMda?: string;
  @IsOptional() @IsString() @MaxLength(4000) summary?: string;
  @IsOptional() @IsString() dueAt?: string;
  @IsOptional() @IsIn(['LOW', 'MEDIUM', 'HIGH', 'URGENT']) priority?: string;
  @IsOptional() @IsBoolean() isSensitive?: boolean;
}
export class NoteDto {
  @IsString() @MaxLength(4000) body!: string;
}
export class ReferDto {
  @IsString() @MaxLength(200) mdaName!: string;
  @IsOptional() @IsString() @MaxLength(200) liaisonName?: string;
  @IsOptional() @IsString() @MaxLength(200) liaisonContact?: string;
  @IsOptional() @IsString() liaisonUserId?: string;
  @IsOptional() @IsString() @MaxLength(4000) note?: string;
  @IsOptional() @IsString() dueAt?: string;
}
export class ReferralResponseDto {
  @IsIn(['ACKNOWLEDGED', 'RESPONDED', 'DECLINED']) status!: string;
  @IsOptional() @IsString() @MaxLength(4000) response?: string;
}
export class NotifiedDto {
  @IsString() @MaxLength(60) channel!: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

/**
 * Citizen cases (PRD §10) and MDA referrals (§15). Visibility rules live in
 * the service, in the query itself. Writes are OWNER/ADMIN/AGENT — front-desk
 * work, like scheduling; a VIEWER can read only.
 */
@Controller('api/cases')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Get()
  list(
    @Req() req: { user: AuthUser },
    @Query('stage') stage?: string,
    @Query('category') category?: string,
    @Query('lga') lga?: string,
    @Query('mda') mda?: string,
    @Query('overdue') overdue?: string,
    @Query('mine') mine?: string,
  ) {
    return this.cases.list(req.user, { stage, category, lga, mda, overdue: overdue === 'true', mine: mine === 'true' });
  }

  @Get('summary')
  summary(@Req() req: { user: AuthUser }) {
    return this.cases.summary(req.user);
  }

  @Get(':id')
  get(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.cases.get(req.user, id);
  }

  @Roles('OWNER', 'ADMIN', 'AGENT')
  @Post(':id/stage')
  stage(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() b: MoveStageDto) {
    return this.cases.moveStage(req.user, actorFrom(req), id, b.stage, b.outcome, b.note);
  }

  @Roles('OWNER', 'ADMIN', 'AGENT')
  @Post(':id/assign')
  assign(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() b: AssignDto) {
    return this.cases.assign(req.user, id, b.userId ?? null);
  }

  @Roles('OWNER', 'ADMIN', 'AGENT')
  @Post(':id/classify')
  classify(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() b: ClassifyDto) {
    return this.cases.classify(req.user, id, b);
  }

  @Roles('OWNER', 'ADMIN', 'AGENT')
  @Post(':id/notes')
  note(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() b: NoteDto) {
    return this.cases.addNote(req.user, id, b.body);
  }

  @Roles('OWNER', 'ADMIN', 'AGENT')
  @Post(':id/refer')
  refer(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() b: ReferDto) {
    return this.cases.refer(req.user, actorFrom(req), id, b);
  }

  @Roles('OWNER', 'ADMIN', 'AGENT')
  @Post('referrals/:referralId/respond')
  respond(@Req() req: { user: AuthUser }, @Param('referralId') id: string, @Body() b: ReferralResponseDto) {
    return this.cases.respondToReferral(req.user, id, b);
  }

  @Roles('OWNER', 'ADMIN', 'AGENT')
  @Post(':id/citizen-notified')
  notified(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() b: NotifiedDto) {
    return this.cases.recordCitizenNotified(req.user, id, b);
  }
}
