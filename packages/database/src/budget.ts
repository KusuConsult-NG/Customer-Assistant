/**
 * Budget figures, answered deterministically and with their source (PRD §03).
 *
 * Shared by the conversation engine and the API so a citizen on WhatsApp and
 * an officer on the dashboard get the same number from the same rows. Like
 * `serviceHoursFrom`, every query function TAKES the client rather than
 * importing one, so the orchestrator suites that replace `@ace/database` can
 * still exercise it.
 *
 * ── Four rules, each one a way a figure goes wrong ───────────────────────────
 *
 * 1. DECIMAL, never float. Amounts are summed and compared as Prisma.Decimal
 *    (decimal.js). `0.1 + 0.2` is not a rounding curiosity when the number is
 *    read to a citizen as the education budget.
 *
 * 2. STAGE is never mixed. A figure is always "the APPROVED allocation" or
 *    "the RELEASED amount" or "reported EXPENDITURE" — never a sum across
 *    them. The PRD's own example: approved ₦500m does not mean ₦500m spent.
 *
 * 3. ONE document per answer, never a sum across documents. Two approved
 *    documents covering the same year and stage (an appropriation law and a
 *    citizens' budget restating it) would double-count if summed. If they
 *    AGREE the figure is given once, citing both; if they DISAGREE, no figure
 *    is given at all and the conflict is reported for human verification
 *    (PRD §20 "conflicting budget: suspend unverified financial answers").
 *
 * 4. Only APPROVED documents answer. A draft upload is not something the
 *    State has published.
 */
import { Prisma } from '@prisma/client';

type Decimal = Prisma.Decimal;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export const BUDGET_STAGES = ['PROPOSED', 'APPROVED', 'REVISED', 'RELEASED', 'ACTUAL_EXPENDITURE'] as const;
export type BudgetStageName = (typeof BUDGET_STAGES)[number];

/** How each stage is said aloud. The words themselves carry rule 2. */
export const STAGE_PHRASE: Record<BudgetStageName, string> = {
  PROPOSED: 'proposed (not yet approved) budget',
  APPROVED: 'approved allocation',
  REVISED: 'revised allocation',
  RELEASED: 'amount released',
  ACTUAL_EXPENDITURE: 'reported expenditure',
};

/**
 * Parse an amount as published: "1,234,567.89", "₦ 500,000", "N500000".
 * Returns null for anything that is not unambiguously a non-negative number
 * with at most two decimal places — "1.2e9", "500m", "1.234,56" and "" are
 * rejected rather than guessed, because a misread import is a fabricated
 * figure with a source attached.
 */
export function parseAmount(raw: string | number | null | undefined): Decimal | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/^(₦|NGN|N)\s*/i, '').trim();
  if (!s) return null;
  // Thousands separators must be well-formed if present at all.
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(s)) return null;
  return D(s.replace(/,/g, ''));
}

/** "₦1,234,567.89", or "₦1,234,567" when there are no kobo. */
export function formatNaira(amount: Decimal | string | number): string {
  const d = D(amount);
  const fixed = d.toFixed(2);
  const [whole, kobo] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `₦${grouped}${kobo === '00' ? '' : `.${kobo}`}`;
}

/** Spoken form for large figures: "₦12.4 billion". Exact figure is always given alongside. */
export function nairaInWords(amount: Decimal | string | number): string {
  const d = D(amount);
  const units: Array<[Decimal, string]> = [
    [D('1e12'), 'trillion'],
    [D('1e9'), 'billion'],
    [D('1e6'), 'million'],
  ];
  for (const [size, word] of units) {
    if (d.gte(size)) return `₦${d.div(size).toDecimalPlaces(1).toString()} ${word}`;
  }
  return formatNaira(d);
}

export interface BudgetSource {
  documentId: string;
  title: string;
  documentType: string;
  fiscalYear: number;
  reportingPeriod: string | null;
  sourceUrl: string | null;
  verifiedAt: Date | null;
  /** Up to five page/table references from the lines that made the figure. */
  references: string[];
}

export type BudgetFigure =
  | {
      kind: 'figure';
      stage: BudgetStageName;
      fiscalYear: number;
      total: Decimal;
      lineCount: number;
      matchedMdas: string[];
      sources: BudgetSource[];
    }
  | { kind: 'none'; stage: BudgetStageName; fiscalYear: number }
  | {
      kind: 'conflict';
      stage: BudgetStageName;
      fiscalYear: number;
      /** Each disagreeing document and what it says. */
      candidates: Array<{ source: BudgetSource; total: Decimal }>;
    };

