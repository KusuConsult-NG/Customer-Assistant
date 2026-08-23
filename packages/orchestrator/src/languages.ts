/**
 * Nigerian language support for the deterministic engine.
 *
 * The platform serves Nigerian businesses and MDAs; PLASCHEMA's enrollees are
 * Plateau State residents, where Hausa is the everyday lingua franca and an
 * English-only assistant simply excludes people. Five languages: English,
 * Nigerian Pidgin (pcm), Hausa (ha), Igbo (ig), Yoruba (yo) — the ISO 639
 * codes stored on Contact.preferredLanguage and Organization.defaultLanguage.
 *
 * ── Detection is CONSERVATIVE by design ─────────────────────────────────────
 *
 * A wrong language guess is worse than none: a customer greeted in a language
 * they don't speak has been told "you don't belong here". So detection returns
 * a language only on strong signals — an explicit request ("in hausa", "na
 * hausa"), or distinctive greetings/phrases that are not shared across these
 * languages — and null otherwise. Null means "keep whatever we knew", never
 * "reset to English". Single ambiguous words ("ok", "abi") detect nothing.
 *
 * ── Translations are TEMPLATES, and honest about their origin ───────────────
 *
 * Only the CONSEQUENTIAL replies are translated — the sentences where being
 * misunderstood costs money or trust: payment details, booking outcomes, the
 * AI disclosure, the handoff, the failure apology. Everything conversational
 * stays with the LLM tier, which mirrors the customer's language natively.
 *
 * ⚠ NATIVE-SPEAKER REVIEW REQUIRED before production. These renderings are
 * careful and deliberately simple, but they were machine-authored. Hausa was
 * written in the Boko orthography without tonal marks; Igbo and Yoruba use
 * standard diacritics sparingly so they survive any SMS/WhatsApp encoding.
 * Wrong register in a payment instruction is a trust problem — have a native
 * speaker of each language read these once. The keys make that a translation
 * task, not a code task.
 */

export type Language = 'en' | 'pcm' | 'ha' | 'ig' | 'yo';

export const SUPPORTED_LANGUAGES: Language[] = ['en', 'pcm', 'ha', 'ig', 'yo'];

export const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  pcm: 'Nigerian Pidgin',
  ha: 'Hausa',
  ig: 'Igbo',
  yo: 'Yoruba',
};

/** Strong, distinctive signals only. Order within a language is irrelevant. */
const SIGNALS: Record<Exclude<Language, 'en'>, RegExp[]> = {
  ha: [
    /\b(in|for|na|da)\s+hausa\b/i,
    /\bina kwana\b/i, // good morning
    /\bina wuni\b/i, // good afternoon
    /\bsannu( da (zuwa|aiki))?\b/i, // hello / well done
    /\byaya (dai|kake|kike)\b/i, // how are you
    /\bnagode\b/i, // thank you
    /\bdon allah\b/i, // please
    /\bnawa ne\b/i, // how much
    /\bba turanci\b/i, // "no English"
  ],
  ig: [
    /\b(in|for|na)\s+igbo\b/i,
    /\bndewo\b/i, // hello
    /\bkedu( ka \w+ mere)?\b/i, // how are you / greetings
    /\bdaal[uụ]\b/i, // thank you
    /\bbiko\b/i, // please
    /\bego ole\b/i, // how much
    /\ba na m ach[oọ]\b/i, // I want
  ],
  yo: [
    /\b(in|for|ni)\s+yoruba\b/i,
    /\b[eẹ] k[aá]ar[oọ]\b/i, // good morning
    /\b[eẹ] k[aá]as[aá]n\b/i, // good afternoon
    /\bbawo ni\b/i, // how are you
    /\b[eẹ] ?[sṣ][eé]( gan)?\b/i, // thank you
    /\bj[oọ]w[oọ]\b/i, // please
    /\beelo ni\b/i, // how much
    /\bmo f[eẹ]\b/i, // I want
  ],
  pcm: [
    /\b(in|for)\s+pidgin\b/i,
    /\bhow far\b/i,
    /\babeg\b/i,
    /\bwetin\b/i,
    /\bi wan\b/i,
    /\bhow much e (be|dey)\b/i,
    /\bno wahala\b/i,
    /\bwahala dey\b/i,
    /\boya\b/i,
  ],
};

/** Explicit ask to switch back. */
const ENGLISH_SIGNALS = [/\b(in|for)\s+english\b/i, /\bspeak english\b/i, /\benglish please\b/i];

/**
 * The customer's language, from this one message — or null when the message
 * does not say. Two distinct signals are required for the marker-based
 * languages' single short words to avoid loanword false positives, except
 * where one signal is unambiguous (an explicit request, a full greeting).
 */
