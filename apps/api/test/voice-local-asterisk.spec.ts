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
import { INestApplication } from '@nestjs/common';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, type TestTenant } from './support/tenant';
import { LocalVoiceService } from '../src/voice-local/local-voice.service';
import { rms } from '../src/voice-local/pcm';
import type { LlmEvent } from '../src/voice-local/llm';
import type { SpeechEngine } from '../src/voice-local/tts';
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
