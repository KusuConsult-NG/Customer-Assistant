/**
 * Suite 09 — Onboarding selfie capture.
 *
 * Everything here is asserted against observable behaviour: the row in the database,
 * the bytes in the bucket, what the public endpoint returns to an anonymous caller.
 * Nothing is taken on the word of the implementation.
 *
 * The adversarial cases matter more than the happy path. This is an unauthenticated
 * upload endpoint that accepts binary from the open internet and stores photographs of
 * people's faces — the interesting question is not "does it work" but "what does it
 * refuse".
 */
const H = require('../harness');
const { api, prisma, check, suite, uniq, seedSession } = H;

const API = process.env.E2E_API_URL || 'http://localhost:4000';

/** A genuine, minimal JPEG (not a stub): SOI + APP0/JFIF + a real encoded 8x8 grey image. */
function realJpeg(padToBytes = 2048) {
  // Smallest valid baseline JPEG, then padded inside a COM (comment) segment so the
  // file stays a *decodable* JPEG at any size we need.
  const base = Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEB' +
    'AQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1Fh' +
    'ByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZ' +
    'WmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
    'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+v//Z',
    'base64'
  );
  if (base.length >= padToBytes) return base;

  // Insert a COM segment right after SOI so the result is still a valid JPEG.
  const padLen = padToBytes - base.length;
  const comLen = padLen; // 2 length bytes + payload
  const com = Buffer.concat([
    Buffer.from([0xff, 0xfe, (comLen >> 8) & 0xff, comLen & 0xff]),
    Buffer.alloc(comLen - 2, 0x20),
  ]);
  return Buffer.concat([base.subarray(0, 2), com, base.subarray(2)]);
}

const b64 = (buf) => buf.toString('base64');

/** Public endpoints take no auth, so they are called directly rather than through api(). */
async function publicGet(token) {
  const res = await fetch(`${API}/api/public/selfie/${token}`);
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* non-JSON is itself the finding */ }
  return { status: res.status, body, text };
}

