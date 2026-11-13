/**
 * Where a call's recording is, as stored in `CallLog.recordingUrl`.
 *
 * ── Why there was never anything to play ────────────────────────────────────
 *
 * The phone line is answered by an ElevenLabs agent, and ElevenLabs keeps the
 * audio of every conversation. The platform copied each finished call's
 * transcript (by webhook, and by the two-minute sync) but never where the
 * audio was, and nothing ever wrote `recordingUrl` — so every call on the
 * telephony screen showed a disabled "Play Audio" with "No recording
 * available", for calls whose audio existed the whole time.
 *
 * ── Why it is a reference, not a URL ────────────────────────────────────────
 *
 * ElevenLabs' audio is fetched with the agency's own workspace key, so it
 * cannot be a link a browser opens: the browser does not hold that key, and
 * must never be handed it. The column therefore holds `elevenlabs:<conversation
 * id>`, and `GET /api/calls/:id/recording` fetches the audio with the agency's
 * key, scoped to the agency, and streams it. The column keeps its name because
 * renaming it is a schema change that must reach production before the code.
 *
 * A citizen's erasure clears the column and marks the call; the endpoint
 * refuses a marked call even though ElevenLabs may still hold the audio, so an
 * erased call cannot be played back by being re-found.
 */
const PREFIX = 'elevenlabs:';

export function elevenLabsRecordingRef(conversationId: string): string {
  return `${PREFIX}${conversationId}`;
}

/** The ElevenLabs conversation id a stored reference names, or null. */
export function elevenLabsConversationFrom(recordingUrl: string | null | undefined): string | null {
  return recordingUrl?.startsWith(PREFIX) ? recordingUrl.slice(PREFIX.length) || null : null;
}

/** Erasure (data-rights.service) marks a call this way; nothing about it may be played. */
export function isErasedCall(call: { fromNumber?: string | null }): boolean {
  return call.fromNumber === 'erased';
}

/**
 * Whether the screen should offer Play. True when the reference is stored, or
 * when the call is one ElevenLabs could hold audio for (the agency has an agent
 * and the call was answered) — older calls are linked the first time someone
 * presses Play. The endpoint says plainly when there turns out to be none.
 */
export function recordingPlayable(
  call: { recordingUrl?: string | null; fromNumber?: string | null; status?: string | null; durationSeconds?: number | null },
  agencyHasAgent: boolean
): boolean {
  if (isErasedCall(call)) return false;
  if (elevenLabsConversationFrom(call.recordingUrl)) return true;
  return agencyHasAgent && call.status === 'COMPLETED' && (call.durationSeconds ?? 0) > 0;
}
