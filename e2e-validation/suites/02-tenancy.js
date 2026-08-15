/**
 * Suite 02 — Multi-tenant isolation & access control.
 *
 * The single highest-consequence class of defect in a B2B SaaS: one customer
 * seeing or mutating another customer's data. Every test here uses two REAL
 * organizations and attempts a genuine cross-tenant operation.
 */
const H = require('../harness');
const { api, prisma, check, suite, state, uniq, seedUser, seedSession, loginAs } = H;

module.exports = async function () {
  suite('02 · Multi-Tenant Isolation & RBAC');

  const A = await seedSession('tenantA');
  const B = await seedSession('tenantB');

  // Give each tenant one of every record type.
  const mk = async (t) => {
    const contact = await prisma.contact.create({
      data: { organizationId: t.orgId, fullName: `${t.email} Contact`, phoneNumber: `+234${Math.floor(1e9 + Math.random() * 8e9)}` },
    });
    const lead = await prisma.lead.create({ data: { organizationId: t.orgId, contactId: contact.id, notes: 'seed' } });
    const deal = await prisma.deal.create({ data: { organizationId: t.orgId, contactId: contact.id, title: 'Seed Deal', amount: 100000 } });
    const ticket = await prisma.ticket.create({
      data: { organizationId: t.orgId, contactId: contact.id, ticketNumber: `T-${uniq('x')}`.slice(0, 40), subject: 'Seed', description: 'Seed', updatedAt: new Date() },
    });
    const conversation = await prisma.conversation.create({ data: { organizationId: t.orgId, contactId: contact.id, channel: 'WHATSAPP' } });
    await prisma.message.create({ data: { conversationId: conversation.id, sender: 'CUSTOMER', content: `SECRET-OF-${t.orgId}` } });
    const booking = await prisma.booking.create({
      data: { organizationId: t.orgId, contactId: contact.id, serviceName: 'Seed Service', startTime: new Date(Date.now() + 864e5), endTime: new Date(Date.now() + 864e5 + 18e5) },
    });
    const workflow = await prisma.workflow.create({ data: { organizationId: t.orgId, name: 'Seed WF', nodes: [], edges: [] } });
    const doc = await prisma.knowledgeDocument.create({
      data: { organizationId: t.orgId, title: 'Seed Doc', fileName: 'seed.txt', fileSize: 10, mimeType: 'text/plain', storageUrl: 'seed/path.txt', status: 'INDEXED' },
    });
    return { contact, lead, deal, ticket, conversation, booking, workflow, doc };
  };

  const dataA = await mk(A);
  const dataB = await mk(B);
  state.tenantA = { ...A, data: dataA };
  state.tenantB = { ...B, data: dataB };

  // ── Read isolation ────────────────────────────────────────────────────────
  const readCases = [
    ['TEN-001', 'CRM contacts', '/api/crm/contacts', (body) => (body.data || []).map(x => x.id)],
    ['TEN-002', 'CRM leads', '/api/crm/leads', (body) => (body.data || []).map(x => x.id)],
    ['TEN-003', 'CRM deals', '/api/crm/deals', (body) => (body.data || []).map(x => x.id)],
    ['TEN-004', 'CRM tickets', '/api/crm/tickets', (body) => (body.data || []).map(x => x.id)],
    ['TEN-005', 'Conversations', '/api/conversations', (body) => (Array.isArray(body) ? body : []).map(x => x.id)],
    ['TEN-006', 'Bookings', '/api/scheduling/bookings', (body) => (Array.isArray(body) ? body : []).map(x => x.id)],
    ['TEN-007', 'Workflows', '/api/workflows', (body) => (Array.isArray(body) ? body : []).map(x => x.id)],
    ['TEN-008', 'Knowledge documents', '/api/knowledge/documents', (body) => (Array.isArray(body) ? body : []).map(x => x.id)],
  ];

  for (const [id, label, url, extract] of readCases) {
    await check(id, `${label}: tenant A's list contains none of tenant B's records`, async () => {
      const res = await api('GET', url, { token: A.token });
      if (res.status !== 200) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 150)}` };
      const ids = extract(res.body);
      const bIds = Object.values(dataB).map(r => r.id);
      const leaked = ids.filter(i => bIds.includes(i));
      if (leaked.length) return { expected: 'no tenant-B ids', actual: `LEAKED ${leaked.join(',')}`, evidence: url };
      return { ok: true, evidence: `${ids.length} own records, 0 foreign` };
    }, 'CRITICAL');
  }

  // ── Direct-object reference (IDOR) ────────────────────────────────────────
  const idorCases = [
    ['TEN-020', 'GET contact by id', 'GET', () => `/api/crm/contacts/${dataB.contact.id}`, undefined],
    ['TEN-021', 'GET conversation messages', 'GET', () => `/api/conversations/${dataB.conversation.id}/messages`, undefined],
    ['TEN-022', 'GET workflow by id', 'GET', () => `/api/workflows/${dataB.workflow.id}`, undefined],
    ['TEN-023', 'GET deal quotation', 'GET', () => `/api/crm/deals/${dataB.deal.id}/quotation`, undefined],
    ['TEN-024', 'GET contact timeline', 'GET', () => `/api/crm/contacts/${dataB.contact.id}/timeline`, undefined],
  ];

  for (const [id, label, method, urlFn, body] of idorCases) {
    await check(id, `IDOR — ${label} of another tenant is refused`, async () => {
      const res = await api(method, urlFn(), { token: A.token, body });
      if (res.status === 200) {
        const payload = JSON.stringify(res.body || {});
        // An empty array is an acceptable "nothing here for you" answer.
        if (payload === '[]' || payload === '{}' || payload === 'null') {
          return { ok: true, evidence: '200 with empty payload (no data disclosed)' };
        }
        return { expected: '403/404', actual: `200 DISCLOSED ${payload.slice(0, 160)}` };
      }
      if (![401, 403, 404].includes(res.status)) return { expected: '403/404', actual: String(res.status) };
      return { ok: true, evidence: `${res.status}` };
    }, 'CRITICAL');
  }

  // ── Cross-tenant writes ───────────────────────────────────────────────────
  await check('TEN-030', 'Cannot update another tenant\'s contact', async () => {
    const res = await api('PATCH', `/api/crm/contacts/${dataB.contact.id}`, { token: A.token, body: { fullName: 'HIJACKED' } });
    const after = await prisma.contact.findUnique({ where: { id: dataB.contact.id } });
    if (after.fullName === 'HIJACKED') return { expected: 'unchanged', actual: `MUTATED by other tenant (http ${res.status})` };
    return [403, 404].includes(res.status) ? { ok: true, evidence: `${res.status}, row unchanged` } : { expected: '403/404', actual: `${res.status} (row unchanged)` };
  }, 'CRITICAL');

  await check('TEN-031', 'Cannot delete another tenant\'s contact', async () => {
    const res = await api('DELETE', `/api/crm/contacts/${dataB.contact.id}`, { token: A.token });
    const after = await prisma.contact.findUnique({ where: { id: dataB.contact.id } });
    if (!after) return { expected: 'row survives', actual: `DELETED by other tenant (http ${res.status})` };
    return [403, 404].includes(res.status) ? { ok: true, evidence: `${res.status}, row survives` } : { expected: '403/404', actual: `${res.status} (row survives)` };
  }, 'CRITICAL');

  await check('TEN-032', 'Cannot delete another tenant\'s workflow', async () => {
    const res = await api('DELETE', `/api/workflows/${dataB.workflow.id}`, { token: A.token });
    const after = await prisma.workflow.findUnique({ where: { id: dataB.workflow.id } });
    if (!after) return { expected: 'row survives', actual: `DELETED by other tenant (http ${res.status})` };
    return { ok: true, evidence: `${res.status}, row survives` };
  }, 'CRITICAL');

  await check('TEN-033', 'Cannot cancel another tenant\'s booking', async () => {
    const res = await api('PATCH', `/api/scheduling/bookings/${dataB.booking.id}/cancel`, { token: A.token, body: { reason: 'hijack' } });
    const after = await prisma.booking.findUnique({ where: { id: dataB.booking.id } });
    if (after.status === 'CANCELLED') return { expected: 'still CONFIRMED', actual: `CANCELLED by other tenant (http ${res.status})` };
    return { ok: true, evidence: `${res.status}, status=${after.status}` };
  }, 'CRITICAL');

  await check('TEN-034', 'Cannot post a message into another tenant\'s conversation', async () => {
    const before = await prisma.message.count({ where: { conversationId: dataB.conversation.id } });
    const res = await api('POST', `/api/conversations/${dataB.conversation.id}/messages`, { token: A.token, body: { content: 'INJECTED BY TENANT A' } });
    const after = await prisma.message.count({ where: { conversationId: dataB.conversation.id } });
    if (after > before) return { expected: 'no new message', actual: `MESSAGE INJECTED into other tenant's conversation (http ${res.status})` };
    return { ok: true, evidence: `${res.status}, message count unchanged (${after})` };
  }, 'CRITICAL');

  await check('TEN-035', 'Cannot toggle handoff on another tenant\'s conversation', async () => {
    const res = await api('PATCH', `/api/conversations/${dataB.conversation.id}/handoff`, { token: A.token, body: { handoff: true } });
    const after = await prisma.conversation.findUnique({ where: { id: dataB.conversation.id } });
    if (after.isHumanHandoffActive) return { expected: 'unchanged', actual: `HANDOFF TOGGLED by other tenant (http ${res.status})` };
    return { ok: true, evidence: `${res.status}` };
  }, 'CRITICAL');

  await check('TEN-036', 'Cannot attach a booking to another tenant\'s contact', async () => {
    const res = await api('POST', '/api/scheduling/bookings', {
      token: A.token,
      body: { contactId: dataB.contact.id, serviceName: 'Cross-tenant booking', startTime: new Date(Date.now() + 3 * 864e5).toISOString() },
    });
    const created = await prisma.booking.findFirst({ where: { contactId: dataB.contact.id, serviceName: 'Cross-tenant booking' } });
    if (created) return { expected: 'refused', actual: `BOOKING CREATED against foreign contact (http ${res.status})` };
    return [400, 403, 404].includes(res.status) ? { ok: true, evidence: String(res.status) } : { expected: '404', actual: String(res.status) };
  }, 'CRITICAL');

  await check('TEN-037', 'Cannot send WhatsApp on another tenant\'s conversation', async () => {
    const res = await api('POST', `/api/whatsapp/conversations/${dataB.conversation.id}/messages`, { token: A.token, body: { content: 'cross-tenant send' } });
    return [401, 403, 404].includes(res.status)
      ? { ok: true, evidence: String(res.status) }
      : { expected: '403/404', actual: `${res.status} ${res.text.slice(0, 120)}` };
  }, 'CRITICAL');

  await check('TEN-038', 'Cannot read another tenant\'s knowledge base via search', async () => {
    await prisma.documentChunk.create({
      data: { documentId: dataB.doc.id, organizationId: B.orgId, chunkIndex: 0, content: 'TENANT-B-CONFIDENTIAL-MARKER pricing is 1 million naira' },
    });
    const res = await api('GET', '/api/knowledge/search?q=TENANT-B-CONFIDENTIAL-MARKER', { token: A.token });
    const payload = JSON.stringify(res.body || {});
    if (payload.includes('TENANT-B-CONFIDENTIAL-MARKER')) {
      return { expected: 'no cross-tenant chunks', actual: 'LEAKED tenant B knowledge chunk into tenant A search' };
    }
    return { ok: true, evidence: `${res.status}, ${payload.length} bytes, marker absent` };
  }, 'CRITICAL');

  // ── Organization settings isolation ───────────────────────────────────────
  await check('TEN-040', 'GET /organizations/me returns only the caller\'s org', async () => {
    const res = await api('GET', '/api/organizations/me', { token: A.token });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    if (res.body.id !== A.orgId) return { expected: A.orgId, actual: res.body.id };
    const memberEmails = (res.body.users || []).map(u => u.email);
    if (memberEmails.includes(B.email)) return { expected: 'no foreign members', actual: 'tenant B user listed in tenant A org' };
    return { ok: true, evidence: `org=${res.body.id}, ${memberEmails.length} members` };
  }, 'CRITICAL');

  await check('TEN-041', 'Updating settings affects only the caller\'s org', async () => {
    const before = await prisma.organization.findUnique({ where: { id: B.orgId } });
    await api('PATCH', '/api/organizations/settings', { token: A.token, body: { name: 'Renamed By A' } });
    const after = await prisma.organization.findUnique({ where: { id: B.orgId } });
    const mine = await prisma.organization.findUnique({ where: { id: A.orgId } });
    if (after.name !== before.name) return { expected: 'B unchanged', actual: `B renamed to ${after.name}` };
    if (mine.name !== 'Renamed By A') return { expected: 'A renamed', actual: mine.name };
    return { ok: true, evidence: `A="${mine.name}" B="${after.name}"` };
  }, 'CRITICAL');

  await check('TEN-042', 'Cannot remove a member of another organization', async () => {
    const res = await api('DELETE', `/api/organizations/members/${B.userId}`, { token: A.token });
    const stillThere = await prisma.user.findUnique({ where: { id: B.userId } });
    if (!stillThere) return { expected: 'user survives', actual: `TENANT B OWNER DELETED by tenant A (http ${res.status})` };
    return { ok: true, evidence: `${res.status}, user survives` };
  }, 'CRITICAL');

  await check('TEN-043', 'Cannot change the role of a user in another organization', async () => {
    const res = await api('PATCH', `/api/organizations/members/${B.userId}/role`, { token: A.token, body: { role: 'VIEWER' } });
    const after = await prisma.user.findUnique({ where: { id: B.userId } });
    if (after.role !== 'OWNER') return { expected: 'role unchanged', actual: `ROLE CHANGED to ${after.role} by other tenant` };
    return { ok: true, evidence: `${res.status}, role=${after.role}` };
  }, 'CRITICAL');

  // ── RBAC ──────────────────────────────────────────────────────────────────
  const viewer = await seedSession('viewer', { role: 'VIEWER', orgId: A.orgId });
  const agent = await seedSession('agent', { role: 'AGENT', orgId: A.orgId });
  state.viewer = viewer; state.agent = agent;

  await check('TEN-050', 'OWNER can reach a @Roles(OWNER,ADMIN) route (guard order regression)', async () => {
    const res = await api('PATCH', '/api/organizations/settings', { token: A.token, body: { welcomeMessage: 'Owner can write' } });
    return res.status === 200
      ? { ok: true, evidence: '200 — RolesGuard runs after JwtAuthGuard' }
      : { expected: '200', actual: `${res.status} — OWNER LOCKED OUT of their own settings` };
  }, 'CRITICAL');

  await check('TEN-051', 'VIEWER cannot change organization settings', async () => {
    const res = await api('PATCH', '/api/organizations/settings', { token: viewer.token, body: { name: 'Viewer Should Not Rename' } });
    const org = await prisma.organization.findUnique({ where: { id: A.orgId } });
    if (org.name === 'Viewer Should Not Rename') return { expected: 'refused', actual: 'VIEWER RENAMED THE ORGANIZATION' };
    return res.status === 403 ? { ok: true, evidence: '403' } : { expected: '403', actual: `${res.status} (row unchanged)` };
  }, 'CRITICAL');

  await check('TEN-052', 'AGENT cannot add team members', async () => {
    const res = await api('POST', '/api/organizations/members', { token: agent.token, body: { email: `${uniq('sneak')}@e2e.test`, fullName: 'Sneak In', role: 'ADMIN' } });
    return res.status === 403 ? { ok: true } : { expected: '403', actual: `${res.status} — AGENT CAN ADD ADMINS` };
  }, 'CRITICAL');

  await check('TEN-053', 'AGENT cannot regenerate the organization API key', async () => {
    const res = await api('POST', '/api/organizations/api-keys/regenerate', { token: agent.token });
    return res.status === 403 ? { ok: true } : { expected: '403', actual: `${res.status} — AGENT CAN MINT WIDGET KEYS` };
  }, 'CRITICAL');

  await check('TEN-054', 'AGENT cannot activate a paid plan for free', async () => {
    const res = await api('POST', '/api/billing/activate', { token: agent.token, body: { plan: 'ENTERPRISE' } });
    const org = await prisma.organization.findUnique({ where: { id: A.orgId } });
    if (org.subscriptionPlan === 'ENTERPRISE') return { expected: 'refused', actual: 'AGENT SELF-UPGRADED TO ENTERPRISE' };
    return res.status === 403 ? { ok: true, evidence: '403' } : { expected: '403', actual: `${res.status} (plan unchanged)` };
  }, 'CRITICAL');

  await check('TEN-055', 'VIEWER cannot delete knowledge documents', async () => {
    const res = await api('DELETE', `/api/knowledge/documents/${dataA.doc.id}`, { token: viewer.token });
    const still = await prisma.knowledgeDocument.findUnique({ where: { id: dataA.doc.id } });
    if (!still) return { expected: 'doc survives', actual: 'VIEWER DELETED A DOCUMENT' };
    return res.status === 403 ? { ok: true } : { expected: '403', actual: `${res.status} (doc survives)` };
  }, 'HIGH');

  await check('TEN-056', 'AGENT can still do their job (read CRM)', async () => {
    const res = await api('GET', '/api/crm/contacts', { token: agent.token });
    return res.status === 200
      ? { ok: true, evidence: `200, ${(res.body.data || []).length} contacts` }
      : { expected: '200', actual: `${res.status} — RBAC too strict, agents cannot work` };
  }, 'HIGH');

  // ── Privilege escalation ──────────────────────────────────────────────────
  await check('TEN-060', 'A user cannot escalate their own role via the members endpoint', async () => {
    const res = await api('PATCH', `/api/organizations/members/${agent.userId}/role`, { token: agent.token, body: { role: 'OWNER' } });
    const after = await prisma.user.findUnique({ where: { id: agent.userId } });
    if (after.role === 'OWNER') return { expected: 'AGENT stays AGENT', actual: 'SELF-ESCALATION TO OWNER SUCCEEDED' };
    return { ok: true, evidence: `${res.status}, role=${after.role}` };
  }, 'CRITICAL');

  await check('TEN-061', 'Role is read from the database, not the token', async () => {
    // Promote, then demote in the DB, and confirm the pre-demotion token loses access.
    await prisma.user.update({ where: { id: agent.userId }, data: { role: 'OWNER' } });
    const promoted = await loginAs(agent.email, agent.password);
    const okWhileOwner = await api('POST', '/api/organizations/api-keys/regenerate', { token: promoted.accessToken });
    await prisma.user.update({ where: { id: agent.userId }, data: { role: 'AGENT' } });
    const afterDemotion = await api('POST', '/api/organizations/api-keys/regenerate', { token: promoted.accessToken });

    if (okWhileOwner.status !== 200 && okWhileOwner.status !== 201) {
      return { expected: 'OWNER token works', actual: `${okWhileOwner.status} before demotion` };
    }
    return afterDemotion.status === 403
      ? { ok: true, evidence: 'demotion took effect on an already-issued token' }
      : { expected: '403 after demotion', actual: `${afterDemotion.status} — STALE ROLE HONOURED FROM TOKEN` };
  }, 'CRITICAL');
};
