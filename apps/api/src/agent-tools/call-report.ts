/**
 * Turning what a caller reported into a CASE — the classification half.
 *
 * The Contact Centre script (Phase 3) asks different follow-up questions for
 * infrastructure, healthcare, education and public administration, and the
 * case it registers (Phase 8) must say which, so an officer — and every
 * report grouped by category — can route it. The agent names the area it was
 * asking about; the words the caller used can be more specific than that (a
 * pothole is a ROADS case, not merely "infrastructure"), so the shared
 * classifier the WhatsApp engine uses gets the first say inside the area.
 *
 * One classifier, `classifyComplaint` in @ace/database, for both engines: two
 * definitions of "what kind of complaint is this" would file the same report
 * under different categories depending on whether it arrived by phone or
 * WhatsApp, and every count by category would be wrong.
 */
import { classifyComplaint } from '@ace/database';

export interface CaseClass {
  category: string;
  sensitive: boolean;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  /** Days before the case is overdue, until an officer sets a date. */
  serviceDays: number;
}

/** The classifier's categories that are infrastructure. */
const INFRASTRUCTURE = new Set(['roads', 'water', 'electricity', 'waste', 'project', 'environment']);

/**
 * The area the agent names, as the case category it maps to.
 *
 * Keys are matched loosely (case, spaces, slashes) because the value comes
 * from a model filling a string parameter, not from a fixed enum.
 */
const AREAS: Record<string, CaseClass | 'infrastructure'> = {
  infrastructure: 'infrastructure',
  roads: 'infrastructure',
  water: 'infrastructure',
  electricity: 'infrastructure',
  health: { category: 'health', sensitive: false, priority: 'HIGH', serviceDays: 7 },
  healthcare: { category: 'health', sensitive: false, priority: 'HIGH', serviceDays: 7 },
  medical: { category: 'health', sensitive: false, priority: 'HIGH', serviceDays: 7 },
  education: { category: 'education', sensitive: false, priority: 'MEDIUM', serviceDays: 14 },
  publicadministration: { category: 'public_administration', sensitive: false, priority: 'MEDIUM', serviceDays: 14 },
  administration: { category: 'public_administration', sensitive: false, priority: 'MEDIUM', serviceDays: 14 },
  security: { category: 'security', sensitive: true, priority: 'HIGH', serviceDays: 3 },
  securityattack: { category: 'security', sensitive: true, priority: 'HIGH', serviceDays: 3 },
  corruption: { category: 'misconduct', sensitive: true, priority: 'HIGH', serviceDays: 14 },
  misconduct: { category: 'misconduct', sensitive: true, priority: 'HIGH', serviceDays: 14 },
  fire: { category: 'fire', sensitive: false, priority: 'URGENT', serviceDays: 1 },
  flooddisaster: { category: 'disaster', sensitive: false, priority: 'URGENT', serviceDays: 1 },
  flood: { category: 'disaster', sensitive: false, priority: 'URGENT', serviceDays: 1 },
  disaster: { category: 'disaster', sensitive: false, priority: 'URGENT', serviceDays: 1 },
  // A medical emergency that is over (an accident last week, a death at a
  // facility) is a health complaint; one still happening is handled as an
  // incident before this is consulted.
  medicalemergency: { category: 'health', sensitive: false, priority: 'HIGH', serviceDays: 7 },
};

const key = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

export function caseClassFor(area: string | undefined | null, words: string): CaseClass {
  const fromWords = classifyComplaint(words);
  const named = area ? AREAS[key(area)] : undefined;

  if (named === 'infrastructure') {
    // The caller's words narrow it when they can: "pothole" is a roads case.
    return INFRASTRUCTURE.has(fromWords.category)
      ? fromWords
      : { category: 'infrastructure', sensitive: false, priority: 'MEDIUM', serviceDays: 30 };
  }
  if (named) {
    // Misconduct inside a public office is still misconduct, and sensitive:
    // a report of a bribe must not be visible to the office it names.
    if (named.category === 'public_administration' && fromWords.category === 'misconduct') return fromWords;
    return named;
  }
  return fromWords;
}
