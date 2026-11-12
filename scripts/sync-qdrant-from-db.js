const path = require('path');
require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));
const { PrismaClient } = require('@prisma/client');
const { QdrantRAGService } = require(path.join(__dirname, '..', 'packages', 'orchestrator', 'dist', 'index.js'));

const prisma = new PrismaClient();
const rag = new QdrantRAGService();

async function main() {
  console.log('1. Connecting to DB...');
  const org = await prisma.organization.findFirst({ where: { slug: 'plaschema' } });
  if (!org) throw new Error('Org not found');
  console.log(`Found org: ${org.name} (${org.id})`);

  console.log('2. Fetching all document chunks from PostgreSQL...');
  const chunks = await prisma.documentChunk.findMany({
    where: { organizationId: org.id },
    select: { id: true, documentId: true, chunkIndex: true, content: true },
    orderBy: [{ documentId: 'asc' }, { chunkIndex: 'asc' }],
  });
  console.log(`Found ${chunks.length} chunks in PostgreSQL.`);

  console.log('3. Deleting stale collection in Qdrant...');
  const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
  const apiKey = process.env.QDRANT_API_KEY;
  const headers = {};
  if (apiKey) headers['api-key'] = apiKey;

  try {
    const delRes = await fetch(`${qdrantUrl}/collections/org_${org.id}`, {
      method: 'DELETE',
      headers,
    });
    console.log('Delete status:', delRes.status);
  } catch (e) {
    console.warn('Delete collection error (non-fatal):', e.message);
  }

  console.log('4. Embedding and upserting chunks into Qdrant...');
  const points = chunks.map((c) => ({
    chunkId: c.id,
    documentId: c.documentId,
    chunkIndex: c.chunkIndex,
    content: c.content,
  }));

  await rag.upsertChunks(org.id, points);
  console.log(`✓ Successfully synced ${points.length} chunks into Qdrant!`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
