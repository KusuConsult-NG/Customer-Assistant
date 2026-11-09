/**
 * The Infobip media stream, driven by a fake Infobip.
 *
 * What a real call can still disprove — whether Infobip's packets arrive as
 * documented — is not tested here, because it cannot be. What IS tested is
 * everything this bridge decides: that it speaks first, that it refuses a
 * stream it cannot place, that the caller can interrupt it, that it hears
 * every sentence, and that it never claims a transfer it did not make.
 */
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { InfobipVoiceService } from '../src/telephony/infobip/infobip-voice.service';
import { InfobipMediaStreamHandler } from '../src/telephony/infobip/infobip-media-stream.handler';
import { DEFAULT_WELCOME_MESSAGE } from '../src/common/welcome-message';

jest.setTimeout(30000);

/** A WebSocket-shaped fake for Infobip's side of the stream. */
class FakeInfobipSocket extends EventEmitter {
  readyState = 1; // OPEN
  sent: Array<Buffer | string> = [];
  closedWith: number | null = null;
  send(data: Buffer | string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
    this.emit('close');
  }
  /** Infobip's first message, then whatever comes after. */
  meta(callId: string, sampleRate = 16000, packetizationTime = 20) {
    this.emit('message', Buffer.from(JSON.stringify({ callId, sampleRate, packetizationTime })), false);
  }
  audioFrames() {
    return this.sent.filter((d) => Buffer.isBuffer(d)) as Buffer[];
  }
  textFrames() {
    return this.sent.filter((d) => typeof d === 'string') as string[];
  }
}

/** A Deepgram stand-in whose messages the test controls. */
class FakeDeepgram extends EventEmitter {
  readyState = 1;
  received: Buffer[] = [];
  send(b: Buffer) {
    this.received.push(b);
  }
  close() {
    this.readyState = 3;
  }
  final(transcript: string) {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript }] } })));
  }
  speechStarted() {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'SpeechStarted' })));
  }
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const eventually = async (check: () => boolean, ms = 4000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await settle(25);
  }
  throw new Error('condition never became true');
};

