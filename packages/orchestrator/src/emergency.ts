/**
 * Recognising an emergency, and saying only what is true about it (PRD §11).
 *
 * ── Why this runs before every other branch ─────────────────────────────────
 *
 * A citizen reporting a fire, an attack or somebody not breathing must not be
 * walked through a registration form, asked their LGA for a callback, or
 * answered from the knowledge base with the fire service's opening hours. So
 * the check sits at the very top of the conversation engine, above flows,
 * escalation and intent routing. Nothing else gets to answer first.
 *
 * ── Recall over precision, but not "fire" on its own ────────────────────────
 *
 * A false positive costs a citizen one paragraph they did not need. A false
 * negative can cost a life. So the patterns favour catching too much — but a
 * bare word like "fire" or "accident" also appears in "fire service fees" and
 * "accident insurance", and an engine that answers every one of those with an
 * emergency script trains citizens to ignore it. The patterns therefore look
 * for the shape of an incident ("fire outbreak", "house is burning", "gunmen
 * attacked") rather than for a topic.
 *
 * ── What the reply may and may NOT say ──────────────────────────────────────
 *
 * It may say: call 112 (Nigeria's free national emergency number, run by the
 * NCC and reachable from every network), plus whatever emergency contacts the
 * agency has configured and approved (`Organization.emergencyContacts`).
 *
 * It may NOT say help is on the way. This platform is not an emergency
 * dispatch service and has no integration with one (PlateauEYE integration is
 * a PROPOSED dependency in the PRD, not a built one). "Responders have been
 * dispatched" said by software that dispatched nobody is the worst possible
 * fabrication on this platform. The reply says an officer has been alerted —
 * which is true, because the thread is escalated — and nothing more.
 *
 * Local contact numbers are never hardcoded here. A wrong number in an
 * emergency script is worse than none, and only the agency can vouch for
 * theirs.
 */
import type { Language } from './languages';

export type EmergencyKind =
  | 'fire'
  | 'violence'
  | 'medical'
  | 'accident'
  | 'flood'
  | 'collapse'
  | 'general';

interface Rule {
  kind: EmergencyKind;
  pattern: RegExp;
}

