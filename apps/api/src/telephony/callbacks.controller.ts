import {
  Controller, Get, Post, Patch, Body, Param, Query, Req, UseGuards, BadRequestException,
  ConflictException, BadGatewayException,
} from '@nestjs/common';
import { isPlatformOperator } from '../common/agency-audience';
import { prisma, callbackReference, normalizePhoneNumber, phoneNumberVariants, outboundContactHoursFrom, nextServiceTime, nextAttemptAt } from '@ace/database';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser } from '@ace/shared-types';
import { CallbackDispatcherService } from './callback-dispatcher.service';
import { InfobipVoiceService, INFOBIP_OUTBOUND_REASON } from './infobip/infobip-voice.service';
import { outboundLineFor } from './outbound-line';
import { clientIdentityFor } from './browser-calling.service';

/**
 * How long an officer's browser token lasts.
 *
 * Minted per call rather than per shift, so it only has to outlive one
 * conversation. An hour is longer than any callback should take and short
 * enough that a token lifted from a browser is not a lasting capability.
 */
const BROWSER_CALL_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * What a browser may report about its call.
 *
 * `not_placed` is distinct from `failed` on purpose: it means the citizen's
 * phone never rang (the SDK would not load, Infobip refused the connection),
 * so the promise is handed back without an attempt counted against them.
 * `failed` is a call Infobip accepted that then went wrong — it may have rung.
 */
const BROWSER_OUTCOMES = ['answered', 'not_answered', 'failed', 'not_placed'] as const;

/**
 * A number in the form Infobip's own examples use: digits only, no plus.
 *
 * Every phone number in Infobip's SDK documentation is written without it
 * (`callPhone('41793026727', … setFrom('33712345678'))`). Stored numbers here
 * are canonical E.164 WITH it, so it is stripped at the one place a number is
 * handed to Infobip.
 */
function infobipNumber(phoneNumber: string): string {
  return phoneNumber.trim().replace(/^\+/, '');
}

/**
 * The queue of citizens we owe a call.
 *
 * Reading is open to every member: an officer at a desk needs to see who is
 * waiting, and a VIEWER seeing the queue harms nobody. Writing is OWNER /
 * ADMIN / AGENT, matching SchedulingController — placing or cancelling a call
 * to a citizen is front-desk work, and making an officer escalate to ring
 * somebody back is how agencies end up sharing an admin login.
 *
 * `RolesGuard` is listed after `JwtAuthGuard` deliberately. It is not global
 * (Nest runs guards global → controller → route, so a global one would run
 * before authentication populated `request.user`), and `@Roles` without it is
 * metadata nothing reads.
 */
