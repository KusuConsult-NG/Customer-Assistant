import { resolveLga } from './state-geography';

/**
 * What ONE agency offers, and where it offers it.
 *
 * ── Why this is a snapshot rather than a set of queries ─────────────────────
 *
 * The registration flow's slots are synchronous — `accept`, `prompt`,
 * `skipIf`, `identifies` all return values, not promises — because the flow
 * engine is deliberately free of database access. Making them async to look up
 * a facility would mean reworking every flow the engine runs, booking and
 * cancelling included, to fix one of them.
 *
 * The engine already has the answer to this: the orchestrator loads a list
 * BEFORE the flow starts and seeds it into `collected` under an underscored
 * key, where the slots read it synchronously. `_targets` does exactly this for
 * "which of your appointments did you mean". This is the same mechanism for
 * "what can I register for" and "where would you like to go".
 *
 * So the catalogue is fetched once per conversation, travels in the flow
 * state, and nothing below the orchestrator touches a database.
 */

export interface ServiceOptionSnapshot {
  id: string;
  name: string;
  description: string | null;
  matchPhrases: string[];
  isNoCost: boolean;
  requiresReview: boolean;
}

export interface ServiceLocationSnapshot {
  id: string;
  name: string;
  kind: string | null;
  address: string | null;
  lga: string;
}

export interface ServiceCatalogue {
  options: ServiceOptionSnapshot[];
  locations: ServiceLocationSnapshot[];
}

export const EMPTY_CATALOGUE: ServiceCatalogue = { options: [], locations: [] };

/**
 * Just enough of a Prisma client to read one agency's catalogue.
 *
 * Passed in, like `BusyLoader` and `serviceHoursFrom` — the orchestrator's
 * suites replace `@ace/database` wholesale, so a helper reaching for its own
 * client is undefined in exactly the tests that cover registration.
 */
export interface ServiceCatalogueReader {
  serviceOption: {
    findMany: (args: any) => Promise<Array<{
      id: string; name: string; description: string | null;
      matchPhrases: string[]; isNoCost: boolean; requiresReview: boolean;
    }>>;
  };
  serviceLocation: {
    findMany: (args: any) => Promise<Array<{
      id: string; name: string; kind: string | null; address: string | null; lga: string;
    }>>;
  };
}

/**
 * One agency's active services and locations.
 *
 * Never throws: this runs at the start of a live conversation, and an
 * exception here would mean the citizen gets no reply. An agency with nothing
 * configured gets an empty catalogue, and the flow refuses to start rather
 * than asking a citizen to choose from a list that does not exist.
 */
