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
    expect(spoken[0]).toMatch(/TCK-\d+/);
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
