/**
 * Answering budget and project questions from the structured register, not
 * from the language model (PRD §03, §04, §13).
 *
 * The model never produces a figure here. It does not see this path at all:
 * the question is parsed deterministically (year, stage, MDA or sector, LGA),
 * the figure comes from `budgetFigure` in @ace/database, and the sentence is
 * assembled from that row's own fields. That is what "zero fabricated critical
 * figures" requires — an LLM summarising a budget PDF can, and eventually
 * will, produce a plausible number that is in no document.
 *
 * Returns null when the question is not about the budget or projects, or when
 * the agency has loaded no budget data at all — so the existing knowledge path
 * is unchanged for every agency that has not used this.
 */
import {
  budgetFigure,
  compareAmounts,
  describeFigure,
  formatNaira,
  nairaInWords,
  resolveMdaNames,
  STAGE_PHRASE,
  PLATEAU_LGAS,
  type BudgetFigure,
  type BudgetStageName,
} from '@ace/database';

export interface StructuredAnswer {
  replyText: string;
  intent: 'BUDGET_ANSWER' | 'BUDGET_UNAVAILABLE' | 'BUDGET_CONFLICT' | 'BUDGET_CLARIFY' | 'PROJECT_ANSWER' | 'PROJECT_OBSERVATION' | 'PROJECT_UNAVAILABLE';
  /** True when a person must verify (conflicting sources). */
  needsHuman: boolean;
  toolResult?: unknown;
}

const BUDGET_RE = /\b(budget|budgets|allocat\w*|appropriat\w*|expenditure|spent|spend|spending|released|release of funds|capital vote|recurrent vote)\b/i;
const PROJECT_RE = /\b(projects?|contract(s|or)? (awarded|for)|road (construction|project)|constructing|construction of)\b/i;

export function looksLikeBudgetQuestion(text: string): boolean {
  return BUDGET_RE.test(text);
}
export function looksLikeProjectQuestion(text: string): boolean {
  return PROJECT_RE.test(text);
}

export function stageFromText(text: string): BudgetStageName {
  const t = text.toLowerCase();
  if (/\b(spent|spend|spending|expenditure|used)\b/.test(t)) return 'ACTUAL_EXPENDITURE';
  if (/\b(released|release)\b/.test(t)) return 'RELEASED';
  if (/\b(proposed|proposal)\b/.test(t)) return 'PROPOSED';
  if (/\b(revised|supplementary)\b/.test(t)) return 'REVISED';
  return 'APPROVED';
}

export function yearsFromText(text: string): number[] {
  return [...new Set((text.match(/\b(20\d{2})\b/g) ?? []).map(Number))].sort();
}

export function wantsComparison(text: string): boolean {
  return /\b(compare|compared|comparison|versus|vs\.?|last year|previous year|year[- ]on[- ]year|increase|decrease|change from)\b/i.test(text);
}

type Client = any;

/** Does the question name a specific body ("budget for X") rather than the State as a whole? */
function namesSomethingElse(text: string): boolean {
  if (/\b(state|plateau|total|whole|overall|entire|government)\b/i.test(text)) return false;
  return /\b(for|of|to|by)\s+(the\s+)?(?!20\d\d\b)(?!last\b)(?!this\b)(?!next\b)[a-z]/i.test(text);
}

async function distinctApproved(client: Client, organizationId: string, field: 'mdaName' | 'sector'): Promise<string[]> {
  const rows = await client.budgetLine.findMany({
    // `not: null` only on the nullable column; on a required one Prisma throws.
    where: { organizationId, document: { status: 'APPROVED' }, ...(field === 'sector' ? { sector: { not: null } } : {}) },
    distinct: [field],
    select: { [field]: true },
    take: 500,
  });
  return rows.map((r: any) => r[field]).filter(Boolean);
}

async function latestYear(client: Client, organizationId: string, stage: BudgetStageName): Promise<number | null> {
  const row = await client.budgetLine.findFirst({
    where: { organizationId, stage, document: { status: 'APPROVED' } },
    orderBy: { fiscalYear: 'desc' },
    select: { fiscalYear: true },
  });
  return row?.fiscalYear ?? null;
}

function unavailable(stage: BudgetStageName, subject: string, year: number): StructuredAnswer {
  return {
    replyText:
      `I don't have a verified ${STAGE_PHRASE[stage]} for ${subject} in ${year}, so I won't give a figure. ` +
      `If you'd like, ask for an officer and they can check the published documents for you.`,
    intent: 'BUDGET_UNAVAILABLE',
    needsHuman: false,
  };
}