export interface BudgetQuery {
  organizationId: string;
  fiscalYear: number;
  stage: BudgetStageName;
  /** Exact MDA names (already resolved — see resolveMdaName). */
  mdaNames?: string[];
  sector?: string;
  economicClass?: string;
}

type Client = {
  budgetLine: { findMany: (args: any) => Promise<any[]> };
};

/**
 * The figure for one year, one stage, optionally one MDA/sector, from
 * APPROVED documents only. Never sums across documents (rule 3).
 */
export async function budgetFigure(client: Client, q: BudgetQuery): Promise<BudgetFigure> {
  const rows = await client.budgetLine.findMany({
    where: {
      organizationId: q.organizationId,
      fiscalYear: q.fiscalYear,
      stage: q.stage,
      document: { status: 'APPROVED' },
      ...(q.mdaNames?.length ? { mdaName: { in: q.mdaNames } } : {}),
      ...(q.sector ? { sector: { equals: q.sector, mode: 'insensitive' } } : {}),
      ...(q.economicClass ? { economicClass: { equals: q.economicClass, mode: 'insensitive' } } : {}),
    },
    select: {
      amount: true,
      mdaName: true,
      sourcePage: true,
      sourceTable: true,
      lineCode: true,
      document: {
        select: {
          id: true,
          title: true,
          documentType: true,
          fiscalYear: true,
          reportingPeriod: true,
          sourceUrl: true,
          verifiedAt: true,
        },
      },
    },
  });

  if (!rows.length) return { kind: 'none', stage: q.stage, fiscalYear: q.fiscalYear };

  const byDoc = new Map<string, { source: BudgetSource; total: Decimal; count: number; mdas: Set<string> }>();
  for (const r of rows) {
    const doc = r.document;
    let entry = byDoc.get(doc.id);
    if (!entry) {
      entry = {
        source: {
          documentId: doc.id,
          title: doc.title,
          documentType: doc.documentType,
          fiscalYear: doc.fiscalYear,
          reportingPeriod: doc.reportingPeriod ?? null,
          sourceUrl: doc.sourceUrl ?? null,
          verifiedAt: doc.verifiedAt ?? null,
          references: [],
        },
        total: D(0),
        count: 0,
        mdas: new Set(),
      };
      byDoc.set(doc.id, entry);
    }
    entry.total = entry.total.plus(D(r.amount));
    entry.count += 1;
    entry.mdas.add(r.mdaName);
    const ref = [r.sourcePage, r.sourceTable, r.lineCode && `code ${r.lineCode}`].filter(Boolean).join(', ');
    if (ref && entry.source.references.length < 5 && !entry.source.references.includes(ref)) {
      entry.source.references.push(ref);
    }
  }

  const docs = [...byDoc.values()];
  const first = docs[0];
  if (docs.every((d) => d.total.eq(first.total))) {
    return {
      kind: 'figure',
      stage: q.stage,
      fiscalYear: q.fiscalYear,
      total: first.total,
      lineCount: first.count,
      matchedMdas: [...first.mdas].sort(),
      sources: docs.map((d) => d.source),
    };
  }
  return {
    kind: 'conflict',
    stage: q.stage,
    fiscalYear: q.fiscalYear,
    candidates: docs.map((d) => ({ source: d.source, total: d.total })),
  };
}

export interface YearComparison {
  from: Decimal;
  to: Decimal;
  change: Decimal;
  /** Percentage change to one decimal place; null when the base year is zero. */
  percent: Decimal | null;
}

/** Year-on-year change, exact. */
export function compareAmounts(from: Decimal | string | number, to: Decimal | string | number): YearComparison {
  const a = D(from);
  const b = D(to);
  const change = b.minus(a);
  return {
    from: a,
    to: b,
    change,
    percent: a.isZero() ? null : change.div(a).times(100).toDecimalPlaces(1),
  };
}

/** Share of a whole, to one decimal place; null when the whole is zero. */
export function sharePercent(part: Decimal | string | number, whole: Decimal | string | number): Decimal | null {
  const w = D(whole);
  return w.isZero() ? null : D(part).div(w).times(100).toDecimalPlaces(1);
}

const STOP = new Set(['ministry', 'of', 'and', 'the', 'state', 'plateau', 'department', 'agency', 'board', 'commission', 'for', 'office', 'bureau']);
const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));

