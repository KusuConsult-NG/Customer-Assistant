/**
 * The State's own administrative geography.
 *
 * This used to be derived: `PLATEAU_LGAS = Object.keys(PLASCHEMA_FACILITIES)`,
 * so the list of Local Government Areas the whole platform recognised was
 * whatever the health scheme happened to have an accredited hospital in. It
 * produced the right 17 only because that directory was complete.
 *
 * That coupling is wrong for a platform serving every ministry: if the health
 * agency de-accredited the last facility in an LGA, that LGA would silently
 * stop existing for the lands registry, the revenue board and everyone else —
 * and a citizen there could not say where they live.
 *
 * An LGA is a fact about the State, not about one agency's service coverage,
 * so it is stated here and the service directories are checked against it.
 */

/** The 17 Local Government Areas of Plateau State, alphabetically. */
export const PLATEAU_LGAS: readonly string[] = [
  'Barkin Ladi',
  'Bassa',
  'Bokkos',
  'Jos East',
  'Jos North',
  'Jos South',
  'Kanam',
  'Kanke',
  'Langtang North',
  'Langtang South',
  'Mangu',
  'Mikang',
  'Pankshin',
  "Qua'an Pan",
  'Riyom',
  'Shendam',
  'Wase',
];

/**
 * Resolves what a citizen said into a known LGA, or null.
 *
 * Returns null rather than guessing: an unrecognised answer recorded as the
 * nearest-looking LGA sends somebody to the wrong office, which is worse than
 * asking them again.
 */
export function resolveLga(input: string | undefined | null): string | null {
  const asked = (input ?? '').trim().toLowerCase();
  if (!asked) return null;

  const exact = PLATEAU_LGAS.find((l) => l.toLowerCase() === asked);
  if (exact) return exact;

  // "jos north lga", "i live in jos north" — a contained match is safe because
  // no LGA name is a substring of another.
  const contained = PLATEAU_LGAS.find(
    (l) => asked.includes(l.toLowerCase()) || l.toLowerCase().includes(asked)
  );
  return contained ?? null;
}

export function isKnownLga(input: string | undefined | null): boolean {
  return resolveLga(input) !== null;
}
