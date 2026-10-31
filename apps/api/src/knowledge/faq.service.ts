import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { prisma } from '@ace/database';

@Injectable()
export class FaqService {
  async getFaqs(organizationId: string) {
    return prisma.faqEntry.findMany({
      where: { organizationId },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async createFaq(organizationId: string, data: { question: string; answer: string; category?: string }) {
    const count = await prisma.faqEntry.count({ where: { organizationId } });
    return prisma.faqEntry.create({
      data: {
        organizationId,
        question: data.question,
        answer: data.answer,
        category: data.category,
        sortOrder: count,
      },
    });
  }

  async updateFaq(organizationId: string, id: string, data: { question?: string; answer?: string; category?: string }) {
    // First verify this FAQ belongs to the org (security check)
    const existing = await prisma.faqEntry.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('FAQ entry not found');
    if (existing.organizationId !== organizationId) throw new ForbiddenException('Access denied');

    return prisma.faqEntry.update({
      where: { id },   // Prisma requires unique field only in where for update
      data,
    });
  }

  async deleteFaq(organizationId: string, id: string) {
    const existing = await prisma.faqEntry.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('FAQ entry not found');
    if (existing.organizationId !== organizationId) throw new ForbiddenException('Access denied');

    return prisma.faqEntry.delete({ where: { id } });
  }

  /**
   * Set the order the AI consults these FAQs in.
   *
   * ── This is not cosmetic ───────────────────────────────────────────────────
   *
   * The orchestrator reads FAQs `orderBy: sortOrder asc` and keeps the first
   * entry on a tie — `overlap > best.overlap`, strictly — so when two FAQs
   * match a citizen's question equally well, POSITION DECIDES WHICH ANSWER
   * THEY GET. It is the only lever an agency has over that.
   *
   * ── Why the whole list is required ────────────────────────────────────────
   *
   * `sortOrder` is a position, not a label. A partial list assigns 0…k-1 to a
   * subset while every other row keeps the value it already had, so two FAQs
   * end up at position 0 and the tie-break that decides what a citizen is told
   * becomes arbitrary. The previous version accepted any subset: ids that
   * matched nothing updated no rows and it still returned `{success: true}`,
   * which is reporting a change that did not happen.
   */
  async reorderFaqs(organizationId: string, ids: string[]) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new BadRequestException('Provide the FAQ ids in the order you want them consulted.');
    }

    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('The same FAQ appears more than once in that order.');
    }

    const owned = await prisma.faqEntry.findMany({
      where: { organizationId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((f) => f.id));

    // Named rather than counted: an operator reordering a stale page needs to
    // know WHICH entry is no longer there.
    const foreign = ids.filter((id) => !ownedIds.has(id));
    if (foreign.length > 0) {
      throw new NotFoundException(
        `These FAQ entries do not belong to this agency, or no longer exist: ${foreign.join(', ')}. Reload the list and try again.`
      );
    }

    if (ids.length !== ownedIds.size) {
      const missing = owned.filter((f) => !ids.includes(f.id)).map((f) => f.id);
      throw new BadRequestException(
        `A reorder has to cover every FAQ, because the order is a position rather than a rank — leaving ${missing.length} out would put two entries in the same place and make the tie-break arbitrary. Missing: ${missing.join(', ')}.`
      );
    }

    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.faqEntry.updateMany({
          where: { id, organizationId }, // updateMany allows compound where
          data: { sortOrder: index },
        })
      )
    );

    return { success: true, ordered: ids.length };
  }
}
