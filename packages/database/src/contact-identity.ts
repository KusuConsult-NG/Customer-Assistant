/**
 * One citizen, one record — and the name on it.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * Five places wrote "the contact for this phone number", each with its own
 * placeholder name: `Caller (···1234)` (here and in post-call ingestion),
 * `Caller (1234)` (the agent's tools), `Caller 1234` (the voice handoff
 * ticket) and `WhatsApp Contact (···1234)` (the WhatsApp service). Three of
 * them had no guard against a withheld number and two had no retry when two
 * first calls arrived at once.
 *
 * And none of them ever replaced a placeholder. So the platform DID remember
 * the caller's number and DID find their record — then greeted somebody who
 * had given her name on the previous call as "Welcome back, Caller (···5678)",
 * while her real name sat in the booking she had made. The lookup was never
 * the problem; nothing wrote the name back to the record the greeting reads.
 *
 * So: one function, and it upgrades a placeholder when the citizen gives their
 * name. It will not do the reverse, and it will not overwrite a real name with
 * a different real name — a caller booking for a relative gives one, and an
 * officer may have corrected the record by hand. Neither is ours to replace.
 */
import { normalizePhoneNumber, phoneNumberVariants } from './phone-number';

/** The one placeholder this platform writes from now on. */
export function placeholderContactName(phoneNumber: string): string {
  return `Caller (···${(phoneNumber || '').slice(-4)})`;
}

/**
 * Every placeholder shape that is in live data, not just the current one.
 *
 * A detector that knew only today's format would leave every row written by
 * the four earlier ones stuck with a name the citizen never gave.
 */
const PLACEHOLDER_NAMES: RegExp[] = [
  /^caller\s*\(?[·.\s]*\d{3,4}\)?$/i,          // Caller (···5678) · Caller (5678) · Caller 5678
  /^whatsapp\s+contact\s*\(?[·.\s]*\d{3,4}\)?$/i, // WhatsApp Contact (···5678)
  /^(unknown|anonymous|withheld|private|restricted)(\s+caller)?$/i,
  /^valued\s+customer$/i,
  /^(new\s+)?(customer|contact|caller|citizen)$/i,
];

/** True when the name on a record is one WE invented, not one we were given. */
export function isPlaceholderContactName(name: string | null | undefined): boolean {
  const value = (name || '').trim();
  if (!value || value.length < 2 || /^[\s.·_\-]+$/.test(value)) return true;
  return PLACEHOLDER_NAMES.some((re) => re.test(value));
}

/** A name worth storing: given to us, and not one of our own placeholders. */
function realName(name?: string | null): string | null {
  const value = (name || '').trim();
  if (!value || isPlaceholderContactName(value)) return null;
  return value;
}

type ContactRow = { id: string; fullName: string; phoneNumber: string };

/**
 * Generic over the row the client returns, so passing the real `prisma` gives
 * back a real `Contact` — callers need the fields this helper does not care
 * about (email, tags, metadata), and narrowing them away here would push every
 * caller into a second read.
 */
type ContactDb<T extends ContactRow> = {
  contact: {
    findFirst: (args: any) => Promise<T | null>;
    create: (args: any) => Promise<T>;
    update: (args: any) => Promise<T>;
  };
};

/**
 * The citizen record for a phone number, created if this is the first contact
 * and renamed if this is the first time they gave us their name.
 *
 * ── Why it runs at the start of a call, not when a tool needs it ────────────
 *
 * The orchestrator created contacts lazily. A citizen who rang, heard the
 * greeting and hung up left a CallLog and no citizen record at all — invisible
 * on Citizens & Contacts and impossible to ring back, which is exactly the
 * person a care line most needs to reach.
 *
 * Matching is across every stored shape (`phoneNumberVariants`) and writing is
 * canonical, so the same person arriving by phone and by WhatsApp lands on one
 * record rather than two.
 */

/**
 * Is this number one the agency owns rather than a citizen's?
 *
 * Compared across every shape a number might be written in, for the same
 * reason the lookups are: the carrier sends E.164 and an operator types what
 * is on the letterhead, so a string comparison misses the match that matters.
 */
export function isAgencyOwnNumber(
  candidate: string | null | undefined,
  agencyNumbers?: Array<string | null | undefined>
): boolean {
  if (!candidate || !agencyNumbers?.length) return false;
  const mine = new Set<string>();
  for (const n of agencyNumbers) {
    if (!n) continue;
    for (const variant of phoneNumberVariants(String(n).trim())) mine.add(variant);
  }
  if (mine.size === 0) return false;
  return phoneNumberVariants(candidate.trim()).some((v) => mine.has(v));
}

export async function ensureContactForPhone<T extends ContactRow>(
  db: ContactDb<T>,
  organizationId: string,
  phoneNumber: string,
  fullName?: string,
  /**
   * Numbers that belong to the AGENCY, not to a citizen — its own lines, their
   * forwarding targets, and any number a carrier forwards from. Optional, so
   * every existing caller keeps its behaviour; the telephony path passes them.
   */
  agencyNumbers?: Array<string | null | undefined>
): Promise<T | null> {
  const phone = (phoneNumber || '').trim();
  // Carriers send "UNKNOWN", "anonymous" or an empty value for a withheld
  // number. A contact keyed on that is one row every withheld caller in the
  // State shares, so it is not created at all.
  if (!phone || /^(unknown|anonymous|private|restricted|withheld)$/i.test(phone)) return null;

  // A number the AGENCY owns is never the citizen on the line.
  //
  // This matters the moment a local toll-free number is forwarded to the
  // platform's line, which is how a Nigerian citizen reaches a service whose
  // carrier number is foreign. Many carriers forward without passing the
  // original calling line identity through: what arrives as the caller is the
  // dialled number, or the forwarding trunk.
  //
  // Unguarded, every citizen who rings that line is matched to ONE contact —
  // and then their bookings, their tickets and their conversation history all
  // land on the same record. That is not a duplicate, which is recoverable; it
  // is one citizen's appointments filed under another's name, across the whole
  // helpline, with nothing in the data to say it happened.
  //
  // So an agency number is treated exactly as a withheld one: the call is
  // answered, the greeting plays, flows that need no identity still work, and
  // nothing is attributed to a person. The raw value is still on the CallLog,
  // so an officer can see what the carrier actually sent.
  if (isAgencyOwnNumber(phone, agencyNumbers)) return null;

  const given = realName(fullName);

  const existing = await db.contact.findFirst({
    where: { organizationId, phoneNumber: { in: phoneNumberVariants(phone) } },
  });

  if (existing) {
    // The upgrade. Only ever placeholder → real: see the header.
    if (given && isPlaceholderContactName(existing.fullName)) {
      return db.contact.update({ where: { id: existing.id }, data: { fullName: given } });
    }
    return existing;
  }

  try {
    return await db.contact.create({
      data: {
        organizationId,
        phoneNumber: normalizePhoneNumber(phone),
        // Not "Valued Customer": this is a State agency and the people on the
        // other end are citizens. The last four digits make one unnamed caller
        // distinguishable from the next at a glance.
        fullName: given || placeholderContactName(phone),
      },
    });
  } catch (err: any) {
    // Two calls from the same new number at once: the unique constraint is the
    // arbiter, and the loser re-reads rather than failing the call.
    if (err?.code === 'P2002') {
      const won = await db.contact.findFirst({
        where: { organizationId, phoneNumber: { in: phoneNumberVariants(phone) } },
      });
      if (won && given && isPlaceholderContactName(won.fullName)) {
        return db.contact.update({ where: { id: won.id }, data: { fullName: given } });
      }
      return won;
    }
    throw err;
  }
}
