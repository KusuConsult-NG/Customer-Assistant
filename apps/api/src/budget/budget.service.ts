import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  prisma,
  parseAmount,
  budgetFigure,
  validateBudgetDocument,
  recordAgencyAudit,
  resolveLga,
  BUDGET_STAGES,
  type Actor,
  type BudgetStageName,
} from '@ace/database';
import { parseCsv } from '../common/csv';

const DOC_TYPES = [
  'APPROPRIATION_LAW', 'PROPOSED_BUDGET', 'SUPPLEMENTARY_BUDGET', 'REVISED_APPROPRIATION',
  'CITIZENS_BUDGET', 'IMPLEMENTATION_REPORT', 'AUDITED_STATEMENT', 'PROCUREMENT_PLAN', 'OTHER',
] as const;
const PROJECT_STATUSES = ['PLANNED', 'AWARDED', 'ONGOING', 'COMPLETED', 'SUSPENDED', 'ABANDONED', 'OTHER'] as const;

/** The stage a line takes when the CSV does not say, from what kind of document it is. */
const DEFAULT_STAGE: Partial<Record<(typeof DOC_TYPES)[number], BudgetStageName>> = {
  APPROPRIATION_LAW: 'APPROVED',
  CITIZENS_BUDGET: 'APPROVED',
  PROPOSED_BUDGET: 'PROPOSED',
  SUPPLEMENTARY_BUDGET: 'REVISED',
  REVISED_APPROPRIATION: 'REVISED',
};

export interface BudgetDocumentInput {
  title: string;
  documentType: string;
  fiscalYear: number;
  sourceUrl?: string;
  publishedAt?: string;
  reportingPeriod?: string;
  declaredTotal?: string;
  notes?: string;
}

export interface ImportReport {
  imported: number;
  rejected: Array<{ line: number; message: string }>;
}

/**
 * Budget documents and the project register (PRD §03, §04, §12, §17).
 *
 * The lifecycle is DRAFT → APPROVED → WITHDRAWN. Only APPROVED rows answer
 * citizens. Lines can be replaced only while DRAFT: once a figure has been
 * read to the public, changing it underneath is a silent correction, so a
 * correction is a new version (withdraw, then upload again).
 *
 * Approval is a second person's act. The approver must not be the officer who
 * uploaded the document, and a document whose lines do not add up to its own
 * stated total cannot be approved at all.
 */
@Injectable()
export class BudgetService {
  // ── Documents ─────────────────────────────────────────────────────────────

  listDocuments(organizationId: string) {
    return prisma.budgetDocument.findMany({
      where: { organizationId },
      orderBy: [{ fiscalYear: 'desc' }, { createdAt: 'desc' }],
      include: { _count: { select: { lines: true } } },
      take: 200,
    });
  }

  async createDocument(organizationId: string, userId: string, input: BudgetDocumentInput) {
    const title = (input.title ?? '').trim();
    if (!title) throw new BadRequestException('A title is required.');
    if (!(DOC_TYPES as readonly string[]).includes(input.documentType)) {
      throw new BadRequestException(`documentType must be one of: ${DOC_TYPES.join(', ')}.`);
    }
    const year = Number(input.fiscalYear);
    if (!Number.isInteger(year) || year < 1990 || year > 2100) throw new BadRequestException('fiscalYear must be a year.');
    let declared = null;
    if (input.declaredTotal !== undefined && input.declaredTotal !== null && String(input.declaredTotal).trim() !== '') {
      declared = parseAmount(input.declaredTotal);
      if (!declared) throw new BadRequestException(`declaredTotal "${input.declaredTotal}" is not an amount.`);
    }
    return prisma.budgetDocument.create({
      data: {
        organizationId,
        title,
        documentType: input.documentType as any,
        fiscalYear: year,
        sourceUrl: input.sourceUrl?.trim() || null,
        publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
        reportingPeriod: input.reportingPeriod?.trim() || null,
        declaredTotal: declared,
        notes: input.notes?.trim() || null,
        createdByUserId: userId,
      },
    });
  }

  private async ownDocument(organizationId: string, id: string) {
    const doc = await prisma.budgetDocument.findFirst({ where: { id, organizationId } });
    if (!doc) throw new NotFoundException('Budget document not found.');
    return doc;
  }

