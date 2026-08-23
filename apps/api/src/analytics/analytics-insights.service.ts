/**
 * Operational analytics — the questions staff actually ask, answered from the
 * data this platform already records.
 *
 * The dashboard summary next door is counts: how many conversations, how many
 * bookings. This module is the layer that was missing — WHAT customers ask for
 * (intent distribution), WHY conversations end up with a human (handoff
 * reasons, trustworthy since the overwrite fix), WHEN demand arrives (hourly
 * curve, so staffing can follow it), and WHERE the work is (services booked,
 * ticket flow, languages spoken).
 *
 * Design rules, each earned earlier in this codebase's life:
 *
 *   - Every query is scoped by organizationId. No exceptions; multi-tenancy
 *     has no automatic filter here.
 *   - Aggregation happens in SQL, not by fetching rows and reducing in JS —
 *     a tenant with 100k messages must not cost 100k rows per dashboard load.
 *   - Sections degrade independently: one failed aggregate returns its empty
 *     shape rather than blanking the whole page.
 *   - Empty is a real answer. Intent data only exists from the release that
 *     started persisting it, and the response says so via `since` rather than
 *     letting an empty chart read as "no customers".
 */
import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';
import { AceLogger } from '../config/logger';

const log = new AceLogger('AnalyticsInsights');

type Period = '7d' | '30d' | '90d';

const periodToDays = (period: Period): number =>
  period === '90d' ? 90 : period === '30d' ? 30 : 7;

export interface OperationalInsights {
  period: Period;
  since: string;
  volumeTrend: Array<{
    date: string;
    customerMessages: number;
    aiMessages: number;
    calls: number;
    bookings: number;
  }>;
  intentDistribution: Array<{ intent: string; count: number }>;
  handoffReasons: Array<{ reason: string; count: number }>;
  hourlyDemand: Array<{ hour: number; messages: number; calls: number }>;
  bookingFunnel: {
    byStatus: Array<{ status: string; count: number }>;
    topServices: Array<{ serviceName: string; count: number }>;
    upcomingWeek: Array<{ date: string; count: number }>;
  };
  ticketFlow: {
    opened: number;
    resolved: number;
    openByPriority: Array<{ priority: string; count: number }>;
    refundRequests: number;
  };
  languages: Array<{ language: string; count: number }>;
  /**
   * Calls the platform could not answer — almost always every concurrent slot
   * on the workspace plan being in use. This is the only number that says how
   * many people tried to reach the helpline and did not get through, so it is
   * reported even when it is zero rather than being omitted as uninteresting.
   */
  callsNotConnected: number;
}

@Injectable()
export class AnalyticsInsightsService {
  async getOperationalInsights(
    organizationId: string,
    period: Period = '7d'
  ): Promise<OperationalInsights> {
    const days = periodToDays(period);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [
      volumeTrend,
      intentDistribution,
      handoffReasons,
      hourlyDemand,
      bookingFunnel,
      ticketFlow,
      languages,
      callsNotConnected,
    ] = await Promise.all([
      this.volumeTrend(organizationId, since).catch(this.empty('volumeTrend', [])),
      this.intentDistribution(organizationId, since).catch(this.empty('intentDistribution', [])),
      this.handoffReasons(organizationId).catch(this.empty('handoffReasons', [])),
      this.hourlyDemand(organizationId, since).catch(this.empty('hourlyDemand', [])),
      this.bookingFunnel(organizationId, since).catch(
        this.empty('bookingFunnel', { byStatus: [], topServices: [], upcomingWeek: [] })
      ),
      this.ticketFlow(organizationId, since).catch(
        this.empty('ticketFlow', { opened: 0, resolved: 0, openByPriority: [], refundRequests: 0 })
      ),
      this.languages(organizationId).catch(this.empty('languages', [])),
      this.callsNotConnected(organizationId, since).catch(this.empty('callsNotConnected', 0)),
    ]);

    return {
      period,
      since: since.toISOString(),
      volumeTrend,
      intentDistribution,
      handoffReasons,
      hourlyDemand,
      bookingFunnel,
      ticketFlow,
      languages,
      callsNotConnected,
    };
  }

  /**
   * How many callers could not be connected in the period.
   *
   * Written by the `call_initiation_failure` webhook. A zero here means either
   * a healthy line or a line nobody called — the volume trend beside it tells
   * those apart, which is why this is a bare count and not a rate.
   */
  private async callsNotConnected(organizationId: string, since: Date): Promise<number> {
    return prisma.callLog.count({
      where: { organizationId, status: 'FAILED', startedAt: { gte: since } },
    });
  }

