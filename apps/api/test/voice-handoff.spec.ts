/**
 * Voice handoff — what a caller gets when they need a person.
 *
 * They are QUEUED FOR A CALLBACK, not transferred: the request goes on the
 * callback queue an officer works from the dashboard, and the caller is read
 * the reference. The orchestrator still answers "Connecting you to a live
 * human agent right away" — that sentence must never be spoken on a call,
 * because nothing is connecting anybody.
 *
 * These tests drive the real handler and the real VoiceAiService against a
 * stubbed Twilio REST API, because the property that matters is not "a
 * function was called" — it is that what the caller HEARS always matches what
 * actually happened to their call.
 */

import { TwilioMediaStreamHandler } from '../src/telephony/twilio-media-stream.handler';
import { VoiceAiService } from '../src/telephony/voice-ai.service';
import { prisma } from '@ace/database';
import { randomBytes } from 'crypto';

const TWILIO_CALLS_URL = /api\.twilio\.com.*\/Calls\//;

describe('Voice handoff to a human', () => {
  let handler: TwilioMediaStreamHandler;
  let voiceAi: VoiceAiService;
  let broadcastEvents: Array<{ event: string; payload: any }>;
  let spoken: string[];
  let twilioRequests: Array<{ url: string; twiml: string }>;
  /**
   * Webhooks the handler asked for.
   *
   * Voice deliberately dispatches NO `handover.requested`: that handoff
   * redirects the live call at the carrier and VOICE has no `Conversation` row,
   * so the event would have nothing to name. `appointment.booked` IS dispatched
   * from this handler, which is why it holds a dispatcher at all.
   */
  let webhookCalls: Array<{ method: string; args: any[] }>;
  let orgId: string;
  const realFetch = global.fetch;

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: {
        name: `Voice Handoff Test ${Date.now()}`,
        slug: `voice-handoff-${Date.now()}`,
        industry: 'OTHER',
      },
    });
    orgId = org.id;
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    global.fetch = realFetch;
  });

  beforeEach(() => {
    broadcastEvents = [];
    spoken = [];
    twilioRequests = [];
    webhookCalls = [];

    voiceAi = new VoiceAiService();
    // Capture what the caller would hear instead of calling ElevenLabs.
    (voiceAi as any).streamTTSToTwilio = jest.fn(async (text: string) => {
      spoken.push(text);
    });

    const broadcast: any = {
      emit: (callSid: string, event: string, payload: any) =>
        broadcastEvents.push({ event, payload }),
    };
    const webhooks: any = {
      appointmentBooked: async (...args: any[]) => {
        webhookCalls.push({ method: 'appointmentBooked', args });
      },
      handoverRequested: async (...args: any[]) => {
        webhookCalls.push({ method: 'handoverRequested', args });
      },
      dispatch: async (...args: any[]) => {
        webhookCalls.push({ method: 'dispatch', args });
      },
    };

    handler = new TwilioMediaStreamHandler(voiceAi, broadcast, webhooks);
  });

  function stubTwilio(status: number) {
    global.fetch = jest.fn(async (url: any, init: any) => {
      const href = String(url);
      if (TWILIO_CALLS_URL.test(href)) {
        const body = new URLSearchParams(init.body);
        twilioRequests.push({ url: href, twiml: body.get('Twiml') ?? '' });
        return {
          ok: status < 400,
          status,
          text: async () => (status < 400 ? '{}' : 'Twilio rejected it'),
        } as any;
      }
      return realFetch(url, init);
    }) as any;
  }

  function makeSession(overrides: Partial<any> = {}) {
    return {
      callSid: `CA_test_${Date.now()}`,
      streamSid: 'MZ_test',
      organizationId: orgId,
      fromNumber: `+23480${randomBytes(4).readUInt32BE(0).toString().padStart(8, '0').slice(0, 8)}`,
      toNumber: '+15550001111',
      language: 'en',
      carrier: {
        accountSid: 'AC_stub',
        authToken: 'stub_token',
        forwardingNumber: '+2348030001111',
      },
      conversationHistory: [],
      isTtsSpeaking: false,
      ttsAbortController: null,
      handoffAttempted: false,
      ...overrides,
    };
  }

  const runHandoff = (session: any, utterance = 'let me speak to a human') =>
    (handler as any).handOffCallToHuman(session, { readyState: 1 } as any, utterance);

  /**
   * ── The record of the call, when the summary cannot be written ────────────
   *
   * Teardown generated a summary first and wrote the CallLog INSIDE the
   * `.then`. So when summarisation failed — an LLM outage, a quota, a network
   * blip — the `.catch` logged and emitted, and the row was never touched:
   * no `endedAt`, no duration, status stuck on IN_PROGRESS, and the TRANSCRIPT
   * of what the agency said to a citizen discarded.
   *
   * The call history is the record. The summary is a convenience on top of it,
   * and a convenience must not be able to destroy the thing it decorates.
   */
  describe('teardown', () => {
    const seedCallLog = async (callSid: string, fromNumber: string) =>
      prisma.callLog.create({
        data: {
          organizationId: orgId,
          callSid,
          fromNumber,
          toNumber: '+15550001111',
          direction: 'INBOUND',
          status: 'IN_PROGRESS',
          provider: 'TWILIO',
        },
      });

    it('still closes the call record when the summary cannot be generated', async () => {
      const session = makeSession({
        conversationHistory: [
          { sender: 'CUSTOMER', content: 'my water has been off for a week', timestamp: new Date() },
          { sender: 'AI', content: 'I have logged that for the water board.', timestamp: new Date() },
        ],
        startedAt: new Date(Date.now() - 42_000),
      });
      await seedCallLog(session.callSid, session.fromNumber);

      (voiceAi as any).generateSummary = jest.fn(async () => {
        throw new Error('LLM provider returned 503');
      });

      await (handler as any).teardown(session, 'CALLER_DISCONNECTED');
      // Teardown fires the summary without awaiting it; let it settle.
      await new Promise((r) => setTimeout(r, 50));

      const after = await prisma.callLog.findFirst({ where: { callSid: session.callSid } });
      expect(after!.status).toBe('COMPLETED');
      expect(after!.endedAt).not.toBeNull();
      expect(after!.durationSeconds).toBeGreaterThan(0);
      // The words themselves survive, which is the part that cannot be regenerated.
      expect(after!.transcript).toContain('my water has been off for a week');
      // No summary was produced, and none is invented.
      expect(after!.summary ?? '').toBe('');
    });

    it('adds the summary when it does arrive, without rewriting the record', async () => {
      const session = makeSession({
        conversationHistory: [
          { sender: 'CUSTOMER', content: 'I need a new bin', timestamp: new Date() },
        ],
        startedAt: new Date(Date.now() - 30_000),
      });
      await seedCallLog(session.callSid, session.fromNumber);

      (voiceAi as any).generateSummary = jest.fn(async () => ({
        summary: 'Citizen requested a replacement bin.',
        sentiment: 'NEUTRAL',
      }));

      await (handler as any).teardown(session, 'CALLER_DISCONNECTED');
      await new Promise((r) => setTimeout(r, 50));

      const after = await prisma.callLog.findFirst({ where: { callSid: session.callSid } });
      expect(after!.summary).toBe('Citizen requested a replacement bin.');
      expect(after!.status).toBe('COMPLETED');
      expect(after!.transcript).toContain('I need a new bin');
    });
  });

  const callbackFor = (phone: string) =>
    prisma.callbackRequest.findFirst({
      where: { organizationId: orgId, phoneNumber: phone },
      orderBy: { createdAt: 'desc' },
    });

  it('announces no handover webhook, because voice has no conversation to name', async () => {
    stubTwilio(200);
    await runHandoff(makeSession());
    // `handover.requested` carries a conversationId, and VOICE has no
    // `Conversation` row. The callback row is the record of this one.
    expect(webhookCalls.filter((c) => c.method === 'handoverRequested')).toEqual([]);
  });

  it('queues a callback instead of transferring, even with a forwarding number set', async () => {
    stubTwilio(200);
    // The forwarding number is present and deliberately NOT used.
    const session = makeSession();

    await runHandoff(session, 'I need to speak to someone about my pension');

    // The carrier is never asked to move the call.
    expect(twilioRequests).toHaveLength(0);

    const row = await callbackFor(session.fromNumber);
    expect(row).toBeTruthy();
    expect(row!.reason).toContain('my pension');
    const ref = `CB-${row!.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain(ref);
    expect(spoken[0]).toMatch(/call you back/i);

    const handoff = broadcastEvents.find((e) => e.event === 'human_handoff');
    expect(handoff?.payload).toMatchObject({ transferred: false, callback: ref });
  });

  it('never claims the call is being put through', async () => {
    stubTwilio(200);
    await runHandoff(makeSession());
    expect(spoken.join(' ')).not.toMatch(/connecting you|putting you through|transferring/i);
  });

  it('files the callback under the caller\'s own number, so the officer reaches them', async () => {
    stubTwilio(200);
    const session = makeSession();

    await runHandoff(session);

    const contact = await prisma.contact.findFirst({
      where: { organizationId: orgId, phoneNumber: session.fromNumber },
      include: { callbacks: true },
    });
    expect(contact).toBeTruthy();
    expect(contact!.callbacks).toHaveLength(1);
  });

  it('promises nothing it cannot keep when the number is withheld', async () => {
    stubTwilio(200);
    await runHandoff(makeSession({ fromNumber: 'anonymous' }));

    expect(spoken[0]).toMatch(/number isn't showing/i);
    expect(spoken[0]).not.toMatch(/reference/i);
    const handoff = broadcastEvents.find((e) => e.event === 'human_handoff');
    expect(handoff?.payload).toMatchObject({ transferred: false, callback: null, reason: 'withheld' });
  });

  /**
   * PRD §11: an emergency on a call. The 112 guidance must be SPOKEN, before
   * the callback promise — the handoff path used to replace the orchestrator's
   * reply entirely, which would have swallowed it — and the callback is due
   * now, whatever the office hours, and reads as an emergency in the queue.
   */
  it('speaks the 112 guidance first on an emergency, and makes the callback due now', async () => {
    stubTwilio(200);
    const session = makeSession();
    const before = Date.now();
    await (handler as any).handOffCallToHuman(
      session,
      { readyState: 1 } as any,
      'there is a fire outbreak in our street',
      'This sounds like an emergency. If anyone is in immediate danger, call 112 now.',
    );

    expect(spoken).toHaveLength(1);
    expect(spoken[0].indexOf('112')).toBeGreaterThanOrEqual(0);
    expect(spoken[0].indexOf('112')).toBeLessThan(spoken[0].search(/call you back/i));
    expect(spoken[0]).not.toMatch(/dispatched|on (their|the) way/i);

    const row = await callbackFor(session.fromNumber);
    expect(row!.reason).toMatch(/^EMERGENCY REPORTED/);
    expect(row!.dueAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row!.dueAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});