  /**
   * Replace a DRAFT document's lines from CSV. Every row is validated; a row
   * that cannot be read exactly is REJECTED and reported, never guessed.
   * Columns: mda, amount (required); stage, mdaCode, sector, programme,
   * lineCode, description, economicClass, lga, period, sourcePage, sourceTable.
   */
  async importLines(organizationId: string, documentId: string, csv: string): Promise<ImportReport> {
    const doc = await this.ownDocument(organizationId, documentId);
    if (doc.status !== 'DRAFT') {
      throw new ConflictException('Only a draft can be changed. Withdraw this document and upload a corrected version.');
    }
    if (!csv || !csv.trim()) throw new BadRequestException('The CSV is empty.');
    const table = parseCsv(csv);
    const cols = table.header.map((h) => h.toLowerCase());
    for (const required of ['mda', 'amount']) {
      if (!cols.includes(required)) throw new BadRequestException(`The CSV needs a "${required}" column.`);
    }
    const rejected = [...table.errors];
    const get = (v: Record<string, string>, k: string) => {
      const key = Object.keys(v).find((h) => h.toLowerCase() === k.toLowerCase());
      return key ? v[key] : '';
    };
    const data: any[] = [];
    for (const { line, values } of table.rows) {
      const mda = get(values, 'mda');
      const amount = parseAmount(get(values, 'amount'));
      const stageRaw = get(values, 'stage').toUpperCase().replace(/[\s-]+/g, '_');
      const stage = (stageRaw || DEFAULT_STAGE[doc.documentType as keyof typeof DEFAULT_STAGE]) as BudgetStageName | undefined;
      const lgaRaw = get(values, 'lga');
      if (!mda) { rejected.push({ line, message: 'No MDA.' }); continue; }
      if (!amount) { rejected.push({ line, message: `"${get(values, 'amount')}" is not an exact amount.` }); continue; }
      if (!stage || !(BUDGET_STAGES as readonly string[]).includes(stage)) {
        rejected.push({ line, message: `Stage "${stageRaw || '(none)'}" is not one of ${BUDGET_STAGES.join(', ')}.` });
        continue;
      }
      const lga = lgaRaw ? resolveLga(lgaRaw) : null;
      if (lgaRaw && !lga) { rejected.push({ line, message: `"${lgaRaw}" is not a Plateau LGA.` }); continue; }
      data.push({
        organizationId,
        documentId,
        fiscalYear: doc.fiscalYear,
        stage,
        mdaName: mda,
        mdaCode: get(values, 'mdaCode') || null,
        sector: get(values, 'sector') || null,
        programme: get(values, 'programme') || null,
        lineCode: get(values, 'lineCode') || null,
        description: get(values, 'description') || mda,
        economicClass: get(values, 'economicClass') || null,
        lga,
        amount,
        currency: doc.currency,
        period: get(values, 'period') || doc.reportingPeriod || null,
        sourcePage: get(values, 'sourcePage') || null,
        sourceTable: get(values, 'sourceTable') || null,
      });
    }
    await prisma.$transaction([
      prisma.budgetLine.deleteMany({ where: { documentId } }),
      prisma.budgetLine.createMany({ data }),
    ]);
    return { imported: data.length, rejected };
  }

  async validate(organizationId: string, documentId: string) {
    await this.ownDocument(organizationId, documentId);
    return validateBudgetDocument(prisma, documentId);
  }

  async approve(organizationId: string, documentId: string, actor: Actor) {
    const doc = await this.ownDocument(organizationId, documentId);
    if (doc.status !== 'DRAFT') throw new ConflictException(`This document is already ${doc.status.toLowerCase()}.`);
    if (doc.createdByUserId && doc.createdByUserId === actor.userId) {
      throw new ForbiddenException('The officer who uploaded a document cannot also approve it. Ask another administrator.');
    }
    const check = await validateBudgetDocument(prisma, documentId);
    if (check.problems.length) {
      throw new BadRequestException(`This document cannot be approved until it validates. ${check.problems.join(' ')}`);
    }
    const now = new Date();
    const updated = await prisma.budgetDocument.update({
      where: { id: documentId },
      data: { status: 'APPROVED', approvedByUserId: actor.userId, approvedAt: now, verifiedAt: now },
    });
    await recordAgencyAudit(actor, organizationId, {
      action: 'budget.document.approved',
      targetType: 'BudgetDocument',
      targetId: documentId,
      newValue: { title: doc.title, fiscalYear: doc.fiscalYear, lines: check.lineCount, totals: check.totalsByStage },
    });
    return updated;
  }

