import { prisma } from '@ace/database';

/**
 * What the platform's own monitoring records (SystemEvent): each result from
 * the external monitor, each nightly backup, and each call the local voice
 * line handed to the backup line, and each step of a caller in the waiting
 * room (joined, admitted, abandoned, timeout, full, callback).
 *
 * Best effort by design: recording an event must never break the thing it
 * records. A call whose failover could not be written still fails over, and a
 * backup whose result could not be stored is still a backup.
 */
export type SystemEventKind = 'external_check' | 'backup' | 'voice_failover' | 'voice_queue';

export async function recordSystemEvent(kind: SystemEventKind, status: string, detail?: Record<string, unknown>): Promise<boolean> {
  try {
    await prisma.systemEvent.create({ data: { kind, status: status.slice(0, 60), ...(detail ? { detail: detail as any } : {}) } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Why a call went to the backup line, as one word the dashboard can count.
 * From the session's failure text ("model: Language model refused (HTTP 429)
 * … no credits remaining …") or the register() reason ("spitch-circuit-open").
 * The text itself is kept, shortened, beside it: it names a provider and a
 * status, never a caller.
 */
export function failoverReason(text: string): string {
  const t = text.toLowerCase();
  if (/insufficient_quota|no credits|billing/.test(t)) return 'openai_no_credit';
  if (/request too large|tokens per min|rate limit|http 429/.test(t) && /model|language model|openai/.test(t)) return 'openai_rate_limit';
  if (/^model:|language model/.test(t)) return 'openai_error';
  if (/spitch/.test(t)) return 'spitch';
  if (/speech recognition|deepgram/.test(t)) return 'deepgram';
  if (/speech:/.test(t)) return 'speech';
  if (/not-ready/.test(t)) return 'not_ready';
  if (/busy/.test(t)) return 'busy';
  if (/unknown-number/.test(t)) return 'unknown_number';
  return 'other';
}

/** A failover as a SystemEvent: the reason class, and the provider's words, shortened. */
export function recordFailover(source: 'register' | 'session', text: string): Promise<boolean> {
  return recordSystemEvent('voice_failover', failoverReason(text), { source, reason: text.slice(0, 200) });
}
