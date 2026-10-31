import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { prisma, recordAudit } from '@ace/database';
import { IndustryType } from '@ace/shared-types';
import { OrganizationsService } from '../organizations/organizations.service';
import { generateUniqueSlug } from '../common/slug';
import { AceLogger } from '../config/logger';

const log = new AceLogger('PlatformService');

/**
 * The operating ministry's view across every agency on the platform.
 *
 * ── WHAT THIS TIER MAY SEE ───────────────────────────────────────────────────
 *
 * Metrics and configuration. NOT content.
 *
 * The ministry's job is service standards across agencies: who answers, how
 * fast, how much is escalated, what is left unresolved. That job needs counts.
 * It does not need to read what a citizen said to the health agency about their
 * diagnosis, or to a law-enforcement agency about a crime, and an oversight tier
 * that can read every conversation in the State is a surveillance capability
 * nobody asked for and no citizen consented to.
 *
 * So every query here returns aggregates, configuration, and the identity of
 * STAFF. No method returns a message body, a transcript, a call recording, a
 * citizen's name or a citizen's phone number, and a test pins that. Reading an
 * individual citizen's record stays where it already is: inside the agency that
 * holds the relationship, scoped by organizationId like everything else.
 *
 * ── WHY COUNTS ARE GROUPED, NOT LOOPED ───────────────────────────────────────
 *
 * The listing runs a fixed number of grouped queries rather than per-agency
 * counts in a loop. With thirty-odd MDAs the loop is several hundred round
 * trips for one page, and it degrades as the State onboards agencies — which is
 * exactly when the ministry is most likely to be looking at it.
 */
@Injectable()
export class PlatformService {
  constructor(private readonly organizations: OrganizationsService) {}

  // ── Audit ──────────────────────────────────────────────────────────────────

  /**
   * Every mutating action in this tier is audited, without exception.
   *
   * A platform operator is the one actor whose reach is not bounded by the
   * tenant scoping that bounds everyone else, so "who did this to our agency"
   * must always have an answer. The write is awaited and NOT swallowed: an
   * audit record that silently fails to write is the failure mode this replaced
   * in the first place.
   */
  private async audit(entry: {
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    organizationId?: string | null;
    previousValue?: unknown;
    newValue?: unknown;
    ipAddress?: string | null;
    requestId?: string | null;
  }) {
    // Delegates to the one writer in `@ace/database`. This was the only place
    // that wrote an audit record, so the agency tier gaining one would have
    // meant a second implementation of the same contract — and two callers
    // that disagree about what an audit record contains is precisely the way
    // a trail becomes untrustworthy.
    const { actorUserId, ...rest } = entry;
    await recordAudit({ ...rest, actor: actorUserId });
  }

  // ── Cross-agency reporting ─────────────────────────────────────────────────