@Controller('api/callbacks')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CallbacksController {
  constructor(
    private readonly dispatcher: CallbackDispatcherService,
    private readonly infobip: InfobipVoiceService,
  ) {}

  /**
   * How this agency's promises get dialled, so the queue shows the right button.
   *
   * `automatic`: this process dials (Twilio and the other carriers), and
   * "Call now" asks it to. `officer-browser`: the agency's line is Infobip,
   * which this process does not dial — an officer rings the citizen from the
   * browser, and "Call now" would only be refused. `none`: no line at all.
   *
   * `ready` is false when the line is Infobip but the deployment cannot mint
   * a browser token, and `blocked` says what is missing. A button that fails
   * on every press is worse than a stated gap.
   */
  @Get('dialling')
  async dialling(@Req() req: { user: AuthUser }) {
    const line = await outboundLineFor(req.user.organizationId);
    if (!line?.phoneNumber) {
      return {
        mode: 'none' as const,
        line: null,
        ready: false,
        blocked: ['This agency has no phone line. Add one under Settings → Voice & Telephony.'],
      };
    }
    if ((line.provider as string) !== 'INFOBIP') {
      return { mode: 'automatic' as const, line: line.phoneNumber, ready: true, blocked: [] as string[] };
    }
    const blocked: string[] = [];
    if (!this.infobip.baseUrl()) blocked.push('INFOBIP_BASE_URL is not set (or is not https).');
    if (!process.env.INFOBIP_API_KEY?.trim()) blocked.push('INFOBIP_API_KEY is not set.');
    // Every officer reads this notice on the Callback Queue. Server variable
    // names are for the platform operators who can set them; an officer is
    // told what they can do about it, which is ask.
    const shown =
      blocked.length === 0 || isPlatformOperator(req.user)
        ? blocked
        : ['Calling from the browser is not set up on this platform yet. Contact the State platform team.'];
    return { mode: 'officer-browser' as const, line: line.phoneNumber, ready: blocked.length === 0, blocked: shown };
  }

  /** The queue, newest promise first, scoped to the caller's own agency. */
  @Get()
  async list(@Req() req: { user: AuthUser }, @Query('status') status?: string) {
    const rows = await prisma.callbackRequest.findMany({
      where: {
        organizationId: req.user.organizationId,
        ...(status ? { status: status as any } : {}),
      },
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
      take: 200,
      include: {
        contact: { select: { id: true, fullName: true, phoneNumber: true } },
        assignedUser: { select: { id: true, fullName: true } },
        attemptLog: { orderBy: { createdAt: 'asc' }, take: 20 },
      },
    });

    const now = Date.now();
    return rows.map((r) => {
      const open = ['PENDING', 'DUE'].includes(r.status);
      return {
        ...r,
        reference: callbackReference(r.id),
        // Computed, not stored: "late" is a fact about now, and a stored flag
        // would be wrong the moment it was read.
        overdue: r.dueAt.getTime() < now && open,
        // PRD §09 "escalate overdue tasks": more than an hour past the promise
        // is a supervisor's problem, the same line voice-readiness reports on.
        escalated: open && now - r.dueAt.getTime() > 60 * 60_000,
      };
    });
  }

  /**
   * Raise one by hand, for a citizen who asked an officer rather than the AI.
   *
   * The contact must already exist: inventing one from a typed number would
   * create a citizen record nobody verified, and the CRM is where that record
   * is supposed to come from.
   */
  @Post()
  @Roles('OWNER', 'ADMIN', 'AGENT')
  async create(
    @Req() req: { user: AuthUser },
    @Body() body: { contactId?: string; phoneNumber?: string; reason?: string; dueInMinutes?: number; promisedText?: string },
  ) {
    if (!body?.contactId) throw new BadRequestException('contactId is required');
    if (!body?.reason?.trim()) {
      throw new BadRequestException('A reason is required — the officer who rings has to know what it is about.');
    }

    const contact = await prisma.contact.findFirst({
      where: { id: body.contactId, organizationId: req.user.organizationId },
    });
    if (!contact) throw new BadRequestException('Contact not found in this agency');

    const minutes = Number.isFinite(body.dueInMinutes) ? Number(body.dueInMinutes) : 60;
    const hours = await outboundContactHoursFrom(prisma, req.user.organizationId);
    const dueAt = nextServiceTime(new Date(Date.now() + minutes * 60_000), hours);

    const row = await prisma.callbackRequest.create({
      data: {
        organizationId: req.user.organizationId,
        contactId: contact.id,
        phoneNumber: normalizePhoneNumber(body.phoneNumber || contact.phoneNumber),
        reason: body.reason.trim().slice(0, 1000),
        promisedText: body.promisedText?.trim() || `within ${minutes} minutes`,
        dueAt,
      },
    });
    return { ...row, reference: callbackReference(row.id) };
  }

  /**
   * Dial one now, ahead of its window.
   *
   * Goes through the dispatcher's own claim rather than dialling directly, so
   * a press of this button and the sweeper's next pass cannot both ring the
   * same citizen.
   */
  @Post(':id/call-now')
  @Roles('OWNER', 'ADMIN', 'AGENT')
  async callNow(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    const row = await prisma.callbackRequest.findFirst({
      where: { id, organizationId: req.user.organizationId },
    });
    if (!row) throw new BadRequestException('Callback not found in this agency');

    // Refused with the reason, before anything is claimed. Without this the
    // dispatcher skips the row and the officer is told only "Not placed".
    const line = await outboundLineFor(req.user.organizationId);
    if ((line?.provider as string | undefined) === 'INFOBIP') {
      throw new BadRequestException(INFOBIP_OUTBOUND_REASON);
    }

    const outcome = await this.dispatcher.placeOne(id);
    const after = await prisma.callbackRequest.findUnique({ where: { id } });

    // Reports what actually happened, from the row the dispatcher wrote —
    // never from the intention to dial.
    return {
      outcome,
      status: after?.status,
      attempts: after?.attempts,
      failureReason: after?.failureReason ?? null,
      reference: callbackReference(id),
    };
  }

  /**
   * An officer is about to ring this citizen from their browser, over Infobip.
   *
   * Claims the promise first, with the dispatcher's own atomic claim, so two
   * officers cannot both ring the same citizen; the second is told who has
   * it rather than dialling over them. Then mints a token for THIS officer —
   * the identity comes from `req.user`, never from the request — and hands
   * back exactly what the browser needs to dial: the citizen's number and the
   * agency's line as caller ID.
   *
   * If Infobip refuses the token the claim is released, so the refusal does
   * not leave the promise showing DIALLING and then cost the citizen an
   * attempt that was never made.
   */
  @Post(':id/browser-call')
  @Roles('OWNER', 'ADMIN', 'AGENT')
  async browserCall(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    const organizationId = req.user.organizationId;
    const line = await outboundLineFor(organizationId);
    if ((line?.provider as string | undefined) !== 'INFOBIP' || !line?.phoneNumber) {
      throw new BadRequestException(
        "Calling from the browser is for an agency whose line is on Infobip. This agency's " +
          'promises are dialled automatically: use "Call now".'
      );
    }

    const row = await prisma.callbackRequest.findFirst({
      where: { id, organizationId },
      select: { id: true, status: true, assignedUser: { select: { fullName: true } } },
    });
    if (!row) throw new BadRequestException('Callback not found in this agency');
    if (row.status !== 'PENDING' && row.status !== 'DUE') {
      throw new ConflictException(
        row.status === 'IN_PROGRESS'
          ? `${row.assignedUser?.fullName ?? 'Another officer'} is already calling this citizen.`
          : `This callback is ${row.status} and cannot be dialled.`
      );
    }

    const claimed = await this.dispatcher.claimForBrowser(id, organizationId, req.user.userId);
    if (!claimed) throw new ConflictException('Another officer started this call a moment ago.');

    const minted = await this.infobip.webrtcToken(
      clientIdentityFor(req.user.userId),
      req.user.fullName,
      BROWSER_CALL_TOKEN_TTL_SECONDS
    );
    if (!minted.ok) {
      await this.dispatcher.releaseBrowserClaim(id, organizationId);
      throw new BadGatewayException(minted.error);
    }

    return {
      reference: callbackReference(id),
      token: minted.token,
      expiresAt: minted.expiresAt,
      to: infobipNumber(claimed.phoneNumber),
      from: infobipNumber(line.phoneNumber),
    };
  }

  /**
   * What the officer's browser call did, reported when it ends.
   *
   * `answered` only when Infobip raised ESTABLISHED; see
   * `CallbackDispatcherService.recordBrowserAttempt` for why that is recorded
   * as REACHED and everything else as an attempt that was not. A second
   * report for the same call, or one for a promise nobody claimed, is a 409
   * rather than a second attempt counted against the citizen.
   */
  @Post(':id/browser-call/result')
  @Roles('OWNER', 'ADMIN', 'AGENT')
  async browserCallResult(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { callId?: string; outcome?: string; durationSeconds?: number; reason?: string }
  ) {
    const outcome = BROWSER_OUTCOMES.find((o) => o === body?.outcome);
    if (!outcome) {
      throw new BadRequestException(`outcome must be one of: ${BROWSER_OUTCOMES.join(', ')}`);
    }
    // Infobip's call ids are opaque; anything outside this shape is not one,
    // and it ends up in a unique column.
    const callId =
      typeof body.callId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(body.callId) ? body.callId : null;
    const durationSeconds = Number.isFinite(Number(body.durationSeconds)) ? Number(body.durationSeconds) : 0;
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 300) : null;

    if (outcome === 'not_placed') {
      const status = await this.dispatcher.releaseBrowserClaim(id, req.user.organizationId);
      if (!status) {
        throw new ConflictException('This callback is not being dialled from a browser any more.');
      }
      return { reference: callbackReference(id), status, attempts: null, failureReason: null };
    }

    const line = await outboundLineFor(req.user.organizationId);
    const result = await this.dispatcher.recordBrowserAttempt({
      id,
      organizationId: req.user.organizationId,
      officerName: req.user.fullName || req.user.email,
      fromNumber: line?.phoneNumber ?? 'unknown',
      callId,
      outcome,
      durationSeconds,
      reason,
    });
    if (!result) {
      throw new ConflictException(
        'This callback is not being dialled from a browser any more — it was already recorded, ' +
          'or it was reopened after going quiet.'
      );
    }
    return { reference: callbackReference(id), ...result };
  }

  /**
   * An officer rang from their OWN phone and is recording what happened
   * (PRD §09). REACHED closes the promise. Anything else counts as an attempt:
   * it is retried on the platform's back-off — or at the time the officer
   * agreed with the citizen — until the maximum, then marked FAILED so a
   * supervisor sees a promise that could not be kept rather than one that
   * quietly stays pending.
   */
  @Post(':id/attempt')
  @Roles('OWNER', 'ADMIN', 'AGENT')
  async logAttempt(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { outcome: string; note?: string; rescheduleTo?: string }
  ) {
    const OUTCOMES = ['REACHED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'VOICEMAIL', 'FAILED'];
    if (!OUTCOMES.includes(body?.outcome)) {
      throw new BadRequestException(`outcome must be one of: ${OUTCOMES.join(', ')}`);
    }
    if (body.rescheduleTo && Number.isNaN(Date.parse(body.rescheduleTo))) {
      throw new BadRequestException('rescheduleTo is not a date.');
    }
    const row = await prisma.callbackRequest.findFirst({
      where: { id, organizationId: req.user.organizationId, status: { in: ['PENDING', 'DUE', 'IN_PROGRESS'] } },
    });
    if (!row) throw new BadRequestException('That callback is already closed, or is not in this agency');

    const attempts = row.attempts + 1;
    const reached = body.outcome === 'REACHED';
    // A wrong number cannot be fixed by ringing it again.
    const exhausted = !reached && (attempts >= row.maxAttempts || body.outcome === 'WRONG_NUMBER');
    const now = new Date();
    const note = body.note?.trim().slice(0, 1000) || null;
    const reason = reached ? null : `${body.outcome.toLowerCase().replace(/_/g, ' ')}${note ? `: ${note}` : ''}`;
    let dueAt = row.dueAt;
    if (!reached && !exhausted) {
      dueAt = body.rescheduleTo
        ? new Date(body.rescheduleTo)
        : nextAttemptAt(attempts, await outboundContactHoursFrom(prisma, row.organizationId), now);
    }
    const status = reached ? 'COMPLETED' : exhausted ? 'FAILED' : 'PENDING';

    const updated = await prisma.$transaction(async (tx) => {
      const { count } = await tx.callbackRequest.updateMany({
        where: { id, organizationId: req.user.organizationId, status: { in: ['PENDING', 'DUE', 'IN_PROGRESS'] } },
        data: {
          attempts,
          status,
          lastAttemptAt: now,
          failureReason: reason,
          ...(reached ? { completedAt: now } : {}),
          ...(status === 'PENDING' ? { dueAt } : {}),
          ...(row.assignedUserId ? {} : { assignedUserId: req.user.userId }),
        },
      });
      if (count !== 1) return null;
      await tx.callbackAttempt.create({
        data: {
          organizationId: req.user.organizationId,
          callbackId: id,
          outcome: body.outcome,
          via: 'OWN_PHONE',
          userId: req.user.userId,
          note,
        },
      });
      return true;
    });
    if (!updated) throw new ConflictException('This callback changed while you were recording it. Refresh and try again.');
    return { reference: callbackReference(id), status, attempts, dueAt: status === 'PENDING' ? dueAt : null };
  }

  /** Who is going to keep this promise. */
  @Patch(':id/assign')
  @Roles('OWNER', 'ADMIN', 'AGENT')
  async assign(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { userId?: string | null }) {
    const userId = body?.userId || null;
    if (userId) {
      const member = await prisma.user.findFirst({ where: { id: userId, organizationId: req.user.organizationId, isActive: true } });
      if (!member) throw new BadRequestException('That officer is not an active member of this agency.');
    }
    const updated = await prisma.callbackRequest.updateMany({
      where: { id, organizationId: req.user.organizationId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      data: { assignedUserId: userId },
    });
    if (updated.count !== 1) throw new BadRequestException('That callback is already closed, or is not in this agency');
    return { ok: true, reference: callbackReference(id) };
  }

  /** Move the promise to a time agreed with the citizen. Does not spend an attempt. */
  @Patch(':id/reschedule')
  @Roles('OWNER', 'ADMIN', 'AGENT')
  async reschedule(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { dueAt: string; preferredTime?: string }) {
    if (!body?.dueAt || Number.isNaN(Date.parse(body.dueAt))) throw new BadRequestException('dueAt must be a date.');
    const updated = await prisma.callbackRequest.updateMany({
      where: { id, organizationId: req.user.organizationId, status: { in: ['PENDING', 'DUE', 'FAILED'] } },
      data: {
        dueAt: new Date(body.dueAt),
        status: 'PENDING',
        ...(body.preferredTime !== undefined ? { preferredTime: body.preferredTime?.slice(0, 200) || null } : {}),
      },
    });
    if (updated.count !== 1) throw new BadRequestException('Only an open or failed callback can be rescheduled.');
    return { ok: true, reference: callbackReference(id) };
  }

  /** Close one off by hand — the officer rang from their own phone. */
  @Patch(':id/complete')
  @Roles('OWNER', 'ADMIN', 'AGENT')
  async complete(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    const updated = await prisma.callbackRequest.updateMany({
      where: { id, organizationId: req.user.organizationId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    if (updated.count !== 1) throw new BadRequestException('That callback is already closed, or is not in this agency');
    return { ok: true, reference: callbackReference(id) };
  }

  @Patch(':id/cancel')
  @Roles('OWNER', 'ADMIN', 'AGENT')
  async cancel(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { reason?: string }) {
    const updated = await prisma.callbackRequest.updateMany({
      where: { id, organizationId: req.user.organizationId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      data: { status: 'CANCELLED', failureReason: body?.reason?.slice(0, 500) ?? null },
    });
    if (updated.count !== 1) throw new BadRequestException('That callback is already closed, or is not in this agency');
    return { ok: true, reference: callbackReference(id) };
  }
}
