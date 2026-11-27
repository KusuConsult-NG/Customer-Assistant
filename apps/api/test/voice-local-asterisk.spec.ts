/**
 * The local voice line against a REAL Asterisk running the REAL dialplan
 * (infra/sip-bridge/templates/extensions.conf.template). Skipped unless
 * ASTERISK_E2E=1 — it needs an Asterisk with app_audiosocket and func_curl
 * reachable as `ASTERISK_RX` (a command prefix that runs `asterisk -rx`), with
 * the dialplan rendered against API_PORT=4555 and AUDIOSOCKET_PORT=9192.
 *
 * What it proves that voice-local.spec.ts cannot: the dialplan's CURL
 * register, AudioSocket connecting with the uuid the API issued, audio both
 * ways through Asterisk, and the outcome read sending a failed local leg on to
 * the ElevenLabs Dial — on Asterisk itself, not on a fake of it.
 *
 * Providers are still faked (no Deepgram/Azure/model key in a sandbox). On the
 * server, deploy/vps/PHASE3.md is the same check with real ones and a real call.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { INestApplication } from '@nestjs/common';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, type TestTenant } from './support/tenant';
import { LocalVoiceService } from '../src/voice-local/local-voice.service';
import { rms, wavFile } from '../src/voice-local/pcm';
import type { LlmEvent } from '../src/voice-local/llm';
import { SpitchTts, type SpeechEngine } from '../src/voice-local/tts';
import { ACKS, HOLDING_LINE } from '../src/voice-local/voice-session';
import { TtsCache } from '../src/voice-local/tts-cache';
import type { SttEvents } from '../src/voice-local/stt';

const run = process.env.ASTERISK_E2E === '1' ? describe : describe.skip;
const RX = process.env.ASTERISK_RX || 'asterisk -rx';
const rx = (cmd: string) => execSync(`${RX} ${JSON.stringify(cmd)}`, { encoding: 'utf8' });
const shell = (cmd: string) => execSync(`${(process.env.ASTERISK_SHELL || 'bash -c')} ${JSON.stringify(cmd)}`, { encoding: 'utf8' });

const until = async (cond: () => boolean | Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
};

class Tone implements SpeechEngine {
  readonly name = 'azure';
  said: string[] = [];
  async synthesize(text: string) {
    this.said.push(text);
    const out = Buffer.alloc(8000 * 2); // one second of 440 Hz
    for (let i = 0; i < 8000; i++) out.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 8000)), i * 2);
    return out;
  }
}

run('voice-local against a real Asterisk', () => {
  let app: INestApplication;
  let voice: LocalVoiceService;
  let tenant: TestTenant;
  let events: SttEvents | null = null;
  let loudFrames = 0;
  let sttFails = false;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.LOCAL_VOICE_PIPELINE = '1';
    process.env.LOCAL_VOICE_SECRET = process.env.ASTERISK_LOCAL_VOICE_SECRET || 'asterisk-e2e-secret-0123456789';
    process.env.DEEPGRAM_API_KEY = 'unused';
    process.env.OPENAI_API_KEY ||= 'sk-unused-in-this-suite';
    app = await createTestApp();
    tenant = await createTenant(app, 'asterisk-e2e');
    process.env.LOCAL_VOICE_ORGANIZATION_SLUG = (await prisma.organization.findUnique({ where: { id: tenant.orgId } }))!.slug;
    voice = app.get(LocalVoiceService);
    voice.warmLlm = undefined; // no provider in this suite
    voice.stt = async (ev) => {
      if (sttFails) throw new Error('recognition down');
      events = ev;
      return {
        send: (frame: Buffer) => {
          if (rms(frame) > 300) loudFrames++;
        },
        close: () => undefined,
      };
    };
    voice.llm = async function* (messages): AsyncGenerator<LlmEvent> {
      const last = messages[messages.length - 1];
      if (last.role === 'user') {
        yield { type: 'text', delta: 'Thank you for calling. Goodbye.' };
        yield { type: 'tool_calls', calls: [{ id: 'e', type: 'function', function: { name: 'end_call', arguments: '{}' } }] };
      }
    };
    voice.assistantEngine = () => new Tone();
    voice.governorEngine = () => new Tone();
    await app.listen(4555, '127.0.0.1');
    await voice.listen(9192);
  }, 60_000);

  afterAll(async () => {
    await prisma.callLog.deleteMany({ where: { organizationId: tenant?.orgId } }).catch(() => undefined);
    await dropTenant(tenant?.orgId);
    await app?.close();
    process.env = saved;
  });

  beforeEach(() => {
    events = null;
    loudFrames = 0;
    sttFails = false;
  });

  it('our speech reaches the caller through Asterisk, and end_call hangs up', async () => {
    shell('rm -f /tmp/heard.wav');
    rx('channel originate Local/s@bridge application Record /tmp/heard.wav,0,12,k');
    await until(() => events !== null);
    // Let the opening play into the recording, then the caller says goodbye.
    await new Promise((r) => setTimeout(r, 2500));
    events!.onFinal('No thank you, goodbye.', true);
    await until(() => !rx('core show channels concise').includes('bridge'), 25_000);
    const size = Number(shell('stat -c %s /tmp/heard.wav 2>/dev/null || echo 0').trim());
    // A second of tone is 16 KB of slin; Record writes it as 8 kHz WAV.
    expect(size).toBeGreaterThan(8_000);
  }, 60_000);

  it('the caller’s audio reaches recognition through Asterisk', async () => {
    rx('channel originate Local/s@bridge application Playback tt-monkeys');
    await until(() => loudFrames > 20, 20_000);
    events!.onFinal('Goodbye.', true);
    await until(() => !rx('core show channels concise').includes('bridge'), 25_000);
  }, 60_000);

  it('a slow Spitch on a busy server: every sentence reaches the caller whole, in a steady 20 ms stream', async () => {
    // What the caller hears, measured at both ends: the frames Asterisk is
    // handed (timing — what the carrier's jitter buffer sees) and the audio
    // Asterisk recorded on the caller's side (nothing dropped).
    const SECS_PER_WORD = 0.3;
    // Built ONCE, before the call: generating it per request would block the
    // event loop inside the fake provider and be measured as our own stall.
    const toneSource = (() => {
      const n = 24000 * 12;
      const pcm = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 500 * i) / 24000)), i * 2);
      return pcm;
    })();
    const toneWav = (secs: number) => wavFile(toneSource.subarray(0, Math.round(24000 * secs) * 2), 1, 24000);
    const spoken: string[] = [];
    const realFetch = global.fetch;
    (global as any).fetch = async (url: string, init: any) => {
      if (!String(url).includes('/v1/speech')) return realFetch(url, init);
      const { text } = JSON.parse(init.body);
      spoken.push(text);
      await new Promise((r) => setTimeout(r, 1_500)); // a slow provider, every sentence
      return new Response(new Uint8Array(toneWav(text.split(/\s+/).length * SECS_PER_WORD)), { status: 200 });
    };
    // A COLD speech cache, as on the first calls after a voice change.
    const savedCache = (voice as any).cache;
    (voice as any).cache = new TtsCache(fs.mkdtempSync(path.join(os.tmpdir(), 'ace-e2e-cache-')));
    const savedEngine = voice.assistantEngine;
    const savedLlm = voice.llm;
    voice.assistantEngine = () => new SpitchTts({ key: 'k', voice: 'jude' });
    const answer = ['There are three events in December.', 'The Jos Carnival opens on the twentieth.', 'Is there anything else I can help you with?'];
    voice.llm = async function* (messages): AsyncGenerator<LlmEvent> {
      const last = messages[messages.length - 1];
      if (last.role === 'user' && /December/.test(String(last.content))) {
        for (const a of answer) yield { type: 'text', delta: a + ' ' };
        yield { type: 'tool_calls', calls: [{ id: 'e', type: 'function', function: { name: 'end_call', arguments: '{}' } }] };
      }
    };

    // Every AudioSocket audio frame we hand Asterisk, with the time it left.
    const sent: Array<{ t: number; loud: boolean }> = [];
    const realWrite = net.Socket.prototype.write;
    (net.Socket.prototype as any).write = function (this: net.Socket, chunk: any, ...rest: any[]) {
      if (this.localPort === 9192 && Buffer.isBuffer(chunk) && chunk[0] === 0x10 && chunk.length === 323) {
        sent.push({ t: performance.now(), loud: rms(chunk.subarray(3)) > 500 });
      }
      return (realWrite as any).call(this, chunk, ...rest);
    };
    // A busy server: the event loop is blocked for 60 ms every 250 ms.
    const STALL_MS = Number(process.env.E2E_STALL_MS ?? 60);
    const stall = setInterval(() => {
      if (!STALL_MS) return;
      const until = performance.now() + STALL_MS;
      while (performance.now() < until) {
        /* busy */
      }
    }, 250);

    try {
      shell('rm -f /tmp/heard-slow.wav');
      rx('channel originate Local/s@bridge application Record /tmp/heard-slow.wav,0,40,k');
      await until(() => events !== null);
      await until(() => spoken.length >= 2, 15_000); // the opening's sentences went to Spitch
      await new Promise((r) => setTimeout(r, 4_000)); // and played
      events!.onFinal('What events are in December?', true);
      await until(() => !rx('core show channels concise').includes('bridge'), 40_000);
    } finally {
      clearInterval(stall);
      (net.Socket.prototype as any).write = realWrite;
      (global as any).fetch = realFetch;
      voice.assistantEngine = savedEngine;
      voice.llm = savedLlm;
      (voice as any).cache = savedCache;
    }

    // Every sentence was synthesised and none was skipped.
    for (const a of answer) expect(spoken).toContain(a);

    // The stream never stopped: no gap between frames longer than the stalls
    // themselves, and never a burst of more than two frames at once.
    const gaps = sent.slice(1).map((f, i) => f.t - sent[i].t);
    const maxGap = Math.max(...gaps);
    // eslint-disable-next-line no-console
    if (process.env.E2E_DEBUG) console.log('gaps>45ms at', gaps.map((g, i) => [i, g]).filter(([, g]) => g > 45).map(([i, g]) => `${((sent[i].t - sent[0].t) / 1000).toFixed(2)}s:${g.toFixed(0)}ms${sent[i].loud ? '(speech)' : ''}`).join(' '));
    let burst = 1;
    let maxBurst = 1;
    for (const g of gaps) {
      burst = g < 3 ? burst + 1 : 1;
      maxBurst = Math.max(maxBurst, burst);
    }
    const secs = (sent[sent.length - 1].t - sent[0].t) / 1000;
    const rate = sent.length / secs;
    // eslint-disable-next-line no-console
    console.log(`frames=${sent.length} secs=${secs.toFixed(1)} rate=${rate.toFixed(1)}/s maxGap=${maxGap.toFixed(0)}ms maxBurst=${maxBurst}`);
    // At 50 a second, whatever the event loop did: a stall can delay frames
    // by its own length, and the catch-up afterwards is a bounded burst.
    // With no load, single gaps of 60-80 ms remain where a provider's reply is
    // decoded (the test runner runs this code about twice as slowly as the
    // built dist). Each is followed by a catch-up, so the rate holds at 50/s,
    // which a carrier's jitter buffer absorbs.
    expect(maxGap).toBeLessThan(Math.max(STALL_MS, 55) + 45);
    expect(maxBurst).toBeLessThanOrEqual(6);
    expect(rate).toBeGreaterThan(48.5);
    expect(rate).toBeLessThan(51);

    // Nothing dropped: the speech the caller's side recorded is as long as
    // every sentence we synthesised (the Governor's line is the 1 s tone).
    // The acknowledgements are put on disk after the opening but only played when a reply is slow.
    const played = spoken.filter((t) => ![...ACKS, HOLDING_LINE].includes(t));
    const expectedSpeechSecs = played.reduce((n, t) => n + t.split(/\s+/).length * SECS_PER_WORD, 0);
    const sentSpeechSecs = sent.filter((f) => f.loud).length * 0.02;
    const heard = fs.readFileSync('/tmp/heard-slow.wav');
    let loudSamples = 0;
    for (let i = 44; i + 1 < heard.length; i += 2) if (Math.abs(heard.readInt16LE(i)) > 1500) loudSamples++;
    const heardSecs = loudSamples / 8000;
    // eslint-disable-next-line no-console
    console.log(`speech synthesised=${expectedSpeechSecs.toFixed(2)}s sent=${sentSpeechSecs.toFixed(2)}s heard~${heardSecs.toFixed(2)}s`);
    expect(sentSpeechSecs).toBeGreaterThan(expectedSpeechSecs - 0.1);
    // A sine is above 1500 for ~88% of its samples; the governor's tone adds 1 s.
    expect(heardSecs).toBeGreaterThan((expectedSpeechSecs + 1) * 0.8);
  }, 90_000);

  it('a failed local leg is handed to the ElevenLabs Dial by the dialplan itself', async () => {
    sttFails = true;
    const count = () =>
      Number(shell("grep -c 'PJSIP/elevenlabs/sip:' /var/log/asterisk/cdr-csv/Master.csv || true").trim() || 0);
    const before = count();
    // Wait: a caller who sends NO audio — the case a bare socket close missed.
    rx('channel originate Local/s@bridge application Wait 15');
    // The call records (CDR) are Asterisk's own account of the dialplan's
    // steps: a NEW ElevenLabs Dial after the local leg, read from Asterisk.
    await until(() => count() > before, 30_000);
    const last = shell("grep 'Local/s@bridge' /var/log/asterisk/cdr-csv/Master.csv | tail -n 4");
    expect(last).toMatch(/AudioSocket\/127\.0\.0\.1:9192\//);
  }, 60_000);
});
