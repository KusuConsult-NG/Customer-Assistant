/**
 * Deleting a document has to mean the assistant stops quoting it.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * The vectors were removed inside a `try` whose `catch` logged a warning and
 * carried on. The row was then deleted regardless, the operator was told
 * "removed from knowledge base and storage", and the orphaned vectors kept
 * being retrieved — still answering citizens with whatever the agency had just
 * decided was wrong enough to delete, and now with nothing in the dashboard
 * left to point at.
 *
 * That is the no-fabrication rule applied to a delete: a confirmation is a
 * statement about the world, and this one was not true whenever the vector
 * store was unreachable.
 */
import { Test } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { prisma } from '@ace/database';
import { randomBytes } from 'crypto';
import { KnowledgeModule } from '../src/knowledge/knowledge.module';
import { WorkflowTriggerModule } from '../src/workflows/workflow-trigger.module';
import { KnowledgeService } from '../src/knowledge/knowledge.service';
import { QdrantRAGService } from '@ace/orchestrator';

describe('deleting a knowledge document', () => {
  let service: KnowledgeService;
  let orgId: string;
  let rag: QdrantRAGService;
  // `recordAgencyAudit` requires a real actor — an audit record that cannot
  // name who acted is not an audit record — so the fixture is a real member.
  let actor: any;

  jest.setTimeout(60000);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkflowTriggerModule, KnowledgeModule],
    }).compile();
    service = moduleRef.get(KnowledgeService);
    // `ragService` is constructed by the service itself rather than injected,
    // so it is reached through the instance rather than the Nest container.
    rag = (service as any).ragService as QdrantRAGService;

    const org = await prisma.organization.create({
      data: {
        name: 'Knowledge Delete',
        slug: `kdel-${randomBytes(4).toString('hex')}`,
        industry: 'GOVERNMENT',
      },
    });
    orgId = org.id;
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `kdel-${randomBytes(4).toString('hex')}@mda.test`,
        passwordHash: 'x',
        fullName: 'Knowledge Admin',
        role: 'ADMIN',
      },
    });
    actor = { userId: user.id, email: user.email };
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  });

  const seedDoc = (chunkCount: number) =>
    prisma.knowledgeDocument.create({
      data: {
        organizationId: orgId,
        title: 'Levy schedule 2026',
        fileName: 'levies.pdf',
        fileSize: 4096,
        mimeType: 'application/pdf',
        // Not an http URL, so the storage delete path is exercised too.
        storageUrl: `knowledge/${orgId}/levies.pdf`,
        status: 'INDEXED',
        chunkCount,
      },
    });

  it('refuses, and says so, when the indexed text cannot be removed', async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-embeddings-configured';
    const doc = await seedDoc(12);

    const spy = jest
      .spyOn(rag, 'deleteDocumentVectors')
      .mockRejectedValue(new Error('Qdrant delete failed (503): upstream unavailable'));

    try {
      await expect(service.deleteDocument(orgId, doc.id, actor)).rejects.toBeInstanceOf(
        ServiceUnavailableException
      );

      // The document is STILL THERE, which is the whole point: the dashboard
      // and the index agree, and the operator can try again.
      const still = await prisma.knowledgeDocument.findUnique({ where: { id: doc.id } });
      expect(still).not.toBeNull();
    } finally {
      spy.mockRestore();
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      await prisma.knowledgeDocument.delete({ where: { id: doc.id } }).catch(() => {});
    }
  });

  it('names the document and says retrying is safe', async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-embeddings-configured';
    const doc = await seedDoc(3);
    const spy = jest
      .spyOn(rag, 'deleteDocumentVectors')
      .mockRejectedValue(new Error('connect ECONNREFUSED'));

    try {
      await service.deleteDocument(orgId, doc.id, actor);
      throw new Error('expected a refusal');
    } catch (e: any) {
      expect(e.message).toContain('Levy schedule 2026');
      expect(e.message).toMatch(/was NOT deleted/i);
      expect(e.message).toMatch(/repeating this is safe/i);
    } finally {
      spy.mockRestore();
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      await prisma.knowledgeDocument.delete({ where: { id: doc.id } }).catch(() => {});
    }
  });

  it('still deletes a document that was never indexed', async () => {
    // A deployment on the Postgres fallback has no Qdrant to reach. Refusing
    // here would mean it could never remove a document at all.
    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const doc = await seedDoc(0);
    const spy = jest
      .spyOn(rag, 'deleteDocumentVectors')
      .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6333'));

    try {
      const res = await service.deleteDocument(orgId, doc.id, actor);
      expect(res.success).toBe(true);
      expect(await prisma.knowledgeDocument.findUnique({ where: { id: doc.id } })).toBeNull();
    } finally {
      spy.mockRestore();
      if (previousKey !== undefined) process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it('deletes cleanly when the vectors do go', async () => {
    const doc = await seedDoc(7);
    const spy = jest.spyOn(rag, 'deleteDocumentVectors').mockResolvedValue(undefined);
    try {
      const res = await service.deleteDocument(orgId, doc.id, actor);
      expect(res.success).toBe(true);
      expect(spy).toHaveBeenCalledWith(orgId, doc.id);
      expect(await prisma.knowledgeDocument.findUnique({ where: { id: doc.id } })).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