  /**
   * One row per agency: who they are, whether they are in service, and how they
   * are performing. This is the comparative table the ministry actually
   * operates from.
   */
  async listAgencies() {
    const organizations = await prisma.organization.findMany({
      select: {
        id: true, name: true, slug: true, industry: true, phone: true,
        defaultLanguage: true, suspendedAt: true, suspendedReason: true, createdAt: true,
      },
      orderBy: { name: 'asc' },
    });

    const ids = organizations.map((o) => o.id);
    if (ids.length === 0) return { agencies: [], total: 0 };

    const where = { organizationId: { in: ids } };
    const [staff, contacts, conversations, openTickets, calls, bookings, handoffs] =
      await Promise.all([
        prisma.user.groupBy({ by: ['organizationId'], where: { ...where, isActive: true }, _count: { _all: true } }),
        prisma.contact.groupBy({ by: ['organizationId'], where, _count: { _all: true } }),
        prisma.conversation.groupBy({ by: ['organizationId'], where, _count: { _all: true } }),
        prisma.ticket.groupBy({
          by: ['organizationId'],
          where: { ...where, status: { in: ['OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER'] } },
          _count: { _all: true },
        }),
        prisma.callLog.groupBy({ by: ['organizationId'], where, _count: { _all: true } }),
        prisma.booking.groupBy({ by: ['organizationId'], where, _count: { _all: true } }),
        prisma.conversation.groupBy({
          by: ['organizationId'],
          where: { ...where, isHumanHandoffActive: true },
          _count: { _all: true },
        }),
      ]);

    const tally = (rows: Array<{ organizationId: string; _count: { _all: number } }>) =>
      new Map(rows.map((r) => [r.organizationId, r._count._all]));

    const staffBy = tally(staff);
    const contactsBy = tally(contacts);
    const convBy = tally(conversations);
    const ticketsBy = tally(openTickets);
    const callsBy = tally(calls);
    const bookingsBy = tally(bookings);
    const handoffBy = tally(handoffs);

    const agencies = organizations.map((o) => {
      const conversationCount = convBy.get(o.id) ?? 0;
      const handoverCount = handoffBy.get(o.id) ?? 0;
      return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        category: o.industry,
        phone: o.phone,
        defaultLanguage: o.defaultLanguage,
        inService: o.suspendedAt === null,
        suspendedAt: o.suspendedAt,
        suspendedReason: o.suspendedReason,
        onboardedAt: o.createdAt,
        metrics: {
          activeStaff: staffBy.get(o.id) ?? 0,
          citizens: contactsBy.get(o.id) ?? 0,
          conversations: conversationCount,
          calls: callsBy.get(o.id) ?? 0,
          appointments: bookingsBy.get(o.id) ?? 0,
          openCases: ticketsBy.get(o.id) ?? 0,
          // Null rather than 0 when there is nothing to divide: an agency that
          // has handled no conversations has no handover rate, and reporting
          // 0% would rank it top of a league table it never entered.
          handoverRatePercent:
            conversationCount > 0 ? Math.round((handoverCount / conversationCount) * 100) : null,
        },
      };
    });

