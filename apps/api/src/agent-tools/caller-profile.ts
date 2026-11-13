/**
 * Who is calling, as far as our records know — ONE definition.
 *
 * Two places answer that question: `lookup-customer`, which the agent calls
 * mid-conversation, and the conversation-start webhook, which ElevenLabs calls
 * as the call connects. If they disagreed about what makes a caller "new" or
 * "returning", the agent would greet somebody by name and then ask for it, or
 * welcome a stranger back. So the rule lives here and both read it.
 *
 * ── What is asked, and why only this ────────────────────────────────────────
 *
 * The Contact Centre's standard operating script (Phases 1–2) identifies a
 * caller by their name, the Local Government Area, ward and community they
 * are calling from, their occupation and preferred language, and the number
 * to reach them on. A home address is saved when volunteered and never asked.
 *
 * The LOCATION is what a returning caller is asked to confirm in the first
 * message, so it is kept apart (`LOCATION_FIELDS`): a caller missing only
 * their occupation is greeted by name and asked to confirm where they are,
 * then asked the one thing missing — never asked for a "ward" they gave.
 *
 * The NAME is asked but optional — a caller may decline and is still served.
 * A record is only as good as the name on it: a contact whose name is one of
 * our placeholders (`Caller (···1234)`) is a NEW caller, however many calls it
 * has, and is asked again (politely, and again free to decline).
 */
import { isPlaceholderContactName } from '@ace/database';

/** The caller details the script collects, in the order it asks them. */
export const PROFILE_FIELDS = ['fullName', 'lga', 'ward', 'community', 'occupation', 'preferredLanguage'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** Where the caller is — what a returning caller is asked to confirm. */
export const LOCATION_FIELDS: readonly ProfileField[] = ['lga', 'ward', 'community'];

/** How each field is said to the agent, and to the caller. */
export const FIELD_LABELS: Record<ProfileField, string> = {
  fullName: 'full name',
  lga: 'LGA',
  ward: 'ward',
  community: 'community',
  occupation: 'occupation',
  preferredLanguage: 'preferred language',
};

/** "ward, community and occupation" — the given fields that are missing, as words. */
export function missingPhrase(profile: CallerProfile, among: readonly ProfileField[] = PROFILE_FIELDS): string {
  const words = profile.missing.filter((f) => among.includes(f) && f !== 'fullName').map((f) => FIELD_LABELS[f]);
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * - `returning`: a real name and the whole profile — greet by name, confirm
 *   the location in one question, ask nothing else.
 * - `partial`: a real name, part of the profile missing — greet by name, ask
 *   only for what is missing.
 * - `new`: no record, or only a placeholder name — the script from Phase 1.
 * - `unknown`: the records could not be read in time. NOT the same as new: the
 *   agent falls back to its lookup tool rather than starting over with
 *   somebody who may have given their details last week.
 */
export type ProfileStatus = 'returning' | 'partial' | 'new' | 'unknown';

export interface ContactProfileFields {
  fullName: string | null;
  city: string | null;
  address?: string | null;
  preferredLanguage?: string | null;
  metadata: unknown;
}

export interface CallerProfile {
  status: Exclude<ProfileStatus, 'unknown'>;
  /** The caller's real name, never a placeholder. */
  name: string | null;
  missing: ProfileField[];
  values: Record<ProfileField, string | null>;
  /**
   * Where to reach them, as they said on an earlier call: the number they are
   * calling from (`calling number`), another number they gave and confirmed,
   * or null when it was never agreed.
   */
  followUp: string | null;
}

const present = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const meta = (contact: ContactProfileFields | null) =>
  ((contact?.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;

export function profileOf(contact: ContactProfileFields | null): CallerProfile {
  const name = contact && present(contact.fullName) && !isPlaceholderContactName(contact.fullName!)
    ? contact.fullName!.trim()
    : null;
  const m = meta(contact);
  const values: Record<ProfileField, string | null> = {
    fullName: name,
    // LGA lives in `city`, as it always has: every screen that shows a
    // citizen's area reads that column.
    lga: present(contact?.city),
    ward: present(m.ward),
    community: present(m.community),
    occupation: present(m.occupation),
    preferredLanguage: present(contact?.preferredLanguage),
  };
  const followUp = present(m.alternativePhone) ?? (m.phoneConfirmedForFollowUp === true ? 'calling number' : null);
  const missing = PROFILE_FIELDS.filter((f) => !values[f]);

  if (!name) return { status: 'new', name: null, missing: [...PROFILE_FIELDS], values, followUp };
  return { status: missing.length === 0 ? 'returning' : 'partial', name, missing, values, followUp };
}

/**
 * The prompt variables the conversation-start webhook fills.
 *
 * Every one needs a placeholder on the agent too (see `dynamicVariablesFor`):
 * a conversation that starts without the webhook — a preview, an outbound call
 * that sends its own data — would otherwise read `{{caller_status}}` literally.
 * The defaults say "unknown", which sends the agent to its lookup tool.
 */
export const CALLER_VARIABLE_DEFAULTS = {
  caller_status: 'unknown',
  caller_name: 'not on file',
  caller_profile: 'not looked up yet',
  caller_missing_fields: 'not looked up yet',
} as const;

export type CallerVariables = Record<keyof typeof CALLER_VARIABLE_DEFAULTS, string>;

/** The caller's location as one phrase: "Angwan Rogo, Ali Kazaure ward, Jos North". */
export function locationPhrase(profile: CallerProfile): string | null {
  const parts = [
    profile.values.community,
    profile.values.ward ? `${profile.values.ward} ward` : null,
    profile.values.lga,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export function callerVariablesFor(profile: CallerProfile): CallerVariables {
  const said = (f: ProfileField) => profile.values[f] ?? 'MISSING';
  return {
    caller_status: profile.status,
    caller_name: profile.name ?? 'not on file',
    caller_profile:
      profile.status === 'new' && !locationPhrase(profile)
        ? 'none on file'
        : `LGA: ${said('lga')}; ward: ${said('ward')}; community: ${said('community')}; ` +
          `occupation: ${said('occupation')}; preferred language: ${said('preferredLanguage')}; ` +
          `follow-up number: ${profile.followUp ?? 'not yet agreed'}`,
    caller_missing_fields: profile.missing.length ? profile.missing.map((f) => FIELD_LABELS[f]).join(', ') : 'none',
  };
}
