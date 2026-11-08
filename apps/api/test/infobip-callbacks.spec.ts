/**
 * Promised callbacks on an Infobip line: held for an officer, dialled from the
 * browser, settled from what the call actually did.
 *
 * Driven through the real routes against a real database, with Infobip's API
 * replaced by a recorder. What it pins:
 *
 *  - the dialler never claims an Infobip agency's promise, so no attempt is
 *    spent on a call nobody placed, and "Call now" says why instead of
 *    surfacing a Twilio credential error;
 *  - the token request is exactly the fields Infobip's API declares, for the
 *    signed-in officer's own identity;
 *  - two officers cannot ring one citizen at once;
 *  - an answered call is REACHED with a call record; an unanswered one is an
 *    attempt with Infobip's reason; one the browser never placed costs the
 *    citizen nothing; and a report counts once;
 *  - a long conversation is not reopened by the dialler's grace sweep.
 */
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, TestTenant } from './support/tenant';
import { CallbackDispatcherService, BROWSER_DIAL_MARKER } from '../src/telephony/callback-dispatcher.service';
import { TelephonyService } from '../src/telephony/telephony.service';
import { InfobipVoiceService, INFOBIP_OUTBOUND_REASON } from '../src/telephony/infobip/infobip-voice.service';

jest.setTimeout(90000);

const IB = 'https://ib-cb.api.infobip.test';

