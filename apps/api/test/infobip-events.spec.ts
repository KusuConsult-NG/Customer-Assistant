/**
 * Infobip call events over real HTTP, against a real database.
 *
 * The route is driven through the app exactly as Infobip would reach it, with
 * Infobip's own API replaced by a recorder. It pins: that nothing is trusted
 * before Basic auth passes; that a citizen's call becomes a contact and a call
 * record on the right agency; that the request attaching the AI is the one in
 * Infobip's tutorial; that an unknown number is hung up rather than answered
 * as a guessed agency; and that the AI leg ending never closes the citizen's
 * call.
 */
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { prisma, phoneNumberVariants } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { InfobipVoiceService } from '../src/telephony/infobip/infobip-voice.service';
import { WebhookDispatcherService } from '../src/webhooks/webhook-dispatcher.service';

jest.setTimeout(60000);

describe('Infobip call events', () => {
  let app: INestApplication;
  let orgId: string;
  let lineNumber: string;
  let realFetch: typeof globalThis.fetch;
  let infobipCalls: Array<{ path: string; body: any }>;
  let dialogResponse: { status: number; body: any };
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  const AUTH = `Basic ${Buffer.from('plateau:a-long-shared-secret').toString('base64')}`;
  const post = (body: any, auth: string | null = AUTH) => {
    const r = request(app.getHttpServer()).post('/api/telephony/inbound/infobip').send(body);
    return auth ? r.set('Authorization', auth) : r;
  };
  const eventually = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> => {
    const until = Date.now() + ms;
    let last = await read();
    while (!ok(last) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
      last = await read();
    }
    return last;
  };
  const received = (callId: string, from: string, to: string) => ({
    callId,
    type: 'CALL_RECEIVED',
    timestamp: new Date().toISOString(),
    properties: { call: { id: callId, from, to, direction: 'INBOUND' } },
  });

  beforeAll(async () => {
    setEnv('INFOBIP_BASE_URL', 'https://abc123.api.infobip.com');
    setEnv('INFOBIP_API_KEY', 'ib_test_key_value');
    setEnv('INFOBIP_MEDIA_STREAM_CONFIG_ID', 'msc-0001');
    setEnv('INFOBIP_WEBHOOK_USERNAME', 'plateau');
    setEnv('INFOBIP_WEBHOOK_PASSWORD', 'a-long-shared-secret');
    setEnv('INFOBIP_STREAM_TOKEN', 'stream-token-0123456789');
    realFetch = globalThis.fetch;
    app = await createTestApp();

    const org = await prisma.organization.create({
      data: { name: 'Infobip Toll-Free Agency', slug: `ibe-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
    });
    orgId = org.id;
    // Stored the way an operator types a toll-free number, not as E.164 — the
    // dialled number must still match across shapes.
    lineNumber = `0800${randomBytes(3).readUIntBE(0, 3).toString().padStart(7, '0').slice(0, 7)}`;
    await prisma.telephonyConfig.create({
      data: { organizationId: orgId, provider: 'INFOBIP' as any, phoneNumber: lineNumber },
    });
  });

  beforeEach(() => {
    infobipCalls = [];
    dialogResponse = {
      status: 200,
      body: { id: `dialog-${randomBytes(4).toString('hex')}`, childCall: { id: `child-${randomBytes(6).toString('hex')}` } },
    };
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (u.startsWith('https://abc123.api.infobip.com')) {
        const path = u.replace('https://abc123.api.infobip.com', '');
        infobipCalls.push({ path, body: init?.body ? JSON.parse(init.body) : null });
        if (path === '/calls/1/dialogs') {
          return new Response(JSON.stringify(dialogResponse.body), { status: dialogResponse.status });
        }
        return new Response('{}', { status: 200 });
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
    await prisma.callLog.deleteMany({ where: { organizationId: orgId } });
    await prisma.contact.deleteMany({ where: { organizationId: orgId } });
    await prisma.telephonyConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await app.close();
  });

  describe('before anything is trusted', () => {
    it('refuses without credentials, and writes nothing', async () => {
      const callId = `call-${randomBytes(6).toString('hex')}`;
      const res = await post(received(callId, '2348031234567', lineNumber), null);
      expect(res.status).toBe(401);
      await new Promise((r) => setTimeout(r, 300));
      expect(await prisma.callLog.findUnique({ where: { callSid: callId } })).toBeNull();
      expect(infobipCalls).toEqual([]);
    });

    it('refuses wrong credentials', async () => {
      const wrong = `Basic ${Buffer.from('plateau:guess').toString('base64')}`;
      expect((await post(received('x-1', '2348031234567', lineNumber), wrong)).status).toBe(401);
    });

    it('refuses EVERYTHING when no credentials are configured — 500, so Infobip retries once fixed', async () => {
      setEnv('INFOBIP_WEBHOOK_PASSWORD', undefined);
      try {
        expect((await post(received('x-2', '2348031234567', lineNumber))).status).toBe(500);
      } finally {
        process.env.INFOBIP_WEBHOOK_PASSWORD = 'a-long-shared-secret';
      }
    });
  });

  describe('a citizen rings', () => {
    it('becomes a contact and a call record on the RIGHT agency, then is handed to the AI', async () => {
      const callId = `call-${randomBytes(6).toString('hex')}`;
      // Infobip sends numbers without a plus.
      const caller = `23480${randomBytes(4).readUInt32BE(0).toString().padStart(8, '0').slice(0, 8)}`;
      // Dialled in E.164 while stored as 0800…: matched across shapes.
      const dialled = phoneNumberVariants(lineNumber).find((v) => v.startsWith('+')) ?? lineNumber;

      const res = await post(received(callId, caller, dialled));
      expect(res.status).toBe(200);

      const log = await eventually(
        () => prisma.callLog.findUnique({ where: { callSid: callId } }),
        (r) => !!r
      );
      expect(log?.organizationId).toBe(orgId);
      expect(log?.provider).toBe('INFOBIP');
      expect(log?.status).toBe('IN_PROGRESS');
      // Stored canonically, so the record matches the contact a citizen has
      // from every other channel.
      expect(log?.fromNumber).toBe(`+${caller}`);
      expect(log?.contactId).toBeTruthy();

      await eventually(async () => infobipCalls.length, (n) => n >= 1);
      expect(infobipCalls[0]).toEqual({
        path: '/calls/1/dialogs',
        body: {
          parentCallId: callId,
          childCallRequest: { endpoint: { type: 'WEBSOCKET', websocketEndpointConfigId: 'msc-0001' } },
        },
      });
    });

    it('lets a stream naming the AI LEG still find the citizen’s call', async () => {
      const callId = `call-${randomBytes(6).toString('hex')}`;
      const childId = dialogResponse.body.childCall.id;
      await post(received(callId, '2348031112222', lineNumber));

      const svc = app.get(InfobipVoiceService);
      const ctx = await eventually(() => svc.resolve(childId), (c) => !!c);
      expect(ctx?.parentCallId).toBe(callId);
      expect(ctx?.organizationId).toBe(orgId);
    });

    it('HANGS UP an unknown number rather than answering it as a guessed agency', async () => {
      const callId = `call-${randomBytes(6).toString('hex')}`;
      await post(received(callId, '2348031112222', '+2349999999999'));

      await eventually(async () => infobipCalls.length, (n) => n >= 1);
      expect(infobipCalls).toEqual([{ path: `/calls/1/calls/${callId}/hangup`, body: {} }]);
      expect(await prisma.callLog.findUnique({ where: { callSid: callId } })).toBeNull();
    });

    it('records the failure and hangs up when the AI cannot be attached', async () => {
      dialogResponse = {
        status: 400,
        body: { requestError: { serviceException: { text: 'Unknown websocket endpoint config' } } },
      };
      const callId = `call-${randomBytes(6).toString('hex')}`;
      await post(received(callId, '2348031113333', lineNumber));

      const log = await eventually(
        () => prisma.callLog.findUnique({ where: { callSid: callId } }),
        (r) => r?.status === 'FAILED'
      );
      expect(log?.status).toBe('FAILED');
      // Infobip's own words on the record, not "it failed".
      expect(log?.summary).toMatch(/Unknown websocket endpoint config/);
      expect(infobipCalls.map((c) => c.path)).toContain(`/calls/1/calls/${callId}/hangup`);
    });

    it('is idempotent when Infobip redelivers', async () => {
      const callId = `call-${randomBytes(6).toString('hex')}`;
      await post(received(callId, '2348031114444', lineNumber));
      await post(received(callId, '2348031114444', lineNumber));
      await eventually(() => prisma.callLog.count({ where: { callSid: callId } }), (n) => n === 1);
      expect(await prisma.callLog.count({ where: { callSid: callId } })).toBe(1);
    });
  });

  describe('the call ends', () => {
    /** Every `call.ended` the agency's webhook subscribers were sent. */
    const endedDispatches = () => {
      const spy = jest.spyOn(app.get(WebhookDispatcherService), 'dispatch');
      return {
        spy,
        ended: () => spy.mock.calls.filter((c) => c[1] === 'call.ended').map((c) => c[2] as any),
      };
    };

    it("closes the citizen's call with its duration, and tells subscribers it ended", async () => {
      const { spy, ended } = endedDispatches();
      const callId = `call-${randomBytes(6).toString('hex')}`;
      await post(received(callId, '2348031115555', lineNumber));
      await eventually(() => prisma.callLog.findUnique({ where: { callSid: callId } }), (r) => !!r);

      await post({ callId, type: 'CALL_FINISHED', properties: { callLog: { duration: 73 } } });
      await eventually(async () => ended().length, (n) => n >= 1);
      expect(ended()).toEqual([{ callSid: callId, outcome: 'completed' }]);
      spy.mockRestore();
      const log = await eventually(
        () => prisma.callLog.findUnique({ where: { callSid: callId } }),
        (r) => r?.status === 'COMPLETED'
      );
      expect(log?.status).toBe('COMPLETED');
      expect(log?.durationSeconds).toBe(73);
      expect(log?.endedAt).toBeTruthy();
    });

    it("does NOT announce the citizen's call ended when only the AI leg ends", async () => {
      // The AI leg's id resolves — through its alias — to the citizen's call.
      // Treated as the call ending, it would tell the agency's subscribers
      // `call.ended` while the citizen was still on the line.
      //
      // This test first checked only the call RECORD, and survived the guard
      // being removed: the record keys on the event's own id, which the AI leg
      // has no row for. The webhook is what the guard protects, so it is what
      // this asserts.
      const { spy, ended } = endedDispatches();
      const callId = `call-${randomBytes(6).toString('hex')}`;
      const childId = dialogResponse.body.childCall.id;
      await post(received(callId, '2348031116666', lineNumber));
      const svc = app.get(InfobipVoiceService);
      await eventually(() => svc.resolve(childId), (c) => !!c);

      await post({ callId: childId, type: 'CALL_FINISHED', properties: { callLog: { duration: 5 } } });
      await new Promise((r) => setTimeout(r, 400));

      expect(ended()).toEqual([]);
      const log = await prisma.callLog.findUnique({ where: { callSid: callId } });
      expect(log?.status).toBe('IN_PROGRESS');
      // And the citizen's call is still findable for the stream.
      expect((await svc.resolve(callId))?.parentCallId).toBe(callId);
      spy.mockRestore();
    });
  });
});
