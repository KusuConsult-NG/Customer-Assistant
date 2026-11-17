import {
  Controller, Get, Post, Patch, Body, Param, Query, Req, UseGuards, BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { MIN_UPDATE_CHARS } from './callback-opening';
import { prisma, callbackReference, newReference, normalizePhoneNumber, phoneNumberVariants, outboundContactHoursFrom, nextServiceTime, nextAttemptAt } from '@ace/database';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser } from '@ace/shared-types';
import { CallbackDispatcherService } from './callback-dispatcher.service';
import { outboundLineFor, INFOBIP_RETIRED_REASON } from './outbound-line';

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
/** The reference the citizen holds: their five digits, or the older CB- form. */
async function referenceOf(id: string): Promise<string> {
  const row = await prisma.callbackRequest.findUnique({ where: { id }, select: { id: true, reference: true } });
  return callbackReference(row ?? id);
}

@Controller('api/callbacks')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CallbacksController {
  constructor(
    private readonly dispatcher: CallbackDispatcherService,
  ) {}

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
        reference: callbackReference(r),
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
        reference: await newReference(prisma.callbackRequest, req.user.organizationId),
        contactId: contact.id,
        phoneNumber: normalizePhoneNumber(body.phoneNumber || contact.phoneNumber),
        reason: body.reason.trim().slice(0, 1000),
        promisedText: body.promisedText?.trim() || `within ${minutes} minutes`,
        dueAt,
      },
    });
    return { ...row, reference: callbackReference(row) };
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
  async callNow(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { update?: string } = {}
  ) {
    const row = await prisma.callbackRequest.findFirst({
      where: { id, organizationId: req.user.organizationId },
    });
    if (!row) throw new BadRequestException('Callback not found in this agency');

    // A callback is for news. Without an update the assistant would ring the
    // citizen with nothing to tell them — the "random" calls this replaces.
    const update = String(body?.update ?? '').trim();
    if (update.length < MIN_UPDATE_CHARS) {
      throw new BadRequestException(
        'Say what has changed before calling — for example "Your complaint has been resolved" or ' +
          '"The Water Board has scheduled the repair for Friday". The assistant tells the citizen this first.'
      );
    }

    // Refused with the reason, before anything is claimed, so pressing the
    // button on a retired Infobip line costs the citizen no attempt.
    const line = await outboundLineFor(req.user.organizationId);
    if ((line?.provider as string | undefined) === 'INFOBIP') {
      throw new BadRequestException(INFOBIP_RETIRED_REASON);
    }

    const outcome = await this.dispatcher.placeOne(id, { update });
    const after = await prisma.callbackRequest.findUnique({ where: { id } });

    // Reports what actually happened, from the row the dispatcher wrote —
    // never from the intention to dial.
    return {
      outcome,
      status: after?.status,
      attempts: after?.attempts,
      failureReason: after?.failureReason ?? null,
      reference: callbackReference(after ?? id),
    };
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
    return { reference: callbackReference(row), status, attempts, dueAt: status === 'PENDING' ? dueAt : null };
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
    return { ok: true, reference: await referenceOf(id) };
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
    return { ok: true, reference: await referenceOf(id) };
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
    return { ok: true, reference: await referenceOf(id) };
  }

  @Patch(':id/cancel')
  @Roles('OWNER', 'ADMIN', 'AGENT')
  async cancel(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { reason?: string }) {
    const updated = await prisma.callbackRequest.updateMany({
      where: { id, organizationId: req.user.organizationId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      data: { status: 'CANCELLED', failureReason: body?.reason?.slice(0, 500) ?? null },
    });
    if (updated.count !== 1) throw new BadRequestException('That callback is already closed, or is not in this agency');
    return { ok: true, reference: await referenceOf(id) };
  }
}