  async withdraw(organizationId: string, documentId: string, actor: Actor, reason: string) {
    const doc = await this.ownDocument(organizationId, documentId);
    if (!reason?.trim()) throw new BadRequestException('A reason is required to withdraw a published document.');
    const updated = await prisma.budgetDocument.update({ where: { id: documentId }, data: { status: 'WITHDRAWN' } });
    await recordAgencyAudit(actor, organizationId, {
      action: 'budget.document.withdrawn',
      targetType: 'BudgetDocument',
      targetId: documentId,
      previousValue: { status: doc.status },
      newValue: { status: 'WITHDRAWN', reason: reason.trim() },
    });
    return updated;
  }

  /** The figure a citizen would be told — so officers can check it before they are. */
  async query(organizationId: string, q: { year: number; stage?: string; mda?: string; sector?: string }) {
    const stage = (q.stage ?? 'APPROVED').toUpperCase() as BudgetStageName;
    if (!(BUDGET_STAGES as readonly string[]).includes(stage)) throw new BadRequestException('Unknown stage.');
    const year = Number(q.year);
    if (!Number.isInteger(year)) throw new BadRequestException('year is required.');
    const f = await budgetFigure(prisma, {
      organizationId,
      fiscalYear: year,
      stage,
      ...(q.mda ? { mdaNames: [q.mda] } : {}),
      ...(q.sector ? { sector: q.sector } : {}),
    });
    if (f.kind === 'figure') return { ...f, total: f.total.toFixed(2) };
    if (f.kind === 'conflict') return { ...f, candidates: f.candidates.map((c) => ({ ...c, total: c.total.toFixed(2) })) };
    return f;
  }

