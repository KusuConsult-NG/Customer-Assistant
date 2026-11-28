/**
 * The waiting room ([queue] in infra/sip-bridge/templates/extensions.conf.template)
 * on a REAL Asterisk running the REAL dialplan, with the line limited to ONE
 * call. Skipped unless ASTERISK_E2E=1 and ASTERISK_QUEUE_E2E=1: the dialplan
 * must be rendered with
 *
 *   MAX_CONCURRENT_CALLS=1 QUEUE_MAX_CALLS=2 QUEUE_MAX_WAIT=12
 *
 * against API_PORT=4555 and AUDIOSOCKET_PORT=9192 (as voice-local-asterisk.spec.ts),
 * plus the TEST ONLY [test-entry] context that sets the caller id from the
 * dialled extension.
 *
 * What it proves: a caller beyond the limit is held instead of hearing a busy
 * tone, and continues into the normal call path the moment the line is free;
 * callers are let in strictly in the order they called, a caller who hangs up
 * while waiting does not hold up the ones behind them, a caller who waits too
 * long gets a callback request for their number (normalised to +234), and a
 * full waiting room books the callback straight away.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import { INestApplication } from '@nestjs/common';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, type TestTenant } from './support/tenant';
import { LocalVoiceService, QUEUE_CALLBACK_REASON } from '../src/voice-local/local-voice.service';
import type { LlmEvent } from '../src/voice-local/llm';
import { rms } from '../src/voice-local/pcm';
import type { SpeechEngine } from '../src/voice-local/tts';
import type { SttEvents } from '../src/voice-local/stt';

const run = process.env.ASTERISK_E2E === '1' && process.env.ASTERISK_QUEUE_E2E === '1' ? describe : describe.skip;
const RX = process.env.ASTERISK_RX || 'asterisk -rx';
const rx = (cmd: string) => execSync(`${RX} ${JSON.stringify(cmd)}`, { encoding: 'utf8' });

const until = async (cond: () => boolean | Promise<boolean>, ms = 20_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const HEARD = '/tmp/queue-e2e-heard.wav';
/** A global variable of the dialplan (the waiting room's ticket counters). */
const globalNumber = (name: string) => Number((rx('dialplan show globals').match(new RegExp(`${name}=(\\d+)`)) ?? [])[1] ?? 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Tone implements SpeechEngine {
  readonly name = 'azure';
  async synthesize() {
    const out = Buffer.alloc(8000);
    for (let i = 0; i < 4000; i++) out.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / 8000)), i * 2);
    return out;
  }
}

/** Asterisk's channels running a dialplan context, e.g. "queue" or "bridge". */
const inContext = (ctx: string) =>
  rx('core show channels concise')
    .split('\n')
    .filter((l) => l.split('!')[1] === ctx);

