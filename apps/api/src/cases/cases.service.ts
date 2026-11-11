import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  prisma,
  caseTransitionProblem,
  ticketStatusForStage,
  resolveLga,
  recordAgencyAudit,
  CASE_STAGES,
  type Actor,
  type CaseStageName,
} from '@ace/database';
import type { AuthUser } from '@ace/shared-types';

const OPEN_STAGES: CaseStageName[] = ['RECEIVED', 'CLASSIFIED', 'ASSIGNED', 'UNDER_REVIEW', 'ACTION_IN_PROGRESS', 'REOPENED'];
const PRIVILEGED = new Set(['OWNER', 'ADMIN']);

export interface CaseFilters {
  stage?: string;
  category?: string;
  lga?: string;
  overdue?: boolean;
  mine?: boolean;
  mda?: string;
}

/**
 * Case management (PRD §10, §14, §15).
 *
 * ── Who sees what ───────────────────────────────────────────────────────────
 *
 *  - OWNER/ADMIN see every case and every reporter.
 *  - Other State staff see every case, but an ANONYMOUS case's reporter is
 *    withheld, and a SENSITIVE case (security, misconduct) is visible only if
 *    it is assigned to them.
 *  - An MDA liaison (`user.mdaName` set) sees ONLY cases referred to their
 *    MDA, never the reporter of an anonymous one, and can respond to the
 *    referral and add notes — not move the case or refer it elsewhere. "No
 *    MDA may alter another institution's approved data" (§15).
 *
 * These are enforced here, in the query, not in the dashboard: a hidden
 * button is not an access control.
 */
@Injectable()
export class CasesService {
  private isLiaison(user: AuthUser) {
    return !!user.mdaName;
  }

  private visibilityWhere(user: AuthUser): any {
    const base: any = { organizationId: user.organizationId };
    if (this.isLiaison(user)) {
      return { ...base, referrals: { some: { mdaName: user.mdaName } } };
    }
    if (!PRIVILEGED.has(user.role)) {
      return { ...base, OR: [{ isSensitive: false }, { assignedUserId: user.userId }] };
    }
    return base;
  }

  /** Withhold what this viewer may not see. Applied to every case returned. */
  private present(user: AuthUser, c: any) {
    const hideReporter = c.isAnonymous && (this.isLiaison(user) || !PRIVILEGED.has(user.role));
    const now = Date.now();
    const overdue = !!c.dueAt && new Date(c.dueAt).getTime() < now && OPEN_STAGES.includes(c.caseStage);
    const out: any = { ...c, overdue };
    if (hideReporter) {
      out.contactId = null;
      out.contact = c.contact ? { id: null, fullName: 'Anonymous reporter', phoneNumber: null, email: null } : null;
    }
    if (this.isLiaison(user) && Array.isArray(c.events)) {
      // A liaison reads the case and the referral thread, not the State's internal notes.
      out.events = c.events.filter((e: any) => !e.internal || e.type === 'REFERRAL_RESPONSE' || e.type === 'REFERRED');
    }
    if (this.isLiaison(user) && Array.isArray(c.referrals)) {
      out.referrals = c.referrals.filter((r: any) => r.mdaName === user.mdaName);
    }
    return out;
  }

  async list(user: AuthUser, f: CaseFilters) {
    const where: any = { ...this.visibilityWhere(user) };
    if (f.stage) {
      if (!(CASE_STAGES as readonly string[]).includes(f.stage)) throw new BadRequestException('Unknown stage.');
      where.caseStage = f.stage;
    }
    if (f.category) where.category = f.category;
    if (f.lga) where.lga = f.lga;
    if (f.mda) where.responsibleMda = f.mda;
    if (f.mine) where.assignedUserId = user.userId;
    if (f.overdue) {
      where.dueAt = { lt: new Date() };
      where.caseStage = { in: OPEN_STAGES };
    }
    const rows = await prisma.ticket.findMany({
      where,
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
      take: 300,
      include: {
        contact: { select: { id: true, fullName: true, phoneNumber: true, email: true } },
        assignedUser: { select: { id: true, fullName: true } },
        referrals: { select: { id: true, mdaName: true, status: true, dueAt: true } },
      },
    });
    return rows.map((r) => this.present(user, r));
  }

