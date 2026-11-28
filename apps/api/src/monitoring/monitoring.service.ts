import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import { prisma } from '@ace/database';
import { ProviderHealthService, type ProviderCheck } from '../diagnostics/provider-health.service';
import { LocalVoiceService } from '../voice-local/local-voice.service';
import { spitchCircuitState } from '../voice-local/tts';
import { storageRoot } from '../common/object-storage';

/**
 * The system health page: one answer to "is the contact centre working, and
 * if not, what is wrong?" — from what the platform can see itself (providers,
 * calls that fell back, backups, disk) and from the monitor OUTSIDE this
 * server (GitHub Actions, .github/workflows/production-monitor.yml), whose
 * results it receives. Only the outside monitor can report this server down;
 * this page can report that the outside monitor has gone quiet.
 */

/** Thresholds, in one place. */
export const ALERTS = {
  /** The outside monitor runs every 5 minutes; GitHub can delay a scheduled run by several. */
  externalSilentMinutes: 20,
  /** Calls handed to the backup line in the last hour before it is an alert. */
  failoversPerHour: 3,
  /** A nightly backup older than this is missing. */
  backupMaxAgeHours: 26,
  /** Free space on the data volume below this is an alert. */
  diskMinFreePercent: 15,
  /** Callers in the last hour who waited the whole limit (or found the waiting room full) before this is critical; one is a warning. */
  queueUnansweredPerHour: 5,
};

/** The waiting room in numbers: who waited, for how long, and who could not be answered. */
export interface QueueSummary {
  /** Callers in the waiting room now: joined in the last 10 minutes, not yet out. */
  waitingNow: number;
  joined24h: number;
  admitted24h: number;
  abandoned24h: number;
  /** Waited the whole limit. */
  timedOut24h: number;
  /** The waiting room itself was full. */
  full24h: number;
  callbacks24h: number;
  /** Timed out or found it full, in the last hour. */
  unansweredLastHour: number;
  longestWaitSeconds24h: number | null;
  averageWaitSeconds24h: number | null;
}

/** Pure: from the last 24 h of voice_queue events (any order). */
export function summarizeQueue(events: Array<{ status: string; createdAt: Date; detail: any }>, now: Date): QueueSummary {
  const hourAgo = now.getTime() - 3600_000;
  const tenAgo = now.getTime() - 10 * 60_000;
  const count = (st: string) => events.filter((e) => e.status === st).length;
  const exits = new Set(['admitted', 'abandoned', 'timeout']);
  const left = new Set(events.filter((e) => exits.has(e.status)).map((e) => e.detail?.ticket).filter((t) => t !== undefined));
  const waitingNow = events.filter((e) => e.status === 'joined' && e.createdAt.getTime() >= tenAgo && e.detail?.ticket !== undefined && !left.has(e.detail.ticket)).length;
  const waits = events
    .filter((e) => exits.has(e.status) && Number.isFinite(Number(e.detail?.waitSeconds)))
    .map((e) => Number(e.detail.waitSeconds));
  return {
    waitingNow,
    joined24h: count('joined'),
    admitted24h: count('admitted'),
    abandoned24h: count('abandoned'),
    timedOut24h: count('timeout'),
    full24h: count('full'),
    callbacks24h: count('callback'),
    unansweredLastHour: events.filter((e) => (e.status === 'timeout' || e.status === 'full') && e.createdAt.getTime() >= hourAgo).length,
    longestWaitSeconds24h: waits.length ? Math.max(...waits) : null,
    averageWaitSeconds24h: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
  };
}

export interface HealthSnapshot {
  now: Date;
  external: { last: { at: Date; status: string; detail: any } | null; checks24h: number; failed24h: number };
  providers: ProviderCheck[];
  voice: { enabled: boolean; ready: boolean; missing: string[]; spitchCircuitOpen: boolean };
  phone: { callsToday: number; failoversLastHour: number; failovers24h: Array<{ reason: string; count: number }>; lastFailover: { at: Date; reason: string } | null };
  queue: QueueSummary;
  backup: { last: { at: Date; status: string; detail: any } | null };
  disk: { freePercent: number; freeGb: number } | null;
}

export interface Alert {
  id: string;
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
}

