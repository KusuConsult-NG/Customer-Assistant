/**
 * Invariant 5: conversation lists return the LAST N messages, never the first N.
 *
 * CLAUDE.md lists this as reversing a shipped bug, and it had quietly
 * un-reversed in two places — both `orderBy: asc` + `take`, which is "the first
 * N" wearing pagination's clothes:
 *
 *   1. GET /api/conversations/:id/messages served messages 1..200 of a long
 *      thread. The page size of 200 is what kept it invisible: short threads
 *      fit, so the ordering never mattered until a thread grew past it — and
 *      then an operator opening the conversation saw its beginning, with
 *      everything the customer said recently unreachable from the dashboard.
 *
 *   2. The WhatsApp inbound path fetched conversation "history (last 10
 *      messages)" — said the comment — as the FIRST ten. Once a thread grew
 *      past ten messages the AI's context window froze at the conversation's
 *      opening, permanently: every later message was answered with the
 *      customer's greeting as context and none of what they had just said.
 *
 * Both are pinned against the real database, because both defects lived in the
 * query — a mocked Prisma would have asserted the mock.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';
import { WhatsappService } from '../src/whatsapp/whatsapp.service';

describe('Conversation history returns the last N messages', () => {
  let app: INestApplication;
  let orgId: string;
  let token: string;

  jest.setTimeout(60000);

  /** Seed `count` one-minute-spaced messages, numbered so order is checkable. */
  const seedThread = async (count: number, phoneNumber: string) => {
    const contact = await prisma.contact.create({
      data: { organizationId: orgId, phoneNumber, fullName: 'Marathon Talker' },
    });
    const conversation = await prisma.conversation.create({
      data: { organizationId: orgId, contactId: contact.id, channel: 'WHATSAPP' },
    });
    const base = Date.now() - (count + 10) * 60_000;
    await prisma.message.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        conversationId: conversation.id,
        sender: i % 2 ? ('AI' as const) : ('CUSTOMER' as const),
        content: `msg ${String(i + 1).padStart(3, '0')}`,
        sentAt: new Date(base + (i + 1) * 60_000),
      })),
    });
    return conversation;
  };

  const numbersOf = (messages: any[]) => messages.map((m) => parseInt(m.content.slice(4), 10));

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    const email = `history.${randomBytes(4).toString('hex')}@history.test`;
    const password = 'HistoryPassw0rd!';
    const reg = await request(app.getHttpServer()).post('/api/auth/register').send({
      organizationName: 'History Test Ltd',
      industry: 'OTHER',
      email,
      password,
      fullName: 'History Tester',
    });
    expect(reg.status).toBeLessThan(400);
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password });
    token = login.body.accessToken;
    orgId = login.body.user.organizationId;
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    await app?.close();
  });

  describe('GET /api/conversations/:id/messages', () => {
    it('shows the END of a thread longer than the page, not its beginning', async () => {
      const conversation = await seedThread(250, '+2348030007101');

      const res = await request(app.getHttpServer())
        .get(`/api/conversations/${conversation.id}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const nums = numbersOf(res.body);
      // The newest message is what the operator opened the thread to see.
      expect(Math.max(...nums)).toBe(250);
      // And the page is still rendered oldest→newest — desc is the query's
      // business, not the client's.
      expect(nums).toEqual([...nums].sort((a, b) => a - b));
    });

    it('pages BACKWARD from a cursor — scroll-up-for-history, not forward from the start of time', async () => {
      const conversation = await seedThread(250, '+2348030007102');

      const page1 = await request(app.getHttpServer())
        .get(`/api/conversations/${conversation.id}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const page2 = await request(app.getHttpServer())
        .get(`/api/conversations/${conversation.id}/messages`)
        .query({ before: page1.body[0].sentAt })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const n1 = numbersOf(page1.body);
      const n2 = numbersOf(page2.body);
      // Page 2 is everything OLDER than page 1, with no gap and no overlap.
      expect(Math.max(...n2)).toBe(Math.min(...n1) - 1);
      expect(Math.min(...n2)).toBe(1);
    });
  });

  describe('the history handed to the WhatsApp orchestrator', () => {
    it("is the newest ten messages, not the thread's opening", async () => {
      const phoneNumberId = `pnid_${randomBytes(4).toString('hex')}`;
      const customerNumber = '2348030007103';
      await prisma.whatsAppConfig.create({
        data: {
          organizationId: orgId,
          phoneNumberId,
          whatsappBusinessId: 'waba_test',
          // Legacy plaintext, which withWhatsAppCredentials still reads.
          accessToken: 'legacy-plaintext-token',
          displayPhoneNumber: '+2348000000001',
          webhookVerifyToken: 'verify',
        },
      });
      const conversation = await seedThread(15, `+${customerNumber}`);

      // Capture the context instead of answering; an empty replyText also means
      // nothing is handed to the Meta send client, so no network is involved.
      const service = app.get(WhatsappService);
      const captured: any[] = [];
      (service as any).orchestrator = {
        processIncomingMessage: async (context: any) => {
          captured.push(context);
          return { replyText: '', confidenceScore: 1, shouldHandoff: false };
        },
      };

      await service.processIncomingWebhook(
        {
          entry: [
            {
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: phoneNumberId },
                    messages: [
                      {
                        from: customerNumber,
                        id: `wamid.${randomBytes(6).toString('hex')}`,
                        type: 'text',
                        text: { body: 'so what about my booking then?' },
                        timestamp: String(Math.floor(Date.now() / 1000)),
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
        'history-test'
      );

      expect(captured).toHaveLength(1);
      const history = captured[0].history;
      expect(history).toHaveLength(10);

      // The inbound message is persisted before the history fetch, so the
      // newest ten are msg 007..015 plus the message itself.
      const texts = history.map((h: any) => h.content);
      expect(texts[texts.length - 1]).toBe('so what about my booking then?');
      expect(texts).toContain('msg 015');
      // The frozen-window bug: these were the ONLY things the AI ever saw.
      expect(texts).not.toContain('msg 001');
      expect(texts).not.toContain('msg 006');

      // Chronological, oldest→newest — what a conversation context means.
      const times = history.map((h: any) => new Date(h.timestamp).getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));

      // The conversation persists, so a re-run of this spec against the same
      // database must not collide on the config's phoneNumberId.
      await prisma.whatsAppConfig.deleteMany({ where: { phoneNumberId } });
      void conversation;
    });
  });
});
