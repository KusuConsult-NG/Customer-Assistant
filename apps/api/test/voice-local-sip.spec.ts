/**
 * The local voice line called the way Alphatech calls it: a real SIP INVITE
 * and real G.711 RTP into a REAL Asterisk running the bridge's own dialplan.
 * Skipped unless SIP_E2E=1 (needs that Asterisk, with the alphatech identify
 * matching 127.0.0.1 and the dialplan rendered for API_PORT=4555 /
 * AUDIOSOCKET_PORT=9192).
 *
 * Why it exists: the caller's audio was delivered to the voice line as 8-bit
 * µ-law, read as 16-bit linear, and Deepgram heard noise — on every real
 * call. Every other test counted frames or loudness, which noise passes. This
 * one checks the CONTENT: the caller's 300 Hz tone must arrive as 300 Hz.
 */
import * as dgram from 'dgram';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { INestApplication } from '@nestjs/common';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, type TestTenant } from './support/tenant';
import { LocalVoiceService } from '../src/voice-local/local-voice.service';
import { mulawToLinear, rms, wavFile } from '../src/voice-local/pcm';
import type { LlmEvent } from '../src/voice-local/llm';
import { SpitchTts } from '../src/voice-local/tts';
import { TtsCache } from '../src/voice-local/tts-cache';

const run = process.env.SIP_E2E === '1' ? describe : describe.skip;

function linearToMulaw(sample: number): number {
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s = Math.min(s, 32635) + 0x84;
  let exp = 7;
  for (let m = 0x4000; (s & m) === 0 && exp > 0; exp--, m >>= 1);
  return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
}

/** Dominant frequency of slin16 by zero crossings. */
function zeroCrossingHz(slin: Buffer): number {
  let zc = 0;
  const n = slin.length / 2;
  for (let i = 1; i < n; i++) if ((slin.readInt16LE(i * 2) >= 0) !== (slin.readInt16LE(i * 2 - 2) >= 0)) zc++;
  return (zc / 2) * (8000 / n);
}

