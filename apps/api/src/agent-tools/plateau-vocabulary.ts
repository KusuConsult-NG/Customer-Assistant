/**
 * The Plateau words the phone lines' speech recognition is told to expect,
 * kept in ONE place for BOTH lines: the server's own line (Deepgram,
 * voice-local/stt.ts) and the ElevenLabs agent (elevenlabs-contracts.ts).
 *
 * They were two lists, and they drifted: the ElevenLabs agent had "Gyel",
 * "Vom", "Du", "Kuru", "Heipang" and "Gindiri"; the local line had none of
 * them. On 26 Nov 2026 a caller on the local line said "Gyel B" and it was
 * heard as "Galby" and saved as their community.
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

/** Every place a caller may name: the 17 LGAs and the communities and wards above, once each. */
export function plateauPlaceWords(): string[] {
  return [...new Set([...PLATEAU_LGAS, ...PLATEAU_PLACES])];
}