/** What needs attention now, most serious first. Pure: the page and the tests use it alike. */
export function alertsFor(s: HealthSnapshot): Alert[] {
  const out: Alert[] = [];
  const ageMin = (d: Date) => (s.now.getTime() - d.getTime()) / 60_000;

  if (!s.external.last) {
    out.push({ id: 'external-never', severity: 'warning', title: 'The outside monitor has not reported yet', detail: 'Set MONITOR_TOKEN on the server and as a GitHub secret (see PRODUCTION_SIGNOFF.md §12). Until then nobody is told if this server goes down.' });
  } else {
    if (ageMin(s.external.last.at) > ALERTS.externalSilentMinutes) {
      out.push({ id: 'external-silent', severity: 'critical', title: 'The outside monitor has gone quiet', detail: `Last report ${Math.round(ageMin(s.external.last.at))} minutes ago. Check the "Production monitor" workflow on GitHub.` });
    }
    if (s.external.last.status !== 'ok') {
      out.push({ id: 'external-failing', severity: 'critical', title: 'The outside monitor reports a problem', detail: String(s.external.last.detail?.summary ?? 'See the open "Production alert" issue on GitHub.') });
    }
  }

  if (s.voice.enabled && !s.voice.ready) {
    out.push({ id: 'voice-not-ready', severity: 'critical', title: 'The phone line is not answering calls itself', detail: `Every call goes to the backup line. Missing: ${s.voice.missing.join(', ') || 'the call listener'}.` });
  }
  if (s.voice.spitchCircuitOpen) {
    out.push({ id: 'spitch-circuit', severity: 'critical', title: 'The phone line voice (Spitch) keeps failing', detail: 'New calls are sent to the backup line until Spitch answers again.' });
  }
  for (const p of s.providers.filter((x) => x.state === 'failed')) {
    out.push({ id: `provider-${p.id}`, severity: ['openai', 'spitch', 'deepgram'].includes(p.id) ? 'critical' : 'warning', title: `${p.label}: not working`, detail: `${p.detail} ${p.consequence}`.trim() });
  }

  if (s.phone.failoversLastHour >= ALERTS.failoversPerHour) {
    const top = s.phone.failovers24h[0];
    out.push({ id: 'failovers', severity: 'critical', title: `${s.phone.failoversLastHour} calls went to the backup line in the last hour`, detail: top ? `Most common reason today: ${top.reason} (${top.count}).` : '' });
  }

  if (s.queue.unansweredLastHour > 0) {
    const n = s.queue.unansweredLastHour;
    out.push({
      id: 'queue-unanswered',
      severity: n >= ALERTS.queueUnansweredPerHour ? 'critical' : 'warning',
      title: `${n} caller${n === 1 ? '' : 's'} could not be answered in the last hour`,
      detail: 'Every line stayed busy for their whole wait, or the waiting room was full. They were offered a callback: see Callbacks. More lines (MAX_CONCURRENT_CALLS, within the carrier and Spitch limits) would answer them.',
    });
  }

  if (!s.backup.last) {
    out.push({ id: 'backup-never', severity: 'critical', title: 'No backup has been recorded', detail: 'Run deploy/single-server/backup.sh, and check the ace-backup timer.' });
  } else {
    const hours = ageMin(s.backup.last.at) / 60;
    if (s.backup.last.status !== 'ok') {
      out.push({ id: 'backup-failed', severity: 'critical', title: 'The last backup failed', detail: String(s.backup.last.detail?.error ?? 'See: journalctl -u ace-backup') });
    } else if (hours > ALERTS.backupMaxAgeHours) {
      out.push({ id: 'backup-stale', severity: 'critical', title: `No backup for ${Math.round(hours)} hours`, detail: 'The nightly backup has not run. Check: systemctl status ace-backup.timer' });
    } else if (s.backup.last.detail?.offsite !== true) {
      out.push({ id: 'backup-local-only', severity: 'warning', title: 'The last backup is on this server only', detail: 'BACKUP_REMOTE is empty: the backup is lost with the server\'s disk.' });
    }
  }

  if (s.disk && s.disk.freePercent < ALERTS.diskMinFreePercent) {
    out.push({ id: 'disk', severity: s.disk.freePercent < 5 ? 'critical' : 'warning', title: `Disk ${s.disk.freePercent}% free`, detail: `${s.disk.freeGb} GB left on the data volume. Recordings and backups stop when it is full.` });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
}

/** Free space where the files are kept (recordings, backups' source). Null where it cannot be read. */
export function diskFree(dir: string): { freePercent: number; freeGb: number } | null {
  try {
    const st = (fs as any).statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    const total = Number(st.blocks) * Number(st.bsize);
    if (!total) return null;
    return { freePercent: Math.round((free / total) * 100), freeGb: Math.round((free / 1e9) * 10) / 10 };
  } catch {
    return null;
  }
}

@Injectable()
export class MonitoringService {
  constructor(
    private readonly providers: ProviderHealthService,
    private readonly voice: LocalVoiceService,
  ) {}

  async snapshot(organizationId: string, now = new Date()): Promise<HealthSnapshot> {
    const dayAgo = new Date(now.getTime() - 24 * 3600_000);
    const hourAgo = new Date(now.getTime() - 3600_000);
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);

    const [lastExternal, checks24h, failed24h, failoversLastHour, failoverGroups, lastFailover, lastBackup, callsToday, providerReport, queueEvents] = await Promise.all([
      prisma.systemEvent.findFirst({ where: { kind: 'external_check' }, orderBy: { createdAt: 'desc' } }),
      prisma.systemEvent.count({ where: { kind: 'external_check', createdAt: { gte: dayAgo } } }),
      prisma.systemEvent.count({ where: { kind: 'external_check', createdAt: { gte: dayAgo }, NOT: { status: 'ok' } } }),
      prisma.systemEvent.count({ where: { kind: 'voice_failover', createdAt: { gte: hourAgo } } }),
      prisma.systemEvent.groupBy({ by: ['status'], where: { kind: 'voice_failover', createdAt: { gte: dayAgo } }, _count: { _all: true } }),
      prisma.systemEvent.findFirst({ where: { kind: 'voice_failover' }, orderBy: { createdAt: 'desc' } }),
      prisma.systemEvent.findFirst({ where: { kind: 'backup' }, orderBy: { createdAt: 'desc' } }),
      prisma.callLog.count({ where: { organizationId, startedAt: { gte: startOfDay } } }),
      this.providers.check(organizationId),
      prisma.systemEvent.findMany({ where: { kind: 'voice_queue', createdAt: { gte: dayAgo } }, select: { status: true, createdAt: true, detail: true }, orderBy: { createdAt: 'desc' }, take: 20_000 }),
    ]);
    const r = this.voice.readiness();
    return {
      now,
      external: { last: lastExternal ? { at: lastExternal.createdAt, status: lastExternal.status, detail: lastExternal.detail } : null, checks24h, failed24h },
      providers: providerReport.providers,
      voice: { enabled: r.enabled, ready: r.ready, missing: r.missing, spitchCircuitOpen: spitchCircuitState().open },
      phone: {
        callsToday,
        failoversLastHour,
        failovers24h: failoverGroups.map((g: any) => ({ reason: g.status, count: g._count._all })).sort((a: any, b: any) => b.count - a.count),
        lastFailover: lastFailover ? { at: lastFailover.createdAt, reason: String((lastFailover.detail as any)?.reason ?? lastFailover.status) } : null,
      },
      queue: summarizeQueue(queueEvents, now),
      backup: { last: lastBackup ? { at: lastBackup.createdAt, status: lastBackup.status, detail: lastBackup.detail } : null },
      disk: diskFree(storageRoot()),
    };
  }

  async status(organizationId: string) {
    const s = await this.snapshot(organizationId);
    const alerts = alertsFor(s);
    return {
      checkedAt: s.now.toISOString(),
      overall: alerts.some((a) => a.severity === 'critical') ? 'critical' : alerts.length ? 'warning' : 'ok',
      alerts,
      ...s,
      external: { ...s.external, uptime24hPercent: s.external.checks24h ? Math.round(((s.external.checks24h - s.external.failed24h) / s.external.checks24h) * 1000) / 10 : null },
    };
  }

  /**
   * The coarse state the outside monitor reads, unauthenticated: ok, degraded
   * or down, and nothing else (no provider names, no reasons, no counts).
   */
  async publicVoiceState(now = new Date()): Promise<'ok' | 'degraded' | 'down' | 'disabled'> {
    const r = this.voice.readiness();
    if (!r.enabled) return 'disabled';
    if (!r.ready) return 'down';
    if (spitchCircuitState().open) return 'degraded';
    const recent = await prisma.systemEvent
      .count({ where: { kind: 'voice_failover', createdAt: { gte: new Date(now.getTime() - 15 * 60_000) } } })
      .catch(() => 0);
    return recent >= ALERTS.failoversPerHour ? 'degraded' : 'ok';
  }
}
