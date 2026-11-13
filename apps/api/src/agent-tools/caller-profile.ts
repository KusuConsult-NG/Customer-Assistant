/**
 * Who is calling, as far as our records know — ONE definition.
 *
 * Two places answer that question: `lookup-customer`, which the agent calls
 * mid-conversation, and the conversation-start webhook, which ElevenLabs calls
 * as the call connects. If they disagreed about what makes a caller "new" or
 * "returning", the agent would greet somebody by name and then ask for it, or
 * welcome a stranger back. So the rule lives here and both read it.
 *
 * A record is only as good as the name on it: a contact whose name is one of
 * our placeholders (`Caller (···1234)`, written when somebody rang and hung up
 * before giving it) is a NEW caller, however many calls it has.
 */
import { isPlaceholderContactName } from '@ace/database';

/** The five details collected from every new caller, in the order asked. */
export const PROFILE_FIELDS = ['fullName', 'lga', 'homeAddress', 'occupation', 'preferredLanguage'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** How each field is said to the agent. */
const FIELD_LABELS: Record<ProfileField, string> = {
  fullName: 'full name',
  lga: 'LGA',
  homeAddress: 'home address',
  occupation: 'occupation',
  preferredLanguage: 'preferred language',
};

/**
 * - `returning`: a real name and all five details — greet by name, ask nothing.
 * - `partial`: a real name, some details missing — greet by name, ask only those.
 * - `new`: no record, or only a placeholder name — collect all five.
 * - `unknown`: the records could not be read in time. NOT the same as new: the
 *   agent falls back to its lookup tool rather than interviewing somebody who
 *   may have given their details last week.
 */
export type ProfileStatus = 'returning' | 'partial' | 'new' | 'unknown';

export interface ContactProfileFields {
  fullName: string | null;
  city: string | null;
  address: string | null;
  preferredLanguage: string | null;
  metadata: unknown;
}

export interface CallerProfile {
  status: Exclude<ProfileStatus, 'unknown'>;
  /** The caller's real name, never a placeholder. */
  name: string | null;
  missing: ProfileField[];
  values: Record<ProfileField, string | null>;
}

const present = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function profileOf(contact: ContactProfileFields | null): CallerProfile {
  const name = contact && present(contact.fullName) && !isPlaceholderContactName(contact.fullName!)
    ? contact.fullName!.trim()
    : null;
  const values: Record<ProfileField, string | null> = {
    fullName: name,
    lga: present(contact?.city),
    homeAddress: present(contact?.address),
    occupation: present((contact?.metadata as Record<string, unknown> | null)?.occupation),
    preferredLanguage: present(contact?.preferredLanguage),
  };
  const missing = PROFILE_FIELDS.filter((f) => !values[f]);

  if (!name) return { status: 'new', name: null, missing: [...PROFILE_FIELDS], values };
  return { status: missing.length === 0 ? 'returning' : 'partial', name, missing, values };
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

export function callerVariablesFor(profile: CallerProfile): CallerVariables {
  const said = (f: ProfileField) => profile.values[f] ?? 'MISSING';
  return {
    caller_status: profile.status,
    caller_name: profile.name ?? 'not on file',
    caller_profile:
      profile.status === 'new'
        ? 'none on file'
        : `LGA: ${said('lga')}; home address: ${said('homeAddress')}; occupation: ${said('occupation')}; ` +
          `preferred language: ${said('preferredLanguage')}`,
    caller_missing_fields: profile.missing.length ? profile.missing.map((f) => FIELD_LABELS[f]).join(', ') : 'none',
  };
}
