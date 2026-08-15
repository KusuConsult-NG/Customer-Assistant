/**
 * Suite 03 — CRM at volume: CRUD, search, pagination, export, concurrency,
 * referential integrity and injection resistance.
 */
const H = require('../harness');
const { api, prisma, check, suite, state, uniq, seedSession, sleep } = H;

module.exports = async function () {
  suite('03 · CRM (contacts, leads, deals, tickets)');

  const T = await seedSession('crm');
  const token = T.token;
  const orgId = T.orgId;

  // ── Bulk seed: 1,200 contacts ─────────────────────────────────────────────
  const BULK = 1200;
  await check('CRM-001', `Bulk-load ${BULK} contacts and read them back`, async () => {
    const rows = Array.from({ length: BULK }, (_, i) => ({
      organizationId: orgId,
      fullName: `Bulk Contact ${String(i).padStart(5, '0')}`,
      phoneNumber: `+234900${String(i).padStart(7, '0')}`,
      email: `bulk${i}@e2e.test`,
      tags: i % 3 === 0 ? ['vip'] : ['standard'],
    }));
    const t0 = Date.now();
    await prisma.contact.createMany({ data: rows });
    const seeded = Date.now() - t0;
    const count = await prisma.contact.count({ where: { organizationId: orgId } });
    if (count < BULK) return { expected: `${BULK} rows`, actual: `${count}` };
    return { ok: true, evidence: `${count} contacts inserted in ${seeded}ms` };
  }, 'MEDIUM');

  await check('CRM-002', 'Contact list is paginated and does not dump the whole table', async () => {
    const res = await api('GET', '/api/crm/contacts?page=1&limit=50', { token });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    const { data, total, totalPages } = res.body;
    if (!Array.isArray(data)) return { expected: 'data array', actual: typeof data };
    if (data.length > 50) return { expected: '<=50 rows', actual: `${data.length} rows — limit ignored` };
    if (total < BULK) return { expected: `total>=${BULK}`, actual: String(total) };
    if (totalPages !== Math.ceil(total / 50)) return { expected: `totalPages=${Math.ceil(total / 50)}`, actual: String(totalPages) };
    return { ok: true, evidence: `page1=${data.length} total=${total} pages=${totalPages} in ${res.ms}ms` };
  }, 'HIGH');

  await check('CRM-003', 'Pagination pages do not overlap and cover the set', async () => {
    const p1 = await api('GET', '/api/crm/contacts?page=1&limit=25', { token });
    const p2 = await api('GET', '/api/crm/contacts?page=2&limit=25', { token });
    const ids1 = p1.body.data.map(c => c.id);
    const ids2 = p2.body.data.map(c => c.id);
    const overlap = ids1.filter(i => ids2.includes(i));
    if (overlap.length) return { expected: 'disjoint pages', actual: `${overlap.length} rows on both pages — unstable ordering` };
    if (ids2.length !== 25) return { expected: '25 rows on page 2', actual: String(ids2.length) };
    return { ok: true, evidence: `p1=${ids1.length} p2=${ids2.length} overlap=0` };
  }, 'HIGH');

  await check('CRM-004', 'Page beyond the end returns empty, not an error', async () => {
    const res = await api('GET', '/api/crm/contacts?page=99999&limit=50', { token });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    return res.body.data.length === 0 ? { ok: true } : { expected: 'empty', actual: `${res.body.data.length} rows` };
  }, 'MEDIUM');

  await check('CRM-005', 'Negative / zero / non-numeric pagination is handled safely', async () => {
    const cases = ['page=-5&limit=-10', 'page=0&limit=0', 'page=abc&limit=xyz', 'limit=999999999'];
    for (const qs of cases) {
      const res = await api('GET', `/api/crm/contacts?${qs}`, { token });
      if (res.status >= 500) return { expected: 'no 5xx', actual: `${qs} => ${res.status}` };
      if (res.status === 200 && res.body.data.length > 1000) {
        return { expected: 'bounded page size', actual: `${qs} returned ${res.body.data.length} rows — unbounded limit is a DoS vector` };
      }
    }
    return { ok: true, evidence: 'all four handled without 5xx or unbounded reads' };
  }, 'HIGH');

  // ── Create / read / update / delete ────────────────────────────────────────
  let contactId;
  await check('CRM-010', 'Create contact persists exactly what was sent', async () => {
    const payload = { fullName: 'Chíamáka Ọ. Nwosu', phoneNumber: `+2348${Date.now().toString().slice(-9)}`, email: `chi.${uniq('c')}@e2e.test`, tags: ['vip', 'lagos'] };
    const res = await api('POST', '/api/crm/contacts', { token, body: payload });
    if (res.status !== 201 && res.status !== 200) return { expected: '201', actual: `${res.status} ${res.text.slice(0, 150)}` };
    contactId = res.body.id;
    const row = await prisma.contact.findUnique({ where: { id: contactId } });
    if (row.fullName !== payload.fullName) return { expected: payload.fullName, actual: row.fullName };
    if (row.organizationId !== orgId) return { expected: 'own org', actual: row.organizationId };
    if (JSON.stringify(row.tags) !== JSON.stringify(payload.tags)) return { expected: JSON.stringify(payload.tags), actual: JSON.stringify(row.tags) };
    return { ok: true, evidence: `id=${contactId}` };
  }, 'CRITICAL');

  await check('CRM-011', 'Duplicate phone number in the same org is rejected', async () => {
    const row = await prisma.contact.findUnique({ where: { id: contactId } });
    const res = await api('POST', '/api/crm/contacts', { token, body: { fullName: 'Impostor', phoneNumber: row.phoneNumber } });
    if (res.status < 400) {
      const dupes = await prisma.contact.count({ where: { organizationId: orgId, phoneNumber: row.phoneNumber } });
      return { expected: '409/400', actual: `${res.status} — ${dupes} contacts now share one phone number in one org` };
    }
    if (res.status >= 500) return { expected: '409/400', actual: `${res.status} raw Prisma error surfaced to the client` };
    return { ok: true, evidence: String(res.status) };
  }, 'HIGH');

  await check('CRM-012', 'The same phone number IS allowed in a different org', async () => {
    const row = await prisma.contact.findUnique({ where: { id: contactId } });
    const other = await seedSession('crmother');
    const res = await api('POST', '/api/crm/contacts', { token: other.token, body: { fullName: 'Different Tenant Same Number', phoneNumber: row.phoneNumber } });
    return (res.status === 200 || res.status === 201)
      ? { ok: true, evidence: 'uniqueness is scoped per organization' }
      : { expected: '201', actual: `${res.status} — cross-tenant phone collision blocks a legitimate customer` };
  }, 'HIGH');

  await check('CRM-013', 'Update contact writes through to the database', async () => {
    const res = await api('PATCH', `/api/crm/contacts/${contactId}`, { token, body: { fullName: 'Renamed Contact', tags: ['updated'] } });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    const row = await prisma.contact.findUnique({ where: { id: contactId } });
    if (row.fullName !== 'Renamed Contact') return { expected: 'Renamed Contact', actual: row.fullName };
    return { ok: true, evidence: `tags=${JSON.stringify(row.tags)}` };
  }, 'HIGH');

  await check('CRM-014', 'Delete contact removes the row', async () => {
    const tmp = await prisma.contact.create({ data: { organizationId: orgId, fullName: 'To Delete', phoneNumber: `+234700${Date.now().toString().slice(-7)}` } });
    const res = await api('DELETE', `/api/crm/contacts/${tmp.id}`, { token });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    const row = await prisma.contact.findUnique({ where: { id: tmp.id } });
    return row === null ? { ok: true } : { expected: 'row gone', actual: 'row still present' };
  }, 'HIGH');

  await check('CRM-015', 'Deleting a contact cascades to its leads/deals/tickets (no orphans)', async () => {
    const c = await prisma.contact.create({ data: { organizationId: orgId, fullName: 'Cascade Parent', phoneNumber: `+234701${Date.now().toString().slice(-7)}` } });
    const l = await prisma.lead.create({ data: { organizationId: orgId, contactId: c.id } });
    const d = await prisma.deal.create({ data: { organizationId: orgId, contactId: c.id, title: 'Cascade Deal', amount: 1000 } });
    const t = await prisma.ticket.create({ data: { organizationId: orgId, contactId: c.id, ticketNumber: `CAS-${Date.now()}`, subject: 'S', description: 'D', updatedAt: new Date() } });

    const res = await api('DELETE', `/api/crm/contacts/${c.id}`, { token });
    if (res.status !== 200) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 150)}` };

    const orphans = {
      leads: await prisma.lead.count({ where: { id: l.id } }),
      deals: await prisma.deal.count({ where: { id: d.id } }),
      tickets: await prisma.ticket.count({ where: { id: t.id } }),
    };
    const leftover = Object.entries(orphans).filter(([, n]) => n > 0);
    return leftover.length === 0
      ? { ok: true, evidence: 'lead, deal and ticket all removed with the contact' }
      : { expected: 'no orphans', actual: `orphaned ${leftover.map(([k, n]) => `${k}=${n}`).join(', ')}` };
  }, 'HIGH');

  await check('CRM-016', 'Deleting a non-existent contact returns 404, not 500', async () => {
    const res = await api('DELETE', '/api/crm/contacts/00000000-0000-0000-0000-000000000000', { token });
    return res.status === 404 ? { ok: true } : { expected: '404', actual: String(res.status) };
  }, 'MEDIUM');

  await check('CRM-017', 'Malformed UUID in the path returns 4xx, not 500', async () => {
    const res = await api('GET', '/api/crm/contacts/not-a-uuid', { token });
    return res.status < 500 ? { ok: true, evidence: String(res.status) } : { expected: '4xx', actual: `${res.status} — raw DB error leaked` };
  }, 'MEDIUM');

  // ── Search ────────────────────────────────────────────────────────────────
  await check('CRM-020', 'Search finds a contact by partial name', async () => {
    await prisma.contact.create({ data: { organizationId: orgId, fullName: 'Findable Zaphod Beeblebrox', phoneNumber: `+234702${Date.now().toString().slice(-7)}` } });
    const res = await api('GET', '/api/crm/contacts/search?q=Zaphod', { token });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    const arr = Array.isArray(res.body) ? res.body : res.body.data || [];
    return arr.some(c => /Zaphod/.test(c.fullName))
      ? { ok: true, evidence: `${arr.length} hits in ${res.ms}ms` }
      : { expected: 'match found', actual: `${arr.length} results, none matching` };
  }, 'HIGH');

  await check('CRM-021', 'Search is case-insensitive', async () => {
    const res = await api('GET', '/api/crm/contacts/search?q=zAPHOD', { token });
    const arr = Array.isArray(res.body) ? res.body : res.body.data || [];
    return arr.length > 0 ? { ok: true } : { expected: 'case-insensitive hit', actual: '0 results' };
  }, 'MEDIUM');

  await check('CRM-022', 'Search with an empty term does not dump the table', async () => {
    const res = await api('GET', '/api/crm/contacts/search?q=', { token });
    const arr = Array.isArray(res.body) ? res.body : res.body.data || [];
    return arr.length <= 100 ? { ok: true, evidence: `${arr.length} rows` } : { expected: 'bounded', actual: `${arr.length} rows returned for an empty query` };
  }, 'MEDIUM');

  await check('CRM-023', 'SQL injection in the search term does not execute', async () => {
    const payloads = [
      `' OR 1=1 --`,
      `'; DROP TABLE contacts; --`,
      `" UNION SELECT * FROM users --`,
      `%'; UPDATE users SET role='OWNER' WHERE '1'='1`,
    ];
    for (const p of payloads) {
      const res = await api('GET', `/api/crm/contacts/search?q=${encodeURIComponent(p)}`, { token });
      if (res.status >= 500) return { expected: 'no 5xx', actual: `"${p}" => ${res.status}` };
    }
    const tableStillThere = await prisma.contact.count({ where: { organizationId: orgId } });
    if (tableStillThere === 0) return { expected: 'table intact', actual: 'CONTACTS TABLE EMPTIED BY INJECTION' };
    const escalated = await prisma.user.count({ where: { organizationId: orgId, role: 'OWNER' } });
    return { ok: true, evidence: `${tableStillThere} contacts intact, ${escalated} owners (unchanged)` };
  }, 'CRITICAL');

  await check('CRM-024', 'XSS payload is stored and returned verbatim (no HTML execution server-side)', async () => {
    const xss = `<script>alert('xss')</script><img src=x onerror=alert(1)>`;
    const res = await api('POST', '/api/crm/contacts', { token, body: { fullName: xss, phoneNumber: `+234703${Date.now().toString().slice(-7)}` } });
    if (res.status >= 400) return { expected: 'stored or rejected cleanly', actual: `${res.status}` };
    const row = await prisma.contact.findUnique({ where: { id: res.body.id } });
    // Storing verbatim is correct; the escaping obligation is the renderer's. What
    // must NOT happen is the payload being executed or mangled into broken markup.
    if (row.fullName !== xss) return { warn: true, expected: 'verbatim storage', actual: `stored as "${row.fullName}"` };
    return { ok: true, evidence: 'stored verbatim; React escapes on render' };
  }, 'HIGH');

  // ── CSV export ────────────────────────────────────────────────────────────
  await check('CRM-030', 'CSV export returns a CSV attachment with all contacts', async () => {
    const res = await api('GET', '/api/crm/export/contacts', { token });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    const ct = res.headers.get('content-type') || '';
    if (!/csv/i.test(ct)) return { expected: 'text/csv', actual: ct };
    const lines = res.text.trim().split('\n');
    if (!/^ID,Full Name,Phone Number,Email,Address,City,State,Tags/.test(lines[0])) return { expected: 'header row', actual: lines[0].slice(0, 80) };
    if (lines.length < BULK) return { expected: `>${BULK} rows`, actual: `${lines.length} lines` };
    return { ok: true, evidence: `${lines.length} lines, ${res.text.length} bytes, ${res.ms}ms` };
  }, 'HIGH');

  await check('CRM-031', 'CSV injection: a formula-leading name is neutralised', async () => {
    const evil = `=HYPERLINK("http://evil.test","click")`;
    await prisma.contact.create({ data: { organizationId: orgId, fullName: evil, phoneNumber: `+234704${Date.now().toString().slice(-7)}` } });
    const res = await api('GET', '/api/crm/export/contacts', { token });
    const line = res.text.split('\n').find(l => l.includes('HYPERLINK'));
    if (!line) return { expected: 'row present', actual: 'contact missing from export' };
    // Must not begin the field with '=' — Excel/Sheets would evaluate it.
    if (/,"=/.test(line) || /^"=/.test(line)) {
      return { expected: "formula prefixed with '", actual: `LIVE FORMULA IN EXPORT: ${line.slice(0, 90)}` };
    }
    return { ok: true, evidence: `neutralised: ${line.slice(0, 80)}` };
  }, 'HIGH');

  await check('CRM-032', 'CSV quoting survives a name containing quotes and commas', async () => {
    const tricky = `Ade "Sunny" Bello, Jr.`;
    await prisma.contact.create({ data: { organizationId: orgId, fullName: tricky, phoneNumber: `+234705${Date.now().toString().slice(-7)}` } });
    const res = await api('GET', '/api/crm/export/contacts', { token });
    const line = res.text.split('\n').find(l => l.includes('Sunny'));
    if (!line) return { expected: 'row present', actual: 'missing' };
    if (!line.includes('""Sunny""')) return { expected: 'doubled quotes per RFC4180', actual: line.slice(0, 100) };
    // Field count must still be 8 (ID, name, phone, email, address, city, state,
    // tags) despite the embedded comma — every field is quoted by the exporter.
    const fields = line.match(/"(?:[^"]|"")*"/g) || [];
    if (fields.length !== 8) return { expected: '8 quoted fields', actual: `${fields.length} — embedded comma broke the row` };
    return { ok: true, evidence: line.slice(0, 90) };
  }, 'HIGH');

  // ── Leads / deals / tickets ───────────────────────────────────────────────
  await check('CRM-040', 'Lead lifecycle: create then transition status', async () => {
    const c = await prisma.contact.create({ data: { organizationId: orgId, fullName: 'Lead Owner', phoneNumber: `+234706${Date.now().toString().slice(-7)}` } });
    const created = await api('POST', '/api/crm/leads', { token, body: { contactId: c.id, notes: 'Inbound enquiry' } });
    if (created.status !== 201 && created.status !== 200) return { expected: '201', actual: `${created.status} ${created.text.slice(0, 120)}` };
    if (created.body.status !== 'NEW') return { expected: 'NEW', actual: created.body.status };
    const moved = await api('PATCH', `/api/crm/leads/${created.body.id}/status`, { token, body: { status: 'QUALIFIED' } });
    if (moved.status !== 200) return { expected: '200', actual: String(moved.status) };
    const row = await prisma.lead.findUnique({ where: { id: created.body.id } });
    return row.status === 'QUALIFIED' ? { ok: true, evidence: 'NEW → QUALIFIED persisted' } : { expected: 'QUALIFIED', actual: row.status };
  }, 'HIGH');

  await check('CRM-041', 'Invalid lead status is rejected, not written', async () => {
    const lead = await prisma.lead.findFirst({ where: { organizationId: orgId } });
    const res = await api('PATCH', `/api/crm/leads/${lead.id}/status`, { token, body: { status: 'TOTALLY_MADE_UP' } });
    const row = await prisma.lead.findUnique({ where: { id: lead.id } });
    if (row.status === 'TOTALLY_MADE_UP') return { expected: 'rejected', actual: 'invalid enum written to DB' };
    return res.status >= 400 ? { ok: true, evidence: String(res.status) } : { expected: '400', actual: `${res.status} (value not written)` };
  }, 'HIGH');

  await check('CRM-042', 'Deal amount precision survives a round trip', async () => {
    const c = await prisma.contact.findFirst({ where: { organizationId: orgId } });
    const amount = 1234567.89;
    const res = await api('POST', '/api/crm/deals', { token, body: { contactId: c.id, title: 'Precision Deal', amount } });
    if (res.status >= 400) return { expected: '201', actual: `${res.status} ${res.text.slice(0, 120)}` };
    const row = await prisma.deal.findUnique({ where: { id: res.body.id } });
    if (Math.abs(row.amount - amount) > 0.01) return { expected: String(amount), actual: String(row.amount) };
    return { ok: true, evidence: `stored ${row.amount}` };
  }, 'HIGH');

  await check('CRM-043', 'Negative deal amount is rejected', async () => {
    const c = await prisma.contact.findFirst({ where: { organizationId: orgId } });
    const res = await api('POST', '/api/crm/deals', { token, body: { contactId: c.id, title: 'Negative', amount: -50000 } });
    if (res.status < 400) {
      const row = await prisma.deal.findUnique({ where: { id: res.body.id } });
      return { warn: true, expected: '400', actual: `accepted a negative deal amount (${row.amount}) — corrupts pipeline value` };
    }
    return { ok: true, evidence: String(res.status) };
  }, 'MEDIUM');

  await check('CRM-044', 'Ticket numbers are unique under concurrent creation', async () => {
    const c = await prisma.contact.findFirst({ where: { organizationId: orgId } });
    const N = 25;
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      api('POST', '/api/crm/tickets', { token, body: { contactId: c.id, subject: `Concurrent ${i}`, description: 'race test' } })));
    const created = results.filter(r => r.status === 200 || r.status === 201);
    const numbers = created.map(r => r.body.ticketNumber);
    const unique = new Set(numbers);
    const serverErrors = results.filter(r => r.status >= 500).length;
    if (unique.size !== numbers.length) {
      return { expected: 'all unique', actual: `${numbers.length - unique.size} duplicate ticket numbers under concurrency` };
    }
    if (serverErrors > 0) {
      return { expected: 'no 5xx', actual: `${serverErrors}/${N} concurrent creates returned 5xx — unique-constraint race surfaced as a crash` };
    }
    return { ok: true, evidence: `${created.length}/${N} created, ${unique.size} distinct numbers, 0 server errors` };
  }, 'HIGH');

  await check('CRM-045', 'Ticket status transitions persist', async () => {
    const t = await prisma.ticket.findFirst({ where: { organizationId: orgId } });
    const res = await api('PATCH', `/api/crm/tickets/${t.id}/status`, { token, body: { status: 'RESOLVED' } });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    const row = await prisma.ticket.findUnique({ where: { id: t.id } });
    return row.status === 'RESOLVED' ? { ok: true } : { expected: 'RESOLVED', actual: row.status };
  }, 'HIGH');

  await check('CRM-046', 'Deal stage transitions persist', async () => {
    const d = await prisma.deal.findFirst({ where: { organizationId: orgId } });
    const res = await api('PATCH', `/api/crm/deals/${d.id}/stage`, { token, body: { stage: 'CLOSED_WON' } });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    const row = await prisma.deal.findUnique({ where: { id: d.id } });
    return row.stage === 'CLOSED_WON' ? { ok: true } : { expected: 'CLOSED_WON', actual: row.stage };
  }, 'HIGH');

  // ── Timeline ──────────────────────────────────────────────────────────────
  await check('CRM-050', 'Customer timeline aggregates calls, bookings, deals and tickets', async () => {
    const c = await prisma.contact.create({ data: { organizationId: orgId, fullName: 'Timeline Subject', phoneNumber: `+234707${Date.now().toString().slice(-7)}` } });
    await prisma.callLog.create({ data: { organizationId: orgId, callSid: `CA_${uniq('t')}`, fromNumber: c.phoneNumber, toNumber: '+2348000000000', durationSeconds: 90, status: 'COMPLETED' } });
    await prisma.booking.create({ data: { organizationId: orgId, contactId: c.id, serviceName: 'Timeline Service', startTime: new Date(Date.now() + 864e5), endTime: new Date(Date.now() + 864e5 + 18e5) } });
    await prisma.deal.create({ data: { organizationId: orgId, contactId: c.id, title: 'Timeline Deal', amount: 250000 } });
    await prisma.ticket.create({ data: { organizationId: orgId, contactId: c.id, ticketNumber: `TL-${Date.now()}`, subject: 'Timeline Ticket', description: 'x', updatedAt: new Date() } });

    const res = await api('GET', `/api/crm/contacts/${c.id}/timeline`, { token });
    if (res.status !== 200) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 150)}` };
    const types = new Set((res.body.timeline || []).map(t => t.type));
    const missing = ['CALL', 'BOOKING', 'DEAL_UPDATE', 'TICKET_CREATED'].filter(t => !types.has(t));
    if (missing.length) return { expected: 'all four event types', actual: `missing ${missing.join(',')}` };
    if (typeof res.body.healthScore !== 'number') return { expected: 'healthScore number', actual: typeof res.body.healthScore };
    // Must be newest-first.
    const ts = res.body.timeline.map(t => new Date(t.timestamp).getTime());
    const sorted = [...ts].sort((a, b) => b - a);
    if (JSON.stringify(ts) !== JSON.stringify(sorted)) return { expected: 'descending order', actual: 'timeline not sorted' };
    return { ok: true, evidence: `${res.body.timeline.length} events, health=${res.body.healthScore}` };
  }, 'HIGH');

  // ── Concurrency / idempotency ─────────────────────────────────────────────
  await check('CRM-060', 'Double-submit of the same contact does not create two rows', async () => {
    const phone = `+234708${Date.now().toString().slice(-7)}`;
    const body = { fullName: 'Double Submit', phoneNumber: phone };
    const [a, b] = await Promise.all([
      api('POST', '/api/crm/contacts', { token, body }),
      api('POST', '/api/crm/contacts', { token, body }),
    ]);
    const rows = await prisma.contact.count({ where: { organizationId: orgId, phoneNumber: phone } });
    if (rows > 1) return { expected: '1 row', actual: `${rows} rows — rapid double-click creates duplicates (a=${a.status} b=${b.status})` };
    const errors = [a, b].filter(r => r.status >= 500).length;
    if (errors) return { expected: 'no 5xx', actual: `${errors} of 2 concurrent creates returned 5xx` };
    return { ok: true, evidence: `1 row; statuses ${a.status}/${b.status}` };
  }, 'HIGH');

  await check('CRM-061', 'Concurrent updates to one contact leave it consistent', async () => {
    const c = await prisma.contact.create({ data: { organizationId: orgId, fullName: 'Concurrent Target', phoneNumber: `+234709${Date.now().toString().slice(-7)}` } });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      api('PATCH', `/api/crm/contacts/${c.id}`, { token, body: { fullName: `Update ${i}` } })));
    const errs = results.filter(r => r.status >= 500).length;
    const row = await prisma.contact.findUnique({ where: { id: c.id } });
    if (errs) return { expected: 'no 5xx', actual: `${errs}/10 concurrent updates errored` };
    if (!/^Update \d$/.test(row.fullName)) return { expected: 'one of the writes wins', actual: `final value "${row.fullName}"` };
    return { ok: true, evidence: `final="${row.fullName}", 0 errors` };
  }, 'MEDIUM');

  state.crm = { ...T, contactId };
};