// Word boundaries matter: "fired" from a job is not a fire, and "attack" in
// "heart attack" is medical, not violence — order resolves that (medical first).
const RULES: Rule[] = [
  // ── medical ───────────────────────────────────────────────────────────────
  { kind: 'medical', pattern: /\b(heart attack|not breathing|stopped breathing|can'?t breathe|cannot breathe|unconscious|fainted and|collapsed and|bleeding (heavily|badly|a lot|seriously)|seizure|convuls|overdose|poisoned|snake ?bite|in labou?r and|dying)\b/i },
  { kind: 'medical', pattern: /\b(no dey breathe|e no fit breathe|blood dey commot|im don faint)\b/i },
  { kind: 'medical', pattern: /\b(ba ya numfashi|ba ta numfashi|jini na zuba)\b/i },

  // ── fire ──────────────────────────────────────────────────────────────────
  { kind: 'fire', pattern: /\b(fire (outbreak|incident)|on fire|(is|are|it'?s|house|market|shop|building|car|school) (is )?burning|caught fire|burning down|dey burn|fire don catch|gobara|wuta ta kama)\b/i },

  // ── violence / security ───────────────────────────────────────────────────
  { kind: 'violence', pattern: /\b(gun ?men|gunshots?|shooting|being shot|been shot|shot dead|armed (men|robbers?)|robbery (in progress|now)|kidnap(ped|ping|pers)?|abduct(ed|ion)|bandits?|being attacked|under attack|attacked (us|me|our|the)|attacking (us|me|our|the)|stabbed|machete|killing people|dem dey shoot|dem don kidnap|'?yan bindiga|masu garkuwa|an kai hari)\b/i },

  // ── accident ──────────────────────────────────────────────────────────────
  { kind: 'accident', pattern: /\b((road|car|motor|bus|okada|keke|bike|tanker|terrible|serious|bad) (accident|crash)|accident (just )?(happen|occur)|accident don happen|people (are )?(injured|trapped)|hatsarin mota)\b/i },

  // ── flood ─────────────────────────────────────────────────────────────────
  { kind: 'flood', pattern: /\b(flood(ing|ed)? (is|has|have|in|everywhere|carried|washed)|flood don|water (has )?(carried|swept|washed) (away|people|houses?)|ambaliya)\b/i },

  // ── building collapse ─────────────────────────────────────────────────────
  { kind: 'collapse', pattern: /\b(building (has )?collapsed|collapsed building|building collapse|house (has )?collapsed|roof (has )?collapsed|trapped under|gini ya rushe)\b/i },

  // ── said outright ─────────────────────────────────────────────────────────
  { kind: 'general', pattern: /\b(this is an emergency|it'?s an emergency|emergency!+|life[- ]threatening|someone is dying|please help us now|send help|gaggawa)\b/i },
];

/** The kind of emergency described, or null. Never throws. */
export function detectEmergency(text: string | null | undefined): EmergencyKind | null {
  const input = (text ?? '').trim();
  if (!input) return null;
  for (const rule of RULES) {
    if (rule.pattern.test(input)) return rule.kind;
  }
  return null;
}

/**
 * Nigeria's national emergency number. Free, from every network. The only
 * number this file states, because it is the only one that is national and
 * fixed; every local number comes from the agency's own approved list.
 */
export const NATIONAL_EMERGENCY_NUMBER = '112';

const LEAD: Record<Language, string> = {
  en:
    'This sounds like an emergency. If anyone is in immediate danger, call 112 now. ' +
    "It is Nigeria's free emergency number and works from any phone.",
  pcm:
    'E be like say na emergency. If anybody dey for danger now-now, call 112 sharp sharp. ' +
    'Na free emergency number for Nigeria, e dey work for any phone.',
  ha:
    'Wannan ya yi kama da gaggawa. Idan wani yana cikin hadari yanzu, ka kira 112 nan take. ' +
    'Lambar gaggawa ce ta Najeriya kyauta, tana aiki a kowace waya.',
  ig:
    'Nke a dị ka ihe mberede. Ọ bụrụ na mmadụ nọ n\'ihe egwu ugbu a, kpọọ 112 ozugbo. ' +
    'Ọ bụ nọmba mberede Naịjirịa n\'efu.',
  yo:
    'Èyí dàbí pàjáwìrì. Tí ẹnikẹ́ni bá wà nínú ewu báyìí, pe 112 lẹ́sẹ̀kẹsẹ̀. ' +
    'Nọ́mbà pàjáwìrì ọ̀fẹ́ Nàìjíríà ni.',
};

const CONTACTS_LEAD: Record<Language, string> = {
  en: 'Other emergency contacts:',
  pcm: 'Other emergency numbers:',
  ha: 'Sauran lambobin gaggawa:',
  ig: 'Nọmba mberede ndị ọzọ:',
  yo: 'Àwọn nọ́mbà pàjáwìrì mìíràn:',
};

// "Alerted", never "dispatched". See the header.
const TAIL: Record<Language, string> = {
  en:
    "I have flagged this to an officer as urgent. I can't send responders myself, " +
    'so please call 112 first. When you are safe, tell me where this is happening ' +
    '(LGA and community) and what you can see.',
  pcm:
    'I don tell officer say e urgent. I no fit send people come by myself, ' +
    'so abeg call 112 first. When you dey safe, tell me where e dey happen (LGA and community) and wetin you dey see.',
  ha:
    'Na sanar da jami\'i cewa wannan gaggawa ne. Ba zan iya tura masu ceto da kaina ba, ' +
    'don haka ka kira 112 da farko. Idan ka tsira, ka gaya mini inda abin yake faruwa (karamar hukuma da unguwa).',
  ig:
    'Agwala m onye ọrụ na ọ dị ngwa ngwa. Enweghị m ike iziga ndị nnapụta, ' +
    'ya mere biko kpọọ 112 mbụ. Mgbe ị nọ na nchekwa, gwa m ebe ọ na-eme.',
  yo:
    'Mo ti sọ fún òṣìṣẹ́ pé ó jẹ́ kánjúkánjú. Èmi fúnra mi kò lè rán olùrànlọ́wọ́, ' +
    'nítorí náà jọ̀wọ́ pe 112 kọ́kọ́. Nígbà tí o bá wà láìléwu, sọ ibi tí ó ti ń ṣẹlẹ̀ fún mi.',
};

/**
 * The reply. `contacts` is the agency's own approved text (one per line, e.g.
 * "Fire Service, Jos: 0803…"), shown verbatim; empty or absent adds nothing.
 */
export function emergencyReply(lang: Language | null | undefined, contacts?: string | null): string {
  const l: Language = lang && LEAD[lang] ? lang : 'en';
  const lines = (contacts ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);
  const parts = [LEAD[l]];
  if (lines.length) parts.push(`${CONTACTS_LEAD[l]}\n${lines.map((s) => `• ${s}`).join('\n')}`);
  parts.push(TAIL[l]);
  return parts.join('\n\n');
}
