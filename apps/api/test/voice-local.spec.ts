/**
 * The server's own voice line, end to end, against the REAL app and database.
 *
 * A fake Asterisk speaks the AudioSocket protocol over a real TCP socket to the
 * real listener. Only the three paid providers are replaced (speech
 * recognition, the model, speech synthesis) — every tool call, the caller
 * lookup, the call log, the recording and the fallback decision are the
 * production code. What a sandbox cannot do is place a real phone call or
 * reach Azure; that is what the live-call checklist (deploy/vps/PHASE3.md) is for.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, type TestTenant } from './support/tenant';
import { LocalVoiceService } from '../src/voice-local/local-voice.service';
import { FRAME_BYTES, FrameReader, KIND, encodeFrame, uuidFromPayload, uuidToPayload } from '../src/voice-local/audiosocket';
import { SentenceSplitter, type ChatMessage, type LlmEvent } from '../src/voice-local/llm';
import { CachedSpeech, isCacheable, type SpeechEngine } from '../src/voice-local/tts';
import { TtsCache } from '../src/voice-local/tts-cache';
import { localToolDefinitions, runLocalTool } from '../src/voice-local/voice-tools';
import { openingSegments } from '../src/voice-local/voice-session';
import { governorLines, prerender } from '../src/voice-local/prerender';
import { PLATEAU_FEMALE_NAMES, PLATEAU_MALE_NAMES } from '../src/agent-tools/agent-tool-catalog';
import type { SttEvents } from '../src/voice-local/stt';

const SECRET = 'local-voice-test-secret-0123456789';
const saved = { ...process.env };
let app: INestApplication;
let voice: LocalVoiceService;
let tenant: TestTenant;
let port = 0;
let storage: string;

/** A tone whose length says how many words were spoken: 40 ms each, so tests stay fast. */
class FakeEngine implements SpeechEngine {
  said: string[] = [];
  constructor(readonly name: string, readonly fail = false, public delayMs = 0) {}
  async synthesize(text: string): Promise<Buffer> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.fail) throw new Error(`${this.name} down`);
    this.said.push(text);
    const words = text.split(/\s+/).length;
    const out = Buffer.alloc(words * 40 * 16);
    for (let i = 0; i < out.length / 2; i++) out.writeInt16LE(Math.round(4000 * Math.sin(i / 3)), i * 2);
    return out;
  }
}

/** Scripted recognition: the test decides when the caller "says" something. */
let stt: { events: SttEvents | null; received: number; fail: boolean };
/** The model's turns, answered from what the conversation holds so far. */
let modelCalls: ChatMessage[][];

function scriptedModel(messages: ChatMessage[]): LlmEvent[] {
  modelCalls.push(messages.map((m) => ({ ...m })) as ChatMessage[]);
  const last = messages[messages.length - 1];
  if (last.role === 'user' && /December/i.test(last.content)) {
    return [{ type: 'tool_calls', calls: [{ id: 't1', type: 'function', function: { name: 'search-knowledge', arguments: '{"query":"December events"}' } }] }];
  }
  if (last.role === 'tool') {
    return [{ type: 'text', delta: 'There is one event this December, the Jos Carnival. ' }, { type: 'text', delta: 'Is there anything else I can help you with?' }];
  }
  if (last.role === 'user' && /goodbye|no thank/i.test(last.content)) {
    return [
      { type: 'text', delta: 'Thank you for calling. Goodbye.' },
      { type: 'tool_calls', calls: [{ id: 't2', type: 'function', function: { name: 'end_call', arguments: '{}' } }] },
    ];
  }
  return [{ type: 'text', delta: 'Sorry, could you say that again?' }];
}

async function* asStream(events: LlmEvent[]): AsyncGenerator<LlmEvent> {
  for (const e of events) {
    await new Promise((r) => setTimeout(r, 5));
    yield e;
  }
}