  /** One failed section logs and yields its empty shape — never a blank page. */
  private empty<T>(section: string, value: T) {
    return (err: unknown): T => {
      log.warn('insights_section_failed', {
        section,
        error: err instanceof Error ? err.message : String(err),
      });
      return value;
    };
  }

  /** Messages in/out, calls and bookings per day — the shape of the workload. */
  private async volumeTrend(organizationId: string, since: Date) {
    const rows = await prisma.$queryRaw<
      Array<{ date: string; customer: bigint; ai: bigint; calls: bigint; bookings: bigint }>
    >`
      WITH days AS (
        SELECT generate_series(date_trunc('day', ${since}::timestamptz),
                               date_trunc('day', now()), '1 day') AS day
      ),
      msg AS (
        SELECT date_trunc('day', m."sentAt") AS day,
               count(*) FILTER (WHERE m."sender" = 'CUSTOMER') AS customer,
               count(*) FILTER (WHERE m."sender" = 'AI')       AS ai
        FROM "messages" m
        JOIN "conversations" c ON c."id" = m."conversationId"
        WHERE c."organizationId" = ${organizationId} AND m."sentAt" >= ${since}
        GROUP BY 1
      ),
      cl AS (
        SELECT date_trunc('day', "startedAt") AS day, count(*) AS calls
        FROM "call_logs"
        WHERE "organizationId" = ${organizationId} AND "startedAt" >= ${since}
        GROUP BY 1
      ),
      bk AS (
        SELECT date_trunc('day', "createdAt") AS day, count(*) AS bookings
        FROM "bookings"
        WHERE "organizationId" = ${organizationId} AND "createdAt" >= ${since}
        GROUP BY 1
      )
      SELECT to_char(days.day, 'YYYY-MM-DD') AS date,
             COALESCE(msg.customer, 0) AS customer,
             COALESCE(msg.ai, 0)       AS ai,
             COALESCE(cl.calls, 0)     AS calls,
             COALESCE(bk.bookings, 0)  AS bookings
      FROM days
      LEFT JOIN msg ON msg.day = days.day
      LEFT JOIN cl  ON cl.day  = days.day
      LEFT JOIN bk  ON bk.day  = days.day
      ORDER BY days.day`;

    return rows.map((r) => ({
      date: r.date,
      customerMessages: Number(r.customer),
      aiMessages: Number(r.ai),
      calls: Number(r.calls),
      bookings: Number(r.bookings),
    }));
  }

  /**
   * What customers ask for, from the intent persisted on each AI reply.
   *
   * Data exists from the release that started writing it — an empty chart on
   * day one means "no labelled traffic yet", and the UI says so.
   */
  private async intentDistribution(organizationId: string, since: Date) {
    const rows = await prisma.$queryRaw<Array<{ intent: string; count: bigint }>>`
      SELECT m."metadata"->>'intent' AS intent, count(*) AS count
      FROM "messages" m
      JOIN "conversations" c ON c."id" = m."conversationId"
      WHERE c."organizationId" = ${organizationId}
        AND m."sentAt" >= ${since}
        AND m."sender" = 'AI'
        AND m."metadata"->>'intent' IS NOT NULL
      GROUP BY 1
      ORDER BY count(*) DESC
      LIMIT 15`;
    return rows.map((r) => ({ intent: r.intent, count: Number(r.count) }));
  }