  async get(user: AuthUser, id: string) {
    const c = await prisma.ticket.findFirst({
      where: { ...this.visibilityWhere(user), id },
      include: {
        contact: { select: { id: true, fullName: true, phoneNumber: true, email: true } },
        assignedUser: { select: { id: true, fullName: true } },
        events: { orderBy: { createdAt: 'asc' } },
        referrals: { orderBy: { sentAt: 'asc' } },
      },
    });
    if (!c) throw new NotFoundException('Case not found.');
    return this.present(user, c);
  }

  /** Counts a supervisor watches (PRD §14, §16). */
  async summary(user: AuthUser) {
    const where = this.visibilityWhere(user);
    const now = new Date();
    const [byStage, byCategory, overdue, referralsOpen] = await Promise.all([
      prisma.ticket.groupBy({ by: ['caseStage'], where, _count: { _all: true } }),
      prisma.ticket.groupBy({ by: ['category'], where: { ...where, caseStage: { in: OPEN_STAGES } }, _count: { _all: true } }),
      prisma.ticket.count({ where: { ...where, dueAt: { lt: now }, caseStage: { in: OPEN_STAGES } } }),
      prisma.mdaReferral.count({
        where: {
          organizationId: user.organizationId,
          status: { in: ['SENT', 'ACKNOWLEDGED'] },
          ...(this.isLiaison(user) ? { mdaName: user.mdaName! } : {}),
        },
      }),
    ]);
    return {
      byStage: Object.fromEntries(byStage.map((r) => [r.caseStage, r._count._all])),
      openByCategory: Object.fromEntries(byCategory.map((r) => [r.category ?? 'unclassified', r._count._all])),
      overdue,
      referralsAwaitingResponse: referralsOpen,
    };
  }

  private async own(user: AuthUser, id: string) {
    const c = await prisma.ticket.findFirst({ where: { ...this.visibilityWhere(user), id } });
    if (!c) throw new NotFoundException('Case not found.');
    return c;
  }

  private refuseLiaison(user: AuthUser, what: string) {
    if (this.isLiaison(user)) {
      throw new ForbiddenException(`An MDA liaison cannot ${what}. Respond to the referral instead.`);
    }
  }

  async moveStage(user: AuthUser, actor: Actor, id: string, to: string, outcome?: string, note?: string) {
    this.refuseLiaison(user, 'change a case’s stage');
    if (!(CASE_STAGES as readonly string[]).includes(to)) throw new BadRequestException('Unknown stage.');
    const c = await this.own(user, id);
    const target = to as CaseStageName;
    const problem = caseTransitionProblem(c.caseStage as CaseStageName, target, { outcome: outcome ?? c.resolutionOutcome });
    if (problem) throw new ConflictException(problem);

    const now = new Date();
    const updated = await prisma.ticket.update({
      where: { id },
      data: {
        caseStage: target,
        status: ticketStatusForStage(target),
        ...(target === 'RESOLVED' ? { resolutionOutcome: outcome!.trim(), resolvedAt: now } : {}),
        ...(target === 'REOPENED' ? { resolvedAt: null, citizenNotifiedAt: null } : {}),
        events: {
          create: {
            organizationId: user.organizationId,
            type: 'STAGE_CHANGED',
            fromStage: c.caseStage,
            toStage: target,
            actorUserId: user.userId,
            body: [target === 'RESOLVED' ? `Outcome: ${outcome!.trim()}` : null, note?.trim() || null].filter(Boolean).join('\n') || null,
          },
        },
      },
    });
    await recordAgencyAudit(actor, user.organizationId, {
      action: 'case.stage_changed',
      targetType: 'Ticket',
      targetId: id,
      previousValue: { stage: c.caseStage },
      newValue: { stage: target },
    });
    return updated;
  }