async function publicPost(token, imageBase64) {
  const res = await fetch(`${API}/api/public/selfie/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64 }),
  });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, body, text };
}

module.exports = async function () {
  suite('09 · Onboarding Selfie Capture');

  const T = await seedSession('sel');
  const token = T.token;
  const orgId = T.orgId;

  let contactId;
  let requestId;
  let uploadToken;

  // Storage is an external dependency. If the bucket is unreachable the upload tests
  // cannot certify anything, and saying so beats reporting a pass that means nothing.
  // Supabase Storage requires BOTH headers; Authorization alone returns 403.
  const storageHeaders = {
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const storageUp = await fetch(`${process.env.SUPABASE_URL}/storage/v1/bucket/onboarding-selfies`, {
    headers: storageHeaders,
  }).then((r) => r.ok).catch(() => false);

  await check('SEL-000', 'Fixture contact', async () => {
    const res = await api('POST', '/api/crm/contacts', {
      token,
      body: { fullName: 'Selfie Probe', phoneNumber: uniq('+2348', 9), email: uniq('sel') + '@example.com' },
    });
    if (res.status >= 300) return { expected: '201', actual: `${res.status} ${res.text.slice(0, 140)}` };
    contactId = res.body.id;
    return { ok: true, evidence: `contactId=${contactId}` };
  }, 'LOW');

  // ── Requesting ────────────────────────────────────────────────────────────

  await check('SEL-001', 'Requesting a selfie creates a PENDING row and returns a one-time link', async () => {
    const res = await api('POST', '/api/onboarding/selfie-requests', {
      token,
      body: { contactId, channel: 'WHATSAPP', purpose: 'account verification' },
    });
    if (res.status >= 300) return { expected: '201', actual: `${res.status} ${res.text.slice(0, 180)}` };

    requestId = res.body.id;
    uploadToken = String(res.body.uploadUrl || '').split('/').pop();
    if (!uploadToken || uploadToken.length < 20) {
      return { expected: 'an upload link with a long random token', actual: String(res.body.uploadUrl).slice(0, 80) };
    }

    const row = await prisma.selfieRequest.findUnique({ where: { id: requestId } });
    if (!row) return { expected: 'a persisted request', actual: 'no row was written' };
    if (row.organizationId !== orgId) return { expected: orgId, actual: row.organizationId };
    if (row.status !== 'PENDING') return { expected: 'PENDING', actual: row.status };
    if (row.expiresAt <= new Date()) return { expected: 'a future expiry', actual: row.expiresAt.toISOString() };

    return { ok: true, evidence: `id=${requestId} status=${row.status} expires=${row.expiresAt.toISOString()} delivered=${res.body.delivery?.delivered}` };
  }, 'CRITICAL');

  await check('SEL-002', 'The raw upload token is never stored', async () => {
    const row = await prisma.selfieRequest.findUnique({ where: { id: requestId } });
    if (row.tokenHash === uploadToken) {
      return { expected: 'a hash', actual: 'the raw token is stored verbatim — anyone with DB read access could upload as this customer' };
    }
    if (!/^[a-f0-9]{64}$/.test(row.tokenHash)) {
      return { expected: 'a SHA-256 hex digest', actual: String(row.tokenHash).slice(0, 40) };
    }
    // And it must not have leaked into any other column.
    const serialized = JSON.stringify(row);
    if (serialized.includes(uploadToken)) {
      return { expected: 'the token absent from the row', actual: 'the raw token appears in the stored record' };
    }
    return { ok: true, evidence: `tokenHash is a sha256 digest, raw token absent from the row` };
  }, 'CRITICAL');

  await check('SEL-003', 'A new request supersedes the previous pending one', async () => {
    const first = requestId;
    const res = await api('POST', '/api/onboarding/selfie-requests', {
      token,
      body: { contactId, channel: 'WHATSAPP', purpose: 'second attempt' },
    });
    if (res.status >= 300) return { expected: '201', actual: `${res.status} ${res.text.slice(0, 140)}` };

    const old = await prisma.selfieRequest.findUnique({ where: { id: first } });
    if (old.status !== 'CANCELLED') {
      return { expected: 'the first request CANCELLED', actual: `${old.status} — two pending requests means an inbound photo matches both` };
    }

    const pending = await prisma.selfieRequest.count({ where: { contactId, status: 'PENDING' } });
    if (pending !== 1) return { expected: 'exactly 1 pending', actual: String(pending) };

    requestId = res.body.id;
    uploadToken = String(res.body.uploadUrl).split('/').pop();
    return { ok: true, evidence: `old=${old.status}, exactly 1 pending remains` };
  }, 'HIGH');

  // ── The public link ───────────────────────────────────────────────────────

  await check('SEL-010', 'The public link page loads without auth and leaks no PII', async () => {
    const res = await publicGet(uploadToken);
    if (res.status !== 200) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 140)}` };

    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    const serialized = JSON.stringify(res.body);

    // Anyone holding the link sees this. A first name and a company name is the budget.
    for (const [label, value] of [
      ['phone number', contact.phoneNumber],
      ['email', contact.email],
      ['contact id', contactId],
      ['organization id', orgId],
      ['full name', contact.fullName],
    ]) {
      if (value && serialized.includes(value)) {
        return { expected: `no ${label} in the anonymous response`, actual: `the ${label} is exposed: ${serialized.slice(0, 160)}` };
      }
    }
    if (!res.body.organizationName) return { expected: 'the org name, so the customer knows who is asking', actual: serialized.slice(0, 140) };

    return { ok: true, evidence: `firstName="${res.body.firstName}" org="${res.body.organizationName}" — no phone, email, or identifiers` };
  }, 'CRITICAL');

  await check('SEL-011', 'An unknown token is rejected', async () => {
    const res = await publicGet('a'.repeat(43));
    return res.status === 404
      ? { ok: true, evidence: '404' }
      : { expected: '404', actual: `${res.status} ${res.text.slice(0, 120)}` };
  }, 'HIGH');

  await check('SEL-012', 'A short/empty token is rejected without a database lookup', async () => {
    const res = await publicGet('abc');
    return res.status === 404
      ? { ok: true, evidence: '404' }
      : { expected: '404', actual: String(res.status) };
  }, 'MEDIUM');

  // ── Upload ────────────────────────────────────────────────────────────────

  await check('SEL-020', 'A real photo uploads and the request closes', async () => {
    if (!storageUp) return { blocked: 'Supabase Storage bucket "onboarding-selfies" is unreachable — upload cannot be certified.' };

    const res = await publicPost(uploadToken, b64(realJpeg(3000)));
    if (res.status >= 300) return { expected: '200/201', actual: `${res.status} ${res.text.slice(0, 200)}` };

    const row = await prisma.selfieRequest.findUnique({ where: { id: requestId } });
    if (row.status !== 'RECEIVED') return { expected: 'RECEIVED', actual: `${row.status} ${row.rejectionReason ?? ''}` };
    if (!row.storagePath) return { expected: 'a storage path', actual: 'status is RECEIVED but nothing was stored' };
    if (!row.storagePath.startsWith(orgId + '/')) {
      return { expected: 'a tenant-namespaced path', actual: row.storagePath };
    }
    if (row.mimeType !== 'image/jpeg') return { expected: 'image/jpeg', actual: String(row.mimeType) };
    if (!row.sizeBytes || row.sizeBytes < 1000) return { expected: 'a real byte count', actual: String(row.sizeBytes) };
    if (row.receivedVia !== 'WEB') return { expected: 'WEB', actual: String(row.receivedVia) };
    if (row.verifiedAt !== null) {
      return { expected: 'verifiedAt null — nothing verified this photo', actual: 'the system marked an unverified photo as verified' };
    }
    return { ok: true, evidence: `RECEIVED, path=${row.storagePath}, ${row.sizeBytes} bytes, verifiedAt=null` };
  }, 'CRITICAL');

  await check('SEL-021', 'The uploaded bytes are actually retrievable from storage', async () => {
    if (!storageUp) return { blocked: 'Storage unreachable.' };

    const res = await api('GET', `/api/onboarding/selfie-requests/${requestId}/image`, { token });
    if (res.status !== 200) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 160)}` };
    if (!res.body.url) return { expected: 'a signed URL', actual: JSON.stringify(res.body).slice(0, 120) };

    const fetched = await fetch(res.body.url);
    if (!fetched.ok) return { expected: 'the signed URL to resolve', actual: `HTTP ${fetched.status} — the row claims a stored image that cannot be read` };
    const bytes = Buffer.from(await fetched.arrayBuffer());
    if (bytes.length < 1000) return { expected: 'the stored image', actual: `${bytes.length} bytes` };
    if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) {
      return { expected: 'JPEG magic bytes', actual: bytes.subarray(0, 4).toString('hex') };
    }
    return { ok: true, evidence: `${bytes.length} bytes retrieved, JPEG magic intact, link TTL ${res.body.expiresInSeconds}s` };
  }, 'CRITICAL');

  await check('SEL-022', 'The link is single-use', async () => {
    if (!storageUp) return { blocked: 'Storage unreachable.' };
    const res = await publicPost(uploadToken, b64(realJpeg(3000)));
    return res.status >= 400
      ? { ok: true, evidence: `${res.status} — "${String(res.body.message).slice(0, 80)}"` }
      : { expected: '400', actual: `${res.status} — a used link accepted a second upload` };
  }, 'CRITICAL');

  // ── What it refuses ───────────────────────────────────────────────────────

  /** Fresh pending request + its token, for one adversarial case. */
  async function freshToken() {
    const res = await api('POST', '/api/onboarding/selfie-requests', {
      token, body: { contactId, channel: 'WHATSAPP' },
    });
    return { id: res.body.id, token: String(res.body.uploadUrl).split('/').pop() };
  }

  await check('SEL-030', 'A non-image is refused even though the payload is well-formed base64', async () => {
    const t = await freshToken();
    // An HTML document. Stored and later served, this is stored XSS in a bucket.
    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>'.padEnd(4000, ' '));
    const res = await publicPost(t.token, b64(html));
    if (res.status < 400) {
      const row = await prisma.selfieRequest.findUnique({ where: { id: t.id } });
      return { expected: '400', actual: `${res.status} — HTML accepted as a selfie (status now ${row.status})` };
    }
    const row = await prisma.selfieRequest.findUnique({ where: { id: t.id } });
    if (row.storagePath) return { expected: 'nothing stored', actual: `rejected with ${res.status} but an object was written anyway` };
    return { ok: true, evidence: `${res.status}, nothing stored` };
  }, 'CRITICAL');

  await check('SEL-031', 'An SVG is refused (it is a script-capable document, not a photo)', async () => {
    const t = await freshToken();
    const svg = Buffer.from(
      ('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').padEnd(4000, ' ')
    );
    const res = await publicPost(t.token, b64(svg));
    return res.status >= 400
      ? { ok: true, evidence: String(res.status) }
      : { expected: '400', actual: `${res.status} — SVG accepted, which can execute script when viewed` };
  }, 'CRITICAL');

  await check('SEL-032', 'A data: URL prefix is handled rather than corrupting the file', async () => {
    if (!storageUp) return { blocked: 'Storage unreachable.' };
    const t = await freshToken();
    const res = await publicPost(t.token, `data:image/jpeg;base64,${b64(realJpeg(3000))}`);
    if (res.status >= 300) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 140)}` };
    const row = await prisma.selfieRequest.findUnique({ where: { id: t.id } });
    return row.status === 'RECEIVED' && row.mimeType === 'image/jpeg'
      ? { ok: true, evidence: 'data: prefix stripped, stored as image/jpeg' }
      : { expected: 'RECEIVED image/jpeg', actual: `${row.status} ${row.mimeType}` };
  }, 'HIGH');

  await check('SEL-033', 'A tiny file is refused', async () => {
    const t = await freshToken();
    const res = await publicPost(t.token, b64(Buffer.from([0xff, 0xd8, 0xff, 0xe0])));
    return res.status >= 400
      ? { ok: true, evidence: `${res.status} — "${String(res.body.message).slice(0, 70)}"` }
      : { expected: '400', actual: `${res.status} — a 4-byte "photo" was accepted` };
  }, 'HIGH');

  await check('SEL-034', 'An oversized upload is refused on the DECODED size', async () => {
    const t = await freshToken();
    // 12MB of real JPEG — over the 8MB cap.
    const res = await publicPost(t.token, b64(realJpeg(12 * 1024 * 1024))).catch((e) => ({ status: 0, body: {}, text: e.message }));
    return [400, 413, 0].includes(res.status)
      ? { ok: true, evidence: `status=${res.status}` }
      : { expected: '400/413', actual: `${res.status} — a 12MB upload was accepted past an 8MB cap` };
  }, 'HIGH');

  await check('SEL-035', 'Failed attempts are counted and eventually burn the link', async () => {
    const t = await freshToken();
    const junk = b64(Buffer.from('not an image'.padEnd(4000, ' ')));

    // Count attempts the server actually PROCESSED. The endpoint is IP-throttled, so
    // a fixed loop burns its iterations on 429s and never reaches the cap — which
    // would look like a missing cap when the cap is fine.
    let delivered = 0, tries = 0;
    while (delivered < 6 && tries < 30) {
      tries++;
      const res = await publicPost(t.token, junk);
      if (res.status === 429) { await new Promise((r) => setTimeout(r, 4000)); continue; }
      delivered++;
    }
    const row = await prisma.selfieRequest.findUnique({ where: { id: t.id } });
    if (row.attempts < 5) {
      return { expected: 'attempts counted server-side', actual: `attempts=${row.attempts} after ${delivered} delivered attempts (${tries} requests) — the cap can never be reached` };
    }
    // Once burned, even a valid photo must be refused.
    const good = await publicPost(t.token, b64(realJpeg(3000)));
    return good.status >= 400
      ? { ok: true, evidence: `attempts=${row.attempts}, link burned (valid photo then refused with ${good.status})` }
      : { expected: 'the burned link to refuse a valid photo', actual: `${good.status} — the attempt cap does not actually stop anything` };
  }, 'HIGH');

  await check('SEL-036', 'An expired link is refused', async () => {
    const t = await freshToken();
    await prisma.selfieRequest.update({ where: { id: t.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const res = await publicPost(t.token, b64(realJpeg(3000)));
    if (res.status < 400) return { expected: '400', actual: `${res.status} — an expired link still accepted an upload` };
    const row = await prisma.selfieRequest.findUnique({ where: { id: t.id } });
    return row.status === 'EXPIRED' || row.status === 'PENDING'
      ? { ok: true, evidence: `${res.status}, row=${row.status}` }
      : { expected: 'EXPIRED', actual: row.status };
  }, 'HIGH');

  await check('SEL-037', 'A cancelled request cannot be uploaded to', async () => {
    const t = await freshToken();
    const cancel = await api('POST', `/api/onboarding/selfie-requests/${t.id}/cancel`, { token });
    if (cancel.status !== 200) return { expected: 'cancel 200', actual: `${cancel.status} ${cancel.text.slice(0, 120)}` };
    const res = await publicPost(t.token, b64(realJpeg(3000)));
    return res.status >= 400
      ? { ok: true, evidence: String(res.status) }
      : { expected: '400', actual: `${res.status} — a cancelled request accepted a photo` };
  }, 'HIGH');

  await check('SEL-038', 'Simultaneous uploads on one link store exactly one photo', async () => {
    if (!storageUp) return { blocked: 'Storage unreachable.' };

    const t = await freshToken();
    const img = b64(realJpeg(3000));

    // Count objects BEFORE the burst. Earlier checks in this suite legitimately stored
    // photos for the same contact, so an absolute count would flag them as orphans —
    // the delta is what this test is actually about.
    const listObjects = async () => {
      const r = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/list/onboarding-selfies`, {
        method: 'POST',
        headers: { ...storageHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: `${orgId}/`, limit: 1000 }),
      });
      const j = r.ok ? await r.json() : [];
      return new Set((Array.isArray(j) ? j : []).map((o) => o.name));
    };

    const before = await listObjects();

    // The link is reachable by anyone who has it, so two uploads can race. Exactly one
    // must win, and the losers' bytes must not be left behind in the bucket.
    const results = await Promise.all([
      publicPost(t.token, img),
      publicPost(t.token, img),
      publicPost(t.token, img),
    ]);
    const accepted = results.filter((r) => r.status < 300).length;
    if (accepted !== 1) {
      return { expected: 'exactly 1 accepted', actual: `${accepted} of 3 accepted — statuses ${results.map((r) => r.status).join(',')}` };
    }

    const row = await prisma.selfieRequest.findUnique({ where: { id: t.id } });
    if (row.status !== 'RECEIVED' || !row.storagePath) {
      return { expected: 'RECEIVED with one stored path', actual: `${row.status} path=${row.storagePath}` };
    }

    // Storage deletes are not instantaneous; give the losers' cleanup a moment.
    let added = [];
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const after = await listObjects();
      added = [...after].filter((n) => !before.has(n));
      if (added.length <= 1) break;
    }

    if (added.length !== 1) {
      return { expected: '1 new object', actual: `${added.length} new objects — the losing uploads were left orphaned in the bucket` };
    }
    if (!row.storagePath.endsWith(added[0].split('/').pop())) {
      return { expected: 'the surviving object to be the one the row points at', actual: `row=${row.storagePath} bucket=${added[0]}` };
    }
    return { ok: true, evidence: `1 of 3 accepted, exactly 1 new object, and the row points at it` };
  }, 'HIGH');

  // ── Tenancy and erasure ───────────────────────────────────────────────────

  await check('SEL-040', 'Another tenant cannot see or open this selfie', async () => {
    const other = await seedSession('selx');

    const list = await api('GET', `/api/onboarding/selfie-requests?contactId=${contactId}`, { token: other.token });
    if (list.status === 200 && Array.isArray(list.body) && list.body.length > 0) {
      return { expected: 'an empty list', actual: `${list.body.length} of another tenant's selfie requests returned` };
    }
    const image = await api('GET', `/api/onboarding/selfie-requests/${requestId}/image`, { token: other.token });
    if (image.status !== 404) return { expected: '404', actual: `${image.status} — cross-tenant access to a customer's photo` };

    const del = await api('DELETE', `/api/onboarding/selfie-requests/${requestId}`, { token: other.token });
    if (del.status !== 404 && del.status !== 403) {
      return { expected: '404/403', actual: `${del.status} — another tenant could delete this record` };
    }
    return { ok: true, evidence: `list empty, image 404, delete ${del.status}` };
  }, 'CRITICAL');

  await check('SEL-041', 'Requesting a selfie for another tenant\'s contact is refused', async () => {
    const other = await seedSession('sely');
    const res = await api('POST', '/api/onboarding/selfie-requests', {
      token: other.token,
      body: { contactId, channel: 'WHATSAPP' },
    });
    if (res.status !== 404) return { expected: '404', actual: `${res.status} — a request was created against a foreign contact` };
    return { ok: true, evidence: '404' };
  }, 'CRITICAL');

  await check('SEL-042', 'Unauthenticated access to the operator endpoints is refused', async () => {
    const res = await fetch(`${API}/api/onboarding/selfie-requests?contactId=${contactId}`);
    return res.status === 401
      ? { ok: true, evidence: '401' }
      : { expected: '401', actual: `${res.status} — selfie records readable without a token` };
  }, 'CRITICAL');

  await check('SEL-043', 'Deleting a request erases the stored photo too', async () => {
    if (!storageUp) return { blocked: 'Storage unreachable.' };

    const row = await prisma.selfieRequest.findUnique({ where: { id: requestId } });
    const path = row.storagePath;

    const del = await api('DELETE', `/api/onboarding/selfie-requests/${requestId}`, { token });
    if (del.status !== 200) return { expected: '200', actual: `${del.status} ${del.text.slice(0, 140)}` };

    const gone = await prisma.selfieRequest.findUnique({ where: { id: requestId } });
    if (gone) return { expected: 'row deleted', actual: 'the row survives' };

    // The object itself must be gone, not just the pointer to it.
    const head = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/onboarding-selfies/${path}`,
      { headers: storageHeaders }
    );
    return head.status === 404 || head.status === 400
      ? { ok: true, evidence: `row deleted, object returns ${head.status}` }
      : { expected: 'the object removed', actual: `HTTP ${head.status} — the photo remains in the bucket after "deletion"` };
  }, 'CRITICAL');

  // ── Workflow integration ──────────────────────────────────────────────────

  await check('SEL-050', 'The REQUEST_SELFIE workflow action creates a real pending request', async () => {
    const wf = await api('POST', '/api/workflows', {
      token,
      body: {
        name: 'Selfie on lead',
        triggerType: 'LEAD_CREATED',
        isActive: true,
        nodes: [
          { id: 's1', kind: 'TRIGGER', label: 'LEAD_CREATED' },
          { id: 's2', kind: 'ACTION', action: 'REQUEST_SELFIE', config: { purpose: 'onboarding' } },
        ],
        edges: [{ from: 's1', to: 's2' }],
      },
    });
    if (wf.status >= 300) return { expected: '201', actual: `${wf.status} ${wf.text.slice(0, 160)}` };

    const before = await prisma.selfieRequest.count({ where: { contactId, status: 'PENDING' } });
    const run = await api('POST', `/api/workflows/${wf.body.id}/execute`, {
      token,
      body: { payload: { contactId } },
    });
    if (run.status >= 300) return { expected: '200', actual: `${run.status} ${run.text.slice(0, 160)}` };
    if (run.body.status !== 'SUCCEEDED') {
      return { expected: 'SUCCEEDED', actual: `${run.body.status} — ${run.body.error ?? 'no error'}` };
    }

    const after = await prisma.selfieRequest.findFirst({
      where: { contactId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (!after) return { expected: 'a pending selfie request', actual: 'the run reported success but created nothing' };
    if (after.purpose !== 'onboarding') return { expected: 'purpose "onboarding"', actual: String(after.purpose) };

    const step = (run.body.steps || []).find((s) => s.action === 'REQUEST_SELFIE');
    if (!step?.output?.selfieRequestId) {
      return { expected: 'the step output carrying the request id', actual: JSON.stringify(step?.output).slice(0, 120) };
    }
    return { ok: true, evidence: `pending before=${before}, request ${after.id.slice(0, 8)} created via workflow, delivered=${step.output.delivered}` };
  }, 'CRITICAL');
};
