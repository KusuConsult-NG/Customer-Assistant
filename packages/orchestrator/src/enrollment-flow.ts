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
import { t, type Language } from './languages';

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
  title: 'PLASCHEMA enrollment',

  slots: [
    {
      name: 'fullName',
      aliases: ['name', 'full name', 'surname', 'spelling'],
      // No `identifies`: almost any two words are a plausible name, which is
      // exactly why a name can only be corrected by being named. See the note
      // on `findCorrection`.
      prompt: (_c, lang) => t(lang, 'enrol_name_ask'),
      accept: (text, _c, lang) => {
        const value = text.trim().replace(/\s+/g, ' ');
        // Two words, because a card printed "Musa" helps nobody at a desk.
        if (value.length < 3 || !/\s/.test(value)) {
          return { error: t(lang, 'enrol_name_two_words') };
        }
        if (/\d/.test(value)) {
          return { error: t(lang, 'enrol_name_digits') };
        }
        return { value };
      },
    },
    {
      name: 'ageOrDob',
      label: 'Age / date of birth',
      aliases: ['age', 'date of birth', 'dob', 'birthday'],
      identifies: (text) => /^\d{1,3}(\s*years?)?$/i.test(text.trim()),
      prompt: (c, lang) => t(lang, 'enrol_age_ask', { name: firstNameOf(c.fullName, lang) }),
      accept: (text, _c, lang) => {
        const value = text.trim();
        const asAge = value.match(/\b(\d{1,3})\b/);
        if (asAge) {
          const age = Number(asAge[1]);
          if (age < 1 || age > 120) {
            return { error: t(lang, 'enrol_age_implausible') };
          }
          // Stored in English on purpose, like the plan labels below: this is a
          // field of the enrollment RECORD, read by desk staff and sent to
          // PLASCHEMA, not a sentence spoken to the customer. Only the
          // questions and the errors around it change language.
          return { value: `${age} years` };
        }
        // A date in any readable form is fine — it is recorded, not computed on.
        if (/\d{4}|january|february|march|april|may|june|july|august|september|october|november|december/i.test(value)) {
          return { value };
        }
        return { error: t(lang, 'enrol_age_unclear') };
      },
    },
    {
      name: 'residentialAddress',
      aliases: ['address', 'street', 'house', 'where i live'],
      prompt: (_c, lang) => t(lang, 'enrol_address_ask'),
      accept: (text, _c, lang) => {
        const value = text.trim();
        if (value.length < 3) {
          return { error: t(lang, 'enrol_address_short') };
        }
        return { value };
      },
    },
    {
      name: 'lga',
      label: 'LGA',
      aliases: ['lga', 'local government', 'local government area', 'council'],
      // A Plateau LGA name is unambiguous: no other field in this form takes a
      // value that resolves against the accredited list.
      identifies: (text) => canonicalLga(text) !== null,
      prompt: (_c, lang) => t(lang, 'enrol_lga_ask'),
      accept: (text, _c, lang) => {
        const lga = canonicalLga(text);
        if (!lga) {
          return { error: t(lang, 'enrol_lga_unknown', { list: PLATEAU_LGAS.join(', ') }) };
        }
        return { value: lga };
      },
    },
    {
      name: 'planType',
      label: 'Plan',
      aliases: ['plan', 'programme', 'program', 'category', 'sector'],
      // Deliberately excludes the bare digits the prompt offers: "3" is a valid
      // plan answer AND a valid age, so as a CORRECTION it identifies nothing.
      identifies: (text) => /formal|informal|equity|bhcpf/i.test(text),
      prompt: (_c, lang) => t(lang, 'enrol_plan_ask'),
      accept: (text, _c, lang) => {
        const found = PLANS.find((p) => p.match.test(text));
        if (!found) {
          return { error: t(lang, 'enrol_plan_unclear') };
        }
        // `found.label` is the scheme's own name for the plan and stays in
        // English in every language, for the same reason the age does: it is
        // the value written to the record. Every translated prompt keeps the
        // four labels verbatim beside the numbers, so the customer is choosing
        // from the words that will appear on their card.
        return { value: found.label };
      },
    },
    {
      name: 'preferredHospital',
      label: 'Preferred facility',
      aliases: ['hospital', 'facility', 'clinic', 'health centre', 'health center', 'primary facility'],
      identifies: (text, c) =>
        getFacilitiesForLGA(c.lga ?? '').some((f) =>
          f.name.toLowerCase().includes(text.trim().toLowerCase())
        ),
      prompt: (c, lang) =>
        t(lang, 'enrol_facility_ask', {
          lga: c.lga ?? '',
          options: facilitiesForLGAAsText(c.lga),
        }),
      accept: (text, c, lang) => {
        const facilities = getFacilitiesForLGA(c.lga ?? '');
        const lower = text.trim().toLowerCase();
        const matched =
          facilities.find((f) => f.name.toLowerCase() === lower) ??
          facilities.find((f) => f.name.toLowerCase().includes(lower)) ??
          facilities.find((f) => lower.includes(f.name.toLowerCase()));
        if (!matched) {
          return {
            error: t(lang, 'enrol_facility_unaccredited', {
              lga: c.lga ?? '',
              options: facilitiesForLGAAsText(c.lga ?? ''),
            }),
          };
        }
        return { value: matched.name };
      },
    },
    {
      name: 'nin',
      label: 'NIN',
      optional: true,
      aliases: ['nin', 'national identification number', 'national id'],
      identifies: (text) => text.replace(/\D/g, '').length === 11,
      prompt: (_c, lang) => t(lang, 'enrol_nin_ask'),
      accept: (text, _c, lang) => {
        const digits = text.replace(/\D/g, '');
        if (digits.length === 0) return { value: '' };
        if (digits.length !== 11) {
          return { error: t(lang, 'enrol_nin_length') };
        }
        return { value: digits };
      },
    },
  ],

  summarise: (c, lang) => {
    const free = /equity|bhcpf/i.test(c.planType ?? '');
    return t(lang, 'enrol_summary', {
      name: c.fullName ?? '',
      age: c.ageOrDob ?? '',
      address: c.residentialAddress ?? '',
      lga: c.lga ?? '',
      plan: c.planType ?? '',
      free: free ? t(lang, 'enrol_summary_free') : '',
      facility: c.preferredHospital ?? '',
      nin: c.nin ? c.nin : t(lang, 'enrol_nin_none'),
    });
  },
};

function firstNameOf(fullName: string | undefined, lang: Language): string {
  return (fullName ?? '').trim().split(/\s+/)[0] || t(lang, 'enrol_friend');
}