  async assign(user: AuthUser, id: string, assigneeId: string | null) {
    this.refuseLiaison(user, 'reassign a case');
    const c = await this.own(user, id);
    if (assigneeId) {
      const member = await prisma.user.findFirst({ where: { id: assigneeId, organizationId: user.organizationId, isActive: true } });
      if (!member) throw new BadRequestException('That officer is not an active member of this agency.');
    }
    const advance = assigneeId && ['RECEIVED', 'CLASSIFIED', 'REOPENED'].includes(c.caseStage);
    return prisma.ticket.update({
      where: { id },
      data: {
        assignedUserId: assigneeId,
        ...(advance ? { caseStage: 'ASSIGNED', status: ticketStatusForStage('ASSIGNED') } : {}),
        events: {
          create: {
            organizationId: user.organizationId,
            type: 'ASSIGNED',
            actorUserId: user.userId,
            ...(advance ? { fromStage: c.caseStage, toStage: 'ASSIGNED' } : {}),
            body: assigneeId ? `Assigned to ${assigneeId}` : 'Unassigned',
          },
        },
      },
    });
  }

  async classify(
    user: AuthUser,
    id: string,
    body: { category?: string; lga?: string; ward?: string; community?: string; responsibleMda?: string; summary?: string; dueAt?: string; priority?: string; isSensitive?: boolean },
  ) {
    this.refuseLiaison(user, 'reclassify a case');
    const c = await this.own(user, id);
    let lga: string | null | undefined;
    if (body.lga !== undefined) {
      lga = body.lga ? resolveLga(body.lga) : null;
      if (body.lga && !lga) throw new BadRequestException(`"${body.lga}" is not a Plateau LGA.`);
    }
    if (body.dueAt && Number.isNaN(Date.parse(body.dueAt))) throw new BadRequestException('dueAt is not a date.');
    if (body.priority && !['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(body.priority)) throw new BadRequestException('Unknown priority.');
    const advance = c.caseStage === 'RECEIVED' && !!(body.category || c.category);
    return prisma.ticket.update({
      where: { id },
      data: {
        ...(body.category !== undefined ? { category: body.category || null } : {}),
        ...(lga !== undefined ? { lga } : {}),
        ...(body.ward !== undefined ? { ward: body.ward || null } : {}),
        ...(body.community !== undefined ? { community: body.community || null } : {}),
        ...(body.responsibleMda !== undefined ? { responsibleMda: body.responsibleMda || null } : {}),
        ...(body.summary !== undefined ? { summary: body.summary || null } : {}),
        ...(body.dueAt !== undefined ? { dueAt: body.dueAt ? new Date(body.dueAt) : null } : {}),
        ...(body.priority ? { priority: body.priority as any } : {}),
        ...(body.isSensitive !== undefined && PRIVILEGED.has(user.role) ? { isSensitive: body.isSensitive } : {}),
        ...(advance ? { caseStage: 'CLASSIFIED', status: ticketStatusForStage('CLASSIFIED') } : {}),
        events: {
          create: {
            organizationId: user.organizationId,
            type: 'NOTE',
            actorUserId: user.userId,
            ...(advance ? { fromStage: 'RECEIVED', toStage: 'CLASSIFIED' } : {}),
            body: `Classification updated: ${Object.keys(body).join(', ')}`,
          },
        },
      },
    });
  }

  async addNote(user: AuthUser, id: string, text: string) {
    if (!text?.trim()) throw new BadRequestException('A note cannot be empty.');
    await this.own(user, id);
    return prisma.caseEvent.create({
      data: { organizationId: user.organizationId, ticketId: id, type: 'NOTE', actorUserId: user.userId, body: text.trim(), internal: true },
    });
  }

  async refer(
    user: AuthUser,
    actor: Actor,
    id: string,
    body: { mdaName: string; liaisonName?: string; liaisonContact?: string; liaisonUserId?: string; note?: string; dueAt?: string },
  ) {
    this.refuseLiaison(user, 'refer a case to another MDA');
    const mda = (body.mdaName ?? '').trim();
    if (!mda) throw new BadRequestException('Name the MDA the case is referred to.');
    const c = await this.own(user, id);
    if (['RESOLVED', 'CLOSED'].includes(c.caseStage)) throw new ConflictException('Reopen the case before referring it.');
    if (body.liaisonUserId) {
      const liaison = await prisma.user.findFirst({ where: { id: body.liaisonUserId, organizationId: user.organizationId, isActive: true } });
      if (!liaison) throw new BadRequestException('That liaison is not an active member of this agency.');
    }
    const referral = await prisma.mdaReferral.create({
      data: {
        organizationId: user.organizationId,
        ticketId: id,
        mdaName: mda,
        liaisonName: body.liaisonName?.trim() || null,
        liaisonContact: body.liaisonContact?.trim() || null,
        liaisonUserId: body.liaisonUserId || null,
        note: body.note?.trim() || null,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        sentByUserId: user.userId,
      },
    });
    // Referral is recorded and the responsible MDA set. It does NOT resolve
    // the case and does not move it past UNDER_REVIEW.
    const advance = ['RECEIVED', 'CLASSIFIED', 'ASSIGNED', 'REOPENED'].includes(c.caseStage);
    await prisma.ticket.update({
      where: { id },
      data: {
        responsibleMda: c.responsibleMda ?? mda,
        ...(advance ? { caseStage: 'UNDER_REVIEW', status: ticketStatusForStage('UNDER_REVIEW') } : {}),
        events: {
          create: {
            organizationId: user.organizationId,
            type: 'REFERRED',
            actorUserId: user.userId,
            ...(advance ? { fromStage: c.caseStage, toStage: 'UNDER_REVIEW' } : {}),
            body: `Referred to ${mda}${body.note ? `: ${body.note.trim()}` : ''}`,
          },
        },
      },
    });
    await recordAgencyAudit(actor, user.organizationId, {
      action: 'case.referred',
      targetType: 'Ticket',
      targetId: id,
      newValue: { mdaName: mda, referralId: referral.id },
    });
    return referral;
  }

  async respondToReferral(user: AuthUser, referralId: string, body: { status: string; response?: string }) {
    const r = await prisma.mdaReferral.findFirst({ where: { id: referralId, organizationId: user.organizationId } });
    if (!r) throw new NotFoundException('Referral not found.');
    if (this.isLiaison(user) && r.mdaName !== user.mdaName) throw new NotFoundException('Referral not found.');
    if (!['ACKNOWLEDGED', 'RESPONDED', 'DECLINED'].includes(body.status)) {
      throw new BadRequestException('status must be ACKNOWLEDGED, RESPONDED or DECLINED.');
    }
    if ((body.status === 'RESPONDED' || body.status === 'DECLINED') && !body.response?.trim()) {
      throw new BadRequestException('Say what the MDA did or why it declined.');
    }
    const now = new Date();
    const updated = await prisma.mdaReferral.update({
      where: { id: referralId },
      data: {
        status: body.status as any,
        ...(body.status === 'ACKNOWLEDGED' ? { acknowledgedAt: r.acknowledgedAt ?? now } : {}),
        ...(body.status !== 'ACKNOWLEDGED' ? { respondedAt: now, response: body.response!.trim(), acknowledgedAt: r.acknowledgedAt ?? now } : {}),
      },
    });
    await prisma.caseEvent.create({
      data: {
        organizationId: user.organizationId,
        ticketId: r.ticketId,
        type: 'REFERRAL_RESPONSE',
        actorUserId: user.userId,
        body: `${r.mdaName} ${body.status.toLowerCase()}${body.response ? `: ${body.response.trim()}` : ''}`,
        internal: true,
      },
    });
    return updated;
  }

  /**
   * Record that the citizen was told the outcome. A RECORD of something an
   * officer did — not a send — so it never claims a message went out that
   * did not (invariant 1).
   */
  async recordCitizenNotified(user: AuthUser, id: string, body: { channel: string; note?: string }) {
    this.refuseLiaison(user, 'record a citizen notification');
    const c = await this.own(user, id);
    if (!['RESOLVED', 'CLOSED'].includes(c.caseStage)) {
      throw new ConflictException('Notify the citizen of an outcome once the case is resolved.');
    }
    if (!body.channel?.trim()) throw new BadRequestException('How was the citizen told? (phone, WhatsApp, in person, letter)');
    return prisma.ticket.update({
      where: { id },
      data: {
        citizenNotifiedAt: new Date(),
        events: {
          create: {
            organizationId: user.organizationId,
            type: 'CITIZEN_NOTIFIED',
            actorUserId: user.userId,
            body: `Told by ${body.channel.trim()}${body.note ? `: ${body.note.trim()}` : ''}`,
            internal: false,
          },
        },
      },
    });
  }
}
