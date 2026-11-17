/**
 * The longest things the phone agent says, as functions.
 *
 * They lived inline in `createTicket`, which is why nothing could measure them.
 * They matter because ElevenLabs hangs up `silenceEndCallTimeout` seconds after
 * the CALLER last spoke, and the caller does not speak while the agent reads
 * these. At 10 seconds the agent was cut off mid-sentence on every one.
 * `spoken-duration.spec.ts` speaks each of them, at the configured voice speed,
 * against that timeout — so a longer script or a slower voice fails the build
 * instead of a call.
 */

export type IncidentKind = 'security' | 'fire' | 'disaster' | 'medical';

/**
 * A reference as it should be SPOKEN: digit by digit ("4 8 2 1 3"), the way
 * the phone numbers below are written. Read as a number it is "forty-eight
 * thousand two hundred and thirteen", which nobody writes down correctly.
 * A prefix (REF-BK) is kept as written.
 */
export function spokenReference(reference: string): string {
  return reference.replace(/\d{2,}/g, (run) => run.split('').join(' '));
}

/** Who to call depends on what is happening. 112 leads every time. */
export function incidentAuthorityLine(kind: IncidentKind): string {
  return kind === 'security'
    ? 'The fastest route for anything happening now is 1 1 2. You can also reach Operation Enduring Peace, the joint military task force, on their toll-free line 0 8 0 0 0 0 2 0 2 0 3, and Operation Rainbow, the State early-warning and security outfit, on their toll-free line 0 8 0 0 0 0 2 2 3 3 4 4 or their control room 0 9 0 6 4 0 0 0 1 1 2. For crimes like robbery or kidnapping, the Police Plateau Command is on 0 8 0 3 2 4 1 9 3 3 6.'
    : kind === 'fire'
    ? 'Please call 1 1 2 or the Plateau State Fire Service on 0 7 0 4 0 0 0 7 2 8 3 right away, and keep everyone away from the building.'
    : kind === 'disaster'
    ? 'The Plateau State Emergency Management Agency, SEMA, handles floods and disasters — their line is 0 8 0 3 7 8 0 8 2 1 8 — and 1 1 2 will also connect you.'
    : 'Please call 1 1 2 for an ambulance, or get to the nearest hospital as fast as you safely can.';
}

/** create-ticket's reply for an emergency still happening. */
export function urgentReportReply(ticketNumber: string, kind: IncidentKind): string {
  return (
    `Thank you for your patience. Your report has now been registered in our system as urgent and flagged to our team. Your unique reference number is ${spokenReference(ticketNumber)}. I repeat, ${spokenReference(ticketNumber)}. Please keep this number safe, as it will help you track the progress of your report. ` +
    incidentAuthorityLine(kind)
  );
}

/**
 * create-ticket's reply for a complaint: Phase 8 then Phase 10, in the State's
 * document's own words, with the one addition main made on purpose (e0ee9f6):
 * the caller is asked whether there is anything else before the goodbye.
 */
export function reportRegisteredReply(ticketNumber: string, callerDisplayName?: string | null): string {
  const thanks = callerDisplayName ? `Once again, thank you, ${callerDisplayName}, for` : 'Once again, thank you for';
  return (
    `Thank you for your patience. Your report has now been registered in our system. ` +
    `Your unique complaint reference number is ${spokenReference(ticketNumber)}. I repeat, ${spokenReference(ticketNumber)}. Please keep this number safe, as it will ` +
    `help you track the progress of your report and make subsequent enquiries. ` +
    `${thanks} contacting the Plateau State Government Citizen Contact Centre. Your report has been recorded under ` +
    `reference number ${spokenReference(ticketNumber)}. We appreciate your contribution towards improving governance and ` +
    `public service delivery across Plateau State. Your voice matters, and we encourage you to continue using this ` +
    `platform to communicate your concerns, seek information and provide feedback on government services. ` +
    `Is there anything else I can assist you with today, or may I go ahead and end the call?`
  );
}

// ── How long it takes to say ─────────────────────────────────────────────────

/**
 * Words per second at speed 1.0. Conversational TTS runs at about 150 words a
 * minute (2.5/s); 2.3 is deliberately slower, so the estimate errs towards a
 * LONGER turn — the safe side when the question is "will the line hang up".
 */
export const WORDS_PER_SECOND_AT_SPEED_1 = 2.3;
/** The pause the voice leaves at a full stop, question mark or dash. */
export const PAUSE_PER_SENTENCE_SECONDS = 0.4;
/**
 * Single digits and letters read one at a time ("0 8 0 3", "T C K"). They are
 * one short syllable each, so they go faster than words — but still counted
 * conservatively at 2.5/s rather than the 3+/s a voice actually manages.
 */
export const CHARACTERS_PER_SECOND_AT_SPEED_1 = 2.5;

/**
 * Roughly how many seconds `text` takes to speak at `speed`.
 *
 * Counted the way it is read: a phone number already written "0 8 0 3" is
 * four words, and a reference like TCK-000123 — which the agent is told to
 * read "slowly and clearly" — is one word per character. Markup the voice does
 * not say (`<governor>` tags) is dropped and a `<break time="Ns" />` adds N.
 */
export function estimateSpokenSeconds(text: string, speed: number): number {
  let breaks = 0;
  const clean = text
    .replace(/<break\s+time="([\d.]+)s"\s*\/>/g, (_, s) => {
      breaks += Number(s);
      return ' ';
    })
    .replace(/<\/?[a-z]+>/gi, ' ');
  let words = 0;
  let characters = 0;
  for (const token of clean.split(/\s+/)) {
    const bare = token.replace(/[^\p{L}\p{N}]/gu, '');
    if (!bare) continue;
    if (/\d/.test(bare)) characters += bare.length; // a digit run or a reference: read character by character
    else words += 1;
  }
  const sentences = (clean.match(/[.?!—]/g) ?? []).length;
  return (
    words / (WORDS_PER_SECOND_AT_SPEED_1 * speed) +
    characters / (CHARACTERS_PER_SECOND_AT_SPEED_1 * speed) +
    sentences * PAUSE_PER_SENTENCE_SECONDS +
    breaks
  );
}
