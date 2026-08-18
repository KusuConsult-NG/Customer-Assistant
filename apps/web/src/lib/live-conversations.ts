/**
 * What the hosted agent is saying right now.
 *
 * These are NOT rows in our database. They are conversations happening on
 * ElevenLabs at this moment; they only become a CallLog or a Conversation once
 * the call ends and the post-call webhook lands. That distinction is the whole
 * reason this is a separate type and a separate list in the UI — a live call
 * and a stored conversation look similar and behave completely differently, and
 * merging them is how an operator ends up typing a reply into a call that
 * cannot receive one.
 */

export interface LiveTurn {
  role: 'agent' | 'user';
  message: string;
  timeInCallSecs: number;
}

export interface LiveConversation {
  conversationId: string;
  agentId: string;
  status: string;
  startedAt: string;
  durationSecs: number;
  channel: 'voice' | 'whatsapp' | 'other';
  customerNumber: string | null;
  turns: LiveTurn[];
  turnCount: number;
}

export interface LiveConversationsPayload {
  organizationId: string;
  conversations: LiveConversation[];
  polledAt: string;
}

/**
 * How old a snapshot is, in words.
 *
 * The feed is polled every few seconds, not streamed, so the UI says how stale
 * it is rather than implying otherwise. "Live" with no qualifier is a promise
 * this data cannot keep.
 */
export function freshness(polledAt: string | null, now: number = Date.now()): string {
  if (!polledAt) return 'not yet updated';
  const seconds = Math.max(0, Math.round((now - new Date(polledAt).getTime()) / 1000));
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

/** mm:ss for a call that is still running. */
export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds || 0));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** The label for a live participant, which is a number — we have no name yet. */
export function liveTitle(conversation: LiveConversation): string {
  // Never invent a name. The live feed carries a phone number and nothing else;
  // a placeholder like "Customer" would sit next to real names in the same list
  // and read as though we had looked one up and failed.
  return conversation.customerNumber || 'Unknown number';
}

export const CHANNEL_LABEL: Record<LiveConversation['channel'], string> = {
  voice: 'VOICE',
  whatsapp: 'WHATSAPP',
  other: 'AGENT',
};
