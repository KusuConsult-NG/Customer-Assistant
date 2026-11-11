import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { WhatsappService } from '../src/whatsapp/whatsapp.service';
import { validateMedia, bytesMatchMime } from '../src/whatsapp/media-understanding';
import { shouldAdvance } from '../src/whatsapp/delivery-status';

/**
 * PRD §06: WhatsApp is a full care channel — voice notes are UNDERSTOOD,
 * photos and documents are read, files are validated before any provider sees
 * them, and every reply's delivery is tracked.
 *
 * Before this, a voice note reached the assistant as the literal string
 * "[Customer sent a voice message]" and Meta's delivered/read/failed receipts
 * were logged and dropped. These tests drive the real webhook processing path
 * with Meta, Deepgram and the chat model stubbed at `fetch`, and assert on the
 * requests made and the rows written — not on the reply wording alone.
 */
describe('WhatsApp media understanding and delivery tracking', () => {
  let app: INestApplication;
  let service: WhatsappService;
  let orgId: string;
  let phoneNumberId: string;
  let realFetch: typeof globalThis.fetch;
  const savedEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  jest.setTimeout(60000);

  const CITIZEN = `23480${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const OGG = Buffer.concat([Buffer.from('OggS'), randomBytes(200)]);
  const EXE_AS_PDF = Buffer.concat([Buffer.from([0x4d, 0x5a]), randomBytes(200)]);

  let sent: Array<{ to: string; text: string; wamid: string }> = [];
  let providerCalls: string[] = [];
  let mediaBytes: Buffer = OGG;
  let mediaMime = 'audio/ogg; codecs=opus';
  let deepgramReply: () => Response = () =>
    new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: '' }] }] } }), { status: 200 });

  const stub = () => {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes('api.deepgram.com')) {
        providerCalls.push('deepgram');
        return deepgramReply();
      }
      if (url.includes('/chat/completions')) {
        providerCalls.push('llm');
        return new Response('{"error":"not in this test"}', { status: 500 });
      }
      if (url.endsWith('/messages')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.status === 'read') return new Response('{"success":true}', { status: 200 });
        const wamid = `wamid.${randomBytes(6).toString('hex')}`;
        sent.push({ to: body.to, text: body.text?.body ?? '', wamid });
        return new Response(JSON.stringify({ messages: [{ id: wamid }] }), { status: 200 });
      }
      if (url.includes('lookaside.example/media')) {
        return new Response(new Uint8Array(mediaBytes), { status: 200, headers: { 'content-type': mediaMime } });
      }
      if (/\/v\d+\.\d+\/media_/.test(url)) {
        return new Response(JSON.stringify({ url: 'https://lookaside.example/media/x' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as any;
  };

  const inbound = (message: Record<string, any>) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '2349000000000', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Test Citizen' }, wa_id: CITIZEN }],
              messages: [
                {
                  from: CITIZEN,
                  id: `wamid.in.${randomBytes(6).toString('hex')}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  });

  const receipt = (wamid: string, status: string, extra: Record<string, any> = {}) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: { statuses: [{ id: wamid, status, recipient_id: CITIZEN, timestamp: String(Math.floor(Date.now() / 1000)), ...extra }] } }] }],
  });

  const deliver = (payload: any) => service.processIncomingWebhook(payload, `t-${randomBytes(3).toString('hex')}`);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    setEnv('DEEPGRAM_API_KEY', 'dg-test-key');
    setEnv('OPENAI_API_KEY', undefined);
    realFetch = globalThis.fetch;
    app = await createTestApp();
    service = app.get(WhatsappService);

    orgId = (
      await prisma.organization.create({
        data: { name: 'Media Test Agency', slug: `media-${randomBytes(5).toString('hex')}`, industry: 'GOVERNMENT' },
      })
    ).id;
    phoneNumberId = `pn_${randomBytes(6).toString('hex')}`;
    await prisma.whatsAppConfig.create({
      data: {
        organizationId: orgId,
        phoneNumberId,
        displayPhoneNumber: '+2349000000000',
        whatsappBusinessId: 'waba-media-test',
        accessToken: `EAA${'t'.repeat(60)}`,
        webhookVerifyToken: `verify_${randomBytes(6).toString('hex')}`,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await prisma.message.deleteMany({ where: { conversation: { organizationId: orgId } } });
    await prisma.conversation.deleteMany({ where: { organizationId: orgId } });
    await prisma.contact.deleteMany({ where: { organizationId: orgId } });
    await prisma.whatsAppConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await app.close();
  });

  beforeEach(async () => {
    sent = [];
    providerCalls = [];
    mediaBytes = OGG;
    mediaMime = 'audio/ogg; codecs=opus';
    stub();
    // Each test starts on a thread nobody has taken over.
    await prisma.conversation.updateMany({ where: { organizationId: orgId }, data: { isHumanHandoffActive: false } });
  });

  describe('voice notes', () => {
    it('transcribes a voice note and answers what was SAID — here, an emergency', async () => {
      deepgramReply = () =>
        new Response(
          JSON.stringify({
            results: { channels: [{ detected_language: 'en', alternatives: [{ transcript: 'There is a fire outbreak in Terminus market' }] }] },
          }),
          { status: 200 },
        );
      const payload = inbound({ type: 'audio', audio: { id: `media_${randomBytes(4).toString('hex')}`, mime_type: 'audio/ogg' } });
      await deliver(payload);

      expect(providerCalls).toContain('deepgram');
      // The stored inbound message carries the transcript, not only the placeholder.
      const stored = await prisma.message.findUnique({ where: { externalId: payload.entry[0].changes[0].value.messages[0].id } });
      expect(stored!.content).toMatch(/Transcript: There is a fire outbreak/);
      expect((stored!.metadata as any).media).toMatchObject({ kind: 'audio', understood: true });

      // The citizen is told to call 112 and NOT told responders are coming.
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toMatch(/112/);
      expect(sent[0].text).not.toMatch(/dispatched|on (their|the) way|help is coming/i);

      const conv = await prisma.conversation.findFirst({ where: { organizationId: orgId } });
      expect(conv!.isHumanHandoffActive).toBe(true);
      expect(conv!.handoffReason).toBe('URGENT_ESCALATION');
    });

    it('says it could not hear the voice note when transcription fails — and does not guess', async () => {
      deepgramReply = () => new Response('{"err_msg":"bad audio"}', { status: 400 });
      await deliver(inbound({ type: 'audio', audio: { id: `media_${randomBytes(4).toString('hex')}` } }));
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toMatch(/couldn't make out that voice note/i);
      expect(providerCalls).not.toContain('llm');
    });
  });

  describe('validation before any provider sees the file', () => {
    it('refuses an executable sent as a PDF, without forwarding it anywhere', async () => {
      mediaBytes = EXE_AS_PDF;
      mediaMime = 'application/pdf';
      const payload = inbound({ type: 'document', document: { id: `media_${randomBytes(4).toString('hex')}`, filename: 'budget.pdf' } });
      await deliver(payload);
      expect(providerCalls).toEqual([]);
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toMatch(/can't open that kind of file/i);
      const stored = await prisma.message.findUnique({ where: { externalId: payload.entry[0].changes[0].value.messages[0].id } });
      expect((stored!.metadata as any).media).toMatchObject({ understood: false, reason: 'unsupported_type' });
    });

    it('checks type, size and magic bytes', () => {
      expect(validateMedia('image', Buffer.from([0xff, 0xd8, 0xff, 0, 0]), 'image/jpeg')).toBeNull();
      expect(validateMedia('image', Buffer.from([0xff, 0xd8, 0xff]), 'image/gif')).toMatchObject({ reason: 'unsupported_type' });
      expect(validateMedia('image', Buffer.alloc(6 * 1024 * 1024, 0xff), 'image/jpeg')).toMatchObject({ reason: 'too_large' });
      expect(bytesMatchMime(Buffer.from('%PDF-1.7'), 'application/pdf')).toBe(true);
      expect(bytesMatchMime(Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 'text/plain')).toBe(false);
    });
  });

  describe('delivery receipts', () => {
    it('records sent → delivered → read, ignores a late delivered, and records a failure', async () => {
      await deliver(inbound({ type: 'text', text: { body: 'Is anybody there? This is an emergency' } }));
      expect(sent).toHaveLength(1);
      const wamid = sent[0].wamid;
      const row = () => prisma.message.findUnique({ where: { externalId: wamid } });

      expect(((await row())!.metadata as any).delivery.status).toBe('sent');
      await deliver(receipt(wamid, 'read'));
      expect(((await row())!.metadata as any).delivery.status).toBe('read');
      // Meta does not guarantee order; a late "delivered" must not un-read it.
      await deliver(receipt(wamid, 'delivered'));
      expect(((await row())!.metadata as any).delivery.status).toBe('read');

      await deliver(inbound({ type: 'text', text: { body: 'there is a building collapse' } }));
      const second = sent[sent.length - 1].wamid;
      await deliver(receipt(second, 'failed', { errors: [{ code: 131047, title: 'Re-engagement message' }] }));
      const failed = await prisma.message.findUnique({ where: { externalId: second } });
      expect((failed!.metadata as any).delivery).toMatchObject({ status: 'failed', error: 'Re-engagement message', code: 131047 });
    });

    it('only moves forward', () => {
      expect(shouldAdvance('sent', 'delivered')).toBe(true);
      expect(shouldAdvance('read', 'delivered')).toBe(false);
      expect(shouldAdvance('read', 'failed')).toBe(true);
      expect(shouldAdvance('failed', 'read')).toBe(false);
    });
  });
});
