/**
 * PLASCHEMA enrollment, as a conversation.
 *
 * This is the flow the whole platform exists for, and until now it could not be
 * completed on WhatsApp at all — the only implementation was the agent tool,
 * which works because a language model holds the half-filled form in its head.
 * The live engine had no such memory, so a citizen asking to register got a
 * generic appointment booked instead.
 *
 * Six fields are mandatory (name, age, address, LGA, plan, facility) and NIN is
 * optional. The order matters: LGA is asked before the facility because the
 * accredited list is per-LGA, so asking for a hospital first would mean
 * validating it against nothing.
 *
 * ── Where this refuses ──────────────────────────────────────────────────────
 *
 * The LGA and the facility are checked against the accredited lists rather than
 * accepted as free text. Enrolling somebody at a hospital that is not on the
 * list produces a card refused at the desk — which the enrollee discovers while
 * ill, holding a card the state told them was valid. Better to say "that one is
 * not accredited in Jos North, here are the ones that are" while they are still
 * in the conversation.
 */
import {
  PLATEAU_LGAS,
  getFacilitiesForLGA,
  facilitiesForLGAAsText,
} from '@ace/database';
import type { FlowDefinition } from './flows';

export const ENROLLMENT_FLOW_NAME = 'plaschema-enrollment';

/** The plans a caller can choose, and the words that pick each one. */
const PLANS: Array<{ label: string; match: RegExp }> = [
  { label: 'Formal Sector', match: /\bformal\b|\b1\b|civil servant|government work|company staff|employed|salary/i },
  { label: 'Informal Sector', match: /\binformal\b|\b2\b|self.?employed|trader|farmer|artisan|business/i },
  { label: 'Equity Program', match: /\bequity\b|\b3\b|\bfree\b|pregnan|under.?5|under five|elderly|65|disab|orphan|vulnerable/i },
  { label: 'BHCPF', match: /\bbhcpf\b|\b4\b|basic health/i },
];

/** The LGA as the accredited list spells it, or null if it is not one. */
function canonicalLga(text: string): string | null {
  const asked = text.trim();
  if (!asked) return null;
  const exact = PLATEAU_LGAS.find((l) => l.toLowerCase() === asked.toLowerCase());
  if (exact) return exact;
  // getFacilitiesForLGA already carries the alias and fuzzy handling built for
  // speech-to-text variants; if it resolves to a list, the LGA is real.
  const facilities = getFacilitiesForLGA(asked);
  if (facilities.length === 0) return null;
  return PLATEAU_LGAS.find((l) => getFacilitiesForLGA(l)[0]?.name === facilities[0]?.name) ?? null;
}