run('the waiting room on a real Asterisk (line limit 1)', () => {
  let app: INestApplication;
  let voice: LocalVoiceService;
  let tenant: TestTenant;
  /** One entry per call the voice line answered, in order: who, and how to end it. */
  let answered: Array<{ caller: string; events: SttEvents }> = [];
  let started: Date;
  const saved = { ...process.env };

  const queueEvents = async () =>
    (await prisma.systemEvent.findMany({ where: { kind: 'voice_queue', createdAt: { gte: started } }, orderBy: { createdAt: 'asc' } })).map((e) => ({
      status: e.status,
      ...(e.detail as any),
    }));
  /** A caller dials the toll-free line from `number` (the [test-entry] context sets the caller id). */
  const dial = (number: string, app = 'Wait 60') => rx(`channel originate Local/${number}@test-entry application ${app}`);
  const hangUpEverything = async () => {
    rx('channel request hangup all');
    await until(() => !/(bridge|queue)!/.test(rx('core show channels concise')), 15_000, 'every channel to end');
  };
  /** The voice line's call with this caller ends (the caller says goodbye; the model ends the call). */
  const finish = (i: number) => answered[i].events.onFinal('No thank you, goodbye.', true);

  beforeAll(async () => {
    process.env.LOCAL_VOICE_PIPELINE = '1';
    process.env.LOCAL_VOICE_SECRET = process.env.ASTERISK_LOCAL_VOICE_SECRET || 'asterisk-e2e-secret-0123456789';
    process.env.DEEPGRAM_API_KEY = 'unused';
    process.env.OPENAI_API_KEY ||= 'sk-unused-in-this-suite';
    app = await createTestApp();
    tenant = await createTenant(app, 'queue-e2e');
    process.env.LOCAL_VOICE_ORGANIZATION_SLUG = (await prisma.organization.findUnique({ where: { id: tenant.orgId } }))!.slug;
    voice = app.get(LocalVoiceService);
    voice.warmLlm = undefined;
    const register = voice.register.bind(voice);
    let lastCaller = '';
    voice.register = async (from: string, to: string) => {
      lastCaller = from;
      return register(from, to);
    };
    voice.stt = async (ev) => {
      answered.push({ caller: lastCaller, events: ev });
      return { send: () => undefined, close: () => undefined };
    };
    voice.llm = async function* (messages): AsyncGenerator<LlmEvent> {
      const last = messages[messages.length - 1];
      // Only the caller's own goodbye ends the call; the line's "no reply for N seconds" notes do not.
      if (last.role === 'user' && !String(last.content).startsWith('[')) {
        yield { type: 'text', delta: 'Goodbye.' };
        yield { type: 'tool_calls', calls: [{ id: 'e', type: 'function', function: { name: 'end_call', arguments: '{}' } }] };
      } else if (last.role === 'user') {
        yield { type: 'text', delta: 'Are you still there?' };
      }
    };
    voice.assistantEngine = () => new Tone();
    voice.governorEngine = () => new Tone();
    await app.listen(4555, '127.0.0.1');
    await voice.listen(9192);
  }, 60_000);

  afterAll(async () => {
    await hangUpEverything().catch(() => undefined);
    await prisma.systemEvent.deleteMany({ where: { kind: 'voice_queue', createdAt: { gte: started } } }).catch(() => undefined);
    await prisma.callbackRequest.deleteMany({ where: { organizationId: tenant?.orgId } }).catch(() => undefined);
    await prisma.callLog.deleteMany({ where: { organizationId: tenant?.orgId } }).catch(() => undefined);
    await dropTenant(tenant?.orgId);
    await app?.close();
    process.env = saved;
  });

  beforeEach(async () => {
    answered = [];
    started = new Date();
    await prisma.callbackRequest.deleteMany({ where: { organizationId: tenant.orgId } });
  });
  afterEach(async () => {
    await hangUpEverything();
  });

  it('a caller beyond the limit is held, not given a busy tone, and is answered as soon as the line is free', async () => {
    dial('08031119101');
    await until(() => answered.length === 1, 20_000, 'the first call to be answered');
    // The second caller's side of the call is recorded: what they hear while they wait.
    fs.rmSync(HEARD, { force: true });
    dial('08031119102', `Record ${HEARD},0,30,k`);
    await until(() => inContext('queue').length === 1, 10_000, 'the second caller to be in the waiting room');
    await sleep(3000);
    // Still waiting: the one line is taken, and the second caller was not sent anywhere else.
    expect(answered).toHaveLength(1);
    expect(inContext('queue')).toHaveLength(1);
    expect((await queueEvents()).map((e) => e.status)).toEqual(['joined']);

    finish(0);
    await until(() => answered.length === 2, 20_000, 'the waiting caller to be answered');
    // Into the SAME path as any call: registered with their number in E.164.
    expect(answered.map((a) => a.caller)).toEqual(['+2348031119101', '+2348031119102']);
    expect(inContext('queue')).toHaveLength(0);
    const ev = await queueEvents();
    expect(ev.map((e) => e.status)).toEqual(['joined', 'admitted']);
    expect(ev[1].ticket).toBe(ev[0].ticket);
    expect(ev[1].waitSeconds).toBeGreaterThanOrEqual(3);
    expect(ev[1].waitSeconds).toBeLessThan(12);
    expect(await prisma.callbackRequest.count({ where: { organizationId: tenant.orgId } })).toBe(0);

    // While waiting they heard sound — the hold message, then the tone — never a dead line.
    // (The recording continues past admission; only the waiting part, the first 3 s, is checked.)
    await hangUpEverything();
    await until(() => fs.existsSync(HEARD) && fs.statSync(HEARD).size > 44, 10_000, 'the recording');
    const pcm = fs.readFileSync(HEARD).subarray(44);
    const waitPart = pcm.subarray(0, 3 * 8000 * 2);
    const loudSeconds = [0, 1, 2].filter((sec) => rms(waitPart.subarray(sec * 16000, (sec + 1) * 16000)) > 200).length;
    expect(waitPart.length).toBe(3 * 8000 * 2);
    expect(loudSeconds).toBeGreaterThanOrEqual(2);
  }, 90_000);

  it('first come, first served; a caller who hangs up while waiting does not hold up those behind', async () => {
    dial('08031119201');
    await until(() => answered.length === 1, 20_000, 'the first call');
    dial('08031119202'); // will hang up while waiting
    await until(() => inContext('queue').length === 1, 10_000, 'caller 2 waiting');
    await sleep(500);
    dial('08031119203');
    await until(() => inContext('queue').length === 2, 10_000, 'caller 3 waiting');
    await sleep(500);
    // Caller 2 gives up. Their channel in the waiting room ends.
    const two = inContext('queue')
      .map((l) => l.split('!')[0])
      .sort()[0];
    rx(`channel request hangup ${two}`);
    await until(async () => (await queueEvents()).some((e) => e.status === 'abandoned'), 10_000, 'the abandoned event');
    dial('08031119204');
    await until(() => inContext('queue').length === 2, 10_000, 'caller 4 waiting');

    finish(0);
    await until(() => answered.length === 2, 20_000, 'the next caller to be answered');
    await sleep(3000);
    // Caller 3 — who called before caller 4 — is answered; caller 4 still waits.
    expect(answered.map((a) => a.caller)).toEqual(['+2348031119201', '+2348031119203']);
    expect(inContext('queue')).toHaveLength(1);

    finish(1);
    await until(() => answered.length === 3, 20_000, 'caller 4 to be answered');
    expect(answered[2].caller).toBe('+2348031119204');
    const ev = await queueEvents();
    const joined = ev.filter((e) => e.status === 'joined').map((e) => e.ticket);
    expect(ev.filter((e) => e.status === 'admitted').map((e) => e.ticket)).toEqual([joined[1], joined[2]]);
    expect(ev.filter((e) => e.status === 'abandoned').map((e) => e.ticket)).toEqual([joined[0]]);
  }, 120_000);

  it('nobody is let in out of turn: a free line waits for the caller ahead, until that caller leaves', async () => {
    // Timing alone cannot show the order (whichever caller checks first could
    // win by luck), so a caller is put AHEAD in the queue by hand: a ticket
    // taken, whose caller has not left. The real caller behind it must not be
    // let in, even with the line free, until that ticket is marked gone.
    dial('08031119501');
    await until(() => answered.length === 1, 20_000, 'the first call');
    const ahead = globalNumber('QNEXT') + 1;
    rx(`dialplan set global QNEXT ${ahead}`);
    dial('08031119502');
    await until(() => inContext('queue').length === 1, 10_000, 'the caller behind to be waiting');
    finish(0);
    await until(() => inContext('bridge').length === 0, 15_000, 'the line to be free');
    await sleep(5000); // two and more checks of the waiting room
    expect(answered).toHaveLength(1);
    expect(inContext('queue')).toHaveLength(1);

    rx(`dialplan set global QGONE_${ahead} 1`);
    await until(() => answered.length === 2, 10_000, 'the caller behind to be answered');
    expect(answered[1].caller).toBe('+2348031119502');
  }, 90_000);

  it('a dialplan reload while callers wait keeps their places (found in testing: it used to reset the tickets)', async () => {
    dial('08031119601');
    await until(() => answered.length === 1, 20_000, 'the first call');
    dial('08031119602');
    await until(() => inContext('queue').length === 1, 10_000, 'caller 2 waiting');
    rx('dialplan reload');
    await sleep(500);
    dial('08031119603');
    await until(() => inContext('queue').length === 2, 10_000, 'caller 3 waiting');
    finish(0);
    await until(() => answered.length === 2, 20_000, 'caller 2 to be answered');
    finish(1);
    await until(() => answered.length === 3, 20_000, 'caller 3 to be answered');
    expect(answered.map((a) => a.caller)).toEqual(['+2348031119601', '+2348031119602', '+2348031119603']);
    const ev = await queueEvents();
    const joined = ev.filter((e) => e.status === 'joined').map((e) => e.ticket);
    expect(new Set(joined).size).toBe(2); // two different tickets, not the same number handed out twice
  }, 90_000);

  it('a "left" mark someone else left on the next ticket number never skips the caller who gets it', async () => {
    dial('08031119701');
    await until(() => answered.length === 1, 20_000, 'the first call');
    rx(`dialplan set global QGONE_${globalNumber('QNEXT') + 1} 1`);
    dial('08031119702');
    await until(() => inContext('queue').length === 1, 10_000, 'caller 2 waiting');
    finish(0);
    await until(() => answered.length === 2, 10_000, 'caller 2 to be answered');
    expect(answered[1].caller).toBe('+2348031119702');
  }, 60_000);

  it('a caller who waits the whole limit gets one callback request for their number, and the call ends', async () => {
    dial('08031119301');
    await until(() => answered.length === 1, 20_000, 'the first call');
    dial('08031119302');
    await until(() => inContext('queue').length === 1, 10_000, 'caller 2 waiting');
    // QUEUE_MAX_WAIT=12 in this rendering, plus the closing message.
    await until(() => inContext('queue').length === 0, 40_000, 'the waiting caller to be let go');
    const ev = await queueEvents();
    expect(ev.map((e) => e.status)).toEqual(['joined', 'timeout', 'callback']);
    expect(ev[1].waitSeconds).toBeGreaterThanOrEqual(12);
    const rows = await prisma.callbackRequest.findMany({ where: { organizationId: tenant.orgId } });
    expect(rows.map((r) => [r.phoneNumber, r.reason, r.status])).toEqual([['+2348031119302', QUEUE_CALLBACK_REASON, 'PENDING']]);
    // The first caller was never disturbed.
    expect(answered).toHaveLength(1);
    expect(inContext('bridge').length).toBeGreaterThan(0);
  }, 90_000);

  it('a full waiting room books the callback straight away', async () => {
    dial('08031119401');
    await until(() => answered.length === 1, 20_000, 'the first call');
    dial('08031119402');
    await until(() => inContext('queue').length === 1, 10_000, 'caller 2 waiting');
    await sleep(300);
    dial('08031119403');
    await until(() => inContext('queue').length === 2, 10_000, 'caller 3 waiting');
    await sleep(300);
    dial('08031119404'); // QUEUE_MAX_CALLS=2: no room
    await until(async () => (await queueEvents()).some((e) => e.status === 'callback'), 10_000, 'the callback');
    const ev = await queueEvents();
    expect(ev.map((e) => e.status)).toEqual(['joined', 'joined', 'full', 'callback']);
    const rows = await prisma.callbackRequest.findMany({ where: { organizationId: tenant.orgId } });
    expect(rows.map((r) => r.phoneNumber)).toEqual(['+2348031119404']);
    // The turned-away caller hears the closing message and is let go; the two waiting callers are still waiting.
    await until(() => inContext('queue').length === 2, 15_000, 'the turned-away caller to be let go');
    await sleep(1000);
    expect(inContext('queue')).toHaveLength(2);
  }, 90_000);
});