describe('Infobip media stream', () => {
  const saved: Record<string, string | undefined> = {};
  let orgId: string;

  beforeAll(async () => {
    saved.REDIS_URL = process.env.REDIS_URL;
    delete process.env.REDIS_URL; // the store's memory fallback, deterministically
    const org = await prisma.organization.create({
      data: { name: 'Infobip Stream Agency', slug: `ibs-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
    });
    orgId = org.id;
  });

  afterAll(async () => {
    if (saved.REDIS_URL !== undefined) process.env.REDIS_URL = saved.REDIS_URL;
    await prisma.ticket.deleteMany({ where: { organizationId: orgId } });
    await prisma.callLog.deleteMany({ where: { organizationId: orgId } });
    await prisma.contact.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  });

  /** Build a handler wired to fakes, with one known call. */
  const setup = async (
    opts: {
      ttsMs?: number;
      reply?: (text: string) => any;
      /** The caller's number; random unless a test needs the same citizen twice. */
      fromNumber?: string;
    } = {}
  ) => {
    const infobip = new InfobipVoiceService();
    const callId = `parent-${randomBytes(6).toString('hex')}`;
    await infobip.remember({
      parentCallId: callId,
      organizationId: orgId,
      // Random, never `Date.now()`: two setups in one millisecond would share a
      // number, which is the collision this repo already measured at 100%.
      fromNumber:
        opts.fromNumber ?? `+23480${randomBytes(4).readUInt32BE(0).toString().padStart(8, '0').slice(0, 8)}`,
      toNumber: '+2348000000001',
    });
    await prisma.callLog.create({
      data: {
        organizationId: orgId,
        callSid: callId,
        fromNumber: '+2348031111111',
        toNumber: '+2348000000001',
        provider: 'INFOBIP' as any,
        status: 'IN_PROGRESS' as any,
      },
    });

    const deepgram = new FakeDeepgram();
    const spoken: string[] = [];
    const ttsMs = opts.ttsMs ?? 100;
    const voiceAi: any = {
      createDeepgramWsForOrg: async (_org: string, audio: any) => {
        (deepgram as any).audio = audio;
        return deepgram;
      },
      fetchTtsPcm: async (text: string, _lang: string, rate: number) => {
        spoken.push(text);
        return Buffer.alloc(Math.round((rate * ttsMs) / 1000) * 2, 7);
      },
    };
    const broadcast = { emit: jest.fn() };
    const handler = new InfobipMediaStreamHandler(voiceAi, infobip, broadcast as any);
    const asked: string[] = [];
    (handler as any).orchestrator = {
      processIncomingMessage: async (_ctx: any, text: string) => {
        asked.push(text);
        return opts.reply ? opts.reply(text) : { replyText: `You said ${text}.`, shouldHandoff: false };
      },
    };
    const ws = new FakeInfobipSocket();
    handler.handleConnection(ws as any);
    const fromNumber = (await infobip.resolve(callId))!.fromNumber;
    return { handler, ws, deepgram, spoken, asked, callId, broadcast, fromNumber };
  };

  it('speaks first, in packets of the size Infobip announced', async () => {
    const { ws, spoken, callId } = await setup();
    ws.meta(callId, 16000, 20);
    await eventually(() => ws.audioFrames().length >= 5);

    expect(spoken[0]).toBe(DEFAULT_WELCOME_MESSAGE);
    // 16 kHz × 20 ms × 2 bytes.
    for (const f of ws.audioFrames()) expect(f.length).toBe(640);
  });

  it('opens Deepgram at the STREAM’s format, so nothing is transcribed at the wrong speed', async () => {
    const { ws, deepgram, callId } = await setup();
    ws.meta(callId, 8000, 20);
    await eventually(() => (deepgram as any).audio !== undefined);
    expect((deepgram as any).audio).toEqual({ encoding: 'linear16', sampleRate: 8000, channels: 1 });
  });

  it("forwards the caller's audio to Deepgram untouched", async () => {
    const { ws, deepgram, callId } = await setup();
    ws.meta(callId);
    await eventually(() => (deepgram as any).audio !== undefined);
    const packet = Buffer.alloc(640, 3);
    ws.emit('message', packet, true);
    expect(deepgram.received).toContain(packet);
  });

  it('REFUSES a stream naming a call nobody recorded', async () => {
    // Running the wrong agency's AI on a citizen's call, or filing their
    // words under someone else, is worse than a dropped call.
    const { ws, spoken } = await setup();
    ws.meta('call-that-never-arrived-0000');
    await eventually(() => ws.closedWith !== null);
    expect(ws.closedWith).toBe(1008);
    expect(spoken).toEqual([]);
  });

  it('refuses a sample rate it cannot reach exactly', async () => {
    const { ws, callId } = await setup();
    ws.meta(callId, 44100);
    await eventually(() => ws.closedWith !== null);
    expect(ws.closedWith).toBe(1008);
  });

  it('closes a stream that never says which call it is', async () => {
    const { ws } = await setup();
    await eventually(() => ws.closedWith !== null, 7000);
    expect(ws.closedWith).toBe(1008);
  });

  it('lets the caller INTERRUPT: stops talking and flushes what Infobip has queued', async () => {
    const { ws, deepgram, callId } = await setup({ ttsMs: 3000 });
    ws.meta(callId);
    // Past the grace period, mid-greeting.
    await settle(900);
    const beforeBargeIn = ws.audioFrames().length;
    deepgram.speechStarted();
    await settle(300);

    expect(ws.textFrames()).toContain(JSON.stringify({ action: 'clear' }));
    const afterBargeIn = ws.audioFrames().length;
    await settle(400);
    // Nothing more of that greeting goes out.
    expect(ws.audioFrames().length).toBe(afterBargeIn);
    // And it really was cut short: 3 s of audio at 20 ms is 150 packets.
    expect(afterBargeIn).toBeLessThan(150);
    expect(afterBargeIn).toBeGreaterThanOrEqual(beforeBargeIn);
  });

  it('ignores a cough in the first moments, rather than cutting every reply at its first word', async () => {
    const { ws, deepgram, callId } = await setup({ ttsMs: 1500 });
    ws.meta(callId);
    await eventually(() => ws.audioFrames().length > 0);
    deepgram.speechStarted(); // well inside the grace period
    await settle(200);
    expect(ws.textFrames()).not.toContain(JSON.stringify({ action: 'clear' }));
  });

  it('hears EVERY sentence, in order, even while it is still replying', async () => {
    // The WhatsApp bridge drops a final transcript that arrives while it is
    // replying; somebody giving their name in two breaths lost the second half.
    const { ws, deepgram, asked, callId } = await setup({ ttsMs: 50 });
    ws.meta(callId);
    await eventually(() => ws.audioFrames().length > 0);
    deepgram.final('My name is Amina');
    deepgram.final('Yusuf');
    await eventually(() => asked.length === 2);
    expect(asked).toEqual(['My name is Amina', 'Yusuf']);
  });

  it('acts on finals only, not on a half-heard sentence', async () => {
    const { ws, deepgram, asked, callId } = await setup({ ttsMs: 50 });
    ws.meta(callId);
    await eventually(() => ws.audioFrames().length > 0);
    deepgram.emit('message', Buffer.from(JSON.stringify({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'my na' }] } })));
    await settle(200);
    expect(asked).toEqual([]);
  });

  /**
   * A caller who needs a person is QUEUED FOR A CALLBACK, never transferred.
   *
   * An officer works the queue from the dashboard's Callbacks page. A live
   * transfer only works while an officer is free at the exact moment a
   * citizen asks, and fails exactly when the line is busiest.
   */
  describe('when the caller needs a person', () => {
    const askForAHuman = { reply: () => ({ replyText: 'Connecting you to an agent now.', shouldHandoff: true }) };
    const openFor = (phone: string) =>
      prisma.callbackRequest.findMany({
        where: { organizationId: orgId, phoneNumber: phone, status: { in: ['PENDING', 'DUE', 'IN_PROGRESS'] as any } },
      });

    it('queues a callback with their own words and reads the reference back', async () => {
      const { ws, deepgram, spoken, callId, broadcast, fromNumber } = await setup({ ttsMs: 50, ...askForAHuman });
      ws.meta(callId);
      await eventually(() => ws.audioFrames().length > 0);
      deepgram.final('I want to talk to a person about my land title');
      await eventually(() => spoken.length >= 2);

      const rows = await openFor(fromNumber);
      expect(rows).toHaveLength(1);
      // What the officer reads before dialling.
      expect(rows[0].reason).toContain('my land title');

      const ref = `CB-${rows[0].id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
      expect(spoken[1]).toContain(ref);
      expect(spoken[1]).toMatch(/call you back/i);
      expect(broadcast.emit).toHaveBeenCalledWith(
        callId,
        'human_handoff',
        expect.objectContaining({ transferred: false, callback: ref })
      );
    });

    it('never says the call is being put through', async () => {
      const { ws, deepgram, spoken, callId } = await setup({ ttsMs: 50, ...askForAHuman });
      ws.meta(callId);
      await eventually(() => ws.audioFrames().length > 0);
      deepgram.final('I want to talk to a person');
      await eventually(() => spoken.length >= 2);

      // The orchestrator's own words claim a connection that is not happening.
      expect(spoken).not.toContain('Connecting you to an agent now.');
      expect(spoken.join(' ')).not.toMatch(/connecting you|putting you through|transferring/i);
    });

    it('reuses an open request when the same citizen calls again', async () => {
      const phone = `+23480${randomBytes(4).readUInt32BE(0).toString().padStart(8, '0').slice(0, 8)}`;

      const first = await setup({ ttsMs: 50, fromNumber: phone, ...askForAHuman });
      first.ws.meta(first.callId);
      await eventually(() => first.ws.audioFrames().length > 0);
      first.deepgram.final('I need someone to call me');
      await eventually(() => first.spoken.length >= 2);

      const second = await setup({ ttsMs: 50, fromNumber: phone, ...askForAHuman });
      second.ws.meta(second.callId);
      await eventually(() => second.ws.audioFrames().length > 0);
      second.deepgram.final('nobody has called me yet');
      await eventually(() => second.spoken.length >= 2);

      // One citizen, one callback — not two officers phoning them at once.
      expect(await openFor(phone)).toHaveLength(1);
      expect(second.spoken[1]).toMatch(/already have a callback request/i);
    });

    it('promises nothing it cannot keep when the number is withheld', async () => {
      const { ws, deepgram, spoken, callId } = await setup({ ttsMs: 50, fromNumber: 'anonymous', ...askForAHuman });
      ws.meta(callId);
      await eventually(() => ws.audioFrames().length > 0);
      deepgram.final('I want to talk to a person');
      await eventually(() => spoken.length >= 2);

      // A callback against a withheld number is a promise nobody can keep.
      expect(spoken[1]).toMatch(/number isn't showing/i);
      expect(spoken[1]).not.toMatch(/reference/i);
    });

    it('queues once per call, however often the caller asks', async () => {
      const { ws, deepgram, spoken, callId, fromNumber } = await setup({ ttsMs: 50, ...askForAHuman });
      ws.meta(callId);
      await eventually(() => ws.audioFrames().length > 0);
      deepgram.final('I want to talk to a person');
      await eventually(() => spoken.length >= 2);
      deepgram.final('please, a person');
      await settle(400);

      expect(await openFor(fromNumber)).toHaveLength(1);
    });
  });

  it('writes the transcript to the call record when the stream ends', async () => {
    const { ws, deepgram, callId } = await setup({ ttsMs: 50 });
    ws.meta(callId);
    await eventually(() => ws.audioFrames().length > 0);
    deepgram.final('When is my appointment');
    await settle(400);
    ws.close(1000);
    await settle(300);

    const row = await prisma.callLog.findUnique({ where: { callSid: callId } });
    expect(row?.transcript).toMatch(/AI: /);
    expect(row?.transcript).toMatch(/Caller: When is my appointment/);
  });
});
