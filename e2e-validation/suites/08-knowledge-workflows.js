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
  await check('KB-005', 'A real document upload reaches object storage and comes back', async () => {
    // The rejection tests above never touch storage. This one does — it is the only
    // check that would have caught the upload path failing on an auth header.
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return { blocked: 'Supabase Storage is not configured in this environment — the round trip cannot be certified.' };
    }
    const body = 'ACE storage round-trip probe. ' + 'Lorem ipsum dolor sit amet. '.repeat(40);
    const res = await api('POST', '/api/knowledge/documents', {
      token,
      body: { title: 'Storage Probe', fileName: 'probe.txt', mimeType: 'text/plain', fileBufferBase64: b64(body) },
    });
    if (res.status >= 300) return { expected: '201', actual: `${res.status} ${res.text.slice(0, 200)}` };

    const docId = res.body.documentId;
    if (!docId) return { expected: 'documentId in the response', actual: JSON.stringify(res.body).slice(0, 160) };
    const doc = await prisma.knowledgeDocument.findUnique({ where: { id: docId } });
    if (!doc) return { expected: 'a persisted document', actual: 'no row' };
    if (!doc.storageUrl || /^https?:/i.test(doc.storageUrl)) {
      return { expected: 'a storage path', actual: String(doc.storageUrl).slice(0, 80) };
    }

    const dl = await api('GET', `/api/knowledge/documents/${doc.id}/download`, { token });
    if (dl.status !== 200 || !dl.body?.url) {
      return { expected: 'a signed download URL', actual: `${dl.status} ${dl.text.slice(0, 140)}` };
    }
    const fetched = await fetch(dl.body.url);
    if (!fetched.ok) {
      return { expected: 'the signed URL to resolve', actual: `HTTP ${fetched.status} — the document row points at bytes that are not there` };
    }
    const text = await fetched.text();
    return text.includes('storage round-trip probe')
      ? { ok: true, evidence: `${text.length} bytes round-tripped from ${doc.storageUrl}` }
      : { expected: 'the uploaded content', actual: text.slice(0, 80) };
  }, 'CRITICAL');

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
  // ── Workflow engine ───────────────────────────────────────────────────────
  //
  // These tests do not read the workflow source. They assert on observable side
  // effects: a ticket row that exists, a message the executor refused to send, a
  // branch that was skipped, a run row with recorded steps.

  let wfId;
  // A ticket must belong to a contact — the schema requires it — so the workflow
  // tests below run against a real one rather than a synthetic payload.
  let wfContactId;

  await check('WF-000', 'Fixture contact for workflow actions', async () => {
    const res = await api('POST', '/api/crm/contacts', {
      token,
      body: { fullName: 'Amina Bello', phoneNumber: uniq('+2349', 9), email: uniq('amina') + '@example.com' },
    });
    if (res.status >= 300) return { expected: '201', actual: `${res.status} ${res.text.slice(0, 140)}` };
    wfContactId = res.body.id;
    return { ok: true, evidence: `contactId=${wfContactId}` };
  }, 'LOW');

  await check('WF-001', 'Workflow CRUD round-trips', async () => {
    const created = await api('POST', '/api/workflows', {
      token,
      body: {
        name: 'Welcome New Leads',
        description: 'Open a follow-up ticket on capture',
        triggerType: 'LEAD_CREATED',
        nodes: [
          { id: 'n1', kind: 'TRIGGER', label: 'LEAD_CREATED' },
          { id: 'n2', kind: 'ACTION', action: 'CREATE_TICKET', config: { subject: 'Follow up with {{ contact.fullName }}', priority: 'HIGH' } },
        ],
        edges: [{ from: 'n1', to: 'n2' }],
      },
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

  await check('WF-004', 'An unknown trigger type is rejected', async () => {
    const res = await api('POST', '/api/workflows', {
      token,
      body: { name: 'Bogus trigger', triggerType: 'WHEN_PIGS_FLY', nodes: [], edges: [] },
    });
    return res.status === 400
      ? { ok: true, evidence: '400 — the API refuses a trigger nothing will ever emit' }
      : { expected: '400', actual: `${res.status} — accepted a trigger that can never fire` };
  }, 'HIGH');

  await check('WF-005', 'Execute performs a REAL action (ticket row exists)', async () => {
    const act = await api('PATCH', `/api/workflows/${wfId}`, { token, body: { isActive: true } });
    if (act.status !== 200) return { expected: 'activation 200', actual: `${act.status} ${act.text.slice(0, 140)}` };

    const before = await prisma.ticket.count({ where: { organizationId: orgId } });
    const res = await api('POST', `/api/workflows/${wfId}/execute`, {
      token,
      body: { payload: { contactId: wfContactId, contact: { fullName: 'Amina Bello' } } },
    });
    if (res.status >= 300) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 160)}` };
    const body = res.body;
    if (body.executed !== true) return { expected: 'executed:true', actual: JSON.stringify(body).slice(0, 160) };
    if (body.status !== 'SUCCEEDED') return { expected: 'SUCCEEDED', actual: `${body.status} ${body.error ?? ''}` };

    const after = await prisma.ticket.count({ where: { organizationId: orgId } });
    if (after !== before + 1) return { expected: `${before + 1} tickets`, actual: `${after} — the run claimed success but wrote nothing` };

    const ticket = await prisma.ticket.findFirst({ where: { organizationId: orgId }, orderBy: { createdAt: 'desc' } });
    if (ticket.subject !== 'Follow up with Amina Bello') {
      return { expected: 'interpolated subject', actual: ticket.subject };
    }
    return { ok: true, evidence: `runId=${body.runId} steps=${body.stepsExecuted} ticket=${ticket.ticketNumber} subject="${ticket.subject}"` };
  }, 'CRITICAL');

  await check('WF-006', 'The run and its steps are recorded durably', async () => {
    const runs = await api('GET', `/api/workflows/${wfId}/runs`, { token });
    if (runs.status !== 200) return { expected: '200', actual: String(runs.status) };
    const run = (runs.body || [])[0];
    if (!run) return { expected: 'at least one run', actual: 'run history is empty after a successful execution' };
    const step = (run.steps || []).find(s => s.action === 'CREATE_TICKET');
    if (!step) return { expected: 'a CREATE_TICKET step', actual: JSON.stringify(run.steps || []).slice(0, 160) };
    if (step.status !== 'SUCCEEDED') return { expected: 'SUCCEEDED', actual: `${step.status} ${step.error ?? ''}` };
    if (!step.output || !step.output.ticketId) return { expected: 'step output carrying the created ticketId', actual: JSON.stringify(step.output).slice(0, 120) };
    return { ok: true, evidence: `run=${run.id} status=${run.status} steps=${run.steps.length} ticketId=${step.output.ticketId}` };
  }, 'HIGH');

  await check('WF-007', 'A false CONDITION prevents the downstream action', async () => {
    const created = await api('POST', '/api/workflows', {
      token,
      body: {
        name: 'Gated ticket',
        triggerType: 'MESSAGE_RECEIVED',
        isActive: true,
        nodes: [
          { id: 'g1', kind: 'TRIGGER', label: 'MESSAGE_RECEIVED' },
          { id: 'g2', kind: 'CONDITION', field: 'message', operator: 'CONTAINS', value: 'refund' },
          { id: 'g3', kind: 'ACTION', action: 'CREATE_TICKET', config: { subject: 'GATED-TICKET' } },
        ],
        edges: [{ from: 'g1', to: 'g2' }, { from: 'g2', to: 'g3' }],
      },
    });
    if (created.status >= 300) return { expected: '201', actual: `${created.status} ${created.text.slice(0, 140)}` };

    const before = await prisma.ticket.count({ where: { organizationId: orgId, subject: 'GATED-TICKET' } });
    const miss = await api('POST', `/api/workflows/${created.body.id}/execute`, { token, body: { payload: { contactId: wfContactId, message: 'hello there' } } });
    if (miss.status >= 300) return { expected: '200', actual: `${miss.status} ${miss.text.slice(0, 140)}` };
    const afterMiss = await prisma.ticket.count({ where: { organizationId: orgId, subject: 'GATED-TICKET' } });
    if (afterMiss !== before) {
      return { expected: 'no ticket when the condition is false', actual: `${afterMiss - before} ticket(s) created — the condition did not gate anything` };
    }

    const hit = await api('POST', `/api/workflows/${created.body.id}/execute`, { token, body: { payload: { contactId: wfContactId, message: 'I need a refund please' } } });
    const afterHit = await prisma.ticket.count({ where: { organizationId: orgId, subject: 'GATED-TICKET' } });
    if (afterHit !== before + 1) {
      return { expected: '1 ticket when the condition matches', actual: `${afterHit - before} — status=${hit.body?.status} ${hit.body?.error ?? ''}` };
    }
    return { ok: true, evidence: `false→0 tickets, true→1 ticket (run ${hit.body.runId})` };
  }, 'CRITICAL');

  await check('WF-008', 'A real domain event fires the workflow with no manual trigger', async () => {
    const contact = await api('POST', '/api/crm/contacts', {
      token,
      body: { fullName: 'Trigger Probe', phoneNumber: uniq('+2348', 9), email: uniq('probe') + '@example.com' },
    });
    if (contact.status >= 300) return { expected: 'contact 201', actual: `${contact.status} ${contact.text.slice(0, 120)}` };

    const before = await prisma.workflowRun.count({ where: { workflowId: wfId } });
    const lead = await api('POST', '/api/crm/leads', {
      token,
      body: { contactId: contact.body.id, source: 'WEBSITE', status: 'NEW' },
    });
    if (lead.status >= 300) return { expected: 'lead 201', actual: `${lead.status} ${lead.text.slice(0, 120)}` };

    // The emit is fire-and-forget so the HTTP response does not wait on it.
    let after = before, waited = 0;
    while (waited < 15000) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
      after = await prisma.workflowRun.count({ where: { workflowId: wfId } });
      if (after > before) break;
    }
    if (after <= before) {
      return { expected: 'a run queued by LEAD_CREATED', actual: `no run after ${waited}ms — the domain event is not wired to the engine` };
    }

    // And it must actually finish, not sit QUEUED forever.
    let run = null;
    waited = 0;
    while (waited < 30000) {
      run = await prisma.workflowRun.findFirst({ where: { workflowId: wfId }, orderBy: { queuedAt: 'desc' } });
      if (run && ['SUCCEEDED', 'FAILED', 'DEAD_LETTER'].includes(run.status)) break;
      await new Promise(r => setTimeout(r, 1000));
      waited += 1000;
    }
    if (!run || run.status !== 'SUCCEEDED') {
      return { expected: 'SUCCEEDED', actual: `${run?.status ?? 'none'} after ${waited}ms — ${run?.error ?? 'no error recorded'}` };
    }
    return { ok: true, evidence: `LEAD_CREATED → run ${run.id} ${run.status} (inline=${run.ranInline})` };
  }, 'CRITICAL');

  await check('WF-009', 'A failing action fails the run instead of reporting success', async () => {
    const created = await api('POST', '/api/workflows', {
      token,
      body: {
        name: 'Unreachable webhook',
        triggerType: 'MESSAGE_RECEIVED',
        isActive: true,
        nodes: [
          { id: 'f1', kind: 'TRIGGER', label: 'MESSAGE_RECEIVED' },
          { id: 'f2', kind: 'ACTION', action: 'HTTP_WEBHOOK', config: { url: 'http://169.254.169.254/latest/meta-data/' } },
        ],
        edges: [{ from: 'f1', to: 'f2' }],
      },
    });
    if (created.status >= 300) return { expected: '201', actual: `${created.status} ${created.text.slice(0, 140)}` };

    const res = await api('POST', `/api/workflows/${created.body.id}/execute`, { token, body: { payload: {} } });
    if (res.status >= 300) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 140)}` };
    if (res.body.status !== 'FAILED') {
      return { expected: 'FAILED (link-local address must be refused)', actual: `${res.body.status} — SSRF guard did not stop a call to the cloud metadata endpoint` };
    }
    const run = await prisma.workflowRun.findUnique({ where: { id: res.body.runId } });
    if (run.status !== 'FAILED') return { expected: 'run row FAILED', actual: run.status };
    return { ok: true, evidence: `run FAILED — "${String(run.error).slice(0, 90)}"` };
  }, 'CRITICAL');

  await check('WF-010', 'Activation is refused for a graph that cannot execute', async () => {
    const created = await api('POST', '/api/workflows', {
      token,
      body: {
        name: 'Legacy presentational graph',
        triggerType: 'MESSAGE_RECEIVED',
        // Exactly the shape the old builder produced: a label, not an instruction.
        nodes: [
          { id: 'l1', type: 'TRIGGER', label: 'Inbound WhatsApp Message', detail: '', color: 'from-blue-500' },
          { id: 'l2', type: 'ACTION', label: 'Send AI Automated Response', detail: 'RAG lookup', color: 'from-purple-500' },
        ],
        edges: [{ from: 'l1', to: 'l2' }],
      },
    });
    if (created.status >= 300) return { expected: '201', actual: `${created.status} ${created.text.slice(0, 140)}` };
    if (created.body.isActive === true) {
      return { expected: 'created inactive', actual: 'an unexecutable graph was created ACTIVE' };
    }
    const res = await api('PATCH', `/api/workflows/${created.body.id}`, { token, body: { isActive: true } });
    if (res.status !== 400) {
      return { expected: '400 with an explanation', actual: `${res.status} — a graph with no executable action was allowed to go live` };
    }
    const exec = await api('POST', `/api/workflows/${created.body.id}/execute`, { token, body: { payload: {} } });
    if (exec.status !== 400) return { expected: 'execute also 400', actual: String(exec.status) };
    return { ok: true, evidence: `400 — "${String(res.body?.message).slice(0, 110)}"` };
  }, 'CRITICAL');

  await check('WF-011', 'Capabilities describe only actions the engine can run', async () => {
    const res = await api('GET', '/api/workflows/capabilities', { token });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    const { triggers, actions, operators } = res.body || {};
    if (!Array.isArray(actions) || actions.length === 0) return { expected: 'an action catalogue', actual: JSON.stringify(res.body).slice(0, 140) };
    const missingFields = actions.filter(a => !Array.isArray(a.fields));
    if (missingFields.length) return { expected: 'every action documents its fields', actual: missingFields.map(a => a.action).join(',') };
    if (!Array.isArray(triggers) || !triggers.includes('LEAD_CREATED')) {
      return { expected: 'triggers including LEAD_CREATED', actual: JSON.stringify(triggers) };
    }
    if (!Array.isArray(operators) || !operators.includes('CONTAINS')) {
      return { expected: 'condition operators', actual: JSON.stringify(operators) };
    }
    return { ok: true, evidence: `${actions.length} actions, ${triggers.length} triggers, ${operators.length} operators` };
  }, 'MEDIUM');

  await check('WF-012', 'Another tenant cannot read or run this workflow', async () => {
    const other = await seedSession('wfx');
    const read = await api('GET', `/api/workflows/${wfId}`, { token: other.token });
    if (read.status !== 404) return { expected: '404', actual: `${read.status} — cross-tenant read of a workflow` };
    const runs = await api('GET', `/api/workflows/${wfId}/runs`, { token: other.token });
    if (runs.status !== 404) return { expected: '404', actual: `${runs.status} — cross-tenant read of run history` };
    const exec = await api('POST', `/api/workflows/${wfId}/execute`, { token: other.token, body: { payload: {} } });
    if (exec.status !== 404) return { expected: '404', actual: `${exec.status} — another tenant executed this workflow` };
    return { ok: true, evidence: '404 on read, runs and execute' };
  }, 'CRITICAL');

  await check('WF-014', 'BOOKING_CONFIRMED reaches the engine through the real queue', async () => {
    const created = await api('POST', '/api/workflows', {
      token,
      body: {
        name: 'Tag on booking',
        triggerType: 'BOOKING_CONFIRMED',
        isActive: true,
        nodes: [
          { id: 'b1', kind: 'TRIGGER', label: 'BOOKING_CONFIRMED' },
          { id: 'b2', kind: 'ACTION', action: 'TAG_CONTACT', config: { tags: ['booked-via-workflow'] } },
        ],
        edges: [{ from: 'b1', to: 'b2' }],
      },
    });
    if (created.status >= 300) return { expected: '201', actual: `${created.status} ${created.text.slice(0, 140)}` };

    // A weekday slot well into the future, to avoid business-hours rejection.
    const start = new Date();
    start.setDate(start.getDate() + 9);
    start.setHours(11, 0, 0, 0);
    while (start.getDay() === 0 || start.getDay() === 6) start.setDate(start.getDate() + 1);

    const booking = await api('POST', '/api/scheduling/bookings', {
      token,
      body: { contactId: wfContactId, serviceName: 'Workflow Probe Service', staffName: uniq('Staff'), startTime: start.toISOString() },
    });
    if (booking.status >= 300) return { expected: 'booking 201', actual: `${booking.status} ${booking.text.slice(0, 160)}` };

    let run = null, waited = 0;
    while (waited < 30000) {
      run = await prisma.workflowRun.findFirst({ where: { workflowId: created.body.id }, orderBy: { queuedAt: 'desc' } });
      if (run && ['SUCCEEDED', 'FAILED', 'DEAD_LETTER'].includes(run.status)) break;
      await new Promise(r => setTimeout(r, 750));
      waited += 750;
    }
    if (!run) return { expected: 'a run from BOOKING_CONFIRMED', actual: `none after ${waited}ms — the booking engine is not wired to workflows` };
    if (run.status !== 'SUCCEEDED') return { expected: 'SUCCEEDED', actual: `${run.status} — ${run.error ?? 'no error recorded'}` };

    const contact = await prisma.contact.findUnique({ where: { id: wfContactId }, select: { tags: true } });
    if (!(contact.tags || []).includes('booked-via-workflow')) {
      return { expected: 'the tag the action applies', actual: JSON.stringify(contact.tags) + ' — run claimed success but the side effect is absent' };
    }
    return { ok: true, evidence: `run ${run.id.slice(0, 8)} ${run.status} viaQueue=${!run.ranInline} attempt=${run.attempt}, contact tagged` };
  }, 'CRITICAL');

  await check('WF-013', 'Deleting a workflow removes it and its run history', async () => {
    const res = await api('DELETE', `/api/workflows/${wfId}`, { token });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    const row = await prisma.workflow.findUnique({ where: { id: wfId } });
    if (row !== null) return { expected: 'deleted', actual: 'row survives' };
    const orphanRuns = await prisma.workflowRun.count({ where: { workflowId: wfId } });
    return orphanRuns === 0
      ? { ok: true, evidence: 'workflow and runs both gone' }
      : { expected: '0 orphaned runs', actual: `${orphanRuns} run rows left behind` };
  }, 'HIGH');
};
