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
 * The FLOW prompts are here for the same reason, and they are the largest
 * group. A form is the least forgiving place to switch language: a customer
 * mid-way through registering has already given five answers, the questions
 * decide what their health card says, and there is no LLM tier behind them to
 * paraphrase — the deterministic engine says exactly these words. They were
 * English-only at first, with a line in the customer's language apologising
 * for it; that line is gone because the reason for it is.
 *
 * What is NOT translated, in any language, is a VALUE: the plan names that go
 * on the card, "34 years", an LGA, a facility. Those are fields of a record
 * read by desk staff and sent to PLASCHEMA, not sentences said to a customer.
 * `t` interpolates them and never touches them.
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

/**
 * The languages this platform can SPEAK, as opposed to write.
 *
 * Text carries all five. Speech does not: the TTS engines available to both
 * voice paths cover English (and Nigerian Pidgin, which is English-lexified
 * enough to render acceptably) and do NOT cover Hausa, Igbo or Yoruba — those
 * are absent from ElevenLabs' multilingual model line-up entirely, so it is a
 * missing capability rather than a setting.
 *
 * Kept here, beside the templates, because the honest thing to say to a caller
 * and the list of what can be said are the same fact. `agent-tool-catalog.ts`
 * states the same constraint in prose for the hosted agent — change both
 * together, and only when a provider actually gains the language.
 */
export const SPEAKABLE_LANGUAGES: Language[] = ['en', 'pcm'];

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
 * The language names a customer might type, in any of the five.
 *
 * Deliberately generous: someone asking for their own language types it the
 * way they say it, not the way ISO 639 spells it. Diacritics are optional
 * because most phone keyboards do not produce them.
 */
const LANGUAGE_WORDS: Array<{ lang: Language; pattern: RegExp }> = [
  { lang: 'en', pattern: /\b(english|turanci|bekee|g[eè][eè]si)\b/i },
  { lang: 'pcm', pattern: /\b(pidgin|pigin|broken(?:\s+english)?|naija(?:\s+english)?)\b/i },
  { lang: 'ha', pattern: /\b(hausa|hausawa)\b/i },
  { lang: 'ig', pattern: /\b(igbo|ibo|asụsụ igbo|asusu igbo)\b/i },
  { lang: 'yo', pattern: /\b(yoruba|yor[uù]b[aá])\b/i },
];

/**
 * Is this message ASKING for a language, rather than merely written in one?
 *
 * The distinction decides whether the assistant confirms out loud. Someone who
 * types "ina kwana, I want to book" gets a silent switch — confirming would
 * interrupt what they actually came for. Someone who types "hausa please" is
 * making a request, and a request that produces no acknowledgement reads as
 * having been ignored.
 */
const REQUEST_FRAMES = [
  /\b(in|for|na|ni|da)\s+$/i,
  /\b(speak|talk|reply|respond|write|answer|say it|switch to|change to|use)\s+(to me\s+)?(in\s+)?$/i,
  /\b(i want|i prefer|i need|give me|make it|i dey want|abeg)\s+(it\s+)?(in\s+)?$/i,
];
const REQUEST_SUFFIXES = /^\s*(please|abeg|biko|don allah|jow?o|only|now)\b/i;

export function explicitLanguageRequest(text: string): Language | null {
  const value = (text ?? '').trim();
  if (!value || value.length > 120) return null; // a long message is a conversation, not a request

  for (const { lang, pattern } of LANGUAGE_WORDS) {
    const m = value.match(pattern);
    if (!m || m.index === undefined) continue;

    const before = value.slice(0, m.index);
    const after = value.slice(m.index + m[0].length);

    // "hausa" alone, "hausa please", "in hausa", "speak to me in hausa".
    const bareName = before.trim() === '' && after.trim() === '';
    const framed = REQUEST_FRAMES.some((f) => f.test(before));
    const suffixed = before.trim() === '' && REQUEST_SUFFIXES.test(after);
    if (bareName || framed || suffixed) return lang;
  }
  return null;
}

/** Asking WHICH languages are available, without naming one. */
const MENU_SIGNALS = [
  /\bchange\s+(my\s+)?language\b/i,
  /\bswitch\s+(my\s+)?language\b/i,
  /\blanguage\s+(options?|list|menu|settings?)\b/i,
  /\bwhat\s+languages?\b/i,
  /\bwhich\s+languages?\b/i,
  /\bother\s+languages?\b/i,
  /\bdo you speak\b/i,
  /^\s*language\s*$/i,
];

export function wantsLanguageMenu(text: string): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  return MENU_SIGNALS.some((r) => r.test(value));
}

/**
 * The numbered reply to a menu we just sent.
 *
 * Only meaningful directly after the menu — a bare "3" in any other context is
 * an answer to something else entirely, so the caller must establish that the
 * previous turn WAS the menu (see `LANGUAGE_MENU_MARKER`).
 */
export function parseLanguageChoice(text: string): Language | null {
  const value = (text ?? '').trim();
  const numeric = value.match(/^\s*([1-5])\s*[.)]?\s*$/);
  if (numeric) return SUPPORTED_LANGUAGES[Number(numeric[1]) - 1] ?? null;
  return explicitLanguageRequest(value);
}

/**
 * A string that appears in every rendering of the language menu, in every
 * language, so the next turn can recognise its own menu in the history without
 * storing conversation state.
 */
