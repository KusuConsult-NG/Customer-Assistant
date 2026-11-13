/**
 * How a case remembers the call that opened it, and how the call's record is
 * attached to the case once the call ends.
 *
 * The State's script ends: "The call record, transcript, classification,
 * reference number and case routing information should be saved in the case
 * management platform." A case is opened DURING the call (create-ticket), but
 * the call's record — transcript, duration, recording — exists only once the
 * call has ENDED and ElevenLabs reports it. So the link is made in two halves:
 *
 * 1. create-ticket writes the ElevenLabs conversation id into the case's
 *    CREATED event (`callReferenceText`);
 * 2. post-call ingestion finds the cases opened in that conversation and
 *    appends a CALL_RECORDED event naming the CallLog (`callRecordedBody`).
 *
 * The case points AT the call log rather than carrying a copy of the
 * transcript. A copy would survive a citizen's erasure request, which empties
 * the call log; a reference is emptied with it (erasure blanks event bodies).
 *
 * Both halves are text in `CaseEvent.body` on purpose: a column for this would
 * need a schema change, and a schema change must reach the production database
 * before the code that reads it. One module writes and reads the format, so it
 * cannot drift between the writer and the reader.
 */
export const CALL_RECORDED_EVENT = 'CALL_RECORDED';

/** Appended to the CREATED event of a case opened during a call. */
export function callReferenceText(conversationId: string): string {
  return ` Call reference: ${conversationId}.`;
}

/** The body of the event attaching a finished call's record to a case. */
export function callRecordedBody(callLogId: string, durationSeconds: number): string {
  const m = Math.floor(durationSeconds / 60);
  const s = durationSeconds % 60;
  return `Call recorded: ${callLogId} (${m}m ${s}s). The transcript and recording are on the call record.`;
}

/** The CallLog id a CALL_RECORDED event names, or null (erased, or another event). */
export function callLogIdFrom(body: string | null | undefined): string | null {
  const m = /^Call recorded: ([0-9a-f-]{36})\b/.exec(body ?? '');
  return m ? m[1] : null;
}