export const ENROLLMENT_FLOW: FlowDefinition = {
  name: ENROLLMENT_FLOW_NAME,

  slots: [
    {
      name: 'fullName',
      aliases: ['name', 'full name', 'surname', 'spelling'],
      // No `identifies`: almost any two words are a plausible name, which is
      // exactly why a name can only be corrected by being named. See the note
      // on `findCorrection`.
      prompt: () =>
        "Let's get you registered. What is your full name, as it should appear on your health card?",
      accept: (text) => {
        const value = text.trim().replace(/\s+/g, ' ');
        // Two words, because a card printed "Musa" helps nobody at a desk.
        if (value.length < 3 || !/\s/.test(value)) {
          return { error: 'Could you give me your full name — first name and surname?' };
        }
        if (/\d/.test(value)) {
          return { error: 'That looks like it has numbers in it. What is your full name?' };
        }
        return { value };
      },
    },
    {
      name: 'ageOrDob',
      aliases: ['age', 'date of birth', 'dob', 'birthday'],
      identifies: (text) => /^\d{1,3}(\s*years?)?$/i.test(text.trim()),
      prompt: (c) => `Thank you, ${firstNameOf(c.fullName)}. How old are you, or what is your date of birth?`,
      accept: (text) => {
        const value = text.trim();
        const asAge = value.match(/\b(\d{1,3})\b/);
        if (asAge) {
          const age = Number(asAge[1]);
          if (age < 1 || age > 120) {
            return { error: 'That age does not look right. How old are you, in years?' };
          }
          return { value: `${age} years` };
        }
        // A date in any readable form is fine — it is recorded, not computed on.
        if (/\d{4}|january|february|march|april|may|june|july|august|september|october|november|december/i.test(value)) {
          return { value };
        }
        return { error: 'Could you tell me your age in years, or your date of birth?' };
      },
    },
    {
      name: 'residentialAddress',
      aliases: ['address', 'street', 'house', 'where i live'],
      prompt: () => 'What is your street address, or the area where you live?',
      accept: (text) => {
        const value = text.trim();
        if (value.length < 3) {
          return { error: 'Could you give me a bit more — the street or the area you live in?' };
        }
        return { value };
      },
    },
    {
      name: 'lga',
      aliases: ['lga', 'local government', 'local government area', 'council'],
      // A Plateau LGA name is unambiguous: no other field in this form takes a
      // value that resolves against the accredited list.
      identifies: (text) => canonicalLga(text) !== null,
      prompt: () =>
        'Which Local Government Area do you live in? For example: Jos North, Jos South, Barkin Ladi, Mangu, Shendam.',
      accept: (text) => {
        const lga = canonicalLga(text);
        if (!lga) {
          return {
            error:
              `I could not match that to a Plateau State LGA. Could you tell me which one you live in? ` +
              `The full list is: ${PLATEAU_LGAS.join(', ')}.`,
          };
        }
        return { value: lga };
      },
    },
    {
      name: 'planType',
      aliases: ['plan', 'programme', 'program', 'category', 'sector'],
      // Deliberately excludes the bare digits the prompt offers: "3" is a valid
      // plan answer AND a valid age, so as a CORRECTION it identifies nothing.
      identifies: (text) => /formal|informal|equity|bhcpf/i.test(text),
      prompt: () =>
        'Which describes you best?\n\n' +
        '1 — Formal Sector (you work for a company or government)\n' +
        '2 — Informal Sector (self-employed, trader, farmer, artisan)\n' +
        '3 — Equity Programme (free: pregnant, child under 5, over 65, living with a disability)\n' +
        '4 — BHCPF (free, for the most vulnerable)\n\n' +
        'Reply with the number or the name.',
      accept: (text) => {
        const found = PLANS.find((p) => p.match.test(text));
        if (!found) {
          return {
            error:
              'I did not catch which plan that is. Reply 1 for Formal Sector, 2 for Informal Sector, ' +
              '3 for the free Equity Programme, or 4 for BHCPF.',
          };
        }
        return { value: found.label };
      },
    },
    {
      name: 'preferredHospital',
      aliases: ['hospital', 'facility', 'clinic', 'health centre', 'health center', 'primary facility'],
      identifies: (text, c) =>
        getFacilitiesForLGA(c.lga ?? '').some((f) =>
          f.name.toLowerCase().includes(text.trim().toLowerCase())
        ),
      prompt: (c) =>
        `Which hospital or health centre in ${c.lga} would you like as your primary facility?\n\n` +
        `Accredited options: ${facilitiesForLGAAsText(c.lga)}.`,
      accept: (text, c) => {
        const facilities = getFacilitiesForLGA(c.lga ?? '');
        const lower = text.trim().toLowerCase();
        const matched =
          facilities.find((f) => f.name.toLowerCase() === lower) ??
          facilities.find((f) => f.name.toLowerCase().includes(lower)) ??
          facilities.find((f) => lower.includes(f.name.toLowerCase()));
        if (!matched) {
          return {
            error:
              `That one is not on the accredited list for ${c.lga}, and a card issued against it ` +
              `would be refused at the desk. Please choose one of: ${facilitiesForLGAAsText(c.lga ?? '')}.`,
          };
        }
        return { value: matched.name };
      },
    },
    {
      name: 'nin',
      optional: true,
      aliases: ['nin', 'national identification number', 'national id'],
      identifies: (text) => text.replace(/\D/g, '').length === 11,
      prompt: () =>
        'Last one, and it is optional: do you have your National Identification Number (NIN)? ' +
        'It speeds things up, but we can register you without it — just say "no".',
      accept: (text) => {
        const digits = text.replace(/\D/g, '');
        if (digits.length === 0) return { value: '' };
        if (digits.length !== 11) {
          return {
            error:
              'A NIN is 11 digits. Could you check and send it again, or say "no" to continue without it?',
          };
        }
        return { value: digits };
      },
    },
  ],

  summarise: (c) => {
    const free = /equity|bhcpf/i.test(c.planType ?? '');
    return (
      'Here is what I have — please check it carefully before I register you:\n\n' +
      `• Name: ${c.fullName}\n` +
      `• Age / DOB: ${c.ageOrDob}\n` +
      `• Address: ${c.residentialAddress}\n` +
      `• LGA: ${c.lga}\n` +
      `• Plan: ${c.planType}${free ? ' (free — no payment)' : ''}\n` +
      `• Primary facility: ${c.preferredHospital}\n` +
      `• NIN: ${c.nin ? c.nin : 'not provided'}\n\n` +
      'Is all of that correct? Reply *yes* to register, or tell me what to change.'
    );
  },
};

function firstNameOf(fullName?: string): string {
  return (fullName ?? '').trim().split(/\s+/)[0] || 'there';
}
