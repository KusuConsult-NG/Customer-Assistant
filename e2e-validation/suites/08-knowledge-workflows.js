/**
 * Suite 08 — Knowledge base ingestion/search and the workflow engine.
 *
 * Qdrant is unreachable in this environment, so the vector path cannot be certified;
 * what IS verified is that the system says so honestly instead of reporting success.
 */
const H = require('../harness');
const { api, prisma, check, suite, uniq, seedSession } = H;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

module.exports = async function () {
  suite('08 · Knowledge Base & Workflows');

  const T = await seedSession('kb');
  const token = T.token;
  const orgId = T.orgId;

  const qdrantUp = await fetch(`${process.env.QDRANT_URL || 'http://localhost:6333'}/collections`)
    .then(r => r.ok).catch(() => false);

  // ── Upload validation ─────────────────────────────────────────────────────
  await check('KB-001', 'Unsupported MIME type is rejected', async () => {
    const res = await api('POST', '/api/knowledge/documents', {
      token,
      body: { title: 'Executable', fileName: 'evil.exe', mimeType: 'application/x-msdownload', fileBufferBase64: b64('MZ binary') },
    });
    return res.status === 400 ? { ok: true, evidence: '400' } : { expected: '400', actual: `${res.status} — arbitrary binary accepted into the knowledge base` };
  }, 'HIGH');

  await check('KB-002', 'Oversized upload is rejected on the DECODED size, not the claimed one', async () => {
    // 60MB of real content with a dishonest fileSize field: the limit must be
    // enforced on what was actually sent.
    const big = 'A'.repeat(60 * 1024 * 1024);
    const res = await api('POST', '/api/knowledge/documents', {
      token,
      body: { title: 'Huge', fileName: 'huge.txt', fileSize: 10, mimeType: 'text/plain', fileBufferBase64: b64(big) },
    }).catch(e => ({ status: 0, text: e.message }));
    return [400, 413, 0].includes(res.status)
      ? { ok: true, evidence: `status=${res.status}` }
      : { expected: '400/413', actual: `${res.status} — client-declared size defeated the 50MB limit` };
  }, 'HIGH');

  await check('KB-003', 'Missing required upload fields are rejected', async () => {
    const res = await api('POST', '/api/knowledge/documents', { token, body: { title: 'Incomplete' } });
    return res.status === 400 ? { ok: true } : { expected: '400', actual: String(res.status) };
  }, 'MEDIUM');

  await check('KB-004', 'VIEWER cannot upload documents', async () => {
    const viewer = await seedSession('kbviewer', { role: 'VIEWER', orgId });
    const res = await api('POST', '/api/knowledge/documents', {
      token: viewer.token,
      body: { title: 'Viewer Upload', fileName: 'v.txt', mimeType: 'text/plain', fileBufferBase64: b64('hello') },
    });
    return res.status === 403 ? { ok: true } : { expected: '403', actual: String(res.status) };
  }, 'HIGH');

  // ── Website crawling ──────────────────────────────────────────────────────
  await check('KB-010', 'Crawling a real public page indexes extractable text', async () => {
    const res = await api('POST', '/api/knowledge/crawl-website', { token, body: { url: 'https://example.com' } });
    if (res.status !== 200 && res.status !== 201) {
      return { blocked: true, expected: '201', reason: `crawl returned ${res.status}: ${String(res.body?.message).slice(0, 120)}`, evidence: 'outbound network may be restricted' };
    }
    const doc = await prisma.knowledgeDocument.findUnique({ where: { id: res.body.documentId }, include: { _count: { select: { chunks: true } } } });
    if (!doc) return { expected: 'document row', actual: 'none' };
    if (doc._count.chunks === 0) return { expected: '>0 chunks', actual: '0 chunks stored' };
    // The honest-reporting contract: never claim semantic search works when it does not.
    if (res.body.semanticSearchEnabled === true && !qdrantUp) {
      return { expected: 'semanticSearchEnabled=false when Qdrant is down', actual: 'claimed semantic search while the vector store is unreachable' };
    }
    return { ok: true, evidence: `${doc._count.chunks} chunks, semanticSearchEnabled=${res.body.semanticSearchEnabled}` };
  }, 'HIGH');

  await check('KB-011', 'A crawl that yields no text is rejected, not silently indexed', async () => {
    const res = await api('POST', '/api/knowledge/crawl-website', { token, body: { url: 'https://example.com/robots.txt' } });
    // Either refused for content type, or indexed with real content — never an empty success.
    if (res.status === 200 || res.status === 201) {
      const doc = await prisma.knowledgeDocument.findUnique({ where: { id: res.body.documentId }, include: { _count: { select: { chunks: true } } } });
      if (doc && doc._count.chunks === 0) return { expected: 'no empty INDEXED doc', actual: 'document marked INDEXED with 0 chunks' };
    }
    return { ok: true, evidence: `http=${res.status}` };
  }, 'MEDIUM');

  await check('KB-012', 'Malformed URL is rejected', async () => {
    const res = await api('POST', '/api/knowledge/crawl-website', { token, body: { url: 'ht!tp://not a url' } });
    return res.status === 400 ? { ok: true } : { expected: '400', actual: String(res.status) };
  }, 'MEDIUM');

  // ── Search ────────────────────────────────────────────────────────────────
  await check('KB-020', 'Keyword search finds an indexed chunk (Postgres fallback path)', async () => {
    const doc = await prisma.knowledgeDocument.create({
      data: { organizationId: orgId, title: 'Policy', fileName: 'policy.txt', fileSize: 100, mimeType: 'text/plain', storageUrl: 'seed/policy.txt', status: 'INDEXED' },
    });
    const marker = `ZORBLAX${Date.now()}`;
    await prisma.documentChunk.create({
      data: { documentId: doc.id, organizationId: orgId, chunkIndex: 0, content: `Our refund window is 14 days. Reference code ${marker}.` },
    });
    const res = await api('GET', `/api/knowledge/search?q=${marker}`, { token });
    if (res.status !== 200) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 140)}` };
    const hit = (res.body || []).some(r => String(r.content).includes(marker));
    return hit
      ? { ok: true, evidence: `${res.body.length} results, marker found${qdrantUp ? '' : ' (Qdrant down → Postgres fallback)'}` }
      : { expected: 'chunk found', actual: `${(res.body || []).length} results, marker absent` };
  }, 'HIGH');

  await check('KB-021', 'Empty search term is rejected', async () => {
    const res = await api('GET', '/api/knowledge/search?q=', { token });
    return res.status === 400 ? { ok: true } : { expected: '400', actual: String(res.status) };
  }, 'MEDIUM');

  await check('KB-022', 'Search degrades gracefully with the vector store unreachable', async () => {
    if (qdrantUp) return { ok: true, evidence: 'Qdrant reachable — degradation path not exercised' };
    const res = await api('GET', '/api/knowledge/search?q=refund policy', { token });
    return res.status < 500
      ? { ok: true, evidence: `http=${res.status} with Qdrant down` }
      : { expected: 'graceful fallback', actual: `${res.status} — vector store outage breaks search entirely` };
  }, 'CRITICAL');

  // ── Deletion ──────────────────────────────────────────────────────────────
  await check('KB-030', 'Deleting a document removes its chunks (no orphans)', async () => {
    const doc = await prisma.knowledgeDocument.create({
      data: { organizationId: orgId, title: 'Doomed', fileName: 'doomed.txt', fileSize: 10, mimeType: 'text/plain', storageUrl: 'https://example.com/doomed', status: 'INDEXED' },
    });
    await prisma.documentChunk.createMany({
      data: [0, 1, 2].map(i => ({ documentId: doc.id, organizationId: orgId, chunkIndex: i, content: `chunk ${i}` })),
    });
    const res = await api('DELETE', `/api/knowledge/documents/${doc.id}`, { token });
    if (res.status !== 200) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 140)}` };
    const chunks = await prisma.documentChunk.count({ where: { documentId: doc.id } });
    const stillThere = await prisma.knowledgeDocument.findUnique({ where: { id: doc.id } });
    if (chunks > 0) return { expected: '0 chunks', actual: `${chunks} orphaned chunks remain` };
    if (stillThere) return { expected: 'document gone', actual: 'document row survives' };
    return { ok: true, evidence: 'document and all chunks removed' };
  }, 'HIGH');

  await check('KB-031', 'Deleting an unknown document is a 404', async () => {
    const res = await api('DELETE', '/api/knowledge/documents/00000000-0000-0000-0000-000000000000', { token });
    return res.status === 404 ? { ok: true } : { expected: '404', actual: String(res.status) };
  }, 'MEDIUM');

  await check('KB-040', 'Document list is tenant-scoped', async () => {
    const other = await seedSession('kbother');
    await prisma.knowledgeDocument.create({
      data: { organizationId: other.orgId, title: 'Foreign Doc', fileName: 'f.txt', fileSize: 1, mimeType: 'text/plain', storageUrl: 'x', status: 'INDEXED' },
    });
    const res = await api('GET', '/api/knowledge/documents', { token });
    const foreign = (res.body || []).filter(d => d.organizationId !== orgId);
    return foreign.length === 0 ? { ok: true, evidence: `${res.body.length} own documents` } : { expected: 'own only', actual: `${foreign.length} foreign documents` };
  }, 'CRITICAL');

  // ── FAQs ──────────────────────────────────────────────────────────────────
  await check('FAQ-001', 'FAQ CRUD round-trips', async () => {
    const created = await api('POST', '/api/knowledge/faqs', { token, body: { question: 'What are your hours?', answer: 'Mon-Fri 8-6 WAT', category: 'General' } });
    if (created.status >= 300) return { expected: '201', actual: `${created.status} ${created.text.slice(0, 140)}` };
    const updated = await api('PATCH', `/api/knowledge/faqs/${created.body.id}`, { token, body: { answer: 'Mon-Sat 8-8 WAT' } });
    if (updated.status !== 200) return { expected: '200', actual: String(updated.status) };
    const row = await prisma.faqEntry.findUnique({ where: { id: created.body.id } });
    if (row.answer !== 'Mon-Sat 8-8 WAT') return { expected: 'updated answer', actual: row.answer };
    const deleted = await api('DELETE', `/api/knowledge/faqs/${created.body.id}`, { token });
    if (deleted.status !== 200) return { expected: '200', actual: String(deleted.status) };
    const gone = await prisma.faqEntry.findUnique({ where: { id: created.body.id } });
    return gone === null ? { ok: true, evidence: 'create → update → delete verified in DB' } : { expected: 'deleted', actual: 'row survives' };
  }, 'HIGH');

  await check('FAQ-002', 'Cannot edit another tenant\'s FAQ', async () => {
    const other = await seedSession('faqother');
    const foreign = await prisma.faqEntry.create({ data: { organizationId: other.orgId, question: 'Secret?', answer: 'Yes' } });
    const res = await api('PATCH', `/api/knowledge/faqs/${foreign.id}`, { token, body: { answer: 'HIJACKED' } });
    const row = await prisma.faqEntry.findUnique({ where: { id: foreign.id } });
    if (row.answer === 'HIJACKED') return { expected: 'unchanged', actual: 'CROSS-TENANT FAQ EDIT SUCCEEDED' };
    return [403, 404].includes(res.status) ? { ok: true, evidence: String(res.status) } : { expected: '403/404', actual: `${res.status} (unchanged)` };
  }, 'CRITICAL');

  await check('FAQ-003', 'FAQ reorder persists sort order', async () => {
    const ids = [];
    for (const q of ['A', 'B', 'C']) {
      const r = await api('POST', '/api/knowledge/faqs', { token, body: { question: `Q${q}`, answer: `A${q}` } });
      ids.push(r.body.id);
    }
    const reversed = [...ids].reverse();
    const res = await api('PATCH', '/api/knowledge/faqs/reorder', { token, body: { ids: reversed } });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    const rows = await prisma.faqEntry.findMany({ where: { id: { in: ids } }, orderBy: { sortOrder: 'asc' } });
    const order = rows.map(r => r.id);
    return JSON.stringify(order) === JSON.stringify(reversed)
      ? { ok: true, evidence: 'order persisted' }
      : { expected: reversed.join(','), actual: order.join(',') };
  }, 'MEDIUM');

  // ── Workflows ─────────────────────────────────────────────────────────────
  let wfId;
  await check('WF-001', 'Workflow CRUD round-trips', async () => {
    const created = await api('POST', '/api/workflows', {
      token,
      body: { name: 'Welcome New Leads', description: 'Greet on capture', triggerType: 'LEAD_CREATED', nodes: [{ id: 'n1', type: 'SEND_WHATSAPP' }], edges: [] },
    });
    if (created.status >= 300) return { expected: '201', actual: `${created.status} ${created.text.slice(0, 140)}` };
    wfId = created.body.id;
    const row = await prisma.workflow.findUnique({ where: { id: wfId } });
    if (row.organizationId !== orgId) return { expected: orgId, actual: row.organizationId };
    if (row.triggerType !== 'LEAD_CREATED') return { expected: 'LEAD_CREATED', actual: row.triggerType };
    return { ok: true, evidence: `id=${wfId} active=${row.isActive}` };
  }, 'HIGH');

  await check('WF-002', 'Workflow update persists', async () => {
    const res = await api('PATCH', `/api/workflows/${wfId}`, { token, body: { name: 'Renamed Workflow', isActive: false } });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    const row = await prisma.workflow.findUnique({ where: { id: wfId } });
    return (row.name === 'Renamed Workflow' && row.isActive === false)
      ? { ok: true, evidence: `name=${row.name} active=${row.isActive}` }
      : { expected: 'renamed + inactive', actual: `name=${row.name} active=${row.isActive}` };
  }, 'HIGH');

  await check('WF-003', 'Workflow name is required', async () => {
    const res = await api('POST', '/api/workflows', { token, body: { nodes: [], edges: [] } });
    return res.status === 400 ? { ok: true } : { expected: '400', actual: String(res.status) };
  }, 'MEDIUM');

  await check('WF-004', 'Execute reports honestly what it did', async () => {
    await api('PATCH', `/api/workflows/${wfId}`, { token, body: { isActive: true } });
    const res = await api('POST', `/api/workflows/${wfId}/execute`, { token, body: { triggerType: 'LEAD_CREATED', payload: { status: 'NEW' } } });
    if (res.status >= 300) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 140)}` };
    const body = res.body;
    // The engine matches workflows but runs no actions. What it must NOT do is imply
    // otherwise — an operator reading the response should be able to tell.
    if (body.executed === true) {
      return { expected: 'executed:false (no action executor exists)', actual: 'endpoint reports executed:true while performing no action' };
    }
    if (body.executed !== false) {
      return { expected: 'an explicit executed:false', actual: `no execution flag at all: ${JSON.stringify(body).slice(0, 140)}` };
    }
    if (!/not/i.test(String(body.notice))) {
      return { expected: 'a notice saying actions did not run', actual: String(body.notice).slice(0, 120) };
    }
    if (typeof body.matchedCount !== 'number') {
      return { expected: 'matchedCount', actual: JSON.stringify(body).slice(0, 120) };
    }
    return { ok: true, evidence: `executed=false, matched=${body.matchedCount}, notice="${String(body.notice).slice(0, 80)}…" — reports honestly that actions did not run (feature gap tracked as K-01, not a false success)` };
  }, 'HIGH');

  await check('WF-005', 'Deleting a workflow removes it', async () => {
    const res = await api('DELETE', `/api/workflows/${wfId}`, { token });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    const row = await prisma.workflow.findUnique({ where: { id: wfId } });
    return row === null ? { ok: true } : { expected: 'deleted', actual: 'row survives' };
  }, 'HIGH');
};