  /**
   * Why conversations needed a person. Current state, not period-scoped: an
   * open handoff from last month is still a thread someone must pick up.
   */
  private async handoffReasons(organizationId: string) {
    const rows = await prisma.conversation.groupBy({
      by: ['handoffReason'],
      where: { organizationId, isHumanHandoffActive: true },
      _count: { _all: true },
    });
    return rows
      .map((r) => ({
        reason: r.handoffReason ?? 'UNSPECIFIED',
        count: r._count._all,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /** When demand arrives, hour by hour (Africa/Lagos) — staffing follows this. */
  private async hourlyDemand(organizationId: string, since: Date) {
    const rows = await prisma.$queryRaw<Array<{ hour: number; messages: bigint; calls: bigint }>>`
      WITH hours AS (SELECT generate_series(0, 23) AS hour),
      msg AS (
        SELECT EXTRACT(hour FROM m."sentAt" AT TIME ZONE 'Africa/Lagos')::int AS hour,
               count(*) AS messages
        FROM "messages" m
        JOIN "conversations" c ON c."id" = m."conversationId"
        WHERE c."organizationId" = ${organizationId}
          AND m."sentAt" >= ${since} AND m."sender" = 'CUSTOMER'
        GROUP BY 1
      ),
      cl AS (
        SELECT EXTRACT(hour FROM "startedAt" AT TIME ZONE 'Africa/Lagos')::int AS hour,
               count(*) AS calls
        FROM "call_logs"
        WHERE "organizationId" = ${organizationId} AND "startedAt" >= ${since}
        GROUP BY 1
      )
      SELECT hours.hour, COALESCE(msg.messages, 0) AS messages, COALESCE(cl.calls, 0) AS calls
      FROM hours
      LEFT JOIN msg ON msg.hour = hours.hour
      LEFT JOIN cl  ON cl.hour  = hours.hour
      ORDER BY hours.hour`;
    return rows.map((r) => ({
      hour: Number(r.hour),
      messages: Number(r.messages),
      calls: Number(r.calls),
    }));
  }

  private async bookingFunnel(organizationId: string, since: Date) {
    const [byStatusRaw, topServicesRaw, upcomingRaw] = await Promise.all([
      prisma.booking.groupBy({
        by: ['status'],
        where: { organizationId, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.booking.groupBy({
        by: ['serviceName'],
        where: { organizationId, createdAt: { gte: since } },
        _count: { _all: true },
        orderBy: { _count: { serviceName: 'desc' } },
        take: 5,
      }),
      prisma.$queryRaw<Array<{ date: string; count: bigint }>>`
        WITH days AS (
          SELECT generate_series(date_trunc('day', now()),
                                 date_trunc('day', now()) + interval '6 days', '1 day') AS day
        )
        SELECT to_char(days.day, 'YYYY-MM-DD') AS date, COALESCE(b.count, 0) AS count
        FROM days
        LEFT JOIN (
          SELECT date_trunc('day', "startTime") AS day, count(*) AS count
          FROM "bookings"
          WHERE "organizationId" = ${organizationId}
            AND "startTime" >= date_trunc('day', now())
            AND "startTime" <  date_trunc('day', now()) + interval '7 days'
            AND "status" IN ('CONFIRMED', 'RESCHEDULED')
          GROUP BY 1
        ) b ON b.day = days.day
        ORDER BY days.day`,
    ]);

    return {
      byStatus: byStatusRaw.map((r) => ({ status: r.status, count: r._count._all })),
      topServices: topServicesRaw.map((r) => ({
        serviceName: r.serviceName,
        count: r._count._all,
      })),
      upcomingWeek: upcomingRaw.map((r) => ({ date: r.date, count: Number(r.count) })),
    };
  }

  private async ticketFlow(organizationId: string, since: Date) {
    const [opened, resolved, openByPriorityRaw, refundRequests] = await Promise.all([
      prisma.ticket.count({ where: { organizationId, createdAt: { gte: since } } }),
      prisma.ticket.count({
        where: { organizationId, status: 'RESOLVED', updatedAt: { gte: since } },
      }),
      prisma.ticket.groupBy({
        by: ['priority'],
        where: { organizationId, status: 'OPEN' },
        _count: { _all: true },
      }),
      // Refunds carry the REF- prefix precisely so staff can tell them apart.
      prisma.ticket.count({
        where: { organizationId, createdAt: { gte: since }, ticketNumber: { startsWith: 'REF-' } },
      }),
    ]);

    const priorityOrder = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];
    return {
      opened,
      resolved,
      openByPriority: openByPriorityRaw
        .map((r) => ({ priority: r.priority, count: r._count._all }))
        .sort((a, b) => priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority)),
      refundRequests,
    };
  }

  /**
   * Languages customers are known to prefer. "unknown" is the honest bucket
   * for contacts whose language has not been observed yet — never guessed.
   */
  private async languages(organizationId: string) {
    const rows = await prisma.contact.groupBy({
      by: ['preferredLanguage'],
      where: { organizationId },
      _count: { _all: true },
    });
    return rows
      .map((r) => ({ language: r.preferredLanguage ?? 'unknown', count: r._count._all }))
      .sort((a, b) => b.count - a.count);
  }
}
