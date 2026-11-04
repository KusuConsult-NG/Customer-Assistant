/**
 * Voice handoff — putting a caller through to a person.
 *
 * The orchestrator answers "Connecting you to a live human agent right away"
 * whenever a customer asks for one. On chat and WhatsApp that is true. On a
 * phone call nothing used to happen: the sentence was spoken and the AI kept
 * talking to a caller who had just asked for a human.
 *
 * These tests drive the real handler and the real VoiceAiService against a
 * stubbed Twilio REST API, because the property that matters is not "a
 * function was called" — it is that what the caller HEARS always matches what
 * actually happened to their call.
 */

import { TwilioMediaStreamHandler } from '../src/telephony/twilio-media-stream.handler';
import { VoiceAiService } from '../src/telephony/voice-ai.service';
import { prisma } from '@ace/database';

const TWILIO_CALLS_URL = /api\.twilio\.com.*\/Calls\//;

describe('Voice handoff to a human', () => {
  let handler: TwilioMediaStreamHandler;
  let voiceAi: VoiceAiService;
  let broadcastEvents: Array<{ event: string; payload: any }>;
  let spoken: string[];
  let twilioRequests: Array<{ url: string; twiml: string }>;
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

    voiceAi = new VoiceAiService();
    // Capture what the caller would hear instead of calling ElevenLabs.
    (voiceAi as any).streamTTSToTwilio = jest.fn(async (text: string) => {
      spoken.push(text);
    });

    const broadcast: any = {
      emit: (callSid: string, event: string, payload: any) =>
        broadcastEvents.push({ event, payload }),
    };
    handler = new TwilioMediaStreamHandler(voiceAi, broadcast);
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
      fromNumber: `+23480${Date.now().toString().slice(-8)}`,
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

  it('transfers the live call to the forwarding number', async () => {
    stubTwilio(200);
    const session = makeSession();

    await runHandoff(session);

    expect(twilioRequests).toHaveLength(1);
    expect(twilioRequests[0].url).toContain(session.callSid);
    // The caller must actually be dialled through to the configured number.
    expect(twilioRequests[0].twiml).toContain('<Dial');
    expect(twilioRequests[0].twiml).toContain('+2348030001111');
    // Caller ID is the business's own number so the colleague sees the business.
    expect(twilioRequests[0].twiml).toContain('callerId="+15550001111"');

    const handoff = broadcastEvents.find((e) => e.event === 'human_handoff');
    expect(handoff?.payload.transferred).toBe(true);

    // Nothing is spoken over the stream: Twilio's own TwiML announces the
    // transfer, and only after the redirect was accepted.
    expect(spoken).toHaveLength(0);
  });

  it('never promises a transfer it could not perform (no forwarding number)', async () => {
    stubTwilio(200);
    const session = makeSession({
      carrier: { accountSid: 'AC_stub', authToken: 'stub_token', forwardingNumber: null },
    });

    await runHandoff(session);

    // No redirect was attempted, because there is nowhere to send the call.
    expect(twilioRequests).toHaveLength(0);

    // What the caller hears must not claim a connection.
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).not.toMatch(/connecting you/i);
    expect(spoken[0]).toMatch(/can't put you through/i);

    // The request must survive as something a human will see.
    // `/TCK-\d+/` was the OLD generator — `TCK-` plus the last six digits of
    // the epoch millisecond, which repeat every 16.7 minutes across every
    // tenant on a column that is `@unique` table-wide. This path was the last
    // one still using it, so the pattern here was pinning the collision in
    // place. `createTicketWithUniqueNumber` produces TCK-<base36 time>-<hex>.
    expect(spoken[0]).toMatch(/TCK-[0-9A-Z]+-[0-9A-F]+/);
    const ticket = await prisma.ticket.findFirst({
      where: { organizationId: orgId, subject: 'Caller asked to speak to a human' },
      orderBy: { createdAt: 'desc' },
    });
    expect(ticket).toBeTruthy();
    expect(ticket!.priority).toBe('HIGH');
    expect(ticket!.description).toContain('let me speak to a human');

    const handoff = broadcastEvents.find((e) => e.event === 'human_handoff');
    expect(handoff?.payload.transferred).toBe(false);
  });

  it('tells the truth when Twilio refuses the redirect', async () => {
    stubTwilio(400);
    const session = makeSession();

    await runHandoff(session);

    // It tried — and the caller is told it did not work, not that it did.
    expect(twilioRequests).toHaveLength(1);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).not.toMatch(/connecting you/i);
    expect(spoken[0]).toMatch(/call you back|call us back/i);

    const handoff = broadcastEvents.find((e) => e.event === 'human_handoff');
    expect(handoff?.payload.transferred).toBe(false);
  });

  it('files the caller under their own number so the callback reaches them', async () => {
    stubTwilio(500);
    const session = makeSession({
      carrier: { accountSid: 'AC_stub', authToken: 'stub_token', forwardingNumber: null },
    });

    await runHandoff(session);

    const contact = await prisma.contact.findFirst({
      where: { organizationId: orgId, phoneNumber: session.fromNumber },
      include: { tickets: true },
    });
    expect(contact).toBeTruthy();
    expect(contact!.tickets.length).toBeGreaterThan(0);
  });
});