/** A fake Asterisk: sends the UUID, then 20 ms of silence every 20 ms, and collects what it is played. */
function asterisk(uuid: string) {
  const sock = net.connect(port, '127.0.0.1');
  const reader = new FrameReader();
  const played: Buffer[] = [];
  let closed = false;
  const closedP = new Promise<void>((resolve) => sock.on('close', () => ((closed = true), resolve())));
  sock.on('data', (c) => {
    for (const f of reader.push(c)) if (f.kind === KIND.AUDIO) played.push(f.payload);
  });
  sock.on('error', () => undefined);
  sock.on('connect', () => sock.write(encodeFrame(KIND.UUID, uuidToPayload(uuid))));
  const ticker = setInterval(() => {
    if (!closed && sock.writable) sock.write(encodeFrame(KIND.AUDIO, Buffer.alloc(FRAME_BYTES)));
  }, 20);
  return {
    played,
    closed: closedP,
    isClosed: () => closed,
    hangUp: () => sock.end(encodeFrame(KIND.HANGUP)),
    stop: () => {
      clearInterval(ticker);
      sock.destroy();
    },
  };
}

const until = async (cond: () => boolean, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function register(from: string, to = '+2348000000456', secret = SECRET) {
  const res = await request(app.getHttpServer())
    .post('/api/voice-local/register')
    .type('form')
    .send({ secret, from, to });
  return res;
}

let assistant: FakeEngine;
let governor: FakeEngine;

beforeAll(async () => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-voice-'));
  process.env.STORAGE_DIR = storage;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.LOCAL_VOICE_PIPELINE = '1';
  process.env.LOCAL_VOICE_SECRET = SECRET;
  process.env.DEEPGRAM_API_KEY = 'dg-test-key-not-used';
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-not-used-in-this-suite';
  app = await createTestApp();
  tenant = await createTenant(app, 'voice-local');
  await prisma.organization.update({
    where: { id: tenant.orgId },
    data: {
      welcomeMessage:
        '<governor>{greeting}, and welcome to the Test Citizen Contact Centre. Our virtual assistant, {name}, will help you now.</governor> <break time="1.0s" /> I\'m {name}, the virtual assistant. How may I help you today?',
    },
  });
  process.env.LOCAL_VOICE_ORGANIZATION_SLUG = (await prisma.organization.findUnique({ where: { id: tenant.orgId } }))!.slug;

  voice = app.get(LocalVoiceService);
  voice.stt = async (events) => {
    if (stt.fail) throw new Error('Speech recognition did not connect within 5 s');
    stt.events = events;
    return { send: () => void stt.received++, close: () => undefined };
  };
  voice.llm = (messages) => asStream(scriptedModel(messages));
  voice.assistantEngine = () => assistant;
  voice.governorEngine = () => governor;
  port = await voice.listen(0);
});

beforeEach(() => {
  stt = { events: null, received: 0, fail: false };
  modelCalls = [];
  assistant = new FakeEngine('azure');
  governor = new FakeEngine('elevenlabs');
});

afterAll(async () => {
  await prisma.callLog.deleteMany({ where: { organizationId: tenant?.orgId } }).catch(() => undefined);
  await dropTenant(tenant?.orgId);
  await app?.close();
  process.env = saved;
  fs.rmSync(storage, { recursive: true, force: true });
});

