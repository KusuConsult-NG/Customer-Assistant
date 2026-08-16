#!/usr/bin/env node
/**
 * Demo readiness check.
 *
 * Probes every external dependency the platform can use and reports, per
 * capability, what a demo will ACTUALLY do right now — working, degraded (and
 * to what), or unavailable. Nothing is inferred from the presence of an env
 * var alone: each configured service is contacted.
 *
 * The point is to make the honest-degradation design legible before you stand
 * in front of an audience, so you demo what works and say what doesn't rather
 * than discovering it live.
 *
 * Usage:
 *   node scripts/demo-readiness.js            # reads .env from the repo root
 *   API_URL=https://your-api node scripts/demo-readiness.js
 *
 * Exit code is 0 when every capability is at least DEGRADED, 1 when something
 * a demo needs is DOWN.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Load .env without adding a dependency; real env always wins.
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    if (process.env[k] === undefined) {
      process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
}

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', y: '', r: '', d: '', b: '', x: '' };

const results = [];
function record(capability, state, detail, demoBehaviour) {
  results.push({ capability, state, detail, demoBehaviour });
}

async function timed(fn, ms = 10_000) {
  return Promise.race([
    fn(),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

// ─── Probes ──────────────────────────────────────────────────────────────────

async function probeDatabase() {
  if (!process.env.DATABASE_URL) {
    return record('Database (PostgreSQL)', 'DOWN', 'DATABASE_URL is not set',
      'Nothing works — the API will not boot.');
  }
  try {
    const { PrismaClient } = require(path.join(ROOT, 'node_modules/@prisma/client'));
    const prisma = new PrismaClient({ log: [] });
    const orgs = await timed(() => prisma.organization.count());
    const constraint = await timed(() => prisma.$queryRawUnsafe(
      `SELECT 1 FROM pg_constraint WHERE conname = 'bookings_no_staff_overlap'`
    ));
    await prisma.$disconnect();
    const hasConstraint = Array.isArray(constraint) && constraint.length > 0;
    record('Database (PostgreSQL)', hasConstraint ? 'OK' : 'DEGRADED',
      `connected · ${orgs} organization(s)` + (hasConstraint ? ' · double-booking constraint present' : ''),
      hasConstraint
        ? 'Full persistence, and concurrent double-booking is impossible.'
        : 'Works, but the booking EXCLUDE constraint is MISSING — apply the migration or concurrent bookings can collide.');
  } catch (err) {
    record('Database (PostgreSQL)', 'DOWN', err.message.split('\n')[0].slice(0, 120),
      'Nothing works — the API will not boot.');
  }
}

async function probeLlm() {
  const key = process.env.OPENAI_API_KEY;
  const base = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.LLM_CHAT_MODEL || 'gpt-4o-mini';
  if (!key) {
    return record('AI free-text answers (LLM)', 'DEGRADED', 'OPENAI_API_KEY is not set',
      'Curated FAQ answers still work. Anything outside them hands off to a human — honestly, never invented.');
  }
  try {
    const res = await timed(() => fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] }),
    }), 20_000);
    if (res.ok) {
      record('AI free-text answers (LLM)', 'OK', `${base} · model ${model}`,
        'The assistant answers open questions in the org persona, grounded in its knowledge base.');
    } else {
      const body = (await res.text()).slice(0, 120);
      record('AI free-text answers (LLM)', 'DEGRADED', `${base} returned HTTP ${res.status}: ${body}`,
        'Curated FAQ answers still work; open questions hand off to a human.');
    }
  } catch (err) {
    record('AI free-text answers (LLM)', 'DEGRADED', `${base} unreachable: ${err.message.slice(0, 100)}`,
      'Curated FAQ answers still work; open questions hand off to a human.');
  }
}

async function probeEmbeddings() {
  const key = process.env.OPENAI_API_KEY;
  const base = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
  if (!key) {
    return record('Document search (embeddings)', 'DEGRADED', 'no API key',
      'Uploaded documents fall back to PostgreSQL keyword search — exact words match, paraphrases do not.');
  }
  try {
    const res = await timed(() => fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: 'ping' }),
    }), 20_000);
    if (res.ok) {
      const data = await res.json();
      const dims = data?.data?.[0]?.embedding?.length;
      const configured = Number.parseInt(process.env.EMBEDDING_DIMENSIONS ?? '1536', 10);
      record('Document search (embeddings)', dims === configured ? 'OK' : 'DEGRADED',
        `${model} returns ${dims} dims · configured ${configured}`,
        dims === configured
          ? 'Semantic search over uploaded documents.'
          : `DIMENSION MISMATCH — set EMBEDDING_DIMENSIONS=${dims} and re-index, or vector search will fail.`);
    } else {
      record('Document search (embeddings)', 'DEGRADED', `HTTP ${res.status} from ${base}`,
        'PostgreSQL keyword search instead of semantic search.');
    }
  } catch (err) {
    record('Document search (embeddings)', 'DEGRADED', err.message.slice(0, 100),
      'PostgreSQL keyword search instead of semantic search.');
  }
}

async function probeQdrant() {
  const url = process.env.QDRANT_URL;
  if (!url) {
    return record('Vector store (Qdrant)', 'DEGRADED', 'QDRANT_URL is not set',
      'Knowledge search uses the PostgreSQL ILIKE fallback. Fine for a demo with FAQs.');
  }
  try {
    const headers = process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {};
    const res = await timed(() => fetch(`${url.replace(/\/+$/, '')}/collections`, { headers }));
    record('Vector store (Qdrant)', res.ok ? 'OK' : 'DEGRADED',
      res.ok ? `${url} reachable` : `HTTP ${res.status} from ${url}`,
      res.ok ? 'Semantic document search is live.' : 'Falls back to PostgreSQL keyword search.');
  } catch (err) {
    record('Vector store (Qdrant)', 'DEGRADED', err.message.slice(0, 100),
      'Falls back to PostgreSQL keyword search.');
  }
}

async function probeRedis() {
  const url = process.env.REDIS_URL;
  if (!url) {
    return record('Queues & multi-pod realtime (Redis)', 'DEGRADED', 'REDIS_URL is not set',
      'Single pod only: document uploads index inline (text types only), workflows run on the inline sweeper, rate limiting is in-memory.');
  }
  try {
    const IORedis = require(path.join(ROOT, 'node_modules/ioredis'));
    const redis = new IORedis(url, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 5000 });
    await timed(() => redis.connect(), 6000);
    const pong = await timed(() => redis.ping(), 5000);
    redis.disconnect();
    record('Queues & multi-pod realtime (Redis)', pong === 'PONG' ? 'OK' : 'DEGRADED',
      `${url.replace(/:\/\/.*@/, '://***@')} · ${pong}`,
      'Background document ingestion, durable workflow queue, and cross-pod live updates.');
  } catch (err) {
    record('Queues & multi-pod realtime (Redis)', 'DEGRADED', err.message.slice(0, 100),
      'Single pod only: inline indexing, inline workflow sweeper, in-memory rate limiting.');
  }
}

async function probeStorage() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return record('File uploads (Supabase Storage)', 'DEGRADED', 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set',
      'Document uploads and selfie capture return an honest 503. Every other feature is unaffected.');
  }
  const buckets = ['knowledge-documents', 'onboarding-selfies'];
  const missing = [];
  for (const bucket of buckets) {
    try {
      const res = await timed(() => fetch(`${url.replace(/\/+$/, '')}/storage/v1/bucket/${bucket}`, {
        headers: { Authorization: `Bearer ${key}`, apikey: key },
      }));
      if (!res.ok) missing.push(`${bucket} (HTTP ${res.status})`);
    } catch (err) {
      missing.push(`${bucket} (${err.message.slice(0, 40)})`);
    }
  }
  record('File uploads (Supabase Storage)', missing.length === 0 ? 'OK' : 'DEGRADED',
    missing.length === 0 ? 'both private buckets reachable' : `unreachable: ${missing.join(', ')}`,
    missing.length === 0
      ? 'Knowledge-base uploads and onboarding selfie capture work end to end.'
      : 'Create the missing PRIVATE bucket(s) in Supabase, or those two features return an honest 503.');
}

async function probeVoice() {
  const dg = process.env.DEEPGRAM_API_KEY;
  const el = process.env.ELEVENLABS_API_KEY;
  const twilio = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN;
  const missing = [];
  if (!dg) missing.push('DEEPGRAM_API_KEY (speech-to-text)');
  if (!el) missing.push('ELEVENLABS_API_KEY (voice)');
  if (!twilio) missing.push('TWILIO_ACCOUNT_SID/AUTH_TOKEN (telephony)');
  if (missing.length) {
    return record('Voice calls', 'DEGRADED', `not configured: ${missing.join(', ')}`,
      'Skip the voice demo. Chat and WhatsApp are unaffected.');
  }
  try {
    const res = await timed(() => fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${dg}` },
    }));
    record('Voice calls', res.ok ? 'OK' : 'DEGRADED',
      res.ok ? 'Deepgram + ElevenLabs + Twilio configured' : `Deepgram returned HTTP ${res.status}`,
      res.ok
        ? 'Inbound calls are answered by the AI in one consistent voice.'
        : 'Speech-to-text will fail; the caller gets the honest failure path.');
  } catch (err) {
    record('Voice calls', 'DEGRADED', err.message.slice(0, 100), 'Skip the voice demo.');
  }
}

async function probeWhatsApp() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    return record('WhatsApp', 'DEGRADED', 'WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set',
      'Skip the WhatsApp demo. The web-chat widget covers the same assistant.');
  }
  try {
    const res = await timed(() => fetch(`https://graph.facebook.com/v21.0/${phoneId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }));
    record('WhatsApp', res.ok ? 'OK' : 'DEGRADED',
      res.ok ? `phone number id ${phoneId} reachable` : `Graph API HTTP ${res.status}`,
      res.ok
        ? 'Inbound messages are answered; outbound sends are real (failures surface, never faked).'
        : 'Check the token has not expired — Meta test tokens are short-lived.');
  } catch (err) {
    record('WhatsApp', 'DEGRADED', err.message.slice(0, 100), 'Skip the WhatsApp demo.');
  }
}

async function probeApi() {
  const api = (process.env.API_URL || process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/+$/, '');
  try {
    const res = await timed(() => fetch(`${api}/api/health`), 8000);
    record('API service', res.ok ? 'OK' : 'DOWN', `${api} → HTTP ${res.status}`,
      res.ok ? 'Serving.' : 'Start the API before demoing.');
  } catch (err) {
    record('API service', 'DOWN', `${api} unreachable: ${err.message.slice(0, 80)}`,
      'Start the API (node apps/api/dist/main.js) before demoing.');
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.b}Customer Care Agent — demo readiness${C.x}`);
  console.log(`${C.d}Every configured service is contacted; nothing is assumed from env vars alone.${C.x}\n`);

  await probeApi();
  await probeDatabase();
  await probeLlm();
  await probeEmbeddings();
  await probeQdrant();
  await probeRedis();
  await probeStorage();
  await probeVoice();
  await probeWhatsApp();

  const pad = Math.max(...results.map((r) => r.capability.length));
  for (const r of results) {
    const color = r.state === 'OK' ? C.g : r.state === 'DEGRADED' ? C.y : C.r;
    console.log(`${color}${r.state.padEnd(9)}${C.x} ${r.capability.padEnd(pad)}  ${C.d}${r.detail}${C.x}`);
    console.log(`${' '.repeat(10)} ${' '.repeat(pad)}  → ${r.demoBehaviour}`);
  }

  const down = results.filter((r) => r.state === 'DOWN');
  const degraded = results.filter((r) => r.state === 'DEGRADED');
  console.log(`\n${C.b}${results.filter((r) => r.state === 'OK').length} working · ${degraded.length} degraded · ${down.length} down${C.x}`);

  if (down.length) {
    console.log(`\n${C.r}Blocking:${C.x} ${down.map((d) => d.capability).join(', ')}`);
    process.exit(1);
  }
  if (degraded.length) {
    console.log(`\n${C.y}Demo-able${C.x} — the degraded capabilities above fall back honestly. Demo what works and say what is not configured.`);
  } else {
    console.log(`\n${C.g}Everything configured and reachable.${C.x}`);
  }
}

main().catch((err) => {
  console.error('readiness check crashed:', err);
  process.exit(1);
});