function conflict(f: BudgetFigure & { kind: 'conflict' }, subject: string): StructuredAnswer {
  const lines = f.candidates
    .map((c) => `• ${c.source.title}: ${formatNaira(c.total)}`)
    .join('\n');
  return {
    replyText:
      `The published documents disagree on the ${f.fiscalYear} ${STAGE_PHRASE[f.stage]} for ${subject}:\n${lines}\n\n` +
      `I won't pick one. I've asked an officer to verify which is correct.`,
    intent: 'BUDGET_CONFLICT',
    needsHuman: true,
    toolResult: { conflict: f.candidates.map((c) => ({ document: c.source.title, total: c.total.toFixed(2) })) },
  };
}

/** Budget question → answer, or null to let the normal knowledge path handle it. */
export async function answerBudgetQuestion(client: Client, organizationId: string, text: string): Promise<StructuredAnswer | null> {
  if (!looksLikeBudgetQuestion(text)) return null;

  const stage = stageFromText(text);
  const [mdas, sectors] = await Promise.all([
    distinctApproved(client, organizationId, 'mdaName'),
    distinctApproved(client, organizationId, 'sector'),
  ]);
  if (!mdas.length) return null; // this agency has loaded no budget; fall through unchanged

  // Sector first: "the education budget" means the sector unless one agency is named.
  const sector = sectors.find((s) => new RegExp(`\\b${s.toLowerCase().replace(/[^a-z0-9 ]/g, '')}\\b`).test(text.toLowerCase()));
  const matched = resolveMdaNames(text, mdas);
  const namedOneAgency = matched.length === 1;

  let subject: string;
  let filter: { mdaNames?: string[]; sector?: string } = {};
  if (namedOneAgency) {
    subject = matched[0];
    filter = { mdaNames: matched };
  } else if (sector) {
    subject = `the ${sector} sector`;
    filter = { sector };
  } else if (matched.length > 1) {
    return {
      replyText:
        `Several bodies match that. Do you mean one of these?\n` +
        matched.slice(0, 8).map((m) => `• ${m}`).join('\n') +
        `\nOr ask for the whole sector.`,
      intent: 'BUDGET_CLARIFY',
      needsHuman: false,
      toolResult: { options: matched.slice(0, 8) },
    };
  } else if (namesSomethingElse(text)) {
    // "the budget for X" where X is in no approved document. Answering with
    // the whole State's total would be a true figure for the wrong question.
    return {
      replyText:
        `I couldn't find that body in the published budget. Which ministry, department or agency do you mean? ` +
        `You can also ask about a sector, such as health or education, or the whole State.`,
      intent: 'BUDGET_CLARIFY',
      needsHuman: false,
    };
  } else {
    subject = 'the State';
  }

  let years = yearsFromText(text);
  const compare = wantsComparison(text);
  if (!years.length) {
    const latest = await latestYear(client, organizationId, stage);
    if (latest === null) return unavailable(stage, subject, new Date().getFullYear());
    years = [latest];
  }
  if (compare && years.length === 1) years = [years[0] - 1, years[0]];

  const figures = await Promise.all(
    years.slice(-2).map((y) => budgetFigure(client, { organizationId, fiscalYear: y, stage, ...filter })),
  );

  for (const f of figures) if (f.kind === 'conflict') return conflict(f, subject);
  const missing = figures.find((f) => f.kind === 'none');
  if (missing) return unavailable(stage, subject, missing.fiscalYear);

  const [a, b] = figures as Array<BudgetFigure & { kind: 'figure' }>;
  const basis =
    stage === 'APPROVED' || stage === 'PROPOSED' || stage === 'REVISED'
      ? ' An allocation is what was authorised, not what has been released or spent.'
      : '';

  if (!b) {
    return {
      replyText: describeFigure(a, subject) + basis,
      intent: 'BUDGET_ANSWER',
      needsHuman: false,
      toolResult: { fiscalYear: a.fiscalYear, stage, total: a.total.toFixed(2), sources: a.sources.map((s) => s.title) },
    };
  }

  const cmp = compareAmounts(a.total, b.total);
  const direction = cmp.change.isZero() ? 'unchanged' : cmp.change.isNegative() ? 'a decrease' : 'an increase';
  const pct = cmp.percent === null ? '' : ` (${cmp.percent.abs().toFixed(1)}%)`;
  return {
    replyText:
      `${describeFigure(a, subject)}\n\n${describeFigure(b, subject)}\n\n` +
      (cmp.change.isZero()
        ? `That is unchanged between ${a.fiscalYear} and ${b.fiscalYear}.`
        : `That is ${direction} of ${nairaInWords(cmp.change.abs())} (${formatNaira(cmp.change.abs())})${pct} from ${a.fiscalYear} to ${b.fiscalYear}.`) +
      basis,
    intent: 'BUDGET_ANSWER',
    needsHuman: false,
    toolResult: {
      stage,
      from: { year: a.fiscalYear, total: a.total.toFixed(2) },
      to: { year: b.fiscalYear, total: b.total.toFixed(2) },
      change: cmp.change.toFixed(2),
      percent: cmp.percent?.toString() ?? null,
    },
  };
}

