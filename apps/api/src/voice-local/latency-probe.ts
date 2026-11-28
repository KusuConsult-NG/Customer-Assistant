/**
 * Where a reply's wait goes, measured against the live providers with the
 * server's own keys. Read-only: nothing is stored, no call is touched, no key
 * is printed. Run it with no calls in progress (it uses the same accounts):
 *
 *   node apps/api/dist/voice-local/latency-probe.js
 *
 * 1. Spitch: for one ~40-character sentence, the time to the FIRST byte of
 *    audio and to the LAST, per output format. A first byte well before the
 *    last means Spitch sends audio as it makes it, and a call could start
 *    playing it sooner; equal times mean it sends the whole clip at once.
 * 2. The language model: the time to the first words with the line's real
 *    script as the system prompt (about 12,000 tokens), twice per model, the
 *    second time with the script already cached by the provider, and how many
 *    prompt tokens the provider reports as cached.
 */
import { chatCompletionsUrl, llmConfig } from '@ace/orchestrator';
import { SYSTEM_PROMPT } from '../agent-tools/agent-tool-catalog';

export const PROBE_SENTENCE = 'Which ward and community are you calling from?';
const FORMATS = ['wav', 'pcm_s16le', 'mulaw'] as const;
const RUNS = 3;

export interface Timing {
  firstByteMs: number;
  /** To the first 4 KB: past any file header, real audio. */
  first4kMs: number;
  lastByteMs: number;
  bytes: number;
}

/** Time a streamed HTTP body: to its first chunk and to its end. */
export async function timeBody(start: number, res: Response, now: () => number = Date.now): Promise<Timing> {
  const reader = (res.body as any).getReader();
  let firstByteMs = -1;
  let first4kMs = -1;
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) {
      if (firstByteMs < 0) firstByteMs = now() - start;
      bytes += value.length;
      if (first4kMs < 0 && bytes >= 4096) first4kMs = now() - start;
    }
  }
  const lastByteMs = now() - start;
  return { firstByteMs, first4kMs: first4kMs < 0 ? lastByteMs : first4kMs, lastByteMs, bytes };
}

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};

async function spitch(): Promise<void> {
  const key = process.env.SPITCH_API_KEY?.trim();
  if (!key) {
    console.log('Spitch: SPITCH_API_KEY is not set here; skipped.');
    return;
  }
  const url = `${(process.env.SPITCH_API_URL?.trim() || 'https://api.spitch.app').replace(/\/+$/, '')}/v1/speech`;
  const voice = process.env.SPITCH_VOICE?.trim() || 'jude';
  console.log(`Spitch, voice ${voice}, "${PROBE_SENTENCE}" (${PROBE_SENTENCE.length} chars), ${RUNS} runs per format:`);
  for (const format of FORMATS) {
    const runs: Timing[] = [];
    let note = '';
    for (let i = 0; i < RUNS; i++) {
      const start = Date.now();
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: PROBE_SENTENCE, language: process.env.SPITCH_LANGUAGE?.trim() || 'en', voice, format }),
        signal: AbortSignal.timeout(20_000),
      }).catch((e) => e as Error);
      if (res instanceof Error) {
        note = `failed: ${res.message}`;
        break;
      }
      if (!res.ok || !res.body) {
        note = `refused: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`;
        break;
      }
      if (i === 0) note = `content-type ${res.headers.get('content-type') || '?'}, transfer ${res.headers.get('transfer-encoding') || 'whole'}`;
      runs.push(await timeBody(start, res));
    }
    if (!runs.length) {
      console.log(`  ${format.padEnd(10)} ${note}`);
      continue;
    }
    const first = median(runs.map((r) => r.firstByteMs));
    const first4k = median(runs.map((r) => r.first4kMs));
    const last = median(runs.map((r) => r.lastByteMs));
    console.log(
      `  ${format.padEnd(10)} first byte ${first} ms, first 4 KB ${first4k} ms, last byte ${last} ms (median), ${runs[0].bytes} bytes; ${note}` +
        `\n             runs: ${runs.map((r) => `${r.firstByteMs}/${r.first4kMs}/${r.lastByteMs}`).join(', ')}`,
    );
  }
}

async function model(name: string): Promise<void> {
  const { apiKey } = llmConfig();
  if (!apiKey) {
    console.log('Language model: no key is configured here; skipped.');
    return;
  }
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'assistant', content: 'Please, which Local Government Area of Plateau State are you calling from?' },
    { role: 'user', content: 'I am calling from Jos South.' },
  ];
  const out: string[] = [];
  for (const pass of ['first', 'cached']) {
    const start = Date.now();
    const res = await fetch(chatCompletionsUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, messages, stream: true, stream_options: { include_usage: true }, temperature: 0.4, max_tokens: 40 }),
      signal: AbortSignal.timeout(20_000),
    }).catch((e) => e as Error);
    if (res instanceof Error || !res.ok || !res.body) {
      out.push(`${pass}: ${res instanceof Error ? res.message : `HTTP ${res.status}`}`);
      continue;
    }
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let firstText = -1;
    let prompt = 0;
    let cached = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        try {
          const chunk = JSON.parse(line.slice(5));
          if (firstText < 0 && chunk?.choices?.[0]?.delta?.content) firstText = Date.now() - start;
          if (chunk?.usage) {
            prompt = chunk.usage.prompt_tokens ?? 0;
            cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          }
        } catch {
          /* a partial line */
        }
      }
    }
    out.push(`${pass}: first words ${firstText} ms, total ${Date.now() - start} ms, ${prompt} prompt tokens (${cached} cached)`);
  }
  console.log(`  ${name.padEnd(12)} ${out.join(' | ')}`);
}

async function main() {
  await spitch();
  console.log('\nLanguage model, the real script as the prompt:');
  const models = (process.argv[2] || `${process.env.LOCAL_VOICE_LLM_MODEL?.trim() || 'gpt-4o'},gpt-4o-mini,gpt-4.1,gpt-4.1-mini`)
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  for (const m of [...new Set(models)]) await model(m);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
