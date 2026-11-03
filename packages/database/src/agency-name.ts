/**
 * What an agency may be called.
 *
 * ── The incident this exists to prevent ─────────────────────────────────────
 *
 * An agency was renamed to the literal string "NEW AGENCY NAME", straight from
 * a copied command whose placeholder had not been filled in. The settings
 * endpoint took it without a murmur, and it went live.
 *
 * The agency name is not an internal label. It is the opening line the AI
 * speaks to every citizen who calls ("Welcome to …"), the heading on the
 * digital identity card a citizen presents as proof, and the name at the top
 * of every screen an officer works in. A placeholder there is worse than the
 * wrong real name, because the wrong real name at least looks like a name.
 *
 * ── Why a reject rather than a warning ──────────────────────────────────────
 *
 * The same reasoning as the startup check that refuses any env value
 * containing "placeholder": a warning is read once, by the person who already
 * knows, and never by the person who inherits it. The only moment this can be
 * caught for free is the moment it is written.
 *
 * ── Why the list is narrow ──────────────────────────────────────────────────
 *
 * It matches things that are placeholders in form, not names that happen to
 * sound generic. A real agency may well be called "Ministry of Information" or
 * "Plateau State Water Board"; none of those is caught. Over-reaching here
 * would block a legitimate rename, which is a worse failure than the one being
 * prevented — so anything uncertain is allowed through.
 */

export class AgencyNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgencyNameError';
  }
}

/**
 * Shapes that are placeholders rather than names.
 *
 * Each is anchored or distinctive enough that a real name cannot match it by
 * accident. Tested both ways: the placeholders are refused and a list of real
 * Nigerian agency names is accepted.
 */
const PLACEHOLDER_SHAPES: RegExp[] = [
  // Angle brackets are never part of a name: "<agency name>", "<prod>".
  /[<>]/,
  // The convention this codebase already uses for env values.
  /placeholder/i,
  // "NEW AGENCY NAME", "new organisation name", "agency name"
  /^(the\s+)?(new\s+)?(agency|organisation|organization|company|business|tenant)(\s+name)?$/i,
  // "your agency", "my organisation name"
  /^(your|my|our|the)\s+(agency|organisation|organization|company|business)(\s+name)?$/i,
  // An instruction that was meant to be replaced: "Put the real agency name here"
  /^(put|enter|insert|replace|type|add|set)\b.*\b(here|name)\b/i,
  // "real agency name" anywhere — only ever appears in an instruction.
  /\breal\s+(agency|organisation|organization|company)\s+name\b/i,
  // Single filler tokens.
  /^(test|testing|demo|example|sample|foo|bar|baz|tbd|todo|changeme|change\s*me|n\/?a|none|null|undefined|x{3,}|(?:asdf)+|(?:qwerty)+)$/i,
  // "NAME", "AGENCY", shouted on its own.
  /^(name|agency|organisation|organization)$/i,
];

/**
 * Throws when a name must not be stored. Returns the trimmed name otherwise.
 *
 * Trimming is part of the contract: a trailing space is invisible in a form
 * and visible in a greeting.
 */
export function assertUsableAgencyName(raw: string): string {
  const name = (raw ?? '').trim().replace(/\s+/g, ' ');

  if (name.length === 0) {
    throw new AgencyNameError(
      'An agency name is required — it is the first thing the assistant says to a citizen.'
    );
  }
  if (name.length < 2) {
    throw new AgencyNameError(
      `"${name}" is too short to be an agency name.`
    );
  }
  if (name.length > 120) {
    throw new AgencyNameError(
      'An agency name must be 120 characters or fewer.'
    );
  }
  // A name with no letter at all is a reference or a typo, not a name.
  if (!/\p{L}/u.test(name)) {
    throw new AgencyNameError(
      `"${name}" contains no letters, so it cannot be an agency name.`
    );
  }

  for (const shape of PLACEHOLDER_SHAPES) {
    if (shape.test(name)) {
      throw new AgencyNameError(
        `"${name}" looks like a placeholder rather than an agency name. ` +
        'This name is spoken to every citizen who calls and printed on their ' +
        'identity card, so it is refused rather than stored. Use the real name ' +
        'of the ministry, department or agency.'
      );
    }
  }

  return name;
}

/** True when the name would be accepted. For a form that wants to ask first. */
export function isUsableAgencyName(raw: string): boolean {
  try {
    assertUsableAgencyName(raw);
    return true;
  } catch {
    return false;
  }
}
