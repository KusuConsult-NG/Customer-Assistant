import { chatCompletionsUrl, llmConfig } from '@ace/orchestrator';
import type { OpenAiTool } from './voice-tools';

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type LlmEvent = { type: 'text'; delta: string } | { type: 'tool_calls'; calls: ToolCall[] };

/** The model the phone line uses. Matches the ElevenLabs agent default (gpt-4o-mini) for low latency and ~16x lower token cost. */
export function voiceModel(): string {
  return process.env.LOCAL_VOICE_LLM_MODEL?.trim() || 'gpt-4o-mini';
}

/**
 * One streamed chat completion. Text is yielded as it arrives, so the first
 * sentence is being spoken while the rest is still being written; tool calls
 * are assembled from their fragments and yielded once, complete.
 */
export async function* streamChat(
  messages: ChatMessage[],
  tools: OpenAiTool[],
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): AsyncGenerator<LlmEvent> {
  const { apiKey } = llmConfig();
  if (!apiKey) throw new Error('No language model key is configured');
  const res = await fetchImpl(chatCompletionsUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: voiceModel(),
      messages,
      tools,
      tool_choice: 'auto',
      stream: true,
      temperature: 0.4,
      max_tokens: 600,
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Language model refused (HTTP ${res.status}) ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }

  const calls: Array<{ id: string; name: string; args: string }> = [];
  const decoder = new TextDecoder();
  let buffered = '';
  const reader = (res.body as any).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = chunk?.choices?.[0]?.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) yield { type: 'text', delta: delta.content };
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { id: '', name: '', args: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }
    }
  }
  const complete = calls.filter(Boolean).filter((c) => c.name);
  if (complete.length) {
    yield {
      type: 'tool_calls',
      calls: complete.map((c, i) => ({
        id: c.id || `call_${i}`,
        type: 'function',
        function: { name: c.name, arguments: c.args || '{}' },
      })),
    };
  }
}

/**
 * Ask for one token with the call's script and tools, while the opening is
 * still playing, so the provider caches the long shared beginning (~12,000
 * tokens) before the caller's first question. Best effort: a failure only
 * means the first reply reads the prompt uncached, as it did before.
 */
export async function warmPromptCache(messages: ChatMessage[], tools: OpenAiTool[], fetchImpl: typeof fetch = fetch): Promise<void> {
  const { apiKey } = llmConfig();
  if (!apiKey) return;
  await fetchImpl(chatCompletionsUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: voiceModel(),
      messages: [...messages, { role: 'user', content: '(The call has just connected.)' }],
      tools,
      tool_choice: 'auto',
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(10_000),
  })
    .then((r) => r.arrayBuffer())
    .catch(() => undefined);
}

/**
 * Cuts streamed text into sentences worth speaking on their own. Short
 * fragments wait for more, so "Yes." is not a separate synthesis call.
 */
export class SentenceSplitter {
  private buf = '';
  /**
   * With `firstAtComma`, the FIRST piece may end at a comma once it holds a
   * few words ("Yes, the Jos Carnival opens on…" → "Yes, the Jos Carnival
   * opens on the twentieth," then the rest). Speech synthesis takes longer
   * the longer the text, and the first piece is what the caller waits for.
   */
  constructor(private readonly opts: { firstAtComma?: boolean } = {}) {}
  private emitted = 0;
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    if (this.opts.firstAtComma && this.emitted === 0) {
      const c = this.buf.match(/^([^.!?]{24,}?,)(\s+)([\s\S]*)$/);
      if (c && c[1].trim().split(/\s+/).length >= 4) {
        out.push(c[1].trim());
        this.buf = c[3];
        this.emitted++;
      }
    }
    for (;;) {
      const m = this.buf.match(/^([\s\S]*?[.!?])(\s+)([\s\S]*)$/);
      if (!m || m[1].trim().length < 12) {
        if (m && this.buf.length > 200) {
          out.push(m[1].trim());
          this.buf = m[3];
          continue;
        }
        break;
      }
      out.push(m[1].trim());
      this.buf = m[3];
    }
    this.emitted += out.length;
    return out;
  }
  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = '';
    return rest || null;
  }
}