const OBSERVATION_RE = /\b(abandoned|stopped|no work|nothing (is )?happening|not started|never started|poor quality|substandard|not completed|incomplete|they left|has stalled|stalled)\b/i;

function lgaIn(text: string): string | null {
  const t = text.toLowerCase();
  // Longest first so "Langtang North" beats a bare "Langtang".
  return [...PLATEAU_LGAS].sort((a, b) => b.length - a.length).find((l) => t.includes(l.toLowerCase())) ?? null;
}

function describeProject(p: any): string {
  const money: string[] = [];
  if (p.approvedAllocation != null) money.push(`approved allocation ${formatNaira(p.approvedAllocation)}`);
  if (p.contractValue != null) money.push(`contract value ${formatNaira(p.contractValue)}${p.contractor ? ` (${p.contractor})` : ''}`);
  if (p.reportedExpenditure != null) money.push(`reported expenditure ${formatNaira(p.reportedExpenditure)}`);
  const where = [p.community, p.ward, p.lga].filter(Boolean).join(', ');
  const progress = p.physicalProgress != null ? `, ${p.physicalProgress}% physical progress reported` : '';
  const verified = p.verifiedAt ? `, verified ${new Date(p.verifiedAt).toISOString().slice(0, 10)}` : '';
  return (
    `• ${p.name}${where ? ` — ${where}` : ''}. Responsible: ${p.responsibleMda}. ` +
    `Status: ${String(p.status).toLowerCase()}${progress}.` +
    (money.length ? ` ${money.join('; ')}.` : '') +
    ` Source: ${p.sourceDocument ?? p.sourceUrl ?? 'official register'}${verified}.`
  );
}

/** Project question → answer, or null. Records a citizen observation when one is reported. */
export async function answerProjectQuestion(
  client: Client,
  organizationId: string,
  text: string,
  contactId?: string | null,
  channel?: string,
): Promise<StructuredAnswer | null> {
  if (!looksLikeProjectQuestion(text)) return null;
  const any = await client.governmentProject.findFirst({
    where: { organizationId, publicationStatus: 'APPROVED' },
    select: { id: true },
  });
  if (!any) return null;

  const lga = lgaIn(text);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !['project', 'projects', 'what', 'which', 'there', 'where', 'about', 'have', 'been', 'community', 'local', 'government'].includes(w));

  const projects = await client.governmentProject.findMany({
    where: {
      organizationId,
      publicationStatus: 'APPROVED',
      ...(lga ? { lga } : {}),
      ...(words.length && !lga
        ? { OR: words.slice(0, 6).map((w) => ({ name: { contains: w, mode: 'insensitive' } })) }
        : {}),
    },
    orderBy: [{ fiscalYear: 'desc' }, { name: 'asc' }],
    take: 6,
  });

  if (!projects.length) {
    return {
      replyText:
        `I don't have a published project record ${lga ? `for ${lga}` : 'matching that'}. ` +
        `That does not mean there is none — only that none is in the verified register. ` +
        `An officer can check if you ask for one.`,
      intent: 'PROJECT_UNAVAILABLE',
      needsHuman: false,
    };
  }

  // A citizen reporting a problem with ONE identifiable project: record it as
  // their observation, separately from the verified status, and say so.
  if (OBSERVATION_RE.test(text) && projects.length === 1) {
    const p = projects[0];
    await client.projectObservation.create({
      data: { organizationId, projectId: p.id, contactId: contactId ?? null, channel: channel ?? null, text: text.slice(0, 2000) },
    });
    return {
      replyText:
        `Thank you. I've recorded what you've told me about "${p.name}" as a citizen report and referred it for follow-up. ` +
        `It is kept separate from the project's official status, which is currently listed as ${String(p.status).toLowerCase()}. ` +
        `I can't confirm what you've described myself.`,
      intent: 'PROJECT_OBSERVATION',
      needsHuman: true,
      toolResult: { projectId: p.id },
    };
  }

  const shown = projects.slice(0, 5);
  return {
    replyText:
      `${lga ? `Published projects in ${lga}` : 'Published projects matching that'}:\n` +
      shown.map(describeProject).join('\n') +
      (projects.length > 5 ? `\n…and more. Tell me a community or project name to narrow it down.` : '') +
      `\n\nStatus and figures are as officially published; a contract value is not the same as money paid.`,
    intent: 'PROJECT_ANSWER',
    needsHuman: false,
    toolResult: { projectIds: shown.map((p: any) => p.id) },
  };
}