/**
 * Resolve what a citizen said ("education", "ministry of health", "PLASCHEMA")
 * to the MDA names actually in the budget. Returns EVERY name that matches,
 * so "education" finds the Ministry of Education and the Universal Basic
 * Education Board — and the caller decides whether that is the sector or an
 * ambiguity to clarify (PRD §06 example: "clarifies sector versus agency").
 */
export function resolveMdaNames(asked: string, known: string[]): string[] {
  const text = asked.toLowerCase();
  // An acronym or exact name, said outright, wins.
  const exact = known.filter((k) => {
    const lk = k.toLowerCase();
    const acronym = (k.match(/\(([A-Z][A-Z0-9-]{1,})\)/)?.[1] ?? '').toLowerCase();
    return text.includes(lk) || (acronym && new RegExp(`\\b${acronym}\\b`).test(text));
  });
  if (exact.length) return exact;
  const askedTokens = new Set(tokens(asked));
  return known.filter((k) => tokens(k).some((t) => askedTokens.has(t)));
}

export interface DocumentValidation {
  documentId: string;
  lineCount: number;
  /** Sum of every line, per stage (a document can carry more than one). */
  totalsByStage: Partial<Record<BudgetStageName, string>>;
  declaredTotal: string | null;
  /** True only when there is a declared total and exactly one stage sums to it. */
  matchesDeclared: boolean | null;
  problems: string[];
}

/**
 * Check a document's imported lines against the total the document itself
 * states. Approval refuses a document whose lines do not add up — an import
 * that dropped a page is otherwise indistinguishable from a real budget.
 */
export async function validateBudgetDocument(
  client: { budgetDocument: { findUnique: (a: any) => Promise<any> }; budgetLine: { findMany: (a: any) => Promise<any[]> } },
  documentId: string,
): Promise<DocumentValidation> {
  const doc = await client.budgetDocument.findUnique({
    where: { id: documentId },
    select: { id: true, declaredTotal: true, fiscalYear: true },
  });
  const lines = await client.budgetLine.findMany({
    where: { documentId },
    select: { amount: true, stage: true, fiscalYear: true },
  });
  const totals: Partial<Record<BudgetStageName, Decimal>> = {};
  const problems: string[] = [];
  for (const l of lines) {
    const st = l.stage as BudgetStageName;
    totals[st] = (totals[st] ?? D(0)).plus(D(l.amount));
    if (doc && l.fiscalYear !== doc.fiscalYear) {
      problems.push(`A line is for ${l.fiscalYear} but the document is for ${doc.fiscalYear}.`);
    }
  }
  if (!lines.length) problems.push('The document has no lines.');
  const declared = doc?.declaredTotal != null ? D(doc.declaredTotal) : null;
  let matches: boolean | null = null;
  if (declared) {
    const stagesMatching = Object.values(totals).filter((t) => t!.eq(declared));
    matches = stagesMatching.length === 1;
    if (!matches) {
      problems.push(
        `The lines add up to ${Object.entries(totals)
          .map(([s, t]) => `${formatNaira(t!)} (${s})`)
          .join(', ') || 'nothing'}, but the document states ${formatNaira(declared)}.`,
      );
    }
  }
  return {
    documentId,
    lineCount: lines.length,
    totalsByStage: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v!.toFixed(2)])),
    declaredTotal: declared ? declared.toFixed(2) : null,
    matchesDeclared: matches,
    problems: [...new Set(problems)],
  };
}

/** Text the citizen hears for a single figure. Always names the stage, year and source. */
export function describeFigure(f: BudgetFigure & { kind: 'figure' }, subject: string): string {
  const src = f.sources[0];
  const where = src.references.length ? ` (${src.references.slice(0, 2).join('; ')})` : '';
  const verified = src.verifiedAt
    ? ` Last verified ${src.verifiedAt.toISOString().slice(0, 10)}.`
    : '';
  const period = src.reportingPeriod ? ` for ${src.reportingPeriod}` : '';
  const exact = formatNaira(f.total);
  const spoken = nairaInWords(f.total);
  const amount = spoken === exact ? exact : `${spoken} (${exact})`;
  return (
    `The ${f.fiscalYear} ${STAGE_PHRASE[f.stage]}${period} for ${subject} is ${amount}. ` +
    `Source: ${src.title}${where}.${verified}` +
    (src.sourceUrl ? ` ${src.sourceUrl}` : '')
  );
}
