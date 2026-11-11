import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';

export type ReportPeriod = 'day' | 'week' | 'month' | 'quarter';
const DAYS: Record<ReportPeriod, number> = { day: 1, week: 7, month: 30, quarter: 91 };

/**
 * The service-standards report (PRD §16): what a supervisor or the Ministry
 * needs to judge whether citizens are being served — not just traffic.
 *
 * Every figure is read independently and an unreadable one is `null` and
 * named in `unavailable`, never 0: "0 overdue callbacks" said while the query
 * failed is the exact failure AnalyticsService was rebuilt to stop.
 *
 * Counts are of PLATFORM USERS. The PRD is explicit that enquiry volumes are
 * not a statistically representative sample of the population, and the
 * payload says so, so nobody downstream presents them as one.
 */
@Injectable()
export class ServiceStandardsService {
  async report(organizationId: string, period: ReportPeriod) {
    const days = DAYS[period] ?? 7;
    const since = new Date(Date.now() - days * 86_400_000);
    const now = new Date();
    const unavailable: string[] = [];
    const read = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch {
        unavailable.push(name);
        return null;
      }
    };
    const OPEN = ['RECEIVED', 'CLASSIFIED', 'ASSIGNED', 'UNDER_REVIEW', 'ACTION_IN_PROGRESS', 'REOPENED'] as any;

    const [
      conversationsByChannel, calls, handedOver, conversations,
      casesOpened, casesResolved, casesOverdue, casesByCategory, casesByLga,
      callbacksPromised, callbacksKept, callbacksFailed, callbacksOverdue,
      referrals, emergencies, languages, gapsOpen, topGaps, voiceEmergencies,
    ] = await Promise.all([
      read('conversationsByChannel', () => prisma.conversation.groupBy({ by: ['channel'], where: { organizationId, createdAt: { gte: since } }, _count: { _all: true } })),
      read('calls', () => prisma.callLog.count({ where: { organizationId, direction: 'INBOUND', startedAt: { gte: since } } })),
      read('handedOver', () => prisma.conversation.count({ where: { organizationId, createdAt: { gte: since }, isHumanHandoffActive: true } })),
      read('conversations', () => prisma.conversation.count({ where: { organizationId, createdAt: { gte: since } } })),
      read('casesOpened', () => prisma.ticket.count({ where: { organizationId, createdAt: { gte: since } } })),
      read('casesResolved', () => prisma.ticket.count({ where: { organizationId, resolvedAt: { gte: since } } })),
      read('casesOverdue', () => prisma.ticket.count({ where: { organizationId, dueAt: { lt: now }, caseStage: { in: OPEN } } })),
      read('casesByCategory', () => prisma.ticket.groupBy({ by: ['category'], where: { organizationId, createdAt: { gte: since } }, _count: { _all: true } })),
      read('casesByLga', () => prisma.ticket.groupBy({ by: ['lga'], where: { organizationId, createdAt: { gte: since } }, _count: { _all: true } })),
      read('callbacksPromised', () => prisma.callbackRequest.count({ where: { organizationId, createdAt: { gte: since } } })),
      read('callbacksKept', () => prisma.callbackRequest.count({ where: { organizationId, createdAt: { gte: since }, status: 'COMPLETED' } })),
      read('callbacksFailed', () => prisma.callbackRequest.count({ where: { organizationId, createdAt: { gte: since }, status: 'FAILED' } })),
      read('callbacksOverdue', () => prisma.callbackRequest.count({ where: { organizationId, status: { in: ['PENDING', 'DUE'] }, dueAt: { lt: new Date(now.getTime() - 3_600_000) } } })),
      read('referrals', () => prisma.mdaReferral.findMany({ where: { organizationId, sentAt: { gte: since } }, select: { mdaName: true, status: true, sentAt: true, respondedAt: true } })),
      read('emergencies', () => prisma.message.count({ where: { conversation: { organizationId }, sentAt: { gte: since }, sender: 'AI', metadata: { path: ['intent'], equals: 'EMERGENCY' } } })),
      read('languages', () => prisma.contact.groupBy({ by: ['preferredLanguage'], where: { organizationId, updatedAt: { gte: since } }, _count: { _all: true } })),
      read('gapsOpen', () => prisma.knowledgeGap.count({ where: { organizationId, status: { in: ['OPEN', 'ASSIGNED'] } } })),
      read('topGaps', () => prisma.knowledgeGap.findMany({ where: { organizationId, status: { in: ['OPEN', 'ASSIGNED'] } }, orderBy: { count: 'desc' }, take: 5, select: { sampleText: true, count: true } })),
      // A call reporting an emergency leaves a callback whose reason starts with this.
      read('voiceEmergencies', () => prisma.callbackRequest.count({ where: { organizationId, createdAt: { gte: since }, reason: { startsWith: 'EMERGENCY REPORTED' } } })),
    ]);

