/**
 * Case lifecycle and complaint classification (PRD §10).
 *
 * Shared by the conversation engine (which opens cases) and the API (which
 * moves them), so both agree on what a stage means and which moves are legal.
 *
 * ── The rules the lifecycle enforces ────────────────────────────────────────
 *
 *  - Stages move along RECEIVED → CLASSIFIED → ASSIGNED → UNDER_REVIEW →
 *    ACTION_IN_PROGRESS → RESOLVED → CLOSED, may skip FORWARD (a case can be
 *    assigned straight from received), and may be REOPENED from resolved or
 *    closed. Nothing moves backwards except through REOPENED, so the history
 *    always reads as what happened.
 *  - RESOLVED needs an outcome. "Referral is not resolution": a case handed to
 *    an MDA is still open until somebody records what was actually done.
 *  - CLOSED needs RESOLVED first. A case cannot be closed unresolved.
 */

export const CASE_STAGES = [
  'RECEIVED',
  'CLASSIFIED',
  'ASSIGNED',
  'UNDER_REVIEW',
  'ACTION_IN_PROGRESS',
  'RESOLVED',
  'CLOSED',
  'REOPENED',
] as const;
export type CaseStageName = (typeof CASE_STAGES)[number];

const ORDER: Record<CaseStageName, number> = {
  RECEIVED: 0,
  REOPENED: 0,
  CLASSIFIED: 1,
  ASSIGNED: 2,
  UNDER_REVIEW: 3,
  ACTION_IN_PROGRESS: 4,
  RESOLVED: 5,
  CLOSED: 6,
};

/** null when the move is allowed, otherwise the reason it is not. */
export function caseTransitionProblem(
  from: CaseStageName,
  to: CaseStageName,
  opts: { outcome?: string | null } = {},
): string | null {
  if (from === to) return `The case is already ${to.toLowerCase().replace(/_/g, ' ')}.`;
  if (to === 'REOPENED') {
    return from === 'RESOLVED' || from === 'CLOSED' ? null : 'Only a resolved or closed case can be reopened.';
  }
  if (to === 'CLOSED' && from !== 'RESOLVED') return 'A case must be resolved, with its outcome recorded, before it is closed.';
  if (to === 'RESOLVED' && !(opts.outcome ?? '').trim()) {
    return 'Record what was actually done to resolve it. A referral to an MDA is not a resolution.';
  }
  if (from === 'CLOSED') return 'A closed case must be reopened first.';
  if (ORDER[to] < ORDER[from]) return `A case cannot move back from ${from.toLowerCase()} to ${to.toLowerCase()}; reopen it instead.`;
  return null;
}

/** The legacy TicketStatus a stage corresponds to, so older screens agree. */
export function ticketStatusForStage(stage: CaseStageName): 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED' {
  switch (stage) {
    case 'RECEIVED':
    case 'CLASSIFIED':
    case 'REOPENED':
      return 'OPEN';
    case 'RESOLVED':
      return 'RESOLVED';
    case 'CLOSED':
      return 'CLOSED';
    default:
      return 'IN_PROGRESS';
  }
}

export interface ComplaintClass {
  category: string;
  sensitive: boolean;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  /** Service deadline in days for this category, before an officer sets one. */
  serviceDays: number;
}

const CATEGORIES: Array<{ category: string; re: RegExp; sensitive?: boolean; priority?: ComplaintClass['priority']; days?: number }> = [
  { category: 'misconduct', re: /\b(bribe|bribery|extort\w*|corrupt\w*|misconduct|harass\w*|asked (me )?for money|demanded money|abuse of office)\b/i, sensitive: true, priority: 'HIGH', days: 14 },
  { category: 'security', re: /\b(security|insecurity|thieves|theft|robbery|attack|cult(ists)?|gunmen|kidnap\w*|vigilante)\b/i, sensitive: true, priority: 'HIGH', days: 3 },
  { category: 'environment', re: /\b(erosion|gully|deforest\w*|pollution|oil spill|mining pit|flooding|drainage blocked|blocked drain)\b/i, priority: 'HIGH', days: 7 },
  { category: 'water', re: /\b(no water|water shortage|water supply|borehole|pipe burst|burst pipe|tap water|water board)\b/i, priority: 'MEDIUM', days: 7 },
  { category: 'roads', re: /\b(pot ?holes?|damaged road|bad road|road (is|has) (damaged|collapsed|broken|washed)|bridge (collapsed|broken|damaged)|road repair)\b/i, priority: 'MEDIUM', days: 30 },
  { category: 'waste', re: /\b(refuse|waste|rubbish|garbage|dump(site|ing)?|sanitation)\b/i, priority: 'MEDIUM', days: 7 },
  { category: 'electricity', re: /\b(no light|power outage|transformer|electricity|street ?lights?)\b/i, priority: 'MEDIUM', days: 14 },
  { category: 'project', re: /\b(abandoned project|project (was |has been )?abandoned|uncompleted project|contractor (left|abandoned))\b/i, priority: 'MEDIUM', days: 30 },
  { category: 'health', re: /\b(hospital|clinic|health cent(er|re)|no drugs|nurses?|doctors?) .*(not|no|never|refus|closed|absent)/i, priority: 'HIGH', days: 7 },
  { category: 'education', re: /\b(school|teachers?|classroom) .*(not|no|never|closed|absent|collapsed|leaking)/i, priority: 'MEDIUM', days: 14 },
  { category: 'service_delay', re: /\b(delay(ed)?|still waiting|waited for|no response|have not (been )?(attended|responded)|since (last )?(month|week|year))\b/i, priority: 'MEDIUM', days: 14 },
];

/** Classify a citizen's report from their own words. Defaults to 'other'. */
export function classifyComplaint(text: string): ComplaintClass {
  for (const c of CATEGORIES) {
    if (c.re.test(text)) {
      return { category: c.category, sensitive: !!c.sensitive, priority: c.priority ?? 'MEDIUM', serviceDays: c.days ?? 14 };
    }
  }
  return { category: 'other', sensitive: false, priority: 'MEDIUM', serviceDays: 14 };
}

/** Words that mean "do not use my name". */
export function wantsAnonymity(text: string): boolean {
  return /\b(anonymous(ly)?|don'?t (use|mention|reveal|give) my name|do not (use|mention|reveal|give) my name|keep my name|without my name|hide my (name|identity))\b/i.test(text);
}

/** Is this message a report that should become a case? */
export function looksLikeComplaint(text: string): boolean {
  if (/\b(file a complaint|make a complaint|lodge a complaint|i want to complain|report (a|an|the)\b|complaint|petition)\b/i.test(text)) return true;
  return CATEGORIES.slice(0, 8).some((c) => c.re.test(text)) && /\b(there is|there's|we have|our|my|in (our|my)|since|for (\d+|two|three|many) (days|weeks|months))\b/i.test(text);
}