export const LANGUAGE_MENU_MARKER = '1 — English';

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
  | 'tool_failure'
  | 'capabilities'
  | 'language_menu'
  | 'language_set'
  | 'language_voice_unavailable'
  | 'flow_abandoned'
  | 'flow_what_to_change'

  // ── Enrollment (PLASCHEMA) ────────────────────────────────────────────────
  | 'enrol_name_ask' | 'enrol_name_two_words' | 'enrol_name_digits'
  | 'enrol_age_ask' | 'enrol_age_implausible' | 'enrol_age_unclear'
  | 'enrol_address_ask' | 'enrol_address_short'
  | 'enrol_lga_ask' | 'enrol_lga_unknown'
  | 'enrol_plan_ask' | 'enrol_plan_unclear'
  | 'enrol_facility_ask' | 'enrol_facility_unaccredited'
  | 'enrol_nin_ask' | 'enrol_nin_length' | 'enrol_nin_none'
  | 'enrol_summary' | 'enrol_summary_free'
  /**
   * What to call somebody whose name we do not have.
   *
   * Only reachable if the name slot were ever empty when the next question is
   * asked, which the slot order prevents. It is here because an untranslated
   * "there" sitting in a Hausa sentence is exactly the leak this pass exists to
   * close, and a key costs less than reasoning about whether it can be hit.
   */
  | 'enrol_friend'

  // ── Acting on an appointment ──────────────────────────────────────────────
  | 'which_one_ask' | 'which_one_unclear'
  | 'verb_move' | 'verb_cancel'
  | 'when_ask' | 'when_only_these'
  | 'book_ask' | 'book_only_these'
  | 'table_when_ask' | 'table_for'
  | 'party_ask' | 'party_too_many' | 'party_too_few' | 'party_unclear'
  | 'reschedule_summary' | 'cancel_summary' | 'lost_track';

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
    capabilities:
      "Here's what I can do for you at {org}:\n\n" +
      '• Book, check, move or cancel an appointment\n' +
      '• Share our payment details when you want to pay\n' +
      '• File a complaint or report a problem\n' +
      '• Raise a refund request\n' +
      '• Answer questions about our services\n\n' +
      'And any time you\'d rather talk to a person, just say *"speak to an agent"*.',
    language_menu:
      'Which language would you like me to use? Reply with a number:\n\n' +
      '1 — English\n2 — Nigerian Pidgin\n3 — Hausa\n4 — Igbo\n5 — Yorùbá',
    language_set:
      "Done — I'll reply in English from now on. Say *\"change language\"* any time you want to switch.",
    language_voice_unavailable:
      'I understand you, but I cannot speak {language} on a call — only English. ' +
      'I can bring in a colleague who speaks {language}, or we can continue on WhatsApp where I can write to you in it. Which would you prefer?',
    flow_abandoned:
      "No problem — I've stopped that. Tell me any time you'd like to start again.",
    flow_what_to_change:
      'No problem. Which part should I change?',
    enrol_name_ask:
      "Let's get you registered. What is your full name, as it should appear on your health card?",
    enrol_name_two_words:
      'Could you give me your full name — first name and surname?',
    enrol_name_digits:
      'That looks like it has numbers in it. What is your full name?',
    enrol_age_ask:
      'Thank you, {name}. How old are you, or what is your date of birth?',
    enrol_age_implausible:
      'That age does not look right. How old are you, in years?',
    enrol_age_unclear:
      'Could you tell me your age in years, or your date of birth?',
    enrol_address_ask:
      'What is your street address, or the area where you live?',
    enrol_address_short:
      'Could you give me a bit more — the street or the area you live in?',
    enrol_lga_ask:
      'Which Local Government Area do you live in? For example: Jos North, Jos South, Barkin Ladi, Mangu, Shendam.',
    enrol_lga_unknown:
      'I could not match that to a Plateau State LGA. Could you tell me which one you live in? The full list is: {list}.',
    enrol_plan_ask:
      'Which describes you best?\n\n1 — Formal Sector (you work for a company or government)\n2 — Informal Sector (self-employed, trader, farmer, artisan)\n3 — Equity Programme (free: pregnant, child under 5, over 65, living with a disability)\n4 — BHCPF (free, for the most vulnerable)\n\nReply with the number or the name.',
    enrol_plan_unclear:
      'I did not catch which plan that is. Reply 1 for Formal Sector, 2 for Informal Sector, 3 for the free Equity Programme, or 4 for BHCPF.',
    enrol_facility_ask:
      'Which hospital or health centre in {lga} would you like as your primary facility?\n\nAccredited options: {options}.',
    enrol_facility_unaccredited:
      'That one is not on the accredited list for {lga}, and a card issued against it would be refused at the desk. Please choose one of: {options}.',
    enrol_nin_ask:
      "Last one, and it is optional: do you have your National Identification Number (NIN)? It speeds things up, but we can register you without it — just say \"no\".",
    enrol_nin_length:
      "A NIN is 11 digits. Could you check and send it again, or say \"no\" to continue without it?",
    enrol_nin_none:
      'not provided',
    enrol_friend:
      'there',
    enrol_summary:
      'Here is what I have — please check it carefully before I register you:\n\n• Name: {name}\n• Age / DOB: {age}\n• Address: {address}\n• LGA: {lga}\n• Plan: {plan}{free}\n• Primary facility: {facility}\n• NIN: {nin}\n\nIs all of that correct? Reply *yes* to register, or tell me what to change.',
    enrol_summary_free:
      ' (free — no payment)',
    which_one_ask:
      'You have more than one coming up. Which would you like to {verb}?\n\n{list}\n\nReply with the number.',
    which_one_unclear:
      'I did not catch which one. Please reply with the number:\n\n{list}',
    verb_move:
      'move',
    verb_cancel:
      'cancel',
    when_ask:
      '{heading}Here is what is free:\n\n{list}\n\nReply with the number that suits you. If none of these work, say *"speak to an agent"* and a colleague will find something else.',
    when_only_these:
      'I can only move it to one of these, so that I do not put you down for a time that is already taken:\n\n{list}\n\nReply with the number, or say *"speak to an agent"* for anything else.',
    book_ask:
      'Happy to book you in for a {service}. Here is what is free:\n\n{list}\n\nReply with the number that suits you. If none of these work, say *"speak to an agent"* and a colleague will find something else.',
    book_only_these:
      'I can only book one of these, so that I do not put you down for a time that is already taken:\n\n{list}\n\nReply with the number, or say *"speak to an agent"* for anything else.',
    table_when_ask:
      '{heading}Here is what is free:\n\n{list}\n\nReply with the number that suits you. If none of these work, say *"speak to an agent"* and a colleague will find something else.',
    table_for:
      'A table for {guests}. ',
    party_ask:
      'How many people will the table be for?',
    party_too_many:
      'That is more than we can seat on one booking. For a party over {max}, say *"speak to an agent"* and a colleague will arrange it.',
    party_too_few:
      'A table needs at least one person. How many will be coming?',
    party_unclear:
      'How many people should I book the table for? A number is fine.',
    reschedule_summary:
      'Just to confirm before I change anything:\n\n• {label}\n• From: {from}\n• To: {to}\n\nReply *yes* to move it, or tell me what to change.',
    cancel_summary:
      'Just to be sure, because this cannot be undone:\n\n• {label}\n• {when}\n\nReply *yes* to cancel it, or *no* to leave it as it is.',
    lost_track:
      'Sorry — I lost track of which one we were dealing with. Could you tell me again?',
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
    capabilities:
      'See wetin I fit do for you for {org}:\n\n' +
      '• Book appointment, check am, move am or cancel am\n' +
      '• Show you how you go pay\n' +
      '• Take your complaint or report problem\n' +
      '• Raise refund request\n' +
      '• Answer question about our services\n\n' +
      'Anytime you want person, just talk *"speak to an agent"*.',
    language_menu:
      'Which language you want make I take talk? Reply with number:\n\n' +
      '1 — English\n2 — Nigerian Pidgin\n3 — Hausa\n4 — Igbo\n5 — Yorùbá',
    language_set:
      'Done — na Pidgin I go dey talk from now. Just talk *"change language"* anytime you wan change am.',
    // English on purpose: this reply exists precisely because the call cannot
    // carry the customer's language, so it must be said in one the voice can.
    language_voice_unavailable:
      'I understand you, but I cannot speak {language} on a call — only English. ' +
      'I can bring in a colleague who speaks {language}, or we can continue on WhatsApp where I can write to you in it. Which would you prefer?',
    flow_abandoned:
      'No wahala — I don stop am. Tell me anytime wey you wan start again.',
    flow_what_to_change:
      'No wahala. Which one make I change?',
    enrol_name_ask:
      'Make we register you. Wetin be your full name, as e go show for your health card?',
    enrol_name_two_words:
      'Abeg give me your full name — first name and surname.',
    enrol_name_digits:
      'E get number inside am. Wetin be your full name?',
    enrol_age_ask:
      'Thank you, {name}. How old you be, abi wetin be your date of birth?',
    enrol_age_implausible:
      'That age no correct. How many years you get?',
    enrol_age_unclear:
      'Abeg tell me your age for years, abi your date of birth.',
    enrol_address_ask:
      'Wetin be your street address, abi the area wey you dey stay?',
    enrol_address_short:
      'Abeg add small — the street abi area wey you dey live.',
    enrol_lga_ask:
      'Which Local Government Area you dey stay? For example: Jos North, Jos South, Barkin Ladi, Mangu, Shendam.',
    enrol_lga_unknown:
      'I no fit match that one to any Plateau State LGA. Which one you dey stay? Full list na: {list}.',
    enrol_plan_ask:
      'Which one be you?\n\n1 — Formal Sector (you dey work for company abi government)\n2 — Informal Sector (self-employed, trader, farmer, artisan)\n3 — Equity Programme (free: pregnant, pikin wey never reach 5, over 65, person wey get disability)\n4 — BHCPF (free, for people wey need am pass)\n\nReply with the number abi the name.',
    enrol_plan_unclear:
      'I no catch which plan be that. Reply 1 for Formal Sector, 2 for Informal Sector, 3 for the free Equity Programme, abi 4 for BHCPF.',
    enrol_facility_ask:
      'Which hospital abi health centre for {lga} you want as your primary facility?\n\nAccredited options: {options}.',
    enrol_facility_unaccredited:
      'That one no dey the accredited list for {lga}, and card wey dem issue with am go be refuse for desk. Abeg pick one of: {options}.',
    enrol_nin_ask:
      "Last one, and e be optional: you get your National Identification Number (NIN)? E dey fast the thing, but we fit register you without am — just talk \"no\".",
    enrol_nin_length:
      "NIN na 11 digits. Abeg check am send again, abi talk \"no\" make we continue without am.",
    enrol_nin_none:
      'e no give am',
    enrol_friend:
      'my friend',
    enrol_summary:
      'Na wetin I get be this — abeg check am well before I register you:\n\n• Name: {name}\n• Age / DOB: {age}\n• Address: {address}\n• LGA: {lga}\n• Plan: {plan}{free}\n• Primary facility: {facility}\n• NIN: {nin}\n\nEverything correct? Reply *yes* make I register you, abi tell me wetin I go change.',
    enrol_summary_free:
      ' (free — you no go pay anything)',
    which_one_ask:
      'You get pass one wey dey come. Which one you wan {verb}?\n\n{list}\n\nReply with the number.',
    which_one_unclear:
      'I no catch which one. Abeg reply with the number:\n\n{list}',
    verb_move:
      'move',
    verb_cancel:
      'cancel',
    when_ask:
      '{heading}Na these ones free:\n\n{list}\n\nReply with the number wey suit you. If none of dem work, talk *"speak to an agent"* make colleague find another one.',
    when_only_these:
      'Na only one of these I fit move am go, so I no go put you for time wey person don take:\n\n{list}\n\nReply with the number, abi talk *"speak to an agent"* for anything else.',
    book_ask:
      'I fit book you for {service}. Na these ones free:\n\n{list}\n\nReply with the number wey suit you. If none of dem work, talk *"speak to an agent"* make colleague find another one.',
    book_only_these:
      'Na only one of these I fit book, so I no go put you for time wey person don take:\n\n{list}\n\nReply with the number, abi talk *"speak to an agent"* for anything else.',
    table_when_ask:
      '{heading}Na these ones free:\n\n{list}\n\nReply with the number wey suit you. If none of dem work, talk *"speak to an agent"* make colleague find another one.',
    table_for:
      'Table for {guests}. ',
    party_ask:
      'How many people the table go be for?',
    party_too_many:
      'That one pass wetin we fit seat for one booking. If una pass {max}, talk *"speak to an agent"* make colleague arrange am.',
    party_too_few:
      'Table need at least one person. How many people dey come?',
    party_unclear:
      'How many people make I book the table for? Number go do.',
    reschedule_summary:
      'Make I confirm before I change anything:\n\n• {label}\n• From: {from}\n• To: {to}\n\nReply *yes* make I move am, abi tell me wetin I go change.',
    cancel_summary:
      'Make I sure, because we no fit undo am:\n\n• {label}\n• {when}\n\nReply *yes* make I cancel am, abi *no* make e remain as e dey.',
    lost_track:
      'Sorry — I don lose track of which one we dey talk about. Abeg tell me again.',
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
    capabilities:
      'Ga abin da zan iya yi maka a {org}:\n\n' +
      '• Yin alkawari, duba shi, canza shi ko soke shi\n' +
      '• Ba ka bayanin yadda za ka biya\n' +
      '• Daukar korafi ko rahoton matsala\n' +
      '• Neman mayar da kudi\n' +
      '• Amsa tambayoyi game da ayyukanmu\n\n' +
      'Duk lokacin da kake son mutum, ka ce *"speak to an agent"*.',
    language_menu:
      'Wane harshe kake so in yi amfani da shi? Ka amsa da lamba:\n\n' +
      '1 — English\n2 — Nigerian Pidgin\n3 — Hausa\n4 — Igbo\n5 — Yorùbá',
    language_set:
      'An gama — zan yi maka magana da Hausa daga yanzu. Ka ce *"change language"* duk lokacin da kake son canzawa.',
    language_voice_unavailable:
      'I understand you, but I cannot speak {language} on a call — only English. ' +
      'I can bring in a colleague who speaks {language}, or we can continue on WhatsApp where I can write to you in it. Which would you prefer?',
    flow_abandoned:
      'Babu matsala — na daina. Ka gaya mini duk lokacin da kake son sake farawa.',
    flow_what_to_change:
      'Babu matsala. Wanne bangare zan canza?',
    enrol_name_ask:
      'Mu yi maka rijista. Menene cikakken sunanka, kamar yadda zai bayyana a katin lafiyarka?',
    enrol_name_two_words:
      'Ka ba ni cikakken sunanka — sunan farko da sunan mahaifi.',
    enrol_name_digits:
      'Wannan yana da lambobi a ciki. Menene cikakken sunanka?',
    enrol_age_ask:
      'Na gode, {name}. Shekarunka nawa ne, ko kuma ranar haihuwarka?',
    enrol_age_implausible:
      'Wannan shekarun ba su yi daidai ba. Shekarunka nawa ne?',
    enrol_age_unclear:
      'Ka gaya mini shekarunka, ko ranar haihuwarka.',
    enrol_address_ask:
      'Menene adireshinka, ko yankin da kake zama?',
    enrol_address_short:
      'Ka kara bayani kadan — titi ko yankin da kake zama.',
    enrol_lga_ask:
      'A wace Karamar Hukuma kake zama? Misali: Jos North, Jos South, Barkin Ladi, Mangu, Shendam.',
    enrol_lga_unknown:
      'Ban gane wannan a matsayin Karamar Hukuma ta Jihar Filato ba. A wace kake zama? Cikakken jerin: {list}.',
    enrol_plan_ask:
      'Wanne ya fi dacewa da kai?\n\n1 — Formal Sector (kana aiki da kamfani ko gwamnati)\n2 — Informal Sector (kai da kanka, dan kasuwa, manomi, masani)\n3 — Equity Programme (kyauta: mai ciki, yaro kasa da shekara 5, sama da 65, mai nakasa)\n4 — BHCPF (kyauta, ga wadanda suka fi bukata)\n\nKa amsa da lamba ko suna.',
    enrol_plan_unclear:
      'Ban gane wanne shiri ba ne. Ka amsa 1 don Formal Sector, 2 don Informal Sector, 3 don Equity Programme na kyauta, ko 4 don BHCPF.',
    enrol_facility_ask:
      'Wanne asibiti ko cibiyar lafiya a {lga} kake son ya zama babbar cibiyarka?\n\nWadanda aka amince da su: {options}.',
    enrol_facility_unaccredited:
      'Wannan ba ya cikin jerin da aka amince da su a {lga}, kuma za a ki karbar katin a teburin. Ka zabi daya daga cikin: {options}.',
    enrol_nin_ask:
      "Na karshe, kuma ba dole ba ne: kana da lambar NIN? Tana saurin aiki, amma za mu iya yi maka rijista ba tare da ita ba — ka ce \"a'a\".",
    enrol_nin_length:
      "NIN lambobi 11 ne. Ka duba ka sake aikawa, ko ka ce \"a'a\" mu ci gaba ba tare da ita ba.",
    enrol_nin_none:
      'ba a bayar ba',
    enrol_friend:
      'abokina',
    enrol_summary:
      'Ga abin da na samu — ka duba shi da kyau kafin in yi maka rijista:\n\n• Suna: {name}\n• Shekaru / Ranar haihuwa: {age}\n• Adireshi: {address}\n• Karamar Hukuma: {lga}\n• Shiri: {plan}{free}\n• Babbar cibiya: {facility}\n• NIN: {nin}\n\nDuk daidai ne? Ka amsa *yes* in yi rijista, ko ka gaya mini abin da zan canza.',
    enrol_summary_free:
      ' (kyauta — babu biyan kudi)',
    which_one_ask:
      'Kana da fiye da daya mai zuwa. Wanne kake son {verb}?\n\n{list}\n\nKa amsa da lamba.',
    which_one_unclear:
      'Ban gane wanne ba. Ka amsa da lamba:\n\n{list}',
    verb_move:
      'canza',
    verb_cancel:
      'soke',
    when_ask:
      '{heading}Ga lokutan da suke a bude:\n\n{list}\n\nKa amsa da lambar da ta dace da kai. Idan babu wanda ya dace, ka ce *"speak to an agent"* abokin aiki zai nemo wani.',
    when_only_these:
      'Zan iya canza shi zuwa daya daga cikin wadannan kawai, don kada in sa ka a lokacin da aka riga aka dauka:\n\n{list}\n\nKa amsa da lamba, ko ka ce *"speak to an agent"*.',
    book_ask:
      'Zan iya yi maka rijistar {service}. Ga lokutan da suke a bude:\n\n{list}\n\nKa amsa da lambar da ta dace da kai. Idan babu wanda ya dace, ka ce *"speak to an agent"*.',
    book_only_these:
      'Zan iya yin rijista a daya daga cikin wadannan kawai, don kada in sa ka a lokacin da aka riga aka dauka:\n\n{list}\n\nKa amsa da lamba, ko ka ce *"speak to an agent"*.',
    table_when_ask:
      '{heading}Ga lokutan da suke a bude:\n\n{list}\n\nKa amsa da lambar da ta dace da kai. Idan babu wanda ya dace, ka ce *"speak to an agent"*.',
    table_for:
      'Tebur na mutane {guests}. ',
    party_ask:
      'Mutane nawa za su zauna a teburin?',
    party_too_many:
      'Wannan ya fi yawan da za mu iya zama a rijista daya. Idan kun fi {max}, ka ce *"speak to an agent"* abokin aiki zai shirya.',
    party_too_few:
      'Tebur yana bukatar akalla mutum daya. Mutane nawa za su zo?',
    party_unclear:
      'Mutane nawa zan yi rijistar tebur? Lamba ta isa.',
    reschedule_summary:
      'Bari in tabbatar kafin in canza komai:\n\n• {label}\n• Daga: {from}\n• Zuwa: {to}\n\nKa amsa *yes* in canza shi, ko ka gaya mini abin da zan canza.',
    cancel_summary:
      'Bari in tabbata, saboda ba za a iya mayar da shi ba:\n\n• {label}\n• {when}\n\nKa amsa *yes* in soke shi, ko *no* ya kasance kamar yadda yake.',
    lost_track:
      'Yi hakuri — na rasa wanne muke magana a kai. Ka sake gaya mini.',
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
    capabilities:
      'Ihe m nwere ike imere gị na {org}:\n\n' +
      '• Idebe oge, ilele ya, ịgbanwe ya ma ọ bụ kagbuo ya\n' +
      '• Igosi gị otu ị ga-esi kwụọ ụgwọ\n' +
      '• Ịnara mkpesa ma ọ bụ nsogbu\n' +
      '• Ịrịọ nkwụghachi ego\n' +
      '• Ịza ajụjụ gbasara ọrụ anyị\n\n' +
      'Mgbe ọ bụla ị chọrọ mmadụ, kwuo *"speak to an agent"*.',
    language_menu:
      'Kedu asụsụ ị chọrọ ka m jiri? Zaghachi na nọmba:\n\n' +
      '1 — English\n2 — Nigerian Pidgin\n3 — Hausa\n4 — Igbo\n5 — Yorùbá',
    language_set:
      'Ọ gwụla — m ga-aza gị n\'Igbo site ugbu a. Kwuo *"change language"* mgbe ọ bụla ị chọrọ ịgbanwe.',
    language_voice_unavailable:
      'I understand you, but I cannot speak {language} on a call — only English. ' +
      'I can bring in a colleague who speaks {language}, or we can continue on WhatsApp where I can write to you in it. Which would you prefer?',
    flow_abandoned:
      'Nsogbu adịghị — akwụsịla m ya. Gwa m mgbe ọ bụla ị chọrọ ịmalitegharịa.',
    flow_what_to_change:
      'Nsogbu adịghị. Kedu akụkụ ka m ga-agbanwe?',
    enrol_name_ask:
      'Ka anyị debanye aha gị. Gịnị bụ aha gị zuru ezu, dịka ọ ga-esi pụta na kaadị ahụike gị?',
    enrol_name_two_words:
      'Biko nye m aha gị zuru ezu — aha mbụ na aha nna.',
    enrol_name_digits:
      'Nke a nwere ọnụọgụgụ n\'ime ya. Gịnị bụ aha gị zuru ezu?',
    enrol_age_ask:
      'Daalụ, {name}. Afọ ole ka ị dị, ma ọ bụ ụbọchị ọmụmụ gị?',
    enrol_age_implausible:
      'Afọ ahụ ezighi ezi. Afọ ole ka ị dị?',
    enrol_age_unclear:
      'Biko gwa m afọ ole ka ị dị, ma ọ bụ ụbọchị ọmụmụ gị.',
    enrol_address_ask:
      'Gịnị bụ adreesị gị, ma ọ bụ ebe ị bi?',
    enrol_address_short:
      'Biko tinye ntakịrị ọzọ — okporo ámá ma ọ bụ ebe ị bi.',
    enrol_lga_ask:
      'Kedu Local Government Area ị bi? Dịka: Jos North, Jos South, Barkin Ladi, Mangu, Shendam.',
    enrol_lga_unknown:
      'Enweghị m ike ịchọta nke ahụ na LGA nke Plateau State. Kedu nke ị bi? Ndepụta zuru ezu bụ: {list}.',
    enrol_plan_ask:
      'Kedu nke kacha kọwaa gị?\n\n1 — Formal Sector (ị na-arụ ọrụ maka ụlọ ọrụ ma ọ bụ gọọmentị)\n2 — Informal Sector (onwe gị, onye ahịa, onye ọrụ ubi, onye ǹka)\n3 — Equity Programme (n\'efu: dị ime, nwa n\'okpuru afọ 5, karịa 65, onye nwere nkwarụ)\n4 — BHCPF (n\'efu, maka ndị kachasị mkpa)\n\nZaa site na nọmba ma ọ bụ aha.',
    enrol_plan_unclear:
      'Aghọtaghị m nke bụ atụmatụ ahụ. Zaa 1 maka Formal Sector, 2 maka Informal Sector, 3 maka Equity Programme n\'efu, ma ọ bụ 4 maka BHCPF.',
    enrol_facility_ask:
      'Kedu ụlọ ọgwụ ma ọ bụ ebe ahụike na {lga} ị chọrọ ka isi ebe gị?\n\nNdị anabatara: {options}.',
    enrol_facility_unaccredited:
      'Nke ahụ adịghị na ndepụta anabatara maka {lga}, kaadị e nyere na ya ga-abụ nke a jụrụ na tebụl. Biko họrọ otu n\'ime: {options}.',
    enrol_nin_ask:
      "Nke ikpeazụ, ọ bụghịkwa mmanye: ị nwere nọmba NIN gị? Ọ na-eme ka ihe dị ngwa, mana anyị nwere ike idebanye aha gị na-enweghị ya — kwuo \"mba\".",
    enrol_nin_length:
      "NIN bụ ọnụọgụgụ 11. Biko lelee ma zipụ ya ọzọ, ma ọ bụ kwuo \"mba\" ka anyị gaa n'ihu na-enweghị ya.",
    enrol_nin_none:
      'e nyeghị ya',
    enrol_friend:
      'nwanne m',
    enrol_summary:
      'Nke a bụ ihe m nwetara — biko lelee ya nke ọma tupu m debanye aha gị:\n\n• Aha: {name}\n• Afọ / Ụbọchị ọmụmụ: {age}\n• Adreesị: {address}\n• LGA: {lga}\n• Atụmatụ: {plan}{free}\n• Isi ebe ahụike: {facility}\n• NIN: {nin}\n\nIhe niile ziri ezi? Zaa *yes* ka m debanye, ma ọ bụ gwa m ihe m ga-agbanwe.',
    enrol_summary_free:
      ' (n\'efu — ọ dịghị ụgwọ)',
    which_one_ask:
      'Ị nwere ihe karịrị otu na-abịa. Kedu nke ị chọrọ {verb}?\n\n{list}\n\nZaa site na nọmba.',
    which_one_unclear:
      'Aghọtaghị m nke bụ nke. Biko zaa site na nọmba:\n\n{list}',
    verb_move:
      'ịkwaga',
    verb_cancel:
      'ịkagbu',
    when_ask:
      '{heading}Nke a bụ oge ndị nwere ohere:\n\n{list}\n\nZaa site na nọmba dabara gị. Ọ bụrụ na ọ dịghị nke dabara, kwuo *"speak to an agent"*.',
    when_only_these:
      'Enwere m ike ịkwaga ya naanị na otu n\'ime ndị a, ka m ghara itinye gị n\'oge e weerela:\n\n{list}\n\nZaa site na nọmba, ma ọ bụ kwuo *"speak to an agent"*.',
    book_ask:
      'Enwere m ike idebanye gị maka {service}. Nke a bụ oge ndị nwere ohere:\n\n{list}\n\nZaa site na nọmba dabara gị. Ọ bụrụ na ọ dịghị nke dabara, kwuo *"speak to an agent"*.',
    book_only_these:
      'Enwere m ike idebanye naanị otu n\'ime ndị a, ka m ghara itinye gị n\'oge e weerela:\n\n{list}\n\nZaa site na nọmba, ma ọ bụ kwuo *"speak to an agent"*.',
    table_when_ask:
      '{heading}Nke a bụ oge ndị nwere ohere:\n\n{list}\n\nZaa site na nọmba dabara gị. Ọ bụrụ na ọ dịghị nke dabara, kwuo *"speak to an agent"*.',
    table_for:
      'Tebụl maka {guests}. ',
    party_ask:
      'Mmadụ ole ka tebụl ahụ ga-abụrụ?',
    party_too_many:
      'Nke ahụ karịrị ihe anyị nwere ike ịnọdụ na otu ndebanye. Maka ndị karịrị {max}, kwuo *"speak to an agent"*.',
    party_too_few:
      'Tebụl chọrọ opekempe otu mmadụ. Mmadụ ole na-abịa?',
    party_unclear:
      'Mmadụ ole ka m ga-edebanye tebụl maka ya? Nọmba ezuola.',
    reschedule_summary:
      'Ka m kwado tupu m gbanwee ihe ọ bụla:\n\n• {label}\n• Site na: {from}\n• Ruo: {to}\n\nZaa *yes* ka m kwaga ya, ma ọ bụ gwa m ihe m ga-agbanwe.',
    cancel_summary:
      'Ka m jide n\'aka, n\'ihi na enweghị ike ịtụgharị ya:\n\n• {label}\n• {when}\n\nZaa *yes* ka m kagbuo ya, ma ọ bụ *no* ka ọ dịrị ka ọ dị.',
    lost_track:
      'Ndo — echefuru m nke anyị na-ekwu maka ya. Biko gwa m ọzọ.',
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
    capabilities:
      'Ohun tí mo lè ṣe fún ọ ní {org}:\n\n' +
      '• Ṣe ìpàdé, ṣàyẹ̀wò rẹ̀, yí i padà tàbí fagi lé e\n' +
      '• Fi bí o ṣe lè sanwó hàn ọ́\n' +
      '• Gba ẹ̀sùn tàbí ìròyìn ìṣòro\n' +
      '• Bèèrè kí wọ́n dá owó padà\n' +
      '• Dáhùn ìbéèrè nípa iṣẹ́ wa\n\n' +
      'Nígbàkúgbà tí o bá fẹ́ ènìyàn, sọ *"speak to an agent"*.',
    language_menu:
      'Èdè wo ni o fẹ́ kí n lò? Fi nọ́mbà dáhùn:\n\n' +
      '1 — English\n2 — Nigerian Pidgin\n3 — Hausa\n4 — Igbo\n5 — Yorùbá',
    language_set:
      'Ó ti parí — Yorùbá ni màá lò láti ìsinsìnyí. Sọ *"change language"* nígbàkúgbà tí o bá fẹ́ yí i padà.',
    language_voice_unavailable:
      'I understand you, but I cannot speak {language} on a call — only English. ' +
      'I can bring in a colleague who speaks {language}, or we can continue on WhatsApp where I can write to you in it. Which would you prefer?',
    flow_abandoned:
      'Kò sí wàhálà — mo ti dá a dúró. Sọ fún mi nígbàkúgbà tí o bá fẹ́ bẹ̀rẹ̀ lẹ́ẹ̀kansí.',
    flow_what_to_change:
      'Kò sí wàhálà. Apá wo ni kí n yí padà?',
    enrol_name_ask:
      'Jẹ́ kí a forúkọ rẹ sílẹ̀. Kí ni orúkọ rẹ ní kíkún, gẹ́gẹ́ bí yóò ṣe hàn lórí káàdì ìlera rẹ?',
    enrol_name_two_words:
      'Jọ̀wọ́ fún mi ní orúkọ rẹ ní kíkún — orúkọ àkọ́kọ́ àti orúkọ ìdílé.',
    enrol_name_digits:
      'Èyí ní àwọn nọ́ḿbà nínú rẹ̀. Kí ni orúkọ rẹ ní kíkún?',
    enrol_age_ask:
      'O ṣé, {name}. Ọdún mélòó ni ọ́, tàbí kí ni ọjọ́ ìbí rẹ?',
    enrol_age_implausible:
      'Ọdún yẹn kò tọ̀nà. Ọdún mélòó ni ọ́?',
    enrol_age_unclear:
      'Jọ̀wọ́ sọ ọdún rẹ fún mi, tàbí ọjọ́ ìbí rẹ.',
    enrol_address_ask:
      'Kí ni àdírẹ́sì rẹ, tàbí agbègbè tí o ń gbé?',
    enrol_address_short:
      'Jọ̀wọ́ fi kún un díẹ̀ — òpópónà tàbí agbègbè tí o ń gbé.',
    enrol_lga_ask:
      'Ìjọba Ìbílẹ̀ wo ni o ń gbé? Bí àpẹẹrẹ: Jos North, Jos South, Barkin Ladi, Mangu, Shendam.',
    enrol_lga_unknown:
      'Mi ò rí ìyẹn gẹ́gẹ́ bí Ìjọba Ìbílẹ̀ ní Ìpínlẹ̀ Plateau. Èwo ni o ń gbé? Àkọsílẹ̀ kíkún ni: {list}.',
    enrol_plan_ask:
      'Èwo ni ó bá ọ mu jùlọ?\n\n1 — Formal Sector (o ń ṣiṣẹ́ fún ilé-iṣẹ́ tàbí ìjọba)\n2 — Informal Sector (ara rẹ, oníṣòwò, àgbẹ̀, oníṣẹ́-ọwọ́)\n3 — Equity Programme (ọ̀fẹ́: aboyún, ọmọ tí kò tí ì pé ọdún 5, ju 65 lọ, ẹni tí ó ní àbùkù ara)\n4 — BHCPF (ọ̀fẹ́, fún àwọn tí ó nílò rẹ̀ jùlọ)\n\nDáhùn pẹ̀lú nọ́ḿbà tàbí orúkọ.',
    enrol_plan_unclear:
      'Mi ò gbọ́ èwo ni ètò náà. Dáhùn 1 fún Formal Sector, 2 fún Informal Sector, 3 fún Equity Programme ọ̀fẹ́, tàbí 4 fún BHCPF.',
    enrol_facility_ask:
      'Ilé-ìwòsàn tàbí ilé-ìtọ́jú wo ní {lga} ni o fẹ́ gẹ́gẹ́ bí ibùdó àkọ́kọ́ rẹ?\n\nÀwọn tí a fọwọ́sí: {options}.',
    enrol_facility_unaccredited:
      'Ìyẹn kò sí nínú àkọsílẹ̀ tí a fọwọ́sí fún {lga}, káàdì tí a bá fi fún ọ yóò sì jẹ́ èyí tí wọn yóò kọ̀ ní tábìlì. Jọ̀wọ́ yan ọ̀kan nínú: {options}.',
    enrol_nin_ask:
      "Ìkẹyìn, kò sì ṣe dandan: ṣé o ní nọ́ḿbà NIN rẹ? Ó máa yára nǹkan, ṣùgbọ́n a lè forúkọ rẹ sílẹ̀ láìsí rẹ̀ — kàn sọ \"rárá\".",
    enrol_nin_length:
      "NIN jẹ́ nọ́ḿbà 11. Jọ̀wọ́ ṣàyẹ̀wò kí o sì fi ránṣẹ́ lẹ́ẹ̀kansí, tàbí sọ \"rárá\" kí a tẹ̀síwájú láìsí rẹ̀.",
    enrol_nin_none:
      'kò fi fúnni',
    enrol_friend:
      'ọ̀rẹ́ mi',
    enrol_summary:
      'Èyí ni ohun tí mo ní — jọ̀wọ́ ṣàyẹ̀wò rẹ̀ dáadáa kí n tó forúkọ rẹ sílẹ̀:\n\n• Orúkọ: {name}\n• Ọdún / Ọjọ́ ìbí: {age}\n• Àdírẹ́sì: {address}\n• Ìjọba Ìbílẹ̀: {lga}\n• Ètò: {plan}{free}\n• Ibùdó àkọ́kọ́: {facility}\n• NIN: {nin}\n\nGbogbo rẹ̀ tọ̀nà? Dáhùn *yes* kí n forúkọ sílẹ̀, tàbí sọ ohun tí n óò yí padà.',
    enrol_summary_free:
      ' (ọ̀fẹ́ — kò sí owó kankan)',
    which_one_ask:
      'O ní ju ọ̀kan lọ tí ń bọ̀. Èwo ni o fẹ́ {verb}?\n\n{list}\n\nDáhùn pẹ̀lú nọ́ḿbà.',
    which_one_unclear:
      'Mi ò gbọ́ èwo. Jọ̀wọ́ dáhùn pẹ̀lú nọ́ḿbà:\n\n{list}',
    verb_move:
      'yí padà',
    verb_cancel:
      'fagilé',
    when_ask:
      '{heading}Àwọn àkókò tí ó ṣófo ni wọ̀nyí:\n\n{list}\n\nDáhùn pẹ̀lú nọ́ḿbà tí ó bá ọ mu. Bí kò bá sí èyí tí ó bá ọ mu, sọ *"speak to an agent"*.',
    when_only_these:
      'Ọ̀kan nínú wọ̀nyí nìkan ni mo lè yí i padà sí, kí n má bàa fi ọ́ sí àkókò tí a ti gbà:\n\n{list}\n\nDáhùn pẹ̀lú nọ́ḿbà, tàbí sọ *"speak to an agent"*.',
    book_ask:
      'Mo lè forúkọ rẹ sílẹ̀ fún {service}. Àwọn àkókò tí ó ṣófo ni wọ̀nyí:\n\n{list}\n\nDáhùn pẹ̀lú nọ́ḿbà tí ó bá ọ mu. Bí kò bá sí èyí, sọ *"speak to an agent"*.',
    book_only_these:
      'Ọ̀kan nínú wọ̀nyí nìkan ni mo lè forúkọ sílẹ̀, kí n má bàa fi ọ́ sí àkókò tí a ti gbà:\n\n{list}\n\nDáhùn pẹ̀lú nọ́ḿbà, tàbí sọ *"speak to an agent"*.',
    table_when_ask:
      '{heading}Àwọn àkókò tí ó ṣófo ni wọ̀nyí:\n\n{list}\n\nDáhùn pẹ̀lú nọ́ḿbà tí ó bá ọ mu. Bí kò bá sí èyí, sọ *"speak to an agent"*.',
    table_for:
      'Tábìlì fún {guests}. ',
    party_ask:
      'Ènìyàn mélòó ni tábìlì náà yóò jẹ́ fún?',
    party_too_many:
      'Ìyẹn ju èyí tí a lè gbà sí ìforúkọsílẹ̀ kan. Fún àwùjọ tí ó ju {max} lọ, sọ *"speak to an agent"*.',
    party_too_few:
      'Tábìlì nílò ó kéré tán ènìyàn kan. Ènìyàn mélòó ni yóò wá?',
    party_unclear:
      'Ènìyàn mélòó ni kí n forúkọ tábìlì sílẹ̀ fún? Nọ́ḿbà tó.',
    reschedule_summary:
      'Jẹ́ kí n jẹ́rìí kí n tó yí ohunkóhun padà:\n\n• {label}\n• Láti: {from}\n• Sí: {to}\n\nDáhùn *yes* kí n yí i padà, tàbí sọ ohun tí n óò yí padà.',
    cancel_summary:
      'Jẹ́ kí n dá mi lójú, nítorí a kò lè yí i padà:\n\n• {label}\n• {when}\n\nDáhùn *yes* kí n fagilé rẹ̀, tàbí *no* kí ó wà bí ó ti wà.',
    lost_track:
      'Má bínú — mo ti gbàgbé èwo ni a ń sọ̀rọ̀ nípa rẹ̀. Jọ̀wọ́ sọ fún mi lẹ́ẹ̀kansí.',
  },
};

/**
 * Every template key, taken from the table rather than hand-listed.
 *
 * Exported for the tests that sweep all keys in all languages — a hand-kept
 * list goes stale the first time somebody adds a key, and the whole point of
 * those sweeps is to catch the key somebody forgot.
 */
export const TEMPLATE_KEYS = Object.keys(TEMPLATES.en) as TemplateKey[];

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
