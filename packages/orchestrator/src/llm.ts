/**
 * LLM endpoint configuration.
 *
 * Every chat and embedding call in the platform goes through here rather than
 * hardcoding `https://api.openai.com/v1`. The reason is practical: OpenAI has
 * no free tier, but several providers serve the SAME wire format on a free
 * plan (Groq, Google Gemini's OpenAI-compatible endpoint, OpenRouter's free
 * models, Cerebras). Pointing LLM_BASE_URL at one of them is the difference
 * between a demo that answers and a demo that hands every question to a human.
 *
 * The key is still read from OPENAI_API_KEY — it is the bearer token for
 * whichever compatible provider is configured, not a statement about who that
 * provider is.
 *
 * What this does NOT do is invent a fallback. If no endpoint is reachable the
 * callers degrade the way they always have: curated FAQ answers, Postgres
 * keyword search, and an honest handoff. Nothing here fakes a model reply.
 */

export interface LlmConfig {
  /** Base URL including the version segment, no trailing slash. */
  baseUrl: string;
  apiKey: string | undefined;
  chatModel: string;
  embeddingModel: string;
  /**
   * Vector width of `embeddingModel`. This MUST match the Qdrant collection
   * the vectors are written to — changing the embedding model without
   * re-indexing produces a dimension-mismatch error on every search, so both
   * are configured together and deliberately.
   */
  embeddingDimensions: number;
}

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  chatModel: 'gpt-4o-mini',
  embeddingModel: 'text-embedding-3-small',
  embeddingDimensions: 1536,
};

export function llmConfig(): LlmConfig {
  const dims = Number.parseInt(process.env.EMBEDDING_DIMENSIONS ?? '', 10);
  return {
    baseUrl: (process.env.LLM_BASE_URL || DEFAULTS.baseUrl).replace(/\/+$/, ''),
    apiKey: process.env.OPENAI_API_KEY,
    chatModel: process.env.LLM_CHAT_MODEL || DEFAULTS.chatModel,
    embeddingModel: process.env.EMBEDDING_MODEL || DEFAULTS.embeddingModel,
    embeddingDimensions: Number.isFinite(dims) && dims > 0 ? dims : DEFAULTS.embeddingDimensions,
  };
}

/** `POST` target for chat completions on the configured provider. */
export function chatCompletionsUrl(): string {
  return `${llmConfig().baseUrl}/chat/completions`;
}

/** `POST` target for embeddings on the configured provider. */
export function embeddingsUrl(): string {
  return `${llmConfig().baseUrl}/embeddings`;
}

/** True when a key is present — never a claim that the provider is reachable. */
export function isLlmConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}
