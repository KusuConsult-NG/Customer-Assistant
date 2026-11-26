/**
 * The Plateau words the phone lines' speech recognition is told to expect,
 * kept in ONE place for BOTH lines: the server's own line (Deepgram,
 * voice-local/stt.ts) and the ElevenLabs agent (elevenlabs-contracts.ts).
 *
 * The ElevenLabs agent is told every place below. The server's own line is
 * told less, on the evidence of real calls: see localLineRecognitionTerms.
 *
 * A PLACE belongs here only when a call has shown it is needed, or it is a
 * well-known community. This is not the State's ward register: the line must
 * not suggest a ward that does not exist, so no name is added from memory.
 * The full INEC ward list (325 wards) is the source to load once obtained.
 * Kept short on purpose: every boost dilutes the others.
 */
import { PLATEAU_LGAS } from '@ace/database';

/** Communities and wards, as callers say them. */
export const PLATEAU_PLACES: readonly string[] = [
  'Rantya',
  'Rayfield',
  'Rukuba',
  'Angwan Rukuba',
  'Bukuru',
  'Lamingo',
  'Kabong',
  'Rock Haven',
  'Tudun Wada',
  'Angwan Rogo',
  'Gada Biyu',
  'Farin Gada',
  'Terminus',
  'Dadin Kowa',
  'Zarmaganda',
  'Hwolshe',
  'Anglo Jos',
  'Bauchi Road',
  'Mararaba Jama',
  'State Lowcost',
  'Gyel',
  'Vom',
  'Du',
  'Kuru',
  'Foron',
  'Heipang',
  'Gindiri',
];

/** Peoples of the State, and given names often misheard on 8 kHz lines ("Joy Sunday" as "Jos Andy"). */
export const PLATEAU_PEOPLES: readonly string[] = ['Berom', 'Ngas', 'Mwaghavul', 'Tarok', 'Goemai', 'Afizere', 'Irigwe'];
export const PLATEAU_GIVEN_NAMES: readonly string[] = ['Joy', 'Sunday', 'Gyang', 'Dachung', 'Davou', 'Pam', 'Dung', 'Chundung', 'Nanret', 'Ladi'];

/** Names of the State's own bodies and people a caller asks about. */
export const PLATEAU_ORG_WORDS: readonly string[] = ['Plateau', 'Jos', 'PLASCHEMA', 'SUBEB', 'SEMA', 'Operation Rainbow', 'Mutfwang', 'Naanlong'];

/**
 * What the SERVER'S OWN LINE (Deepgram) is told to expect — measured, not the
 * place list above. 26 Nov 2026: the caller's side of four real calls was
 * streamed through five settings. Boosting the community and ward names put
 * them into ordinary speech ("I'm calling" heard as "I'm Kabong", "What
 * project" as "What Rock", "accomplished East", "Kowa", "Foron", and "Gyel" in
 * a call where nobody said it), the assistant answered nonsense and told the
 * caller the line was noisy — and no setting heard "Gyel B" or "Kabong" right
 * anyway. Only nova-3 with these words alone got every question right ("Caleb
 * Mutfwang" three times out of three) and inserted nothing in any call. A
 * misheard community is caught by the read-back instead (update-caller-profile).
 * The ElevenLabs agent keeps the full list: its speech engine was not measured.
 */
export function localLineRecognitionTerms(): string[] {
  return [...new Set([...PLATEAU_LGAS, 'Caleb Mutfwang', 'Plateau', 'PLASCHEMA', 'SUBEB', 'SEMA'])];
}

/** Every place a caller may name: the 17 LGAs and the communities and wards above, once each. */
export function plateauPlaceWords(): string[] {
  return [...new Set([...PLATEAU_LGAS, ...PLATEAU_PLACES])];
}