export async function loadServiceCatalogue(
  db: ServiceCatalogueReader,
  organizationId: string
): Promise<ServiceCatalogue> {
  try {
    const [options, locations] = await Promise.all([
      db.serviceOption.findMany({
        where: { organizationId, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true, name: true, description: true,
          matchPhrases: true, isNoCost: true, requiresReview: true,
        },
      }),
      db.serviceLocation.findMany({
        where: { organizationId, isActive: true },
        orderBy: [{ lga: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, kind: true, address: true, lga: true },
      }),
    ]);
    return { options, locations };
  } catch {
    return EMPTY_CATALOGUE;
  }
}

// ── Reading a catalogue, synchronously ──────────────────────────────────────

/** The agency's locations in one LGA. Empty when it has none there. */
export function locationsInLga(
  catalogue: ServiceCatalogue,
  lga: string | undefined | null
): ServiceLocationSnapshot[] {
  const resolved = resolveLga(lga);
  if (!resolved) return [];
  return catalogue.locations.filter((l) => resolveLga(l.lga) === resolved);
}

/** Every LGA this agency actually has somewhere to send people. */
export function lgasServed(catalogue: ServiceCatalogue): string[] {
  const seen = new Set<string>();
  for (const l of catalogue.locations) {
    const r = resolveLga(l.lga);
    if (r) seen.add(r);
  }
  return [...seen].sort();
}

/**
 * Resolve what the citizen said into one of the agency's locations in their
 * LGA, or null.
 *
 * Null rather than a guess: enrolling somebody at an office that does not
 * serve them is a journey wasted and a record that has to be corrected by
 * hand. The caller re-asks WITH the real options.
 */
export function resolveLocation(
  catalogue: ServiceCatalogue,
  lga: string | undefined | null,
  requested?: string
): ServiceLocationSnapshot | null {
  const here = locationsInLga(catalogue, lga);
  const asked = requested?.trim().toLowerCase();
  if (!asked || here.length === 0) return null;

  return (
    here.find((l) => l.name.toLowerCase() === asked) ??
    here.find((l) => l.name.toLowerCase().includes(asked)) ??
    here.find((l) => asked.includes(l.name.toLowerCase())) ??
    null
  );
}

/** The locations in an LGA as a readable list, for a prompt or an error. */
export function locationsInLgaAsText(
  catalogue: ServiceCatalogue,
  lga: string | undefined | null
): string {
  return locationsInLga(catalogue, lga)
    .map((l) => (l.kind ? `${l.name} (${l.kind})` : l.name))
    .join(', ');
}

/**
 * Which service the citizen means.
 *
 * Matches the option's own phrases, then its name, then its position in the
 * list ("2"). Ambiguity returns null rather than the first match: picking
 * wrongly here registers somebody for the wrong thing.
 */
export function resolveServiceOption(
  catalogue: ServiceCatalogue,
  said: string | undefined | null
): ServiceOptionSnapshot | null {
  const text = (said ?? '').trim().toLowerCase();
  if (!text) return null;
  const { options } = catalogue;
  if (options.length === 0) return null;

  const byPhrase = options.filter((o) =>
    o.matchPhrases.some((p) => p.trim() && text.includes(p.trim().toLowerCase()))
  );
  if (byPhrase.length === 1) return byPhrase[0];

  const byName = options.filter((o) => text.includes(o.name.toLowerCase()));
  if (byName.length === 1) return byName[0];

  // A bare number picks by position, 1-based, as the prompt presents them.
  if (/^\d{1,2}$/.test(text)) {
    const at = Number(text) - 1;
    if (options[at]) return options[at];
  }

  // Several matched, or none did. Both mean "ask again".
  return null;
}

export function serviceOptionsAsText(catalogue: ServiceCatalogue): string {
  return catalogue.options
    .map((o, i) => `${i + 1}. ${o.name}${o.description ? ` — ${o.description}` : ''}`)
    .join('\n');
}

// ── Travelling in the flow state ────────────────────────────────────────────

/**
 * The key the orchestrator seeds the catalogue under.
 *
 * Underscore-prefixed so it can never collide with a slot name — `nextSlot`
 * only looks for slots, so this is inert data riding in the same bag, exactly
 * as `_targets` does for the appointment flows. It is also why
 * `describeConversationFlow` drives its staff-facing summary off the flow's
 * SLOTS rather than the keys of `collected`: this blob must never be shown to
 * an operator as though it were an answer.
 */
export const CATALOGUE_KEY = '_catalogue';

export function seedCatalogue(
  collected: Record<string, string>,
  catalogue: ServiceCatalogue
): Record<string, string> {
  return { ...collected, [CATALOGUE_KEY]: JSON.stringify(catalogue) };
}

/** The catalogue a flow was started with, or an empty one. */
export function readCatalogue(collected: Record<string, string>): ServiceCatalogue {
  try {
    const parsed = JSON.parse(collected[CATALOGUE_KEY] ?? 'null');
    if (!parsed || !Array.isArray(parsed.options) || !Array.isArray(parsed.locations)) {
      return EMPTY_CATALOGUE;
    }
    return parsed as ServiceCatalogue;
  } catch {
    return EMPTY_CATALOGUE;
  }
}

/**
 * Whether an agency can run a registration at all.
 *
 * With no services configured there is nothing to register FOR, and the flow
 * hands over to a human instead of asking a citizen to pick from an empty
 * list and refusing everything they say.
 */
export function canRegister(catalogue: ServiceCatalogue): boolean {
  return catalogue.options.length > 0;
}
