/**
 * What the assistant says first when it rings a citizen back.
 *
 * Callbacks were dialled with no context at all: the agent opened with the
 * inbound greeting ("welcome to the Contact Centre… how may I help you?"), as
 * if the citizen had rung us, and never said why it was calling. And they were
 * dialled on a timer, whether or not anything had happened. The agency's rule
 * is the opposite: ring back only when there is something to tell — the matter
 * is resolved, or there is news — and say so at once.
 *
 * So a callback call now opens with who is calling, which request it is about
 * (its reference and the citizen's own words), and the update an officer typed
 * before pressing "Call now". The agent's rules (agentPromptFor) keep it on
 * that matter rather than treating the call as a new enquiry.
 */

import { spokenReference } from '../agent-tools/spoken-replies';

/** The citizen's words can be long; the opening names the matter, it does not repeat it. */
const MAX_REASON_CHARS = 140;

export interface CallbackOpeningInput {
  /** "Good morning" / "Good afternoon" / "Good evening" at the agency's clock. */
  greeting: string;
  /** The citizen's name, or null when we only hold a placeholder. */
  citizenName: string | null;
  agencyName: string;
  /** The reference they were given: five digits, or CB-… on an older request. */
  reference: string;
  /** Why they asked for a callback, in their words. */
  reason: string;
  /** What has changed, typed by the officer. */
  update: string;
}

function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).replace(/[,;:\s]+$/, '')}…`;
}

const sentence = (t: string) => {
  const s = t.trim();
  return /[.!?]$/.test(s) ? s : `${s}.`;
};

export function callbackOpening(input: CallbackOpeningInput): string {
  const who = input.citizenName ? `${input.greeting}, ${input.citizenName}.` : `${input.greeting}.`;
  return [
    who,
    `This is the virtual assistant calling from the ${input.agencyName},`,
    `about your request, reference ${spokenReference(input.reference)}, concerning ${shorten(input.reason, MAX_REASON_CHARS).replace(/[.!?]+$/, '')}.`,
    `Here is the update: ${sentence(input.update)}`,
    'Do you have any questions about this?',
  ].join(' ');
}

/** The shortest update worth ringing somebody for. Anything shorter says nothing. */
export const MIN_UPDATE_CHARS = 10;