describe('voice-local: a whole call over AudioSocket', () => {
  it('answers, uses the shared tools, hangs up on end_call, and records the call', async () => {
    const reg = await register('+2348031110001');
    expect(reg.status).toBe(200);
    expect(reg.text).toMatch(/^ok [0-9a-f-]{36}$/);
    const uuid = reg.text.split(' ')[1];

    const pbx = asterisk(uuid);
    try {
      // The opening: Governor's part in HIS voice, the rest in the assistant's.
      await until(() => assistant.said.length > 0 && stt.events !== null);
      expect(governor.said[0]).toMatch(/^Good (morning|afternoon|evening), and welcome to the Test Citizen Contact Centre/);
      expect(governor.said[0]).not.toContain('{name}');
      // Split per sentence so each caches and synthesises on its own.
      await until(() => assistant.said.length >= 2);
      expect(assistant.said.slice(0, 2)).toEqual([expect.stringMatching(/^I'm \w+, the virtual assistant\.$/), 'How may I help you today?']);
      await until(() => pbx.played.length > 20);
      expect(stt.received).toBeGreaterThan(0); // caller audio is reaching recognition

      // The stream never stops, even with nothing to say: a stopped RTP stream
      // makes the far end's jitter buffer resync and clip the next sentence.
      // At 50 frames a second, about 25 arrive in half a second either way.
      await until(() => pbx.played.length > 0 && pbx.played.slice(-10).every((f) => f.every((b) => b === 0)), 10_000);
      const before = pbx.played.length;
      await new Promise((r) => setTimeout(r, 500));
      const inHalfSecond = pbx.played.length - before;
      expect(inHalfSecond).toBeGreaterThanOrEqual(18);
      expect(inHalfSecond).toBeLessThanOrEqual(30);

      // The caller asks; the model calls the REAL search-knowledge tool.
      stt.events!.onInterim('what events');
      stt.events!.onFinal('What events are in December?', true);
      await until(() => assistant.said.some((s) => /Jos Carnival/.test(s)));
      const afterTool = modelCalls[modelCalls.length - 1];
      const toolReply = afterTool.find((m) => m.role === 'tool') as any;
      expect(toolReply).toBeTruthy();
      expect(JSON.parse(toolReply.content)).toHaveProperty('ok');

      // The caller is done; the model says goodbye and calls end_call.
      stt.events!.onFinal('No thank you, goodbye.', true);
      await pbx.closed; // the server ended the AudioSocket leg
      expect(assistant.said.slice(-2)).toEqual(['Thank you for calling.', 'Goodbye.']);
    } finally {
      pbx.stop();
    }

    // The dialplan asks what happened: completed → hang up, not fallback.
    const out = await request(app.getHttpServer()).get(`/api/voice-local/outcome/${uuid}`).query({ secret: SECRET });
    expect(out.text).toBe('completed');

    // Recorded through the one ingestion path, with our own recording.
    let log: any = null;
    for (let i = 0; i < 100 && !(log?.recordingUrl); i++) {
      log = await prisma.callLog.findUnique({ where: { callSid: `local-${uuid}` } });
      if (!log?.recordingUrl) await new Promise((r) => setTimeout(r, 100));
    }
    expect(log).toBeTruthy();
    expect(log.organizationId).toBe(tenant.orgId);
    expect(log.provider).toBe('SIP_TRUNK');
    expect(log.direction).toBe('INBOUND');
    expect(log.fromNumber).toBe('+2348031110001');
    expect(log.transcript).toContain('What events are in December?');
    expect(log.recordingUrl).toMatch(/^local:/);

    // An officer can play it back; it is a real WAV of both sides.
    const rec = await request(app.getHttpServer())
      .get(`/api/calls/${log.id}/recording`)
      .set('Authorization', `Bearer ${tenant.token}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(rec.status).toBe(200);
    const wav = Buffer.from(rec.body);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt16LE(22)).toBe(2); // caller and assistant, one channel each
  }, 30_000);

  it('falls back to ElevenLabs when speech recognition cannot connect — the caller is never left in silence', async () => {
    stt.fail = true;
    const reg = await register('+2348031110002');
    const uuid = reg.text.split(' ')[1];
    const pbx = asterisk(uuid);
    try {
      await pbx.closed;
    } finally {
      pbx.stop();
    }
    const out = await request(app.getHttpServer()).get(`/api/voice-local/outcome/${uuid}`).query({ secret: SECRET });
    expect(out.text).toBe('fallback');
  }, 15_000);

  it('falls back when the assistant voice fails during the opening', async () => {
    assistant = new FakeEngine('azure', true);
    const reg = await register('+2348031110003');
    const uuid = reg.text.split(' ')[1];
    const pbx = asterisk(uuid);
    try {
      await pbx.closed;
    } finally {
      pbx.stop();
    }
    expect((await request(app.getHttpServer()).get(`/api/voice-local/outcome/${uuid}`).query({ secret: SECRET })).text).toBe('fallback');
  }, 15_000);

  it('speaks the Governor part in the assistant voice when his recording cannot be made', async () => {
    governor = new FakeEngine('elevenlabs', true);
    const reg = await register('+2348031110004');
    const pbx = asterisk(reg.text.split(' ')[1]);
    try {
      // The opening's sentences are synthesised in parallel (and PLAYED in
      // order), so the fallback Governor line is not necessarily said first.
      await until(() => assistant.said.length >= 2);
      expect(assistant.said.some((t) => /^Good (morning|afternoon|evening), and welcome to the Test Citizen Contact Centre/.test(t))).toBe(true);
    } finally {
      pbx.hangUp();
      pbx.stop();
    }
  }, 15_000);

  it('passes the caller\'s audio to recognition while a slow opening is still being synthesised', async () => {
    // Before: audio was held back until the whole opening was ready, one
    // second kept and the rest dropped, so Deepgram heard nothing, closed
    // (1011) after ~10 s and the call failed over. A cold speech cache after a
    // voice change made exactly that happen on a real call.
    assistant = new FakeEngine('azure', false, 2_500);
    governor = new FakeEngine('elevenlabs', false, 2_500);
    const reg = await register('+2348031110006');
    const pbx = asterisk(reg.text.split(' ')[1]);
    try {
      await new Promise((r) => setTimeout(r, 2_000)); // the opening is not ready yet
      expect(assistant.said).toEqual([]);
      expect(stt.received).toBeGreaterThan(70); // ~2 s at 50 frames/s, not the 50 a buffer kept
    } finally {
      pbx.hangUp();
      pbx.stop();
    }
  }, 15_000);

  it('says a short acknowledgement from disk when the reply is slow to synthesise, and logs where the wait went', async () => {
    const logged: string[] = [];
    const spy = jest.spyOn((voice as any).log, 'log').mockImplementation((m: any) => void logged.push(String(m)));
    const reg = await register('+2348031110007');
    const pbx = asterisk(reg.text.split(' ')[1]);
    try {
      await until(() => stt.events !== null);
      // The acknowledgements are put on disk after the opening.
      const cache = (voice as any).cache as TtsCache;
      const onDisk = (t: string) => !!cache.get(new CachedSpeech(assistant, cache).key(t));
      await until(() => ['Alright.', 'Okay.', 'One moment, please.'].every(onDisk));
      // The opening has finished playing: silence for longer than its own 1 s pause.
      await until(() => pbx.played.length > 100 && pbx.played.slice(-70).every((f) => f.every((b) => b === 0)), 10_000);
      assistant.delayMs = 2_000; // a slow provider for the reply
      const asked = Date.now();
      stt.events!.onFinal('Hello there.', true);
      await until(() => logged.some((l) => l.startsWith('voice_local_ack')), 3_000);
      expect(Date.now() - asked).toBeLessThan(1_800); // well before the 2 s reply
      await until(() => logged.some((l) => l.startsWith('voice_local_turn')), 6_000);
      const turn = JSON.parse(logged.find((l) => l.startsWith('voice_local_turn'))!.replace(/^[^{]*/, ''));
      expect(turn.first_audio_ms).toBeGreaterThanOrEqual(2_000);
      expect(turn.model_ms).toBeLessThan(1_000);
    } finally {
      spy.mockRestore();
      pbx.hangUp();
      pbx.stop();
    }
  }, 20_000);

  it('a caller who hangs up is not handed to the backup agent', async () => {
    const reg = await register('+2348031110005');
    const uuid = reg.text.split(' ')[1];
    const pbx = asterisk(uuid);
    await until(() => assistant.said.length > 0);
    pbx.hangUp();
    pbx.stop();
    await until(() => voice.outcomeOf(uuid) !== 'unknown' && voice.outcomeOf(uuid) !== 'fallback');
    expect(voice.outcomeOf(uuid)).toBe('caller_hung_up');
  }, 15_000);
});

describe('voice-local: registration never costs a call', () => {
  it('refuses a wrong secret (the dialplan reads anything but ok as fallback)', async () => {
    const res = await register('+2348031110009', '+2348000000456', 'wrong');
    expect(res.status).toBe(403);
    expect(res.text.startsWith('ok')).toBe(false);
  });

  it('sends the call to ElevenLabs when switched off, or when a provider key is missing', async () => {
    process.env.LOCAL_VOICE_PIPELINE = '0';
    expect((await register('+2348031110010')).text).toBe('fallback disabled');
    process.env.LOCAL_VOICE_PIPELINE = '1';
    const keep = process.env.DEEPGRAM_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    expect((await register('+2348031110010')).text).toBe('fallback not-ready');
    expect(voice.readiness().missing).toContain('DEEPGRAM_API_KEY');
    process.env.DEEPGRAM_API_KEY = keep;
  });

  it('a registration whose audio never arrives is fallback, and an unknown uuid is unknown', async () => {
    const uuid = (await register('+2348031110011')).text.split(' ')[1];
    expect(voice.outcomeOf(uuid)).toBe('fallback');
    expect(voice.outcomeOf('00000000-0000-0000-0000-000000000000')).toBe('unknown');
  });

  it('an AudioSocket connection with a uuid nobody registered is closed', async () => {
    const pbx = asterisk('11111111-2222-3333-4444-555555555555');
    await pbx.closed;
    pbx.stop();
    expect(voice.outcomeOf('11111111-2222-3333-4444-555555555555')).toBe('fallback');
  });
});

describe('voice-local: parts', () => {
  it('reassembles AudioSocket frames however TCP splits them', () => {
    const uuid = '0f0e0d0c-0b0a-0908-0706-050403020100';
    const stream = Buffer.concat([encodeFrame(KIND.UUID, uuidToPayload(uuid)), encodeFrame(KIND.AUDIO, Buffer.alloc(320, 7)), encodeFrame(KIND.HANGUP)]);
    const r = new FrameReader();
    const frames = [];
    for (let i = 0; i < stream.length; i += 5) frames.push(...r.push(stream.subarray(i, i + 5)));
    expect(frames.map((f) => f.kind)).toEqual([KIND.UUID, KIND.AUDIO, KIND.HANGUP]);
    expect(uuidFromPayload(frames[0].payload)).toBe(uuid);
    expect(frames[1].payload.length).toBe(320);
  });

  it('offers the model the catalog tools WITHOUT the parameters the platform supplies', async () => {
    const defs = localToolDefinitions();
    const names = defs.map((d) => d.function.name);
    expect(names).toContain('create-ticket');
    expect(names).toContain('end_call');
    expect(names).not.toContain('handoff');
    for (const d of defs) {
      expect(Object.keys(d.function.parameters.properties as object)).not.toContain('phoneNumber');
      expect(Object.keys(d.function.parameters.properties as object)).not.toContain('conversationId');
      expect((d.function.parameters.required as string[]).includes('phoneNumber')).toBe(false);
    }
    // ...and the session fills them, whatever the model tries to pass.
    const seen: any[] = [];
    const fakeTools: any = { checkBooking: async (_o: string, phone: string) => (seen.push(phone), { ok: true, message: 'none' }) };
    await runLocalTool(fakeTools, 'check-booking', { phoneNumber: '+2340000000000' }, { organizationId: 'o', callerNumber: '+2348031110012', conversationId: 'local-x' });
    expect(seen).toEqual(['+2348031110012']);
    // A tool that throws is an honest failure for the model, not a dead line.
    const r: any = await runLocalTool({ searchKnowledge: async () => { throw new Error('db down'); } } as any, 'search-knowledge', { query: 'x' }, { organizationId: 'o', callerNumber: '', conversationId: 'c' });
    expect(r.ok).toBe(false);
  });

  it('keeps general phrases on disk and never a number or the caller’s name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-tts-'));
    const engine = new FakeEngine('azure');
    const speech = new CachedSpeech(engine, new TtsCache(dir));
    expect((await speech.speak('One moment, please.')).cached).toBe(false);
    expect((await speech.speak('One moment, please.')).cached).toBe(true);
    expect(engine.said).toEqual(['One moment, please.']);
    await speech.speak('Your reference is 4 8 2 1 3.');
    await speech.speak('Your reference is 4 8 2 1 3.');
    await speech.speak('Welcome back, Amina.', { personal: ['Amina'] });
    await speech.speak('Welcome back, Amina.', { personal: ['Amina'] });
    expect(engine.said.length).toBe(5);
    expect(isCacheable('Good morning, and welcome.')).toBe(true);
    expect(isCacheable('Call 112 now.')).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('evicts the least recently used clips past the size limit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-tts-'));
    const cache = new TtsCache(dir, 2_500);
    for (let i = 0; i < 5; i++) cache.put(TtsCache.keyOf({ i }, 'x'), Buffer.alloc(1000));
    await cache.flush(); // written in the background
    expect(cache.sweep()).toBeGreaterThanOrEqual(2000);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('splits the opening into the Governor, the pause and the assistant', () => {
    expect(openingSegments('<governor>Good morning, welcome.</governor> <break time="1.0s" /> I\'m Dalyop. How may I help you today?')).toEqual([
      { kind: 'governor', text: 'Good morning, welcome.' },
      { kind: 'break', ms: 1000 },
      { kind: 'assistant', text: "I'm Dalyop. How may I help you today?" },
    ]);
    expect(openingSegments('Hello! How can I help?')).toEqual([{ kind: 'assistant', text: 'Hello! How can I help?' }]);
  });

  it('lets the first piece of a reply end at a comma, so the caller hears it sooner', () => {
    const sp = new SentenceSplitter({ firstAtComma: true });
    expect(sp.push('Yes, the Jos Carnival opens on the twentieth, ')).toEqual(['Yes, the Jos Carnival opens on the twentieth,']);
    expect(sp.push('with a parade, then music. ')).toEqual(['with a parade, then music.']); // later pieces: sentences only
    expect(new SentenceSplitter({ firstAtComma: true }).push('Yes, sure. ')).toEqual([]); // too short to split early
    expect(new SentenceSplitter().push('Yes, the Jos Carnival opens on the twentieth, ')).toEqual([]);
  });

  it('speaks streamed text a sentence at a time', () => {
    const s = new SentenceSplitter();
    expect(s.push('There are three events this month. The fir')).toEqual(['There are three events this month.']);
    expect(s.push('st is the carnival. Ok.')).toEqual(['The first is the carnival.']);
    expect(s.flush()).toBe('Ok.');
  });

  it('pre-renders every Governor line once, so none needs ElevenLabs on a call', async () => {
    const org = {
      name: 'Plateau State Government Citizen Contact Centre',
      slug: 'plateau-contact',
      timezone: 'Africa/Lagos',
      welcomeMessage:
        '<governor>{greeting}, and welcome to the Plateau State Government Citizen Contact Centre. Our virtual assistant, {name}, will help you now.</governor> <break time="1.0s" /> I\'m {name}, the virtual assistant. How may I help you today?',
    };
    const lines = governorLines(org);
    // Every roster name, in all three times of day — and nothing else.
    expect(lines.length).toBe(PLATEAU_MALE_NAMES.length * 3);
    expect(lines.filter((l) => l.startsWith('Good morning')).length).toBe(PLATEAU_MALE_NAMES.length);
    expect(lines.every((l) => !/[{}<>]/.test(l))).toBe(true);
    // With Spitch the line also picks female names, and the Governor names them too.
    const both = governorLines(org, true);
    // "Naankang" is on both rosters (Ngas "Naan-" names are unisex): same line, counted once.
    expect(both.length).toBe(new Set([...PLATEAU_MALE_NAMES, ...PLATEAU_FEMALE_NAMES]).size * 3);
    expect(both.some((l) => l.includes(PLATEAU_FEMALE_NAMES[0]))).toBe(true);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-gov-'));
    const cache = new TtsCache(dir);
    const engine = new FakeEngine('elevenlabs');
    const speech = new CachedSpeech(engine, cache);
    const report = await prerender(lines.slice(0, 4), speech, cache, false, () => undefined);
    expect(report).toEqual({ present: 0, rendered: 0, failed: [] });
    expect(engine.said).toEqual([]); // the report renders nothing
    expect((await prerender(lines.slice(0, 4), speech, cache, true)).rendered).toBe(4);
    expect((await prerender(lines.slice(0, 4), speech, cache, true)).present).toBe(4);
    // The call then finds it on disk: no provider is asked.
    expect((await speech.speak(lines[0], { alwaysCache: true })).cached).toBe(true);
    expect(engine.said.length).toBe(4);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
