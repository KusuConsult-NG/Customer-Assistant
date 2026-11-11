import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma, recordAgencyAudit, type Actor } from '@ace/database';

/**
 * Knowledge governance (PRD §12): source and verification metadata,
 * approval by a second person, withdrawal, review deadlines, and the list of
 * questions citizens asked that nothing approved could answer.
 *
 * Only APPROVED documents answer citizens — the conversation engine filters
 * every search result against `publicationStatus` (`onlyPublished`), so a
 * withdrawn document stops answering at once even though its vectors are
 * still in Qdrant.
 */
@Injectable()
export class KnowledgeGovernanceService {
  private async own(organizationId: string, id: string) {
    const d = await prisma.knowledgeDocument.findFirst({ where: { id, organizationId } });
    if (!d) throw new NotFoundException('Document not found.');
    return d;
  }

  private date(v: string | undefined, field: string) {
    if (v === undefined) return undefined;
    if (v === '') return null;
    if (Number.isNaN(Date.parse(v))) throw new BadRequestException(`${field} is not a date.`);
    return new Date(v);
  }

  async updateMetadata(
    organizationId: string,
    id: string,
    body: { sourceUrl?: string; mdaOwner?: string; publishedAt?: string; effectiveDate?: string; reviewDueAt?: string },
  ) {
    await this.own(organizationId, id);
    if (body.sourceUrl && !/^https?:\/\//i.test(body.sourceUrl)) throw new BadRequestException('sourceUrl must be a web address.');
    const publishedAt = this.date(body.publishedAt, 'publishedAt');
    const effectiveDate = this.date(body.effectiveDate, 'effectiveDate');
    const reviewDueAt = this.date(body.reviewDueAt, 'reviewDueAt');
    return prisma.knowledgeDocument.update({
      where: { id },
      data: {
        ...(body.sourceUrl !== undefined ? { sourceUrl: body.sourceUrl || null } : {}),
        ...(body.mdaOwner !== undefined ? { mdaOwner: body.mdaOwner || null } : {}),
        ...(publishedAt !== undefined ? { publishedAt } : {}),
        ...(effectiveDate !== undefined ? { effectiveDate } : {}),
        ...(reviewDueAt !== undefined ? { reviewDueAt } : {}),
      },
    });
  }

  async approve(organizationId: string, id: string, actor: Actor) {
    const d = await this.own(organizationId, id);
    if (d.publicationStatus === 'APPROVED') throw new ConflictException('This document is already approved.');
    if (d.createdByUserId && d.createdByUserId === actor.userId) {
      throw new ForbiddenException('The officer who added a document cannot also approve it. Ask another administrator.');
    }
    if (d.status === 'FAILED') throw new BadRequestException('This document could not be read, so there is nothing to approve. Upload it again.');
    const now = new Date();
    const updated = await prisma.knowledgeDocument.update({
      where: { id },
      data: { publicationStatus: 'APPROVED', approvedByUserId: actor.userId, approvedAt: now, verifiedAt: now, version: d.publicationStatus === 'WITHDRAWN' ? { increment: 1 } : undefined },
    });
    await recordAgencyAudit(actor, organizationId, {
      action: 'knowledge.document.approved',
      targetType: 'KnowledgeDocument',
      targetId: id,
      previousValue: { publicationStatus: d.publicationStatus },
      newValue: { title: d.title, publicationStatus: 'APPROVED' },
    });
    return updated;
  }

  async withdraw(organizationId: string, id: string, actor: Actor, reason: string) {
    const d = await this.own(organizationId, id);
    if (!reason?.trim()) throw new BadRequestException('Say why it is being withdrawn.');
    if (d.publicationStatus === 'WITHDRAWN') throw new ConflictException('Already withdrawn.');
    const updated = await prisma.knowledgeDocument.update({ where: { id }, data: { publicationStatus: 'WITHDRAWN' } });
    await recordAgencyAudit(actor, organizationId, {
      action: 'knowledge.document.withdrawn',
      targetType: 'KnowledgeDocument',
      targetId: id,
      previousValue: { publicationStatus: d.publicationStatus },
      newValue: { publicationStatus: 'WITHDRAWN', reason: reason.trim() },
    });
    return updated;
  }

  listGaps(organizationId: string, status?: string) {
    const valid = ['OPEN', 'ASSIGNED', 'RESOLVED', 'DISMISSED'];
    return prisma.knowledgeGap.findMany({
      where: { organizationId, ...(status && valid.includes(status) ? { status: status as any } : { status: { in: ['OPEN', 'ASSIGNED'] } }) },
      orderBy: [{ count: 'desc' }, { lastAskedAt: 'desc' }],
      take: 200,
    });
  }

  async updateGap(organizationId: string, id: string, body: { status?: string; resolution?: string; assignedUserId?: string | null }) {
    const g = await prisma.knowledgeGap.findFirst({ where: { id, organizationId } });
    if (!g) throw new NotFoundException('Not found.');
    if (body.status === 'RESOLVED' && !(body.resolution ?? g.resolution)?.trim()) {
      throw new BadRequestException('Say where the answer now lives (e.g. the document or FAQ you published).');
    }
    if (body.assignedUserId) {
      const m = await prisma.user.findFirst({ where: { id: body.assignedUserId, organizationId, isActive: true } });
      if (!m) throw new BadRequestException('That officer is not an active member of this agency.');
    }
    return prisma.knowledgeGap.update({
      where: { id },
      data: {
        ...(body.status ? { status: body.status as any } : {}),
        ...(body.resolution !== undefined ? { resolution: body.resolution || null } : {}),
        ...(body.assignedUserId !== undefined ? { assignedUserId: body.assignedUserId || null, ...(body.assignedUserId && !body.status ? { status: 'ASSIGNED' as any } : {}) } : {}),
      },
    });
  }
}
