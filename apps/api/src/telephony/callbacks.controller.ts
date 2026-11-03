import {
  Controller, Get, Post, Patch, Body, Param, Query, Req, UseGuards, BadRequestException,
} from '@nestjs/common';
import { prisma, callbackReference, normalizePhoneNumber, phoneNumberVariants, serviceHoursFrom, nextServiceTime } from '@ace/database';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser } from '@ace/shared-types';
import { CallbackDispatcherService } from './callback-dispatcher.service';

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
  constructor(private readonly dispatcher: CallbackDispatcherService) {}

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
      include: { contact: { select: { id: true, fullName: true, phoneNumber: true } } },
    });

    return rows.map((r) => ({
      ...r,
      reference: callbackReference(r.id),
      // Computed, not stored: "late" is a fact about now, and a stored flag
      // would be wrong the moment it was read.
      overdue: r.dueAt.getTime() < Date.now() && ['PENDING', 'DUE'].includes(r.status),
    }));
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
    const hours = await serviceHoursFrom(prisma, req.user.organizationId);
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
