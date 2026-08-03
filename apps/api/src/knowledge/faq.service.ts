import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
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

  async reorderFaqs(organizationId: string, ids: string[]) {
    const transactions = ids.map((id, index) =>
      prisma.faqEntry.updateMany({
        where: { id, organizationId }, // updateMany allows compound where
        data: { sortOrder: index },
      })
    );
    await prisma.$transaction(transactions);
    return { success: true };
  }
}
