/**
 * WhatsApp inbound probe.
 *
 * Impersonates Meta's WhatsApp Cloud API against the RUNNING service: the same
 * verification handshake, the same `X-Hub-Signature-256` HMAC over the raw body, and
 * the same webhook envelopes Meta actually posts for text, media, interactive,
 * location and status events.
 *
 * The check that matters most is duplicate delivery. Meta guarantees *at least once*,
 * not exactly once — it retries on timeout, on network error, and sometimes simply
 * because it did. Anything not idempotent will double every customer message and send
 * two AI replies, and no amount of testing the happy path reveals it.
 *
 * Usage: node e2e-validation/whatsapp-inbound-probe.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}

const { assertLocalDatabase } = require('./../scripts/guard-production-db');

assertLocalDatabase('the WhatsApp inbound probe');

const API = process.env.E2E_API_URL || 'http://localhost:4000';
const { PrismaClient } = require(path.join(ROOT, 'node_modules/@prisma/client'));
/**
 * Own pool, deliberately small — the API process holds its own, and both draw
 * on the same server's connection budget.
 *
 * Built with the URL parser rather than string concatenation: appending
 * '&connection_limit=3' to a DATABASE_URL that has no query string produced
 * `...&connection_limit=3` as part of the DATABASE NAME, and the probe died
 * with `database "ace_test&connection_limit=3" does not exist` before running
 * a single check.
 */
const probeDbUrl = (() => {
  try {
    const u = new URL(process.env.DATABASE_URL);
    u.searchParams.set('connection_limit', '3');
    return u.toString();
  } catch {
    return process.env.DATABASE_URL;
  }
})();

const prisma = new PrismaClient({
  datasources: { db: { url: probeDbUrl } },
});

const results = [];
function record(id, name, outcome) {
  const status = outcome.ok ? 'PASS' : outcome.blocked ? 'BLOCKED' : 'FAIL';
  results.push({ id, name, status, ...outcome });
  const colour = status === 'PASS' ? '\x1b[32m' : status === 'BLOCKED' ? '\x1b[33m' : '\x1b[31m';
  console.log(`  ${colour}${status.padEnd(7)}\x1b[0m ${id.padEnd(9)} ${name}`);
  if (outcome.evidence) console.log(`          ${outcome.evidence}`);
  if (!outcome.ok && outcome.actual) console.log(`          expected: ${outcome.expected}\n          actual:   ${outcome.actual}`);
  if (outcome.blocked) console.log(`          ${outcome.blocked}`);
}

const APP_SECRET = process.env.WHATSAPP_APP_SECRET;

/** Meta signs the raw request body with HMAC-SHA256 keyed on the app secret. */
function sign(rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
}

async function postWebhook(payload, { signature, omitSignature } = {}) {
  const raw = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (!omitSignature) headers['X-Hub-Signature-256'] = signature ?? sign(raw);
  const res = await fetch(`${API}/api/whatsapp/webhook`, { method: 'POST', headers, body: raw });
  return { status: res.status, text: await res.text() };
}

/** The envelope Meta posts for an inbound message. */
function envelope(phoneNumberId, message, contactName = 'Probe Caller') {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_ID',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: contactName }, wa_id: message.from }],
          messages: [message],
        },
      }],
    }],
  };
}