describe('Infobip callbacks dialled from the browser', () => {
  let app: INestApplication;
  let agency: TestTenant; // Infobip line
  let agent: TestTenant; // a second officer in the SAME agency
  let viewer: TestTenant;
  let twilioAgency: TestTenant; // dialled automatically
  let bare: TestTenant; // no line at all
  let contactId: string;
  let twilioContactId: string;
  let lineNumber: string;
  let realFetch: typeof globalThis.fetch;
  let infobipCalls: Array<{ path: string; auth: string | null; body: any }>;
  let tokenResponse: { status: number; body: any };
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  const runId = randomBytes(2).readUInt16BE(0) % 10000;
  let seq = 0;
  const phone = () => `+23481${String(runId).padStart(4, '0')}${String((seq += 1) % 10000).padStart(4, '0')}`;

  const as = (t: TestTenant) => ({
    get: (path: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${t.token}`),
    post: (path: string, body?: any) =>
      request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${t.token}`).send(body ?? {}),
  });

  async function seed(orgId: string, over: Record<string, any> = {}) {
    return prisma.callbackRequest.create({
      data: {
        organizationId: orgId,
        contactId: orgId === agency.orgId ? contactId : twilioContactId,
        phoneNumber: phone(),
        reason: 'pension arrears since March',
        promisedText: 'Within the hour',
        status: 'DUE',
        dueAt: new Date(Date.now() - 60_000),
        ...over,
      },
    });
  }

  const dispatcherWith = (dial: (org: string, to: string) => Promise<any>) =>
    new CallbackDispatcherService({ initiateOutboundCall: dial } as any, { emitAsync: () => {} } as any);

  beforeAll(async () => {
    setEnv('INFOBIP_BASE_URL', IB);
    setEnv('INFOBIP_API_KEY', 'ib_cb_test_key');
    realFetch = globalThis.fetch;
    app = await createTestApp();

    agency = await createTenant(app, 'ib-cb', { role: 'OWNER' });
    viewer = await createTenant(app, 'ib-cb-viewer', { role: 'VIEWER' });
    twilioAgency = await createTenant(app, 'ib-cb-twilio', { role: 'OWNER' });
    bare = await createTenant(app, 'ib-cb-bare', { role: 'OWNER' });

    // A second officer in the same agency, signed the way createTenant signs.
    const second = await prisma.user.create({
      data: {
        organizationId: agency.orgId,
        email: `second-${randomBytes(4).toString('hex')}@tenant.test`,
        passwordHash: 'not-a-login-path',
        fullName: 'Musa Danladi',
        role: 'AGENT',
      },
    });
    const { JwtService } = await import('@nestjs/jwt');
    agent = {
      orgId: agency.orgId,
      userId: second.id,
      email: second.email,
      token: app.get(JwtService).sign({
        userId: second.id,
        organizationId: agency.orgId,
        email: second.email,
        fullName: second.fullName,
        role: second.role,
        tokenVersion: second.tokenVersion,
      }),
    };
    // The viewer is put in the agency so the 403 is about the ROLE.
    await prisma.user.update({ where: { id: viewer.userId }, data: { organizationId: agency.orgId } });

    lineNumber = `+23480${String(runId).padStart(4, '0')}9999`;
    await prisma.telephonyConfig.create({
      data: { organizationId: agency.orgId, provider: 'INFOBIP', phoneNumber: lineNumber },
    });
    await prisma.telephonyConfig.create({
      data: { organizationId: twilioAgency.orgId, provider: 'TWILIO', phoneNumber: phone() },
    });

    const contact = await prisma.contact.create({
      data: { organizationId: agency.orgId, phoneNumber: phone(), fullName: 'Ngozi Pam' },
    });
    contactId = contact.id;
    twilioContactId = (
      await prisma.contact.create({
        data: { organizationId: twilioAgency.orgId, phoneNumber: phone(), fullName: 'Twilio Agency Citizen' },
      })
    ).id;
  });

  beforeEach(() => {
    infobipCalls = [];
    tokenResponse = {
      status: 200,
      body: { token: `tok-${randomBytes(6).toString('hex')}`, expirationTime: '2026-11-08T20:00:00.000+0000' },
    };
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (u.startsWith(IB)) {
        infobipCalls.push({
          path: u.slice(IB.length),
          auth: (init?.headers as any)?.Authorization ?? null,
          body: init?.body ? JSON.parse(init.body) : null,
        });
        return new Response(
          typeof tokenResponse.body === 'string' ? tokenResponse.body : JSON.stringify(tokenResponse.body),
          { status: tokenResponse.status }
        );
      }
      return realFetch(url, init);
    }) as any;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const t of [agency, twilioAgency, bare, viewer]) {
      await prisma.callLog.deleteMany({ where: { organizationId: t?.orgId } }).catch(() => undefined);
      await dropTenant(t?.orgId);
    }
    await app?.close();
  });

  // ─── How the queue learns which button to show ────────────────────────────

  describe('GET /api/callbacks/dialling', () => {
    it('names an Infobip line as officer-dialled and ready', async () => {
      const res = await as(agency).get('/api/callbacks/dialling');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ mode: 'officer-browser', line: lineNumber, ready: true, blocked: [] });
    });

    it('says a Twilio line is dialled automatically', async () => {
      const res = await as(twilioAgency).get('/api/callbacks/dialling');
      expect(res.body.mode).toBe('automatic');
      expect(res.body.ready).toBe(true);
    });

    it('says plainly when there is no line', async () => {
      const res = await as(bare).get('/api/callbacks/dialling');
      expect(res.body.mode).toBe('none');
      expect(res.body.blocked.join(' ')).toMatch(/no phone line/i);
    });

    it('names each missing variable rather than offering a button that always fails', async () => {
      setEnv('INFOBIP_API_KEY', undefined);
      setEnv('INFOBIP_BASE_URL', undefined);
      try {
        const res = await as(agency).get('/api/callbacks/dialling');
        expect(res.body.mode).toBe('officer-browser');
        expect(res.body.ready).toBe(false);
        expect(res.body.blocked.join(' ')).toMatch(/INFOBIP_BASE_URL/);
        expect(res.body.blocked.join(' ')).toMatch(/INFOBIP_API_KEY/);
      } finally {
        setEnv('INFOBIP_API_KEY', 'ib_cb_test_key');
        setEnv('INFOBIP_BASE_URL', IB);
      }
    });
  });

  // ─── The dialler never spends an attempt on a call it will not place ───────

  describe('the automatic dialler on an Infobip line', () => {
    it('holds the promise for an officer instead of claiming it', async () => {
      // Swept at an instant in 2019, so the scan reads this row and nothing
      // another suite left due — this must not dial somebody else's fixture.
      // 01:00 in Lagos, too: the officer hold is decided before contact hours.
      const row = await seed(agency.orgId, { dueAt: new Date(Date.UTC(2019, 0, 1)) });
      const dialled: string[] = [];
      const result = await dispatcherWith(async (_org, to) => {
        dialled.push(to);
        return { callId: `CA${randomBytes(4).toString('hex')}` };
      }).sweep(new Date(Date.UTC(2019, 5, 1)));

      expect(dialled).not.toContain(row.phoneNumber);
      expect(result.heldForOfficer).toBeGreaterThan(0);
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('DUE');
      expect(after?.attempts).toBe(0);
      expect(after?.failureReason).toBeNull();
    });

    it('skips it in placeOne too, before the claim', async () => {
      const row = await seed(agency.orgId);
      let dialled = false;
      const outcome = await dispatcherWith(async () => {
        dialled = true;
        return { callId: 'x' };
      }).placeOne(row.id);
      expect(outcome).toBe('skipped');
      expect(dialled).toBe(false);
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('DUE');
      expect(after?.attempts).toBe(0);
    });

    it('"Call now" is refused with the reason, and nothing is claimed', async () => {
      const row = await seed(agency.orgId);
      const res = await as(agency).post(`/api/callbacks/${row.id}/call-now`);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(INFOBIP_OUTBOUND_REASON);
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('DUE');
      expect(after?.attempts).toBe(0);
    });

    it('initiateOutboundCall refuses an Infobip line instead of falling through to Twilio', async () => {
      await expect(
        app.get(TelephonyService).initiateOutboundCall(agency.orgId, phone())
      ).rejects.toThrow(INFOBIP_OUTBOUND_REASON);
    });

    it('still dials a Twilio agency exactly as before', async () => {
      const row = await seed(twilioAgency.orgId);
      const outcome = await dispatcherWith(async () => ({ callId: `CA${randomBytes(4).toString('hex')}` })).placeOne(row.id);
      expect(outcome).toBe('placed');
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('IN_PROGRESS');
      expect(after?.attempts).toBe(1);
    });
  });

  // ─── Starting a browser call ──────────────────────────────────────────────

  describe('POST /api/callbacks/:id/browser-call', () => {
    it('claims the promise and mints a token for THIS officer, with exactly Infobip\'s fields', async () => {
      const row = await seed(agency.orgId);
      const res = await as(agency).post(`/api/callbacks/${row.id}/browser-call`);
      expect(res.status).toBe(201);

      expect(infobipCalls).toHaveLength(1);
      expect(infobipCalls[0].path).toBe('/webrtc/1/token');
      expect(infobipCalls[0].auth).toBe('App ib_cb_test_key');
      expect(infobipCalls[0].body).toEqual({
        identity: `officer_${agency.userId.replace(/[^A-Za-z0-9_-]/g, '')}`,
        displayName: 'ib-cb Tester',
        timeToLive: 3600,
      });

      // Numbers the way Infobip's own examples write them: digits, no plus.
      expect(res.body.to).toBe(row.phoneNumber.replace(/^\+/, ''));
      expect(res.body.from).toBe(lineNumber.replace(/^\+/, ''));
      expect(res.body.token).toBe(tokenResponse.body.token);
      expect(res.body.reference).toMatch(/\S/);

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('IN_PROGRESS');
      expect(after?.assignedUserId).toBe(agency.userId);
      expect(after?.callSid).toBe(BROWSER_DIAL_MARKER);
      expect(after?.attempts).toBe(0); // an attempt is counted when it ENDS
    });

    it('refuses a second officer while the first is on the call, and names them', async () => {
      const row = await seed(agency.orgId);
      expect((await as(agency).post(`/api/callbacks/${row.id}/browser-call`)).status).toBe(201);
      const second = await as(agent).post(`/api/callbacks/${row.id}/browser-call`);
      expect(second.status).toBe(409);
      expect(second.body.message).toMatch(/ib-cb Tester is already calling/);
      expect(infobipCalls).toHaveLength(1); // no token for the loser
    });

    it('the claim itself refuses a promise already being dialled', async () => {
      // The route checks the status first, so two presses rarely reach the
      // claim together; this pins the claim, which is what settles a real race.
      const row = await seed(agency.orgId);
      const d = app.get(CallbackDispatcherService);
      expect(await d.claimForBrowser(row.id, agency.orgId, agency.userId)).not.toBeNull();
      expect(await d.claimForBrowser(row.id, agency.orgId, agent.userId)).toBeNull();
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.assignedUserId).toBe(agency.userId);
    });

    it('the claim is scoped to the agency in the write itself', async () => {
      const row = await seed(agency.orgId);
      const d = app.get(CallbackDispatcherService);
      expect(await d.claimForBrowser(row.id, twilioAgency.orgId, twilioAgency.userId)).toBeNull();
      expect((await prisma.callbackRequest.findUnique({ where: { id: row.id } }))?.status).toBe('DUE');
    });

    it('lets only one of two simultaneous presses through', async () => {
      const row = await seed(agency.orgId);
      const [a, b] = await Promise.all([
        as(agency).post(`/api/callbacks/${row.id}/browser-call`),
        as(agent).post(`/api/callbacks/${row.id}/browser-call`),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
    });

    it('releases the claim when Infobip refuses the token, quoting Infobip', async () => {
      const row = await seed(agency.orgId);
      tokenResponse = {
        status: 401,
        body: { requestError: { serviceException: { messageId: 'UNAUTHORIZED', text: 'Invalid login details' } } },
      };
      const res = await as(agency).post(`/api/callbacks/${row.id}/browser-call`);
      expect(res.status).toBe(502);
      expect(res.body.message).toMatch(/Infobip refused \(HTTP 401\): Invalid login details/);
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('DUE');
      expect(after?.attempts).toBe(0);
      expect(after?.callSid).toBeNull();
    });

    it('treats a 200 with no token as a refusal, not a token', async () => {
      const row = await seed(agency.orgId);
      tokenResponse = { status: 200, body: { expirationTime: '2026-11-08T20:00:00.000+0000' } };
      const res = await as(agency).post(`/api/callbacks/${row.id}/browser-call`);
      expect(res.status).toBe(502);
      expect(res.body.message).toMatch(/without a token/);
      expect((await prisma.callbackRequest.findUnique({ where: { id: row.id } }))?.status).toBe('DUE');
    });

    it('is refused to a VIEWER', async () => {
      const row = await seed(agency.orgId);
      const res = await as(viewer).post(`/api/callbacks/${row.id}/browser-call`);
      expect(res.status).toBe(403);
      expect((await prisma.callbackRequest.findUnique({ where: { id: row.id } }))?.status).toBe('DUE');
    });

    it('cannot reach another agency\'s promise', async () => {
      const row = await seed(agency.orgId);
      // twilioAgency has no Infobip line, so give the other side one too: the
      // refusal must come from the tenant boundary, not the carrier check.
      const other = await createTenant(app, 'ib-cb-other', { role: 'OWNER' });
      await prisma.telephonyConfig.create({
        data: { organizationId: other.orgId, provider: 'INFOBIP', phoneNumber: phone() },
      });
      try {
        const res = await as(other).post(`/api/callbacks/${row.id}/browser-call`);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/not found in this agency/);
        expect((await prisma.callbackRequest.findUnique({ where: { id: row.id } }))?.status).toBe('DUE');
      } finally {
        await dropTenant(other.orgId);
      }
    });

    it('is refused for an agency whose promises are dialled automatically', async () => {
      const row = await seed(twilioAgency.orgId);
      const res = await as(twilioAgency).post(`/api/callbacks/${row.id}/browser-call`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/dialled automatically/);
      expect(infobipCalls).toHaveLength(0);
    });

    it('will not dial a promise that is already closed', async () => {
      const row = await seed(agency.orgId, { status: 'COMPLETED', completedAt: new Date() });
      const res = await as(agency).post(`/api/callbacks/${row.id}/browser-call`);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/COMPLETED/);
    });
  });

  // ─── Settling it from what happened ───────────────────────────────────────

  describe('POST /api/callbacks/:id/browser-call/result', () => {
    const claim = async (over: Record<string, any> = {}) => {
      const row = await seed(agency.orgId, over);
      expect((await as(agency).post(`/api/callbacks/${row.id}/browser-call`)).status).toBe(201);
      return row;
    };

    it('an answered call is REACHED, with a call record that says where it came from', async () => {
      const row = await claim();
      const callId = `ib-${randomBytes(6).toString('hex')}`;
      const res = await as(agency).post(`/api/callbacks/${row.id}/browser-call/result`, {
        callId,
        outcome: 'answered',
        durationSeconds: 42,
        reason: 'NORMAL_HANGUP',
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('COMPLETED');

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('COMPLETED');
      expect(after?.completedAt).toBeTruthy();
      expect(after?.attempts).toBe(1);
      expect(after?.failureReason).toBeNull();

      const log = await prisma.callLog.findUnique({ where: { callSid: `infobip-webrtc:${callId}` } });
      expect(log).toMatchObject({
        organizationId: agency.orgId,
        contactId,
        direction: 'OUTBOUND',
        status: 'COMPLETED',
        provider: 'INFOBIP',
        durationSeconds: 42,
        fromNumber: lineNumber,
        toNumber: row.phoneNumber,
      });
      expect(log?.summary).toMatch(/ib-cb Tester/);
      expect(log?.summary).toMatch(/reported by the officer's browser/);
    });

    it('counts a report once: a second one is refused and records nothing', async () => {
      const row = await claim();
      const callId = `ib-${randomBytes(6).toString('hex')}`;
      const body = { callId, outcome: 'not_answered', reason: 'NO_ANSWER' };
      expect((await as(agency).post(`/api/callbacks/${row.id}/browser-call/result`, body)).status).toBe(201);
      const again = await as(agency).post(`/api/callbacks/${row.id}/browser-call/result`, body);
      expect(again.status).toBe(409);
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.attempts).toBe(1);
      expect(await prisma.callLog.count({ where: { callSid: `infobip-webrtc:${callId}` } })).toBe(1);
    });

    it('an unanswered call is an attempt with Infobip\'s reason, back in the queue', async () => {
      const row = await claim();
      const res = await as(agency).post(`/api/callbacks/${row.id}/browser-call/result`, {
        callId: `ib-${randomBytes(6).toString('hex')}`,
        outcome: 'not_answered',
        durationSeconds: 0,
        reason: 'NO_ANSWER: The destination did not answer',
      });
      expect(res.body.status).toBe('PENDING');
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('PENDING');
      expect(after?.attempts).toBe(1);
      expect(after?.failureReason).toBe('NO_ANSWER: The destination did not answer');
      expect(after!.dueAt.getTime()).toBeGreaterThan(Date.now());
      expect(after?.completedAt).toBeNull();
      const log = await prisma.callLog.findFirst({ where: { organizationId: agency.orgId, toNumber: row.phoneNumber } });
      expect(log?.status).toBe('NO_ANSWER');
      expect(log?.durationSeconds).toBe(0);
    });

    it('fails the promise when that was the last attempt', async () => {
      const row = await claim({ maxAttempts: 1 });
      const res = await as(agency).post(`/api/callbacks/${row.id}/browser-call/result`, {
        outcome: 'failed',
        reason: 'DESTINATION_NOT_FOUND',
      });
      expect(res.body.status).toBe('FAILED');
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('FAILED');
      expect(after?.failureReason).toBe('DESTINATION_NOT_FOUND');
    });

    it('a call the browser never placed costs the citizen nothing', async () => {
      const row = await claim();
      const res = await as(agency).post(`/api/callbacks/${row.id}/browser-call/result`, {
        outcome: 'not_placed',
        reason: 'The calling library could not load',
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('DUE');
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('DUE');
      expect(after?.attempts).toBe(0);
      expect(after?.callSid).toBeNull();
      expect(await prisma.callLog.count({ where: { organizationId: agency.orgId, toNumber: row.phoneNumber } })).toBe(0);
    });

    it('a not-yet-due promise goes back to PENDING, keeping its deadline', async () => {
      const dueAt = new Date(Date.now() + 3 * 60 * 60_000);
      const row = await claim({ status: 'PENDING', dueAt });
      const res = await as(agency).post(`/api/callbacks/${row.id}/browser-call/result`, { outcome: 'not_placed' });
      expect(res.body.status).toBe('PENDING');
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.dueAt.getTime()).toBe(dueAt.getTime());
    });

    it('stores a call id that is not one under a generated key, never the raw text', async () => {
      const row = await claim();
      await as(agency).post(`/api/callbacks/${row.id}/browser-call/result`, {
        callId: 'not an id; DROP TABLE',
        outcome: 'not_answered',
      });
      const log = await prisma.callLog.findFirst({ where: { organizationId: agency.orgId, toNumber: row.phoneNumber } });
      expect(log?.callSid).toBe(`infobip-webrtc:${row.id}:1`);
    });

    it('rejects an outcome it does not know', async () => {
      const row = await claim();
      const res = await as(agency).post(`/api/callbacks/${row.id}/browser-call/result`, { outcome: 'completed' });
      expect(res.status).toBe(400);
      expect((await prisma.callbackRequest.findUnique({ where: { id: row.id } }))?.status).toBe('IN_PROGRESS');
    });

    it('another agency cannot settle this agency\'s call', async () => {
      const row = await claim();
      const res = await as(twilioAgency).post(`/api/callbacks/${row.id}/browser-call/result`, {
        outcome: 'answered',
        durationSeconds: 5,
      });
      expect(res.status).toBe(409);
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('IN_PROGRESS');
      expect(after?.attempts).toBe(0);
    });
  });

  // ─── A long conversation is not a lost carrier callback ───────────────────

  describe('the grace sweep and a browser call', () => {
    it('leaves a 30-minute browser call alone, where a dialler row that old is reopened', async () => {
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60_000);
      const browser = await seed(agency.orgId, {
        status: 'IN_PROGRESS',
        callSid: BROWSER_DIAL_MARKER,
        lastAttemptAt: thirtyMinutesAgo,
      });
      const dialler = await seed(twilioAgency.orgId, {
        status: 'IN_PROGRESS',
        callSid: `CA${randomBytes(6).toString('hex')}`,
        lastAttemptAt: thirtyMinutesAgo,
      });

      // The reopen step alone: a full sweep would also dial whatever other
      // suites have left due, with this fake.
      await (dispatcherWith(async () => ({ callId: 'x' })) as any).reopenAbandoned(new Date());

      expect((await prisma.callbackRequest.findUnique({ where: { id: browser.id } }))?.status).toBe('IN_PROGRESS');
      expect((await prisma.callbackRequest.findUnique({ where: { id: dialler.id } }))?.status).not.toBe('IN_PROGRESS');
    });

    it('reopens a browser call that went silent for hours, naming the browser', async () => {
      const row = await seed(agency.orgId, {
        status: 'IN_PROGRESS',
        callSid: BROWSER_DIAL_MARKER,
        lastAttemptAt: new Date(Date.now() - 3 * 60 * 60_000),
      });
      await (dispatcherWith(async () => ({ callId: 'x' })) as any).reopenAbandoned(new Date());
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).not.toBe('IN_PROGRESS');
      expect(after?.failureReason).toMatch(/officer's browser never reported/);
    });
  });

  // ─── The token request itself ─────────────────────────────────────────────

  describe('InfobipVoiceService.webrtcToken', () => {
    it('leaves out a display name outside Infobip\'s 5–50 characters instead of refusing', async () => {
      const svc = app.get(InfobipVoiceService);
      const result = await svc.webrtcToken('officer_abc123', 'Ali', 600);
      expect(result.ok).toBe(true);
      expect(infobipCalls[0].body).toEqual({ identity: 'officer_abc123', timeToLive: 600 });
    });

    it('refuses an identity Infobip would reject, without asking Infobip', async () => {
      const svc = app.get(InfobipVoiceService);
      const result = await svc.webrtcToken('ab', 'Officer Name', 600);
      expect(result.ok).toBe(false);
      expect(infobipCalls).toHaveLength(0);
    });
  });
});
