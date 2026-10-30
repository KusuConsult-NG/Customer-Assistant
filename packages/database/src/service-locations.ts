/**
 * Service locations a citizen may be directed to, by Local Government Area.
 *
 * ── What this is, and what it is not ────────────────────────────────────────
 *
 * This is REFERENCE DATA FOR ONE AGENCY — the State health scheme's accredited
 * facilities. It is not a platform-wide directory, and nothing here describes
 * where a lands registry or a revenue board does business.
 *
 * It lives in code for now because that is where it already was. The honest
 * shape is a per-agency table of service locations, so each ministry lists its
 * own offices; that is recorded as outstanding in PROVENANCE.md. Until then,
 * treat this as that agency's seed data that other agencies simply do not use.
 *
 * The agent reads from this list rather than accepting a free-text location,
 * so a caller cannot be registered against a facility that does not exist.
 *
 * ── What changed ────────────────────────────────────────────────────────────
 *
 * The State's LGA list used to be DERIVED from the keys here, which made one
 * agency's service coverage define the geography of the whole platform. LGAs
 * now come from `state-geography.ts` and this directory is checked against
 * them.
 */

import { PLATEAU_LGAS } from './state-geography';

export interface AccreditedFacility {
  name: string;
  type: string;
  address: string;
}

export const ACCREDITED_FACILITIES: Record<string, AccreditedFacility[]> = {
  "Jos North": [
    { name: "Plateau Specialist Hospital", type: "Specialist Hospital", address: "Plateau Road, Jos" },
    { name: "Jos University Teaching Hospital", type: "Specialist Hospital", address: "Lamingo Road, Jos" },
    { name: "Bingham University Teaching Hospital", type: "Specialist Hospital", address: "Gindiri Road, Jos" },
    { name: "Gwong Primary Health Centre", type: "Primary Health Centre", address: "Gwong, Jos North" },
    { name: "Nasarawa Primary Health Centre", type: "Primary Health Centre", address: "Nasarawa GRA, Jos North" },
    { name: "Anglo Jos Clinic", type: "General Hospital", address: "Anglo Jos, Jos North" },
  ],
  "Jos South": [
    { name: "Du General Hospital", type: "General Hospital", address: "Du, Jos South" },
    { name: "Vwang Health Centre", type: "Primary Health Centre", address: "Vwang, Jos South" },
    { name: "Kuru Primary Health Centre", type: "Primary Health Centre", address: "Kuru, Jos South" },
  ],
  "Jos East": [
    { name: "Vom Christian Hospital", type: "General Hospital", address: "Vom, Jos East" },
    { name: "Naraguta Primary Health Centre", type: "Primary Health Centre", address: "Naraguta, Jos East" },
    { name: "Heipang General Hospital", type: "General Hospital", address: "Heipang, Jos East" },
  ],
  "Barkin Ladi": [
    { name: "Barkin Ladi General Hospital", type: "General Hospital", address: "Barkin Ladi LGA" },
    { name: "Maiyanga Primary Health Centre", type: "Primary Health Centre", address: "Maiyanga, Barkin Ladi" },
    { name: "Ganawuri Primary Health Centre", type: "Primary Health Centre", address: "Ganawuri, Barkin Ladi" },
  ],
  "Bassa": [
    { name: "Bassa General Hospital", type: "General Hospital", address: "Bassa LGA Headquarters" },
    { name: "Jengre Primary Health Centre", type: "Primary Health Centre", address: "Jengre, Bassa" },
  ],
  "Bokkos": [
    { name: "Bokkos General Hospital", type: "General Hospital", address: "Bokkos Town" },
    { name: "Manguna Primary Health Centre", type: "Primary Health Centre", address: "Manguna, Bokkos" },
  ],
  "Kanam": [
    { name: "Kanam General Hospital", type: "General Hospital", address: "Kanam LGA Headquarters" },
    { name: "Dengi Primary Health Centre", type: "Primary Health Centre", address: "Dengi, Kanam" },
    { name: "Shendam General Hospital", type: "General Hospital", address: "Shendam, Kanam" },
  ],
  "Kanke": [
    { name: "Kabwir General Hospital", type: "General Hospital", address: "Kabwir, Kanke" },
    { name: "Kanke Primary Health Centre", type: "Primary Health Centre", address: "Kanke Headquarters" },
  ],
  "Langtang North": [
    { name: "Langtang General Hospital", type: "General Hospital", address: "Langtang Town" },
    { name: "Piapung Primary Health Centre", type: "Primary Health Centre", address: "Piapung, Langtang North" },
  ],
  "Langtang South": [
    { name: "Shendam General Hospital", type: "General Hospital", address: "Shendam" },
    { name: "Yelwa Primary Health Centre", type: "Primary Health Centre", address: "Yelwa, Langtang South" },
  ],
  "Mangu": [
    { name: "Mangu General Hospital", type: "General Hospital", address: "Mangu Town" },
    { name: "Gindiri Hospital", type: "General Hospital", address: "Gindiri, Mangu" },
    { name: "Ampang Primary Health Centre", type: "Primary Health Centre", address: "Ampang East, Mangu" },
  ],
  "Mikang": [
    { name: "Mikang General Hospital", type: "General Hospital", address: "Mikang LGA" },
    { name: "Shendam Cottage Hospital", type: "Cottage Hospital", address: "Shendam Road, Mikang" },
  ],
  "Pankshin": [
    { name: "Pankshin General Hospital", type: "General Hospital", address: "Pankshin Town" },
    { name: "Pamtok Primary Health Centre", type: "Primary Health Centre", address: "Pamtok, Pankshin" },
  ],
  "Qua'an Pan": [
    { name: "Qua'an Pan General Hospital", type: "General Hospital", address: "Qua'an Pan Town" },
    { name: "Shendam General Hospital", type: "General Hospital", address: "Shendam" },
    { name: "Qua'an Pan Primary Health Centre", type: "Primary Health Centre", address: "Qua'an Pan Headquarters" },
  ],
  "Riyom": [
    { name: "Riyom General Hospital", type: "General Hospital", address: "Riyom Town" },
    { name: "Hoss Primary Health Centre", type: "Primary Health Centre", address: "Hoss, Riyom" },
  ],
  "Shendam": [
    { name: "Shendam General Hospital", type: "General Hospital", address: "Shendam" },
    { name: "Namu Primary Health Centre", type: "Primary Health Centre", address: "Namu, Shendam" },
    { name: "Dadin Kowa Primary Health Centre", type: "Primary Health Centre", address: "Dadin Kowa, Shendam" },
  ],
  "Wase": [
    { name: "Wase General Hospital", type: "General Hospital", address: "Wase Town" },
    { name: "Wase Primary Health Centre", type: "Primary Health Centre", address: "Wase Headquarters" },
    { name: "Gimba Primary Health Centre", type: "Primary Health Centre", address: "Gimba, Wase" },
  ],
};

