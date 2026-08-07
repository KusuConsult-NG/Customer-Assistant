/**
 * Voice AI call probe.
 *
 * Impersonates Twilio end-to-end against the RUNNING API:
 *
 *   1. POSTs a real inbound-call webhook and inspects the TwiML that comes back.
 *   2. Opens the Media Streams WebSocket exactly as Twilio does — same path, same
 *      query params, same `connected` / `start` / `media` / `stop` event sequence,
 *      same 8kHz G.711 μ-law base64 payloads in 20ms frames.
 *   3. Watches what the server sends back: TTS audio frames, marks, clears.
 *   4. Checks what was written to the database afterwards.
 *
 * This cannot prove audio quality over a carrier, and it cannot prove Twilio will
 * reach a public URL. It CAN prove whether the pipeline the carrier would drive is
 * wired, authenticated, and capable of producing speech — which is the part that was
 * never verified.
 *
 * Usage: node e2e-validation/voice-call-probe.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}

const API = process.env.E2E_API_URL || 'http://localhost:4000';
/** Where the API under test writes its log — the probe reads it to confirm recovery. */
const LOG_PATH = process.env.API_LOG_PATH || '/tmp/api.log';
const WS_BASE = API.replace(/^http/, 'ws');
const { PrismaClient } = require(path.join(ROOT, 'node_modules/@prisma/client'));

const prisma = new PrismaClient({
  datasources: { db: { url: (process.env.DATABASE_URL || '') + '&connection_limit=3' } },
});

const results = [];
function record(id, name, outcome) {
  const status = outcome.ok ? 'PASS' : outcome.blocked ? 'BLOCKED' : 'FAIL';
  results.push({ id, name, status, ...outcome });
  const colour = status === 'PASS' ? '\x1b[32m' : status === 'BLOCKED' ? '\x1b[33m' : '\x1b[31m';
  console.log(`  ${colour}${status.padEnd(7)}\x1b[0m ${id.padEnd(10)} ${name}`);
  if (outcome.evidence) console.log(`          ${outcome.evidence}`);
  if (!outcome.ok && outcome.actual) console.log(`          expected: ${outcome.expected}\n          actual:   ${outcome.actual}`);
  if (outcome.blocked) console.log(`          ${outcome.blocked}`);
}

/** Twilio signs (url + sorted concatenated params) with HMAC-SHA1, base64. */
function twilioSignature(authToken, url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', authToken).update(data).digest('base64');
}

/**
 * Real speech, 8kHz G.711 μ-law, as 20ms frames.
 *
 * Generated with macOS `say` + `afconvert` by the caller of this probe. A synthetic
 * tone is NOT a substitute: Deepgram correctly transcribes nothing from a sine wave,
 * so a tone-based probe can never tell a working STT pipeline from a broken one.
 * Returns null when no sample is available, and the probe says so rather than
 * reporting a transcription failure it did not fairly test.
 */
function loadSpeechFrames() {
  const wav = process.env.SPEECH_ULAW_PATH;
  if (!wav || !fs.existsSync(wav)) return null;
  const buf = fs.readFileSync(wav);
  // Skip the WAV/CAF header and take the payload; μ-law is 1 byte per sample.
  const dataIdx = buf.indexOf(Buffer.from('data'));
  const body = dataIdx > 0 ? buf.subarray(dataIdx + 8) : buf.subarray(1024);
  const frames = [];
  for (let o = 0; o + 160 <= body.length; o += 160) frames.push(body.subarray(o, o + 160));
  return frames.length ? frames : null;
}

/** 20ms of 8kHz G.711 μ-law. 0xFF is μ-law silence; a tone gives the STT something real. */
function ulawFrame({ silence = false } = {}) {
  const samples = 160; // 8000Hz * 0.02s
  const buf = Buffer.alloc(samples);
  if (silence) { buf.fill(0xff); return buf; }
  for (let i = 0; i < samples; i++) {
    // A 440Hz sine, crudely μ-law companded — enough to be real audio rather than zeros.
    const pcm = Math.round(Math.sin((2 * Math.PI * 440 * i) / 8000) * 8000);
    buf[i] = linearToUlaw(pcm);
  }
  return buf;
}

function linearToUlaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

(async () => {
  console.log(`\n\x1b[1mVoice AI Call Probe\x1b[0m  target=${API}\n`);

  // ── Fixture: an organization with a telephony config ──────────────────────
  let org, config, phoneNumber;
  try {
    const suffix = crypto.randomBytes(3).toString('hex');
    phoneNumber = `+1555${Date.now().toString().slice(-7)}`;
    org = await prisma.organization.create({
      data: { name: `Voice Probe ${suffix}`, slug: `voice-probe-${suffix}`, industry: 'SME' },
    });
    config = await prisma.telephonyConfig.create({
      data: {
        organizationId: org.id,
        provider: 'TWILIO',
        phoneNumber,
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        authToken: process.env.TWILIO_AUTH_TOKEN,
        isDefault: true,
      },
    });
    console.log(`  fixture: org=${org.id.slice(0, 8)} number=${phoneNumber}\n`);
  } catch (e) {
    console.error('  FATAL: could not create the telephony fixture —', e.message);
    await prisma.$disconnect();
    process.exit(2);
  }

  const callSid = `CA${crypto.randomBytes(16).toString('hex')}`;
  const fromNumber = '+2348030000001';

  // ── 1. Inbound webhook → TwiML ────────────────────────────────────────────
  let twiml = '';
  const params = {
    CallSid: callSid, From: fromNumber, To: phoneNumber,
    AccountSid: process.env.TWILIO_ACCOUNT_SID, CallStatus: 'ringing', Direction: 'inbound',
  };
  // Twilio signs the exact URL it requested. When the API is configured with a public
  // API_BASE_URL, that is the URL the server verifies against — not the address the
  // probe happens to connect to.
  const publicBase = (process.env.API_BASE_URL || API).replace(/\/+$/, '');
  const url = `${publicBase}/api/telephony/inbound/twilio`;

  try {
    const res = await fetch(`${API}/api/telephony/inbound/twilio`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': twilioSignature(process.env.TWILIO_AUTH_TOKEN, url, params),
      },
      body: new URLSearchParams(params).toString(),
    });
    twiml = await res.text();

    if (res.status !== 200 && res.status !== 201) {
      record('VOICE-001', 'Inbound call webhook answers', { expected: '200', actual: `${res.status} ${twiml.slice(0, 120)}` });
    } else if (!/<Response>/i.test(twiml)) {
      record('VOICE-001', 'Inbound call webhook answers', { expected: 'TwiML', actual: twiml.slice(0, 160) });
    } else if (/could not be authenticated/i.test(twiml)) {
      record('VOICE-001', 'Inbound call webhook answers', {
        expected: 'a call that is answered',
        actual: 'signature rejected — the caller is told "This call could not be authenticated. Goodbye."',
      });
    } else if (/not currently configured/i.test(twiml)) {
      record('VOICE-001', 'Inbound call webhook answers', {
        expected: 'the org resolved from the dialled number',
        actual: 'the number was not recognised, so the caller is hung up on',
      });
    } else {
      record('VOICE-001', 'Inbound call webhook answers with valid TwiML', {
        ok: true, evidence: twiml.replace(/\s+/g, ' ').slice(0, 150),
      });
    }
  } catch (e) {
    record('VOICE-001', 'Inbound call webhook answers', { expected: '200', actual: 'no response: ' + e.message });
  }

  // ── 2. Does the TwiML actually start a media stream? ──────────────────────
  const streamMatch = twiml.match(/<Stream[^>]*url="([^"]+)"/i);
  if (!streamMatch) {
    record('VOICE-002', 'TwiML opens a media stream for the AI', {
      expected: '<Stream url="wss://…"> so the AI can hear the caller',
      actual: 'no <Stream> element — this call would play a message and never reach the AI: ' + twiml.replace(/\s+/g, ' ').slice(0, 130),
    });
  } else {
    const streamUrl = streamMatch[1];
    const bad = /localhost|127\.0\.0\.1|your-api-domain/i.test(streamUrl);
    record('VOICE-002', 'TwiML opens a media stream for the AI', {
      ok: !bad,
      evidence: bad ? undefined : streamUrl,
      expected: bad ? 'a publicly reachable wss:// URL' : undefined,
      actual: bad ? `${streamUrl} — Twilio cannot reach this, so no live call would ever establish audio` : undefined,
    });
  }

  // ── 3. Drive the media stream exactly as Twilio does ──────────────────────
  const wsUrl = `${WS_BASE}/telephony/stream/${callSid}?orgId=${org.id}&from=${encodeURIComponent(fromNumber)}&to=${encodeURIComponent(phoneNumber)}`;
  const inbound = { media: 0, mark: 0, clear: 0, other: [], firstAudioMs: null };
  let usedRealSpeech = false;
  const openedAt = Date.now();

  await new Promise((resolve) => {
    let ws;
    const done = (outcome) => { try { ws && ws.close(); } catch {} ; resolve(outcome); };
    const timer = setTimeout(() => done(), 25000);

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      record('VOICE-003', 'Media stream accepts the carrier connection', { expected: 'an open socket', actual: e.message });
      clearTimeout(timer); return resolve();
    }

    ws.on('open', async () => {
      record('VOICE-003', 'Media stream accepts the carrier connection', { ok: true, evidence: `connected in ${Date.now() - openedAt}ms` });

      const streamSid = `MZ${crypto.randomBytes(16).toString('hex')}`;
      ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
      ws.send(JSON.stringify({
        event: 'start',
        sequenceNumber: '1',
        start: {
          streamSid, accountSid: process.env.TWILIO_ACCOUNT_SID, callSid,
          tracks: ['inbound'], customParameters: {},
          mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        },
        streamSid,
      }));

      // Real speech if we have it, a tone otherwise — delivered in 20ms frames at
      // wall-clock pace, exactly as a carrier does.
      const speech = loadSpeechFrames();
      usedRealSpeech = Boolean(speech);
      const frames = speech || Array.from({ length: 150 }, () => ulawFrame());
      for (let i = 0; i < frames.length; i++) {
        if (ws.readyState !== WebSocket.OPEN) break;
        ws.send(JSON.stringify({
          event: 'media', sequenceNumber: String(i + 2), streamSid,
          media: { track: 'inbound', chunk: String(i + 1), timestamp: String(i * 20), payload: frames[i].toString('base64') },
        }));
        await new Promise((r) => setTimeout(r, 20));
      }
      // Then silence, which is what should trigger end-of-utterance handling.
      const sil = ulawFrame({ silence: true });
      for (let i = 0; i < 100; i++) {
        if (ws.readyState !== WebSocket.OPEN) break;
        ws.send(JSON.stringify({
          event: 'media', sequenceNumber: String(200 + i), streamSid,
          media: { track: 'inbound', chunk: String(200 + i), timestamp: String(3000 + i * 20), payload: sil.toString('base64') },
        }));
        await new Promise((r) => setTimeout(r, 20));
      }

      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'stop', streamSid, stop: { accountSid: process.env.TWILIO_ACCOUNT_SID, callSid } }));
        setTimeout(() => done(), 2500);
      }, 5000);
    });

    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.event === 'media') { inbound.media++; if (inbound.firstAudioMs === null) inbound.firstAudioMs = Date.now() - openedAt; }
      else if (msg.event === 'mark') inbound.mark++;
      else if (msg.event === 'clear') inbound.clear++;
      else inbound.other.push(msg.event);
    });

    ws.on('error', (err) => {
      record('VOICE-003', 'Media stream accepts the carrier connection', { expected: 'an open socket', actual: err.message });
      clearTimeout(timer); resolve();
    });
    ws.on('close', () => { clearTimeout(timer); resolve(); });
  });

  // ── 4. Did the AI ever speak? ─────────────────────────────────────────────
  if (inbound.media > 0) {
    record('VOICE-004', 'The AI speaks back down the call', {
      ok: true,
      evidence: `${inbound.media} audio frame(s) sent to the caller, first at ${inbound.firstAudioMs}ms; ${inbound.mark} mark(s), ${inbound.clear} clear(s)`,
    });
  } else {
    record('VOICE-004', 'The AI speaks back down the call', {
      expected: 'outbound media frames — the caller hearing a voice',
      actual: `ZERO audio frames returned. A real caller would hear silence for the whole call. (events seen: ${inbound.other.join(',') || 'none'})`,
    });
  }

  // ── 4b. If the AI could not speak, was the call rescued? ──────────────────
  // A caller must never be left listening to silence. When TTS produces nothing the
  // server should redirect the live call — to a human if a forwarding number is set,
  // otherwise to an apology and a hang-up.
  if (inbound.media === 0) {
    const log = fs.readFileSync(LOG_PATH, 'utf8').slice(-40000);
    const detected = /voice_ai_mute/.test(log);
    const recovered = /call_recovered_without_ai/.test(log);
    const attempted = /call_recovery_failed|call_recovery_impossible/.test(log);

    if (!detected) {
      record('VOICE-007', 'A mute AI is detected and the call is rescued', {
        expected: 'the server to notice the caller heard nothing',
        actual: 'no detection at all — the call would run to its full length in silence',
      });
    } else if (recovered) {
      record('VOICE-007', 'A mute AI is detected and the call is rescued', {
        ok: true, evidence: 'detected, and the live call was redirected away from the broken AI',
      });
    } else if (attempted) {
      record('VOICE-007', 'A mute AI is detected and the call is rescued', {
        ok: true,
        evidence: 'detected and recovery was attempted; the redirect itself failed, which is expected for a synthetic CallSid Twilio has never seen',
      });
    } else {
      record('VOICE-007', 'A mute AI is detected and the call is rescued', {
        expected: 'a recovery attempt', actual: 'detected but nothing was done about it',
      });
    }
  }

  // ── 5. Was the call recorded? ─────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const log = await prisma.callLog.findFirst({ where: { callSid } });
    if (!log) {
      record('VOICE-005', 'The call is recorded in the database', {
        expected: 'a call log row', actual: 'no row — the call left no record at all',
      });
    } else {
      record('VOICE-005', 'The call is recorded in the database', {
        ok: true, evidence: `status=${log.status} direction=${log.direction} org=${log.organizationId.slice(0, 8)}`,
      });
      if (log.transcript) {
        record('VOICE-006', 'The caller\'s speech is transcribed', {
          ok: true, evidence: `${log.transcript.length} chars: "${log.transcript.slice(0, 100)}"`,
        });
      } else if (!usedRealSpeech) {
        record('VOICE-006', 'The caller\'s speech is transcribed', {
          blocked: 'No speech sample available (set SPEECH_ULAW_PATH). A synthetic tone cannot test STT — Deepgram correctly returns nothing for it.',
        });
      } else {
        record('VOICE-006', 'The caller\'s speech is transcribed', {
          expected: 'a transcript of the words spoken',
          actual: 'empty — real speech was streamed and nothing was captured',
        });
      }
    }
  } catch (e) {
    record('VOICE-005', 'The call is recorded in the database', { expected: 'a call log row', actual: e.message });
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n' + '═'.repeat(74));
  console.log(`VOICE PROBE  ${results.length} checks   PASS ${pass}   FAIL ${fail}`);
  console.log('═'.repeat(74) + '\n');

  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})();