const settle = (ms = 3500) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`\n\x1b[1mWhatsApp Inbound Probe\x1b[0m  target=${API}\n`);

  if (!APP_SECRET) {
    console.error('  FATAL: WHATSAPP_APP_SECRET is not set — signatures cannot be produced.');
    process.exit(2);
  }

  // ── Fixture ───────────────────────────────────────────────────────────────
  const suffix = crypto.randomBytes(3).toString('hex');
  const phoneNumberId = `PROBE_${Date.now()}`;
  let org;
  try {
    org = await prisma.organization.create({
      data: { name: `WA Probe ${suffix}`, slug: `wa-probe-${suffix}`, industry: 'SME' },
    });
    await prisma.whatsAppConfig.create({
      data: {
        organizationId: org.id,
        phoneNumberId,
        whatsappBusinessId: 'PROBE_WABA',
        accessToken: 'PROBE_TOKEN_NOT_REAL',
        displayPhoneNumber: '+15550000000',
        webhookVerifyToken: 'probe-verify-token',
        isActive: true,
      },
    });
    console.log(`  fixture: org=${org.id.slice(0, 8)} phoneNumberId=${phoneNumberId}\n`);
  } catch (e) {
    console.error('  FATAL: fixture failed —', e.message);
    await prisma.$disconnect();
    process.exit(2);
  }

  const from = `2348${Date.now().toString().slice(-9)}`;

  // ── 1. Verification handshake ─────────────────────────────────────────────
  try {
    const token = process.env.WHATSAPP_VERIFY_TOKEN;
    const r = await fetch(`${API}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=probe12345`);
    const body = await r.text();
    record('WA-001', 'Webhook verification returns the challenge', body.trim() === 'probe12345'
      ? { ok: true, evidence: `echoed the challenge (${r.status})` }
      : { expected: 'the challenge echoed verbatim', actual: `${r.status} "${body.slice(0, 80)}" — Meta would refuse to subscribe` });
  } catch (e) {
    record('WA-001', 'Webhook verification returns the challenge', { expected: '200', actual: e.message });
  }

  try {
    const r = await fetch(`${API}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=probe12345`);
    const body = await r.text();
    record('WA-002', 'A wrong verify token is refused', (r.status === 403 || !body.includes('probe12345'))
      ? { ok: true, evidence: `${r.status}` }
      : { expected: '403', actual: `${r.status} echoed the challenge to an unauthenticated caller` });
  } catch (e) {
    record('WA-002', 'A wrong verify token is refused', { expected: '403', actual: e.message });
  }

  // ── 2. Signature enforcement ──────────────────────────────────────────────
  const forgedId = `wamid.FORGED_${Date.now()}`;
  await postWebhook(envelope(phoneNumberId, { from, id: forgedId, timestamp: '1', type: 'text', text: { body: 'forged' } }), { omitSignature: true });
  await postWebhook(envelope(phoneNumberId, { from, id: forgedId + '_B', timestamp: '1', type: 'text', text: { body: 'forged' } }), { signature: 'sha256=' + '0'.repeat(64) });
  await settle(2500);

  const forgedRows = await prisma.message.count({ where: { content: 'forged' } });
  record('WA-003', 'Unsigned and wrongly-signed payloads are not processed', forgedRows === 0
    ? { ok: true, evidence: 'neither payload created a message' }
    : { expected: '0 messages', actual: `${forgedRows} message(s) written from a forged webhook — anyone who learns the URL can inject conversations` });

  // ── 3. A genuine text message ─────────────────────────────────────────────
  const msgId = `wamid.PROBE_${Date.now()}`;
  const text = 'Hello, what are your opening hours?';
  await postWebhook(envelope(phoneNumberId, { from, id: msgId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }));
  await settle(6000);

  const contact = await prisma.contact.findFirst({ where: { organizationId: org.id, phoneNumber: { contains: from.slice(-9) } } });
  if (!contact) {
    record('WA-004', 'An inbound message creates the contact and conversation', {
      expected: 'a contact created from the sender', actual: 'no contact — the message was dropped entirely',
    });
  } else {
    const convo = await prisma.conversation.findFirst({ where: { organizationId: org.id, contactId: contact.id } });
    const msgs = convo ? await prisma.message.findMany({ where: { conversationId: convo.id }, orderBy: { sentAt: 'asc' } }) : [];
    record('WA-004', 'An inbound message creates the contact and conversation', convo && msgs.length
      ? { ok: true, evidence: `contact=${contact.fullName} conversation=${convo.id.slice(0, 8)} messages=${msgs.length} (${msgs.map((m) => m.sender).join(',')})` }
      : { expected: 'a conversation with the message stored', actual: `conversation=${convo ? 'yes' : 'no'} messages=${msgs.length}` });
  }

  // ── 4. Duplicate delivery — the one that matters ──────────────────────────
  const convo = contact ? await prisma.conversation.findFirst({ where: { organizationId: org.id, contactId: contact.id } }) : null;

  // Wait for the conversation to go QUIET before snapshotting. The assistant's reply to
  // the first message is asynchronous and slow; if it lands after the baseline is taken
  // it looks exactly like a duplicate reply, and the test would report a defect that is
  // really just its own impatience.
  const countAll = async () => (convo ? prisma.message.count({ where: { conversationId: convo.id } }) : 0);
  let stableFor = 0, last = await countAll();
  for (let w = 0; w < 30 && stableFor < 4; w++) {
    await settle(1000);
    const now = await countAll();
    stableFor = now === last ? stableFor + 1 : 0;
    last = now;
  }
  const before = last;
  const beforeCustomer = convo ? await prisma.message.count({ where: { conversationId: convo.id, sender: 'CUSTOMER' } }) : 0;

  // Meta redelivers the identical envelope, same wamid. This happens in production.
  await postWebhook(envelope(phoneNumberId, { from, id: msgId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }));
  // Generous: a second reply, if one were coming, would have to appear within this.
  await settle(12000);

  const after = convo ? await prisma.message.count({ where: { conversationId: convo.id } }) : 0;
  const afterCustomer = convo ? await prisma.message.count({ where: { conversationId: convo.id, sender: 'CUSTOMER' } }) : 0;
  const dupes = convo ? await prisma.message.count({ where: { conversationId: convo.id, content: text } }) : 0;

  // Two things must hold: the customer is not quoted twice, and — the part that reaches
  // the customer — the assistant does not answer the same question a second time.
  const customerDoubled = afterCustomer > beforeCustomer;
  const assistantAnsweredAgain = (after - before) > (afterCustomer - beforeCustomer);

  record('WA-005', 'A redelivered message is not processed twice',
    !customerDoubled && !assistantAnsweredAgain && dupes <= 1
      ? { ok: true, evidence: `customer turns unchanged at ${afterCustomer}, one copy of the text, no second reply sent` }
      : {
          expected: `${beforeCustomer} customer turn(s) and no new reply`,
          actual: `${afterCustomer} customer turn(s), ${dupes} copies of the text` +
                  (assistantAnsweredAgain ? ', and the assistant replied a second time — the customer is answered twice' : ''),
        });

  // ── 5. Unknown phone number id must not be routed anywhere ────────────────
  const strayId = `wamid.STRAY_${Date.now()}`;
  await postWebhook(envelope(`UNMAPPED_${Date.now()}`, { from: '2348099999999', id: strayId, timestamp: '1', type: 'text', text: { body: 'stray tenant probe' } }));
  await settle(3000);
  const stray = await prisma.message.count({ where: { content: 'stray tenant probe' } });
  record('WA-006', 'An unmapped phone number id is not routed to some other tenant', stray === 0
    ? { ok: true, evidence: 'dropped rather than delivered to an arbitrary organization' }
    : { expected: '0', actual: `${stray} message(s) landed in a tenant that does not own that number` });

  // ── 6. Status receipts must not become messages ───────────────────────────
  const statusEnvelope = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA_ID', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
      statuses: [{ id: msgId, status: 'delivered', timestamp: '1', recipient_id: from }],
    } }] }],
  };
  const beforeStatus = convo ? await prisma.message.count({ where: { conversationId: convo.id } }) : 0;
  await postWebhook(statusEnvelope);
  await settle(2500);
  const afterStatus = convo ? await prisma.message.count({ where: { conversationId: convo.id } }) : 0;
  record('WA-007', 'A delivery receipt does not create a message', afterStatus === beforeStatus
    ? { ok: true, evidence: `count unchanged at ${afterStatus}` }
    : { expected: `${beforeStatus}`, actual: `${afterStatus} — receipts are being stored as conversation turns` });

  // ── 7. Non-text message types are handled, not dropped ────────────────────
  const kinds = [
    { type: 'image', body: { image: { id: 'MEDIA_IMG', mime_type: 'image/jpeg', caption: 'here is the receipt' } } },
    { type: 'location', body: { location: { latitude: 6.5244, longitude: 3.3792, name: 'Lagos' } } },
    { type: 'interactive', body: { interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Yes please' } } } },
  ];
  // Count CUSTOMER turns before and after each send. A JSON-path filter on `metadata`
  // is the wrong instrument here — it would fail for reasons unrelated to whether the
  // message was stored.
  let handled = 0;
  const seen = [];
  for (const k of kinds) {
    const id = `wamid.${k.type.toUpperCase()}_${Date.now()}`;
    const pre = convo ? await prisma.message.count({ where: { conversationId: convo.id, sender: 'CUSTOMER' } }) : 0;
    await postWebhook(envelope(phoneNumberId, { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: k.type, ...k.body }));
    // An image goes through the selfie-attachment path, which attempts a media download
    // from Meta before falling through — so allow for a real network round trip, not
    // just the local write.
    let post = 0;
    for (let w = 0; w < 12; w++) {
      await settle(1000);
      post = convo ? await prisma.message.count({ where: { conversationId: convo.id, sender: 'CUSTOMER' } }) : 0;
      if (post > pre) break;
    }
    if (post > pre) {
      handled++;
      const last = await prisma.message.findFirst({ where: { conversationId: convo.id, sender: 'CUSTOMER' }, orderBy: { sentAt: 'desc' }, select: { content: true } });
      seen.push(`${k.type}→"${(last?.content || '').slice(0, 40)}"`);
    } else {
      seen.push(`${k.type}→NOT STORED`);
    }
  }
  record('WA-008', 'Image, location and interactive messages are recorded', handled === kinds.length
    ? { ok: true, evidence: seen.join('  ') }
    : { expected: `${kinds.length} stored`, actual: `${handled} stored — ${seen.join('  ')}` });

  // ── 8. Did the AI actually attempt a reply? ───────────────────────────────
  if (convo) {
    const replies = await prisma.message.count({ where: { conversationId: convo.id, sender: { in: ['AI', 'SYSTEM'] } } });
    record('WA-009', 'The assistant responds to the customer', replies > 0
      ? { ok: true, evidence: `${replies} outbound turn(s) recorded` }
      : { expected: 'a reply attempt', actual: 'no outbound turn at all — the customer messaged and nothing answered' });
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n' + '═'.repeat(74));
  console.log(`WHATSAPP PROBE  ${results.length} checks   PASS ${pass}   FAIL ${fail}`);
  console.log('═'.repeat(74) + '\n');

  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})();