/**
 * LGAs this directory actually covers. NOT the State's list of LGAs — that is
 * `PLATEAU_LGAS` in state-geography.ts, and an LGA with no accredited facility
 * is still a real place somebody lives.
 */
export const FACILITY_COVERED_LGAS = Object.keys(ACCREDITED_FACILITIES).sort();

/** LGAs of the State where this agency has no accredited facility at all. */
export function lgasWithoutFacilities(): string[] {
  return PLATEAU_LGAS.filter((l) => !ACCREDITED_FACILITIES[l]?.length);
}

/**
 * Find facilities for an LGA, with fuzzy matching for common speech-to-text
 * misspellings. "Kwan Pan", "Kwan Kwan", "Quan Pan" → "Qua'an Pan".
 * "Reom", "Riom" → "Riyom". "Wasi", "Wassie" → "Wase".
 */
export function getFacilitiesForLGA(lga: string): AccreditedFacility[] {
  const normalised = lga.trim().toLowerCase().replace(/['']/g, '').replace(/\s+/g, ' ');

  // Exact match first (case-insensitive)
  const exactKey = Object.keys(ACCREDITED_FACILITIES).find(
    k => k.toLowerCase() === lga.trim().toLowerCase()
  );
  if (exactKey) return ACCREDITED_FACILITIES[exactKey];

  // Fuzzy alias map — covers common STT (speech-to-text) variants heard in calls
  const ALIASES: Record<string, string> = {
    'quan pan': "Qua'an Pan",
    'kwan pan': "Qua'an Pan",
    'kwan kwan': "Qua'an Pan",
    'kwanpan': "Qua'an Pan",
    'quaan pan': "Qua'an Pan",
    'qua an pan': "Qua'an Pan",
    'quan an pan': "Qua'an Pan",
    'reom': 'Riyom',
    'riom': 'Riyom',
    'reyom': 'Riyom',
    'wasi': 'Wase',
    'wasie': 'Wase',
    'wassie': 'Wase',
    'bakin ladi': 'Barkin Ladi',
    'barking ladi': 'Barkin Ladi',
    'jos north': 'Jos North',
    'jos south': 'Jos South',
    'jos east': 'Jos East',
    'langtang north': 'Langtang North',
    'langtang south': 'Langtang South',
  };

  const aliasKey = ALIASES[normalised];
  if (aliasKey && ACCREDITED_FACILITIES[aliasKey]) return ACCREDITED_FACILITIES[aliasKey];

  // Partial / starts-with match as last resort
  const partialKey = Object.keys(ACCREDITED_FACILITIES).find(
    k => k.toLowerCase().startsWith(normalised) || normalised.startsWith(k.toLowerCase().split(' ')[0])
  );
  return partialKey ? ACCREDITED_FACILITIES[partialKey] : [];
}

export function isAccreditedFacility(lga: string, hospitalName: string): boolean {
  const facilities = getFacilitiesForLGA(lga);
  const cleaned = hospitalName.trim().toLowerCase();
  return facilities.some(f => f.name.toLowerCase() === cleaned);
}

export function facilitiesForLGAAsText(lga: string): string {
  const facilities = getFacilitiesForLGA(lga);
  if (facilities.length === 0) return 'your nearest General Hospital or Primary Health Centre';
  if (facilities.length === 1) return facilities[0].name;
  const names = facilities.map(f => f.name);
  const last = names.pop();
  return names.join(', ') + ', or ' + last;
}
