/**
 * The System Health page and the monitor outside the server: alerts are
 * raised at the right thresholds, failovers are counted by their real
 * reason, the model check catches an account with no credit (28 Nov 2026:
 * the model list answered 200 while every call failed over), and the
 * endpoints keep their access rules.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, type TestTenant } from './support/tenant';
import { alertsFor, ALERTS, diskFree, summarizeQueue, type HealthSnapshot } from '../src/monitoring/monitoring.service';
import { failoverReason, recordSystemEvent } from '../src/monitoring/system-events';
import { monitorTokenMatches } from '../src/monitoring/monitoring.controller';
import { clearProviderCheckCache, modelRefusal, ProviderHealthService } from '../src/diagnostics/provider-health.service';

const NOW = new Date('2026-11-28T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const healthy = (): HealthSnapshot => ({
  now: NOW,
  external: { last: { at: minsAgo(3), status: 'ok', detail: {} }, checks24h: 288, failed24h: 0 },
  providers: [{ id: 'openai', label: 'Answer synthesis (OpenAI)', state: 'ok', detail: 'ok', consequence: '' }],
  voice: { enabled: true, ready: true, missing: [], spitchCircuitOpen: false },
  phone: { callsToday: 12, failoversLastHour: 0, failovers24h: [], lastFailover: null },
  queue: summarizeQueue([], NOW),
  backup: { last: { at: minsAgo(8 * 60), status: 'ok', detail: { offsite: true } } },
  disk: { freePercent: 60, freeGb: 120 },
});
const ids = (s: HealthSnapshot) => alertsFor(s).map((a) => a.id);

describe('alerts on the System Health page', () => {
  it('raises nothing when everything is working', () => {
    expect(alertsFor(healthy())).toEqual([]);
  });

  it('the outside monitor: not reporting yet, gone quiet, or reporting a problem', () => {
    expect(ids({ ...healthy(), external: { last: null, checks24h: 0, failed24h: 0 } })).toEqual(['external-never']);
    const quiet = { ...healthy(), external: { ...healthy().external, last: { at: minsAgo(ALERTS.externalSilentMinutes + 5), status: 'ok', detail: {} } } };
    expect(alertsFor(quiet)[0]).toMatchObject({ id: 'external-silent', severity: 'critical' });
    expect(ids({ ...healthy(), external: { ...healthy().external, last: { at: minsAgo(ALERTS.externalSilentMinutes - 5), status: 'ok', detail: {} } } })).toEqual([]);
    const failing = { ...healthy(), external: { ...healthy().external, last: { at: minsAgo(2), status: 'failed', detail: { summary: 'the database is not reachable.' } } } };
    expect(alertsFor(failing)[0]).toMatchObject({ id: 'external-failing', detail: 'the database is not reachable.' });
  });

  it('the phone line: not ready, Spitch failing, calls going to the backup line', () => {
    expect(ids({ ...healthy(), voice: { enabled: true, ready: false, missing: ['DEEPGRAM_API_KEY'], spitchCircuitOpen: false } })).toEqual(['voice-not-ready']);
    expect(ids({ ...healthy(), voice: { enabled: false, ready: false, missing: [], spitchCircuitOpen: false } })).toEqual([]); // off by choice: the backup line answers
    expect(ids({ ...healthy(), voice: { ...healthy().voice, spitchCircuitOpen: true } })).toEqual(['spitch-circuit']);
    const phone = (n: number) => ({ ...healthy(), phone: { ...healthy().phone, failoversLastHour: n, failovers24h: [{ reason: 'openai_no_credit', count: n }] } });
    expect(ids(phone(ALERTS.failoversPerHour - 1))).toEqual([]);
    expect(alertsFor(phone(ALERTS.failoversPerHour))[0]).toMatchObject({ id: 'failovers', detail: `Most common reason today: openai_no_credit (${ALERTS.failoversPerHour}).` });
  });

  it('the waiting room: a caller not answered in time is a warning, several in an hour critical', () => {
    const q = (n: number) => ({ ...healthy(), queue: { ...healthy().queue, unansweredLastHour: n } });
    expect(ids(q(0))).toEqual([]);
    expect(alertsFor(q(1))[0]).toMatchObject({ id: 'queue-unanswered', severity: 'warning', title: '1 caller could not be answered in the last hour' });
    expect(alertsFor(q(ALERTS.queueUnansweredPerHour - 1))[0].severity).toBe('warning');
    expect(alertsFor(q(ALERTS.queueUnansweredPerHour))[0]).toMatchObject({ severity: 'critical', title: `${ALERTS.queueUnansweredPerHour} callers could not be answered in the last hour` });
  });

  it('counts the waiting room: who is waiting now, waits, timeouts, the room full, callbacks', () => {
    const e = (status: string, m: number, detail: any = {}) => ({ status, createdAt: minsAgo(m), detail });
    const q = summarizeQueue(
      [
        e('joined', 300, { ticket: 1 }), e('admitted', 299, { ticket: 1, waitSeconds: 40 }),
        e('joined', 200, { ticket: 2 }), e('abandoned', 199, { ticket: 2, waitSeconds: 20 }),
        e('joined', 90, { ticket: 3 }), e('timeout', 87, { ticket: 3, waitSeconds: 180 }), e('callback', 87),
        e('joined', 30, { ticket: 4 }), e('timeout', 27, { ticket: 4, waitSeconds: 180 }), e('callback', 27),
        e('full', 20), e('callback', 20),
        e('joined', 2, { ticket: 5 }), // still waiting
        e('joined', 1, { ticket: 6 }), // still waiting
        e('joined', 4, { ticket: 7 }), e('admitted', 3, { ticket: 7, waitSeconds: 60 }),
        e('joined', 15, { ticket: 8 }), // joined long ago with no exit seen (Asterisk restarted): not "waiting now"
      ],
      NOW,
    );
    expect(q).toEqual({
      waitingNow: 2,
      joined24h: 8,
      admitted24h: 2,
      abandoned24h: 1,
      timedOut24h: 2,
      full24h: 1,
      callbacks24h: 3,
      unansweredLastHour: 2, // ticket 4's timeout and the full room; ticket 3 was 87 min ago
      longestWaitSeconds24h: 180,
      averageWaitSeconds24h: 96, // (40 + 20 + 180 + 180 + 60) / 5
    });
    expect(summarizeQueue([], NOW)).toMatchObject({ waitingNow: 0, longestWaitSeconds24h: null, averageWaitSeconds24h: null });
  });

  it('providers: the voice, model and recognition are critical; email is a warning', () => {
    const p = (id: string) => ({ ...healthy(), providers: [{ id, label: id, state: 'failed' as const, detail: 'refused', consequence: 'x' }] });
    expect(alertsFor(p('openai'))[0].severity).toBe('critical');
    expect(alertsFor(p('spitch'))[0].severity).toBe('critical');
    expect(alertsFor(p('email'))[0].severity).toBe('warning');
  });

  it('backups: never, failed, stale, or on this server only', () => {
    const b = (last: any) => ({ ...healthy(), backup: { last } });
    expect(ids(b(null))).toEqual(['backup-never']);
    expect(ids(b({ at: minsAgo(60), status: 'failed', detail: { error: 'backup.sh exited 1' } }))).toEqual(['backup-failed']);
    expect(ids(b({ at: minsAgo((ALERTS.backupMaxAgeHours + 1) * 60), status: 'ok', detail: { offsite: true } }))).toEqual(['backup-stale']);
    expect(ids(b({ at: minsAgo(60), status: 'ok', detail: { offsite: false } }))).toEqual(['backup-local-only']);
  });

  it('disk: a warning below 15% free, critical below 5%; critical alerts come first', () => {
    expect(alertsFor({ ...healthy(), disk: { freePercent: 10, freeGb: 20 } })[0]).toMatchObject({ id: 'disk', severity: 'warning' });
    expect(alertsFor({ ...healthy(), disk: { freePercent: 3, freeGb: 6 } })[0]).toMatchObject({ id: 'disk', severity: 'critical' });
    const both = alertsFor({ ...healthy(), disk: { freePercent: 10, freeGb: 20 }, backup: { last: null } });
    expect(both.map((a) => a.severity)).toEqual(['critical', 'warning']);
    expect(diskFree(process.cwd())!.freePercent).toBeGreaterThan(0); // reads a real volume
    expect(diskFree('/no/such/dir')).toBeNull();
  });
});

describe('why a call went to the backup line', () => {
  it('reads the real failure texts', () => {
    expect(failoverReason('model: Language model refused (HTTP 429) {"error":{"message":"You have no credits remaining. Add credits to continue","type":"insufficient_quota"}}')).toBe('openai_no_credit');
    expect(failoverReason('model: Language model refused (HTTP 429) Request too large for gpt-4o on tokens per min (TPM): Limit 10000')).toBe('openai_rate_limit');
    expect(failoverReason('model: Language model refused (HTTP 500)')).toBe('openai_error');
    expect(failoverReason('fallback spitch-circuit-open')).toBe('spitch');
    expect(failoverReason('speech recognition: Speech recognition closed (1011)')).toBe('deepgram');
    expect(failoverReason('fallback busy')).toBe('busy');
    expect(failoverReason('fallback not-ready')).toBe('not_ready');
  });
});

describe('the outside monitor token', () => {
  it('matches only a long enough, identical token', () => {
    const t = 'a'.repeat(32);
    expect(monitorTokenMatches(t, t)).toBe(true);
    expect(monitorTokenMatches('b'.repeat(32), t)).toBe(false);
    expect(monitorTokenMatches(undefined, t)).toBe(false);
    expect(monitorTokenMatches('short', 'short')).toBe(false); // a weak token never works
    expect(monitorTokenMatches('', '')).toBe(false); // nor an unset one
  });
});

describe('provider checks that spend a fraction of a cent', () => {
  const saved = { ...process.env };
  const realFetch = global.fetch;
  let calls: string[] = [];
  const respond = (routes: Array<[RegExp, number, string]>) => {
    (global as any).fetch = async (url: string) => {
      calls.push(String(url));
      const hit = routes.find(([re]) => re.test(String(url)));
      return new Response(hit ? hit[2] : '{}', { status: hit ? hit[1] : 404 });
    };
  };
  beforeEach(() => {
    calls = [];
    clearProviderCheckCache();
    for (const k of ['DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY', 'QDRANT_URL', 'RESEND_API_KEY', 'SPITCH_API_KEY', 'LLM_BASE_URL']) delete process.env[k];
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.LOCAL_VOICE_LLM_MODEL = 'gpt-4.1';
  });
  afterAll(() => {
    process.env = saved;
    (global as any).fetch = realFetch;
  });
  const openai = async () => (await new ProviderHealthService().check('org')).providers.find((p) => p.id === 'openai')!;

  it('an account with no credit is FAILED, although its model list answers 200 (the 28 Nov outage)', async () => {
    respond([
      [/\/models$/, 200, '{"data":[]}'],
      [/chat\/completions/, 429, '{"error":{"message":"You have no credits remaining.","type":"insufficient_quota"}}'],
    ]);
    const c = await openai();
    expect(c.state).toBe('failed');
    expect(c.detail).toMatch(/NO CREDIT: every phone call fails over/);
    expect(calls.some((u) => /chat\/completions/.test(u))).toBe(true);
  });

  it('a funded account is ok, and the one-token request is not repeated within five minutes', async () => {
    respond([[/\/models$/, 200, '{"data":[]}'], [/chat\/completions/, 200, '{"choices":[]}']]);
    expect((await openai()).state).toBe('ok');
    expect((await openai()).state).toBe('ok');
    expect(calls.filter((u) => /chat\/completions/.test(u))).toHaveLength(1);
  });

  it('Spitch: one word of speech decides; no key is "not set up"', async () => {
    respond([[/\/models$/, 200, '{}'], [/chat\/completions/, 200, '{}'], [/\/v1\/speech/, 401, 'unauthorized']]);
    let s = (await new ProviderHealthService().check('org')).providers.find((p) => p.id === 'spitch')!;
    expect(s.state).toBe('not_configured');
    process.env.SPITCH_API_KEY = 'sp-test';
    s = (await new ProviderHealthService().check('org')).providers.find((p) => p.id === 'spitch')!;
    expect(s).toMatchObject({ state: 'failed' });
    expect(s.detail).toMatch(/Spitch refused \(HTTP 401\)/);
  });

  it('explains each refusal for the phone line', () => {
    expect(modelRefusal(429, 'Request too large for gpt-4o on tokens per min (TPM): Limit 10000')).toMatch(/tokens-per-minute limit is too low/);
    expect(modelRefusal(429, 'slow down')).toMatch(/rate limited/);
    expect(modelRefusal(401, '')).toMatch(/refused/);
  });
});

describe('monitoring endpoints', () => {
  let app: INestApplication;
  let owner: TestTenant;
  const saved = process.env.MONITOR_TOKEN;
  const TOKEN = randomBytes(24).toString('hex');

  beforeAll(async () => {
    process.env.MONITOR_TOKEN = TOKEN;
    app = await createTestApp();
    owner = await createTenant(app, 'monitoring', { role: 'OWNER' });
  }, 60_000);
  afterAll(async () => {
    await prisma.systemEvent.deleteMany({ where: { kind: 'external_check', detail: { path: ['run'], equals: 'monitoring-spec' } } }).catch(() => undefined);
    await dropTenant(owner?.orgId);
    await app?.close();
    if (saved === undefined) delete process.env.MONITOR_TOKEN;
    else process.env.MONITOR_TOKEN = saved;
  });

  it('the phone line state is public, and says only ok / degraded / down / disabled', async () => {
    const r = await request(app.getHttpServer()).get('/api/health/voice').expect(200);
    expect(Object.keys(r.body)).toEqual(['voice']);
    expect(['ok', 'degraded', 'down', 'disabled']).toContain(r.body.voice);
  });

  it('the heartbeat needs the monitor token, and is kept', async () => {
    await request(app.getHttpServer()).post('/api/monitoring/heartbeat').send({ status: 'ok' }).expect(403);
    await request(app.getHttpServer()).post('/api/monitoring/heartbeat').set('x-monitor-token', 'x'.repeat(48)).send({ status: 'ok' }).expect(403);
    await request(app.getHttpServer())
      .post('/api/monitoring/heartbeat')
      .set('x-monitor-token', TOKEN)
      .send({ status: 'failed', summary: 'the database is not reachable.', checks: { site: 'ok', database: 'HTTP 503' }, run: 'monitoring-spec' })
      .expect(204);
    const kept = await prisma.systemEvent.findFirst({ where: { kind: 'external_check' }, orderBy: { createdAt: 'desc' } });
    expect(kept).toMatchObject({ status: 'failed', detail: { summary: 'the database is not reachable.', checks: { database: 'HTTP 503' } } });
  });

  it('the status page is for owners and admins, and reports what the monitor said', async () => {
    await request(app.getHttpServer()).get('/api/monitoring/status').expect(401);
    const viewer = await prisma.user.create({
      data: { organizationId: owner.orgId, email: `viewer-${randomBytes(3).toString('hex')}@tenant.test`, passwordHash: 'x', fullName: 'Viewer', role: 'VIEWER' },
    });
    const viewerToken = app.get(JwtService).sign({ userId: viewer.id, organizationId: owner.orgId, email: viewer.email, fullName: viewer.fullName, role: 'VIEWER', tokenVersion: viewer.tokenVersion });
    await request(app.getHttpServer()).get('/api/monitoring/status').set('Authorization', `Bearer ${viewerToken}`).expect(403);
    await recordSystemEvent('backup', 'ok', { offsite: true, stamp: 'monitoring-spec' });
    const r = await request(app.getHttpServer()).get('/api/monitoring/status').set('Authorization', `Bearer ${owner.token}`).expect(200);
    expect(r.body.external.last).toMatchObject({ status: 'failed' });
    expect(r.body.alerts.map((a: any) => a.id)).toContain('external-failing');
    expect(r.body.backup.last).toMatchObject({ status: 'ok' });
    expect(['ok', 'warning', 'critical']).toContain(r.body.overall);
  }, 60_000);
});
