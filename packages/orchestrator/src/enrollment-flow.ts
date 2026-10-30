/**
 * Service registration, as a conversation.
 *
 * AGENCY-CONFIGURABLE. The services offered and the locations a citizen can be
 * sent to are the agency's own `ServiceOption` and `ServiceLocation` rows, not
 * a scheme compiled into the platform. The orchestrator loads them once and
 * seeds them into the flow state before the first question, so these slots
 * stay synchronous and the flow engine keeps its freedom from the database.
 *
 * Until now it could not be completed on WhatsApp at all — the only implementation was the agent tool,
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
  resolveLga,
  readCatalogue,
  locationsInLga,
  locationsInLgaAsText,
  resolveLocation,
  resolveServiceOption,
  serviceOptionsAsText,
} from '@ace/database';
import type { FlowDefinition } from './flows';
import { t, type Language } from './languages';

/**
 * The STORED name of this flow. It is written into `Conversation.flowState` and
 * read back to resume a half-finished form, so renaming it would strand every
 * citizen currently part-way through one — they would be asked everything
 * again. Kept for the same reason the `ace_` identifiers are: it is functional,
 * not a display string. `ENROLLMENT_FLOW.title` is what staff actually see.
 */
export const ENROLLMENT_FLOW_NAME = 'plaschema-enrollment';

/**
 * The LGA as the State spells it, or null.
 *
 * Resolved against the State's own list, not against one agency's coverage.
 * It used to be derived from the facility directory — so an LGA where that
 * agency had no hospital was not a place a citizen could say they lived.
 */
function canonicalLga(text: string): string | null {
  return resolveLga(text);
}

export const ENROLLMENT_FLOW: FlowDefinition = {
  name: ENROLLMENT_FLOW_NAME,
  title: 'Service registration',

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
          // field of the registration RECORD, read by desk staff and passed to
          // the agency, not a sentence spoken to the customer. Only the
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
      // Only a phrase the agency itself registered identifies this slot. A
      // bare digit does not: "3" is a valid option answer AND a valid age, so
      // as a CORRECTION it identifies nothing.
      identifies: (text, c) => {
        if (/^\d{1,2}$/.test(text.trim())) return false;
        return resolveServiceOption(readCatalogue(c), text) !== null;
      },
      prompt: (c, lang) =>
        t(lang, 'enrol_plan_ask', { options: serviceOptionsAsText(readCatalogue(c)) }),
      accept: (text, c, lang) => {
        const found = resolveServiceOption(readCatalogue(c), text);
        if (!found) {
          return { error: t(lang, 'enrol_plan_unclear') };
        }
        // The agency's own name for the service, stored in English in every
        // language for the same reason the age is: it is the value written to
        // the record and read at a desk, not a sentence spoken to the citizen.
        return { value: found.name };
      },
    },
    {
      name: 'preferredHospital',
      label: 'Preferred facility',
      aliases: ['hospital', 'facility', 'clinic', 'health centre', 'health center', 'primary facility'],
      identifies: (text, c) => resolveLocation(readCatalogue(c), c.lga, text) !== null,
      // Skipped where the agency has nowhere in this LGA. Asking a citizen to
      // choose from an empty list, then refusing every answer, is a trap: the
      // registration completes without a location and a human assigns one.
      skipIf: (c) => locationsInLga(readCatalogue(c), c.lga).length === 0,
      prompt: (c, lang) =>
        t(lang, 'enrol_facility_ask', {
          lga: c.lga ?? '',
          options: locationsInLgaAsText(readCatalogue(c), c.lga),
        }),
      accept: (text, c, lang) => {
        const matched = resolveLocation(readCatalogue(c), c.lga, text);
        if (!matched) {
          return {
            error: t(lang, 'enrol_facility_unaccredited', {
              lga: c.lga ?? '',
              options: locationsInLgaAsText(readCatalogue(c), c.lga),
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

/**
 * What an enrollment needs, as one list both engines read.
 *
 * ── Why this is derived rather than written down ────────────────────────────
 *
 * The same seven fields were spelled out in six places: the slots above, the
 * hosted agent's `register-enrollee` parameters, that tool's `required` array,
 * its description sentence, and twice in the agent's system prompt — once as a
 * numbered list and once as "ALL six mandatory fields (name, age/DOB, …)".
 *
 * They agreed, and nothing kept them agreeing. A field added here for a card
 * the scheme now requires would be collected on WhatsApp and never asked for on
 * the phone, so the same citizen gets a complete record through one channel and
 * an incomplete one through the other — and nobody finds out until a card is
 * refused at a desk. This is the same reason `availability.ts` is one shared
 * search: two implementations of the same question drift, and the drift lands
 * in what customers are told.
 *
 * Mapped off `ENROLLMENT_FLOW.slots` itself, so it cannot describe a form the
 * live engine does not run.
 */
export interface EnrollmentField {
  name: string;
  /** False only for the fields a caller may decline — today, just the NIN. */
  mandatory: boolean;
}

export const ENROLLMENT_FIELDS: EnrollmentField[] = ENROLLMENT_FLOW.slots.map((slot) => ({
  name: slot.name,
  mandatory: !slot.optional,
}));

export const MANDATORY_ENROLLMENT_FIELDS = ENROLLMENT_FIELDS
  .filter((f) => f.mandatory)
  .map((f) => f.name);