    const pct = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : Math.round((a / b) * 1000) / 10);

    const byMda = new Map<string, { sent: number; responded: number; hours: number[] }>();
    for (const r of referrals ?? []) {
      const e = byMda.get(r.mdaName) ?? { sent: 0, responded: 0, hours: [] };
      e.sent++;
      if (r.respondedAt) {
        e.responded++;
        e.hours.push((r.respondedAt.getTime() - r.sentAt.getTime()) / 3_600_000);
      }
      byMda.set(r.mdaName, e);
    }
    const median = (xs: number[]) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
    };

    return {
      period,
      since: since.toISOString(),
      generatedAt: now.toISOString(),
      note: 'Enquiry volumes describe people who used this service, not a representative sample of the population.',
      unavailable,
      volume: {
        conversationsByChannel: conversationsByChannel ? Object.fromEntries(conversationsByChannel.map((r) => [r.channel, r._count._all])) : null,
        inboundCalls: calls,
      },
      aiResolution: {
        conversations,
        handedToPerson: handedOver,
        // A thread handed over is not one the AI resolved; the rest are not
        // claimed as resolved either — only as not escalated.
        notEscalatedPercent: conversations === null || handedOver === null ? null : pct(conversations - handedOver, conversations),
      },
      cases: {
        opened: casesOpened,
        resolved: casesResolved,
        overdueNow: casesOverdue,
        byCategory: casesByCategory ? Object.fromEntries(casesByCategory.map((r) => [r.category ?? 'unclassified', r._count._all])) : null,
        byLga: casesByLga ? Object.fromEntries(casesByLga.map((r) => [r.lga ?? 'not given', r._count._all])) : null,
      },
      callbacks: {
        promised: callbacksPromised,
        kept: callbacksKept,
        failed: callbacksFailed,
        keptPercent: pct(callbacksKept, callbacksPromised),
        overOneHourLateNow: callbacksOverdue,
      },
      mdaReferrals: referrals === null ? null : [...byMda.entries()].map(([mda, e]) => ({
        mda,
        sent: e.sent,
        responded: e.responded,
        medianHoursToRespond: median(e.hours),
      })),
      emergencies: { whatsapp: emergencies, voice: voiceEmergencies },
      languages: languages ? Object.fromEntries(languages.map((r) => [r.preferredLanguage ?? 'unknown', r._count._all])) : null,
      knowledgeGaps: { open: gapsOpen, mostAsked: topGaps },
    };
  }

  /** The same report as CSV rows, for the daily/weekly/monthly/quarterly pack. */
  toCsv(r: Awaited<ReturnType<ServiceStandardsService['report']>>): string {
    const rows: Array<[string, string, string | number | null]> = [];
    const add = (section: string, metric: string, v: unknown) =>
      rows.push([section, metric, v === null || v === undefined ? 'unavailable' : (v as any)]);
    for (const [k, v] of Object.entries(r.volume.conversationsByChannel ?? {})) add('volume', `conversations_${k}`, v);
    add('volume', 'inbound_calls', r.volume.inboundCalls);
    add('ai', 'conversations', r.aiResolution.conversations);
    add('ai', 'handed_to_person', r.aiResolution.handedToPerson);
    add('cases', 'opened', r.cases.opened);
    add('cases', 'resolved', r.cases.resolved);
    add('cases', 'overdue_now', r.cases.overdueNow);
    for (const [k, v] of Object.entries(r.cases.byCategory ?? {})) add('cases_by_category', k, v);
    for (const [k, v] of Object.entries(r.cases.byLga ?? {})) add('cases_by_lga', k, v);
    add('callbacks', 'promised', r.callbacks.promised);
    add('callbacks', 'kept', r.callbacks.kept);
    add('callbacks', 'failed', r.callbacks.failed);
    add('callbacks', 'over_one_hour_late_now', r.callbacks.overOneHourLateNow);
    for (const m of r.mdaReferrals ?? []) {
      add('mda_referrals', `${m.mda}_sent`, m.sent);
      add('mda_referrals', `${m.mda}_median_hours`, m.medianHoursToRespond);
    }
    add('safety', 'emergencies_whatsapp', r.emergencies.whatsapp);
    add('safety', 'emergencies_voice', r.emergencies.voice);
    for (const [k, v] of Object.entries(r.languages ?? {})) add('languages', k, v);
    add('knowledge', 'open_gaps', r.knowledgeGaps.open);
    const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
    return ['section,metric,value', ...rows.map((row) => row.map(esc).join(','))].join('\n') + '\n';
  }
}