  /** Distinct MDAs and sectors in approved figures, for the dashboard filters. */
  async facets(organizationId: string) {
    const [mdas, sectors, years] = await Promise.all([
      prisma.budgetLine.findMany({ where: { organizationId, document: { status: 'APPROVED' } }, distinct: ['mdaName'], select: { mdaName: true }, orderBy: { mdaName: 'asc' } }),
      prisma.budgetLine.findMany({ where: { organizationId, document: { status: 'APPROVED' }, sector: { not: null } }, distinct: ['sector'], select: { sector: true }, orderBy: { sector: 'asc' } }),
      prisma.budgetLine.findMany({ where: { organizationId, document: { status: 'APPROVED' } }, distinct: ['fiscalYear'], select: { fiscalYear: true }, orderBy: { fiscalYear: 'desc' } }),
    ]);
    return { mdas: mdas.map((m) => m.mdaName), sectors: sectors.map((s) => s.sector), years: years.map((y) => y.fiscalYear) };
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  listProjects(organizationId: string) {
    return prisma.governmentProject.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'desc' }],
      include: { _count: { select: { observations: true } } },
      take: 500,
    });
  }

  listObservations(organizationId: string) {
    return prisma.projectObservation.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: { project: { select: { id: true, name: true, lga: true, status: true } } },
      take: 200,
    });
  }

  /**
   * Import projects from CSV as DRAFTS. Columns: name, responsibleMda
   * (required); projectCode, fiscalYear, lga, ward, community,
   * approvedAllocation, contractValue, contractor, reportedExpenditure,
   * status, physicalProgress, startDate, expectedCompletion, sourceUrl,
   * sourceDocument.
   */
  async importProjects(organizationId: string, userId: string, csv: string): Promise<ImportReport> {
    if (!csv || !csv.trim()) throw new BadRequestException('The CSV is empty.');
    const table = parseCsv(csv);
    const cols = table.header.map((h) => h.toLowerCase());
    for (const required of ['name', 'responsiblemda']) {
      if (!cols.includes(required)) throw new BadRequestException(`The CSV needs a "${required === 'responsiblemda' ? 'responsibleMda' : required}" column.`);
    }
    const rejected = [...table.errors];
    const get = (v: Record<string, string>, k: string) => {
      const key = Object.keys(v).find((h) => h.toLowerCase() === k.toLowerCase());
      return key ? v[key] : '';
    };
    const money = (line: number, v: Record<string, string>, k: string) => {
      const raw = get(v, k);
      if (!raw) return { ok: true as const, value: null };
      const d = parseAmount(raw);
      if (!d) {
        rejected.push({ line, message: `${k} "${raw}" is not an exact amount.` });
        return { ok: false as const, value: null };
      }
      return { ok: true as const, value: d };
    };
    const date = (raw: string) => (raw && !Number.isNaN(Date.parse(raw)) ? new Date(raw) : null);
    const data: any[] = [];
    for (const { line, values } of table.rows) {
      const name = get(values, 'name');
      const mda = get(values, 'responsibleMda');
      if (!name || !mda) { rejected.push({ line, message: 'name and responsibleMda are required.' }); continue; }
      const alloc = money(line, values, 'approvedAllocation');
      const contract = money(line, values, 'contractValue');
      const spent = money(line, values, 'reportedExpenditure');
      if (!alloc.ok || !contract.ok || !spent.ok) continue;
      const statusRaw = (get(values, 'status') || 'PLANNED').toUpperCase();
      if (!(PROJECT_STATUSES as readonly string[]).includes(statusRaw)) {
        rejected.push({ line, message: `status "${statusRaw}" is not one of ${PROJECT_STATUSES.join(', ')}.` });
        continue;
      }
      const lgaRaw = get(values, 'lga');
      const lga = lgaRaw ? resolveLga(lgaRaw) : null;
      if (lgaRaw && !lga) { rejected.push({ line, message: `"${lgaRaw}" is not a Plateau LGA.` }); continue; }
      const progressRaw = get(values, 'physicalProgress');
      const progress = progressRaw === '' ? null : Number(progressRaw);
      if (progress !== null && (!Number.isInteger(progress) || progress < 0 || progress > 100)) {
        rejected.push({ line, message: `physicalProgress "${progressRaw}" must be a whole number 0–100.` });
        continue;
      }
      const yearRaw = get(values, 'fiscalYear');
      data.push({
        organizationId,
        name,
        responsibleMda: mda,
        projectCode: get(values, 'projectCode') || null,
        fiscalYear: yearRaw ? Number(yearRaw) || null : null,
        lga,
        ward: get(values, 'ward') || null,
        community: get(values, 'community') || null,
        approvedAllocation: alloc.value,
        contractValue: contract.value,
        contractor: get(values, 'contractor') || null,
        reportedExpenditure: spent.value,
        status: statusRaw,
        physicalProgress: progress,
        startDate: date(get(values, 'startDate')),
        expectedCompletion: date(get(values, 'expectedCompletion')),
        sourceUrl: get(values, 'sourceUrl') || null,
        sourceDocument: get(values, 'sourceDocument') || null,
        createdByUserId: userId,
      });
    }
    if (data.length) await prisma.governmentProject.createMany({ data });
    return { imported: data.length, rejected };
  }

  async approveProject(organizationId: string, id: string, actor: Actor) {
    const p = await prisma.governmentProject.findFirst({ where: { id, organizationId } });
    if (!p) throw new NotFoundException('Project not found.');
    if (p.publicationStatus !== 'DRAFT') throw new ConflictException(`This project is already ${p.publicationStatus.toLowerCase()}.`);
    if (p.createdByUserId && p.createdByUserId === actor.userId) {
      throw new ForbiddenException('The officer who added a project cannot also approve it. Ask another administrator.');
    }
    if (!p.sourceUrl && !p.sourceDocument) {
      throw new BadRequestException('A project needs a source (URL or document) before it can be published.');
    }
    const now = new Date();
    const updated = await prisma.governmentProject.update({
      where: { id },
      data: { publicationStatus: 'APPROVED', approvedByUserId: actor.userId, approvedAt: now, verifiedAt: now },
    });
    await recordAgencyAudit(actor, organizationId, {
      action: 'project.approved',
      targetType: 'GovernmentProject',
      targetId: id,
      newValue: { name: p.name, status: p.status },
    });
    return updated;
  }

  async markObservationReferred(organizationId: string, id: string) {
    const o = await prisma.projectObservation.findFirst({ where: { id, organizationId } });
    if (!o) throw new NotFoundException('Observation not found.');
    return prisma.projectObservation.update({ where: { id }, data: { referred: true } });
  }
}