run('voice-local: a real SIP caller through the real dialplan', () => {
  let app: INestApplication;
  let voice: LocalVoiceService;
  let tenant: TestTenant;
  const heardByRecognition: Buffer[] = [];

  beforeAll(async () => {
    process.env.LOCAL_VOICE_PIPELINE = '1';
    process.env.LOCAL_VOICE_SECRET = 'asterisk-e2e-secret-0123456789';
    process.env.DEEPGRAM_API_KEY = 'unused';
    process.env.OPENAI_API_KEY ||= 'sk-unused';
    app = await createTestApp();
    tenant = await createTenant(app, 'sip-e2e');
    process.env.LOCAL_VOICE_ORGANIZATION_SLUG = (await prisma.organization.findUnique({ where: { id: tenant.orgId } }))!.slug;
    voice = app.get(LocalVoiceService);
    voice.warmLlm = undefined; // no provider in this suite
    voice.stt = async () => ({ send: (f: Buffer) => void heardByRecognition.push(Buffer.from(f)), close: () => undefined });
    voice.llm = async function* (): AsyncGenerator<LlmEvent> {
      /* no turn is completed in this test */
    };
    const tone = Buffer.alloc(24000 * 12 * 2);
    for (let i = 0; i < 24000 * 12; i++) tone.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 500 * i) / 24000)), i * 2);
    const realFetch = global.fetch;
    (global as any).fetch = async (url: string, init: any) => {
      if (!String(url).includes('/v1/speech')) return realFetch(url, init);
      const { text } = JSON.parse(init.body);
      return new Response(new Uint8Array(wavFile(tone.subarray(0, Math.round(24000 * 0.3 * text.split(/\s+/).length) * 2), 1, 24000)), { status: 200 });
    };
    voice.assistantEngine = () => new SpitchTts({ key: 'k', voice: 'jude' });
    voice.governorEngine = () => new SpitchTts({ key: 'k', voice: 'gov' });
    await app.listen(4555, '127.0.0.1');
    await voice.listen(9192);
    (voice as any).cache = new TtsCache(fs.mkdtempSync(path.join(os.tmpdir(), 'sip-cache-')));
  }, 60_000);

  afterAll(async () => {
    await prisma.callLog.deleteMany({ where: { organizationId: tenant?.orgId } }).catch(() => undefined);
    await dropTenant(tenant?.orgId);
    await app?.close();
  });

  it('the caller hears the assistant, and the assistant receives the caller as real 16-bit audio', async () => {
    const sip = dgram.createSocket('udp4');
    const rtp = dgram.createSocket('udp4');
    await new Promise<void>((r) => sip.bind(5070, '127.0.0.1', () => r()));
    await new Promise<void>((r) => rtp.bind(40000, '127.0.0.1', () => r()));
    const callId = `sip-e2e-${Date.now()}@127.0.0.1`;
    const sdp = ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 'c=IN IP4 127.0.0.1', 't=0 0', 'm=audio 40000 RTP/AVP 0', 'a=rtpmap:0 PCMU/8000', 'a=sendrecv', ''].join('\r\n');
    let toTag = '';
    const req = (method: string, cseq: number, body = '') =>
      `${method} sip:+2348000000456@127.0.0.1:5060 SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK${method}${cseq}x${Date.now()};rport\r\n` +
      `Max-Forwards: 70\r\nFrom: <sip:08031234567@127.0.0.1>;tag=caller\r\nTo: <sip:+2348000000456@127.0.0.1>${toTag ? `;tag=${toTag}` : ''}\r\n` +
      `Call-ID: ${callId}\r\nCSeq: ${cseq} ${method}\r\nContact: <sip:08031234567@127.0.0.1:5070>\r\n` +
      `${body ? 'Content-Type: application/sdp\r\n' : ''}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    let media: { port: number; address: string } | null = null;
    const answered = new Promise<void>((resolve) =>
      sip.on('message', (m) => {
        const t = m.toString();
        if (t.startsWith('SIP/2.0 200') && /CSeq: 1 INVITE/.test(t)) {
          toTag = /To:[^\r\n]*;tag=([^;\r\n]+)/i.exec(t)?.[1] ?? '';
          media = { port: Number(/m=audio (\d+)/.exec(t)?.[1]), address: /c=IN IP4 ([\d.]+)/.exec(t)?.[1] ?? '127.0.0.1' };
          sip.send(req('ACK', 1), 5060, '127.0.0.1');
          resolve();
        } else if (!t.startsWith('SIP/2.0')) {
          const h = (name: string) => new RegExp(`^${name}: [^\\r\\n]+`, 'mi').exec(t)?.[0] ?? '';
          sip.send(`SIP/2.0 200 OK\r\n${h('Via')}\r\n${h('From')}\r\n${h('To')}\r\n${h('Call-ID')}\r\n${h('CSeq')}\r\nContent-Length: 0\r\n\r\n`, 5060, '127.0.0.1');
        }
      }),
    );
    const heardByCaller: Buffer[] = [];
    rtp.on('message', (m) => {
      if (m.length <= 12 || (m[1] & 0x7f) !== 0) return;
      const payload = m.subarray(12);
      const pcm = Buffer.alloc(payload.length * 2);
      for (let i = 0; i < payload.length; i++) pcm.writeInt16LE(mulawToLinear(payload[i]), i * 2);
      heardByCaller.push(pcm);
    });
    sip.send(req('INVITE', 1, sdp), 5060, '127.0.0.1');
    await answered;
    let seq = 1;
    let ts = 0;
    let phase = 0;
    const tx = setInterval(() => {
      const p = Buffer.alloc(172);
      p[0] = 0x80;
      p.writeUInt16BE(seq++ & 0xffff, 2);
      p.writeUInt32BE(ts, 4);
      p.writeUInt32BE(0x1234, 8);
      ts += 160;
      for (let i = 0; i < 160; i++) p[12 + i] = linearToMulaw(Math.round(6000 * Math.sin((phase += (2 * Math.PI * 300) / 8000))));
      if (media) rtp.send(p, media.port, media.address);
    }, 20);
    try {
      await new Promise((r) => setTimeout(r, 8_000));
    } finally {
      clearInterval(tx);
      sip.send(req('BYE', 2), 5060, '127.0.0.1');
      await new Promise((r) => setTimeout(r, 500));
      sip.close();
      rtp.close();
    }

    // The caller → assistant direction: 20 ms of 16-bit audio per frame, and
    // the caller's 300 Hz tone recognisable in it.
    const sizes = new Set(heardByRecognition.map((f) => f.length));
    const recognition = Buffer.concat(heardByRecognition.slice(25));
    // eslint-disable-next-line no-console
    console.log(`recognition got ${heardByRecognition.length} frames, sizes ${[...sizes].join(',')}, ~${zeroCrossingHz(recognition).toFixed(0)} Hz, rms ${rms(recognition).toFixed(0)}`);
    expect(heardByRecognition.length).toBeGreaterThan(300);
    expect([...sizes]).toEqual([320]);
    expect(zeroCrossingHz(recognition)).toBeGreaterThan(280);
    expect(zeroCrossingHz(recognition)).toBeLessThan(320);

    // The assistant → caller direction: its 500 Hz speech stand-in, heard.
    const caller = Buffer.concat(heardByCaller.slice(100, 250));
    // eslint-disable-next-line no-console
    console.log(`caller heard ${heardByCaller.length} packets, ~${zeroCrossingHz(caller).toFixed(0)} Hz, rms ${rms(caller).toFixed(0)}`);
    expect(heardByCaller.length).toBeGreaterThan(300);
    expect(zeroCrossingHz(caller)).toBeGreaterThan(470);
    expect(zeroCrossingHz(caller)).toBeLessThan(530);
  }, 60_000);
});