export function detectLanguage(text: string): Language | null {
  const value = (text ?? '').trim();
  if (!value) return null;

  if (ENGLISH_SIGNALS.some((r) => r.test(value))) return 'en';

  let best: { lang: Language; hits: number; explicit: boolean } | null = null;
  for (const lang of Object.keys(SIGNALS) as Array<Exclude<Language, 'en'>>) {
    const patterns = SIGNALS[lang];
    const hits = patterns.filter((r) => r.test(value)).length;
    if (hits === 0) continue;
    const explicit = patterns[0].test(value); // slot 0 is always the explicit ask
    if (!best || hits > best.hits) best = { lang, hits, explicit };
  }
  if (!best) return null;

  // One hit is enough only when it is the explicit ask or a multi-word phrase;
  // guard the single-word markers (oya, biko, abeg…) behind a second signal.
  if (best.hits >= 2 || best.explicit) return best.lang;
  const matched = SIGNALS[best.lang as Exclude<Language, 'en'>].find((r) => r.test(value));
  const matchText = value.match(matched!)?.[0] ?? '';
  return matchText.trim().includes(' ') ? best.lang : null;
}

type TemplateKey =
  | 'ai_disclosure'
  | 'escalation_connecting'
  | 'payment_details'
  | 'payment_details_ussd_suffix'
  | 'payment_unconfigured'
  | 'booking_confirmed'
  | 'booking_cancelled'
  | 'no_upcoming_booking'
  | 'tool_failure';

type Params = Record<string, string>;

/**
 * {org} organization name · {bank} {account} {number} {ussd} payment fields ·
 * {service} {when} {ref} booking fields. Interpolation only — values are never
 * translated, and payment figures pass through verbatim (invariant 3).
 */