    return { agencies, total: agencies.length };
  }

  /** State-wide totals, plus what is not yet answering citizens. */
  async overview() {
    const [
      agencyCount, suspendedCount, staffCount, citizenCount,
      conversationCount, callCount, openCaseCount, bookingCount,
      aiMessageCount, totalMessageCount, handoverCount,
      withWhatsApp, withTelephony,
    ] = await Promise.all([
      prisma.organization.count(),
      prisma.organization.count({ where: { suspendedAt: { not: null } } }),
      prisma.user.count({ where: { isActive: true } }),
      prisma.contact.count(),
      prisma.conversation.count(),
      prisma.callLog.count(),
      prisma.ticket.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER'] } } }),
      prisma.booking.count(),
      prisma.message.count({ where: { sender: 'AI' } }),
      prisma.message.count(),
      prisma.conversation.count({ where: { isHumanHandoffActive: true } }),
      prisma.whatsAppConfig.count({ where: { isActive: true } }),
      // A TelephonyConfig row IS the connection — the model has no isActive flag,
      // and a configured number is what decides whether citizens can call.
      prisma.telephonyConfig.count(),
    ]);

    const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null);

    return {
      agencies: {
        total: agencyCount,
        inService: agencyCount - suspendedCount,
        suspended: suspendedCount,
        // Readiness, not activity: an agency with no channel connected cannot
        // receive a citizen at all, however well configured it looks.
        withWhatsAppConnected: withWhatsApp,
        withTelephonyConnected: withTelephony,
      },
      volume: {
        activeStaff: staffCount,
        citizens: citizenCount,
        conversations: conversationCount,
        calls: callCount,
        appointments: bookingCount,
        openCases: openCaseCount,
      },
      service: {
        aiReplyRatePercent: pct(aiMessageCount, totalMessageCount),
        handoverRatePercent: pct(handoverCount, conversationCount),
      },
    };
  }

  /** One agency in detail. Configuration and counts — never citizen content. */
  async getAgency(organizationId: string) {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true, name: true, slug: true, industry: true, country: true, timezone: true,
        defaultLanguage: true, phone: true, logoUrl: true,
        suspendedAt: true, suspendedReason: true, createdAt: true,
        users: {
          where: { isActive: true },
          select: { id: true, fullName: true, email: true, role: true, emailVerifiedAt: true },
          orderBy: { createdAt: 'asc' },
        },
        _count: {
          select: {
            contacts: true, conversations: true, callLogs: true,
            bookings: true, tickets: true, knowledgeDocuments: true, workflows: true,
          },
        },
      },
    });
    if (!org) throw new NotFoundException('Agency not found');

    const [whatsapp, telephony] = await Promise.all([
      prisma.whatsAppConfig.count({ where: { organizationId, isActive: true } }),
      prisma.telephonyConfig.count({ where: { organizationId } }),
    ]);

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      category: org.industry,
      country: org.country,
      timezone: org.timezone,
      defaultLanguage: org.defaultLanguage,
      phone: org.phone,
      logoUrl: org.logoUrl,
      inService: org.suspendedAt === null,
      suspendedAt: org.suspendedAt,
      suspendedReason: org.suspendedReason,
      onboardedAt: org.createdAt,
      channels: { whatsAppConnected: whatsapp > 0, telephonyConnected: telephony > 0 },
      staff: org.users,
      metrics: {
        citizens: org._count.contacts,
        conversations: org._count.conversations,
        calls: org._count.callLogs,
        appointments: org._count.bookings,
        cases: org._count.tickets,
        knowledgeDocuments: org._count.knowledgeDocuments,
        automations: org._count.workflows,
      },
    };
  }

  // ── Agency lifecycle ───────────────────────────────────────────────────────

  /**
   * Bring an agency onto the platform, with its first OWNER invited.
   *
   * The owner is created through the ordinary invite path rather than with a
   * password chosen here: nobody — including the ministry — should know an
   * agency owner's credentials, and the invite flow already issues a one-time
   * link and an unusable password hash.
   */
  async createAgency(
    actor: { userId: string; ipAddress?: string | null },
    dto: {
      name: string;
      category?: IndustryType;
      ownerEmail: string;
      ownerFullName: string;
      phone?: string;
      defaultLanguage?: string;
      timezone?: string;
    }
  ) {
    const name = dto.name?.trim();
    const ownerEmail = dto.ownerEmail?.trim().toLowerCase();
    if (!name) throw new BadRequestException('The agency needs a name.');
    if (!ownerEmail || !dto.ownerFullName?.trim()) {
      throw new BadRequestException('An agency needs a named owner with an email address.');
    }

    // Checked before the organization is written, so a clashing email does not
    // leave an agency with no owner behind it.
    const clash = await prisma.user.findUnique({ where: { email: ownerEmail } });
    if (clash) throw new ConflictException('A user with that email address already exists.');

    const slug = await generateUniqueSlug(name);
    const organization = await prisma.organization.create({
      data: {
        name,
        slug,
        industry: (dto.category ?? 'GOVERNMENT') as IndustryType,
        phone: dto.phone,
        ...(dto.defaultLanguage ? { defaultLanguage: dto.defaultLanguage } : {}),
        ...(dto.timezone ? { timezone: dto.timezone } : {}),
        welcomeMessage: `Hello, you have reached ${name}. How may we help you today?`,
        // No persona is invented here. A persona written by the platform would
        // put words in an agency's mouth that it never approved, and the agent
        // guardrails already supply the safe default behaviour.
      },
      select: { id: true, name: true, slug: true, industry: true },
    });

    // The operator is the actor, and the NEW agency is the organization the
    // record belongs to. So the agency's own trail opens with the invitation
    // that created it, attributed to the ministry — which is exactly what it
    // should say, and is why the actor is threaded through rather than
    // defaulted to whoever happens to be convenient.
    const owner = await this.organizations.addTeamMember(
      organization.id,
      { email: ownerEmail, fullName: dto.ownerFullName.trim(), role: 'OWNER' },
      { userId: actor.userId, ipAddress: actor.ipAddress ?? null }
    );

    await this.audit({
      actorUserId: actor.userId,
      action: 'platform.agency.created',
      targetType: 'Organization',
      targetId: organization.id,
      organizationId: organization.id,
      newValue: { name: organization.name, slug: organization.slug, ownerEmail },
      ipAddress: actor.ipAddress,
    });

    log.info('platform_agency_created', { organizationId: organization.id, actor: actor.userId });
    return { agency: organization, owner: { id: (owner as any)?.id ?? null, email: ownerEmail } };
  }

  /**
   * Take an agency out of service.
   *
   * This is not cosmetic: `JwtStrategy` refuses every member of a suspended
   * agency on their next request, so the agency stops answering citizens
   * straight away. A reason is REQUIRED — a suspension nobody can explain later
   * is indistinguishable from a mistake.
   */
  async suspendAgency(
    actor: { userId: string; ipAddress?: string | null },
    organizationId: string,
    reason: string
  ) {
    const trimmed = reason?.trim();
    if (!trimmed) {
      throw new BadRequestException('A suspension must state a reason. It is recorded and shown to the agency.');
    }

    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, suspendedAt: true, suspendedReason: true },
    });
    if (!org) throw new NotFoundException('Agency not found');
    if (org.suspendedAt) throw new ConflictException('That agency is already suspended.');

    // An operator cannot suspend the agency they themselves belong to: doing so
    // would be the one action that cannot be undone from inside the product,
    // and it is far more likely to be a misclick than an intention.
    const self = await prisma.user.findUnique({
      where: { id: actor.userId },
      select: { organizationId: true },
    });
    if (self?.organizationId === organizationId) {
      throw new BadRequestException('You cannot suspend the agency you belong to.');
    }

    const updated = await prisma.organization.update({
      where: { id: organizationId },
      data: { suspendedAt: new Date(), suspendedReason: trimmed },
      select: { id: true, name: true, suspendedAt: true, suspendedReason: true },
    });

    await this.audit({
      actorUserId: actor.userId,
      action: 'platform.agency.suspended',
      targetType: 'Organization',
      targetId: organizationId,
      organizationId,
      previousValue: { suspendedAt: null },
      newValue: { suspendedAt: updated.suspendedAt, reason: trimmed },
      ipAddress: actor.ipAddress,
    });

    log.warn('platform_agency_suspended', { organizationId, actor: actor.userId, reason: trimmed });
    return { ...updated, inService: false };
  }

  /** Put a suspended agency back into service. */
  async reinstateAgency(
    actor: { userId: string; ipAddress?: string | null },
    organizationId: string
  ) {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, suspendedAt: true, suspendedReason: true },
    });
    if (!org) throw new NotFoundException('Agency not found');
    if (!org.suspendedAt) throw new ConflictException('That agency is not suspended.');

    const updated = await prisma.organization.update({
      where: { id: organizationId },
      data: { suspendedAt: null, suspendedReason: null },
      select: { id: true, name: true, suspendedAt: true },
    });

    await this.audit({
      actorUserId: actor.userId,
      action: 'platform.agency.reinstated',
      targetType: 'Organization',
      targetId: organizationId,
      organizationId,
      previousValue: { suspendedAt: org.suspendedAt, reason: org.suspendedReason },
      newValue: { suspendedAt: null },
      ipAddress: actor.ipAddress,
    });

    log.info('platform_agency_reinstated', { organizationId, actor: actor.userId });
    return { ...updated, inService: true };
  }

  // ── Accountability ─────────────────────────────────────────────────────────

  /**
   * The cross-agency audit trail.
   *
   * Read-only by construction: `AuditLog` is append-only and nothing in the
   * application updates or deletes it, so this tier cannot edit the record of
   * its own actions.
   */
  async auditTrail(filter: { organizationId?: string; action?: string; limit?: number }) {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const entries = await prisma.auditLog.findMany({
      where: {
        ...(filter.organizationId ? { organizationId: filter.organizationId } : {}),
        ...(filter.action ? { action: { startsWith: filter.action } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, organizationId: true, actor: true, action: true,
        targetType: true, targetId: true, previousValue: true, newValue: true,
        ipAddress: true, createdAt: true,
      },
    });
    return { entries, count: entries.length, limit };
  }
}