const TEMPLATES: Record<Language, Record<TemplateKey, string>> = {
  en: {
    ai_disclosure:
      "I'm an AI assistant for {org} — but I can help with most things right away, and I'll bring in a human colleague the moment you'd prefer one. What can I do for you?",
    escalation_connecting: 'Connecting you to a live human agent right away. Please hold on a moment...',
    payment_details: 'Payment goes to {account}, {bank}, account number {number}.',
    payment_details_ussd_suffix: ' You can also dial {ussd}.',
    payment_unconfigured:
      "I don't have our payment details on hand to share with you, and I don't want to give you the wrong account. Let me pass you to a colleague at {org} who can help.",
    booking_confirmed:
      "I've put you down for *{service}* on *{when}* (West Africa Time).\n\nReference: #{ref}\n\nIf that time doesn't work, just say *\"reschedule\"* and I'll move it.",
    booking_cancelled:
      '✅ Your booking for *{service}* has been successfully cancelled.\n\nReference: #{ref}\n\nIf you paid and would like a refund, please say *"I need a refund"* and I\'ll raise a request for you.',
    no_upcoming_booking: "I can't find an upcoming appointment under this number.",
    tool_failure:
      'I ran into a technical problem completing that automatically. Let me connect you with a team member who can help right away.',
  },
  pcm: {
    ai_disclosure:
      'Na AI assistant for {org} I be — but I fit help you sharp-sharp for plenty things, and anytime you want person, I go bring human colleague join. Wetin I fit do for you?',
    escalation_connecting: 'I dey connect you to person now-now. Abeg hold on small...',
    payment_details: 'Make you pay go {account}, {bank}, account number {number}.',
    payment_details_ussd_suffix: ' You fit still dial {ussd}.',
    payment_unconfigured:
      'I no get our payment details for hand, and I no wan give you wrong account. Make I carry you go meet person for {org} wey go help you.',
    booking_confirmed:
      'I don book you for *{service}* on *{when}* (West Africa Time).\n\nReference: #{ref}\n\nIf that time no work for you, just talk *"reschedule"* and I go move am.',
    booking_cancelled:
      '✅ I don cancel your booking for *{service}*.\n\nReference: #{ref}\n\nIf you don pay and you want refund, abeg talk *"I need a refund"* and I go raise am for you.',
    no_upcoming_booking: 'I no see any appointment wey dey come for this number.',
    tool_failure:
      'Something spoil small as I dey try do am automatic. Make I connect you to team member wey go help you sharp-sharp.',
  },
  ha: {
    ai_disclosure:
      'Ni mataimaki ne na AI na {org} — amma zan iya taimaka maka nan take a abubuwa da yawa, kuma duk lokacin da kake son mutum, zan kawo abokin aiki. Me zan yi maka?',
    escalation_connecting: 'Ina hada ka da mutum yanzu. Don Allah ka dan jira...',
    payment_details: 'Za a biya zuwa {account}, {bank}, lambar asusu {number}.',
    payment_details_ussd_suffix: ' Kuma za ka iya buga {ussd}.',
    payment_unconfigured:
      'Ba ni da cikakken bayanin biyan kudi a yanzu, kuma ba na son ba ka asusun da ba daidai ba. Bari in hada ka da ma’aikacin {org} da zai taimaka.',
    booking_confirmed:
      'Na yi maka rajistar *{service}* ranar *{when}* (lokacin Najeriya).\n\nLambar tunani: #{ref}\n\nIdan lokacin bai dace ba, ka ce *"reschedule"* zan canza shi.',
    booking_cancelled:
      '✅ An soke rajistarka ta *{service}*.\n\nLambar tunani: #{ref}\n\nIdan ka biya kuma kana son a mayar da kudi, ka ce *"I need a refund"* zan shirya maka.',
    no_upcoming_booking: 'Ban sami wani alkawari mai zuwa a wannan lambar ba.',
    tool_failure:
      'An sami matsala yayin da nake yin haka kai tsaye. Bari in hada ka da ma’aikaci da zai taimaka nan take.',
  },
  ig: {
    ai_disclosure:
      'Abụ m onye enyemaka AI nke {org} — mana enwere m ike inyere gị aka ozugbo n’ọtụtụ ihe, ị chọọ mmadụ, m ga-akpọ onye ọrụ ibe m. Gịnị ka m ga-emere gị?',
    escalation_connecting: 'Ana m ejikọ gị na mmadụ ugbu a. Biko chere ntakịrị...',
    payment_details: 'Ị ga-akwụ ụgwọ na {account}, {bank}, nọmba akaụntụ {number}.',
    payment_details_ussd_suffix: ' Ị nwekwara ike ịpị {ussd}.',
    payment_unconfigured:
      'Enweghị m nkọwa ịkwụ ụgwọ anyị ugbu a, achọghịkwa m inye gị akaụntụ na-ezighị ezi. Ka m kpọọ onye ọrụ {org} ga-enyere gị aka.',
    booking_confirmed:
      'Edebela m gị *{service}* na *{when}* (oge Naịjịrịa).\n\nNọmba ntụaka: #{ref}\n\nỌ bụrụ na oge ahụ adịghị gị mma, kwuo *"reschedule"* ka m gbanwee ya.',
    booking_cancelled:
      '✅ Akagbuola m ndebanye gị maka *{service}*.\n\nNọmba ntụaka: #{ref}\n\nỌ bụrụ na ị kwụrụ ụgwọ ma chọọ nkwụghachi, kwuo *"I need a refund"* ka m debe ya.',
    no_upcoming_booking: 'Ahụghị m nhọpụta ọ bụla na-abịa na nọmba a.',
    tool_failure:
      'Enwere nsogbu mgbe m na-eme ya ozugbo. Ka m jikọọ gị na onye ọrụ ga-enyere gị aka ozugbo.',
  },
  yo: {
    ai_disclosure:
      'Olùrànlọ́wọ́ AI ti {org} ni mí — ṣùgbọ́n mo lè ràn ọ́ lọ́wọ́ lẹ́sẹ̀kẹsẹ̀ lórí ọ̀pọ̀ nǹkan, tí o bá sì fẹ́ ènìyàn, màá pe alábàáṣiṣẹ́ mi. Kí ni mo lè ṣe fún ọ?',
    escalation_connecting: 'Mò ń so ọ́ pọ̀ mọ́ ènìyàn báyìí. Jọ̀wọ́ dúró díẹ̀...',
    payment_details: 'Ẹ san owó sí {account}, {bank}, nọ́mbà àkáǹtì {number}.',
    payment_details_ussd_suffix: ' O tún lè tẹ {ussd}.',
    payment_unconfigured:
      'N kò ní àlàyé ìsanwó wa lọ́wọ́ báyìí, n kò sì fẹ́ fún ọ ní àkáǹtì tí kò tọ́. Jẹ́ kí n so ọ́ pọ̀ mọ́ òṣìṣẹ́ {org} tí yóò ràn ọ́ lọ́wọ́.',
    booking_confirmed:
      'Mo ti ṣe ìforúkọsílẹ̀ *{service}* fún ọ ní *{when}* (àkókò Nàìjíríà).\n\nNọ́mbà ìtọ́kasí: #{ref}\n\nTí àkókò náà kò bá bá ọ mu, sọ *"reschedule"* kí n yí i padà.',
    booking_cancelled:
      '✅ Mo ti fagi lé ìforúkọsílẹ̀ rẹ fún *{service}*.\n\nNọ́mbà ìtọ́kasí: #{ref}\n\nTí o bá ti sanwó tí o sì fẹ́ owó rẹ padà, sọ *"I need a refund"* kí n gbé e kalẹ̀.',
    no_upcoming_booking: 'N kò rí ìpàdé kankan tó ń bọ̀ lórí nọ́mbà yìí.',
    tool_failure:
      'Ìṣòro kékeré wáyé bí mo ṣe ń gbìyànjú rẹ̀ fúnra mi. Jẹ́ kí n so ọ́ pọ̀ mọ́ òṣìṣẹ́ tí yóò ràn ọ́ lọ́wọ́ lẹ́sẹ̀kẹsẹ̀.',
  },
};

/** Render a consequential template in `lang`, falling back to English. */
export function t(lang: Language | null | undefined, key: TemplateKey, params: Params = {}): string {
  const table = TEMPLATES[(lang ?? 'en') as Language] ?? TEMPLATES.en;
  let out = table[key] ?? TEMPLATES.en[key];
  for (const [k, v] of Object.entries(params)) {
    out = out.split(`{${k}}`).join(v);
  }
  return out;
}

/** Normalise anything stored/sent into a supported code, else null. */
export function asLanguage(value: string | null | undefined): Language | null {
  const v = (value ?? '').trim().toLowerCase();
  return (SUPPORTED_LANGUAGES as string[]).includes(v) ? (v as Language) : null;
}
