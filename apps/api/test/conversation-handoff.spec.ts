/**
 * Handing a conversation to a person, once.
 *
 * ── The drift this closes ───────────────────────────────────────────────────
 *
 * Two routes wrote the same three columns:
 *
 *   PATCH /api/conversations/:id/handoff          (channel-agnostic)
 *   POST  /api/whatsapp/conversations/:id/handoff (removed)
 *
 * They were not equivalent. Only the first calls
 * `AgentConsoleGateway.notifyHandoffChanged`, and the console called the
 * SECOND — so an officer taking a thread over was invisible to every other
 * console, and two officers could each believe they owned the citizen. The
 * agent-console carried a comment claiming the WhatsApp route was needed
 * because it "updates assignedUserId + handoff flag", which the surviving
 * route has always done; the real difference ran the other way.
 *
 * Handoff is not channel-specific — VOICE and WEBCHAT conversations are handed
 * to people too — so the channel-agnostic route is the one that survives.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';
import { AgentConsoleGateway } from '../src/events/agent-console.gateway';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('Conversation handoff', () => {
  let app: INestApplication;
  let owner: TestTenant;
  let viewerToken: string;
  let agentToken: string;
  let notified: Array<{ organizationId: string; conversation: any }>;

  jest.setTimeout(90000);

  /**
   * A conversation with its own contact.
   *
   * `Conversation` is unique on `[organizationId, contactId, channel]` — one
   * thread per citizen per channel — so each test needs its own citizen rather
   * than a second thread for the same one.
   */
  let seq = 0;
  const makeConversation = async (channel: 'WHATSAPP' | 'VOICE' = 'WHATSAPP') => {
    seq += 1;
    const contact = await prisma.contact.create({
      data: {
        organizationId: owner.orgId,
        fullName: `Thread Owner ${seq}`,
        phoneNumber: `+23480123495${String(seq).padStart(2, '0')}`,
      },
    });
    const conv = await prisma.conversation.create({
      data: {
        organizationId: owner.orgId,
        contactId: contact.id,
        channel,
        lastMessageAt: new Date(),
      },
    });
    return conv.id;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    owner = await createTenant(app, 'handoff-owner', { role: 'OWNER' });

    const jwt = app.get(JwtService);
    const mint = async (role: 'AGENT' | 'VIEWER') => {
      const u = await prisma.user.create({
        data: {
          organizationId: owner.orgId,
          email: `${role.toLowerCase()}-${owner.orgId.slice(0, 8)}@handoff.test`,
          passwordHash: 'not-a-login-path',
          fullName: `${role} user`,
          role,
        },
      });
      return jwt.sign({
        userId: u.id,
        organizationId: owner.orgId,
        email: u.email,
        fullName: u.fullName,
        role: u.role,
        tokenVersion: u.tokenVersion,
      });
    };
    agentToken = await mint('AGENT');
    viewerToken = await mint('VIEWER');

    // Capture what the console would be told, without a socket.
    notified = [];
    const gateway = app.get(AgentConsoleGateway);
    jest
      .spyOn(gateway, 'notifyHandoffChanged')
      .mockImplementation((organizationId: string, conversation: any) => {
        notified.push({ organizationId, conversation });
      });
  });

  afterAll(async () => {
    await dropTenant(owner?.orgId);
    await app?.close();
  });

  beforeEach(() => { notified.length = 0; });

  it('assigns the thread to whoever took it, and tells every other console', async () => {
    const id = await makeConversation();

    const res = await request(app.getHttpServer())
      .patch(`/api/conversations/${id}/handoff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ handoff: true });

    expect(res.status).toBe(200);

    const row = await prisma.conversation.findUnique({ where: { id } });
    expect(row?.isHumanHandoffActive).toBe(true);
    expect(row?.assignedUserId).toBe(owner.userId);

    // THE assertion the removed duplicate failed: other consoles hear about it.
    // Without this, two officers each believe they own the citizen.
    expect(notified).toHaveLength(1);
    expect(notified[0].organizationId).toBe(owner.orgId);
    expect(notified[0].conversation.id).toBe(id);
  });

  it('releases it back to the AI, and says so on the wire too', async () => {
    const id = await makeConversation();
    await request(app.getHttpServer())
      .patch(`/api/conversations/${id}/handoff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ handoff: true });
    notified.length = 0;

    const res = await request(app.getHttpServer())
      .patch(`/api/conversations/${id}/handoff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ handoff: false });

    expect(res.status).toBe(200);
    const row = await prisma.conversation.findUnique({ where: { id } });
    expect(row?.isHumanHandoffActive).toBe(false);
    // Released means nobody holds it, or the next officer sees it as taken.
    expect(row?.assignedUserId).toBeNull();
    expect(notified).toHaveLength(1);
  });

  it('works on a VOICE conversation, which is why it is not a WhatsApp route', async () => {
    const id = await makeConversation('VOICE');

    const res = await request(app.getHttpServer())
      .patch(`/api/conversations/${id}/handoff`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ handoff: true });

    expect(res.status).toBe(200);
    expect((await prisma.conversation.findUnique({ where: { id } }))?.isHumanHandoffActive).toBe(true);
  });

  it('is the only handoff route left', async () => {
    const id = await makeConversation();

    // The duplicate is gone rather than left as a second thing that can
    // silently stop broadcasting.
    const res = await request(app.getHttpServer())
      .post(`/api/whatsapp/conversations/${id}/handoff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ isHumanHandoffActive: true });

    expect(res.status).toBe(404);
    expect((await prisma.conversation.findUnique({ where: { id } }))?.isHumanHandoffActive).toBe(false);
  });

  describe('who may take a thread', () => {
    it('lets an AGENT, because that is the front desk', async () => {
      const id = await makeConversation();
      const res = await request(app.getHttpServer())
        .patch(`/api/conversations/${id}/handoff`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ handoff: true });

      expect(res.status).toBe(200);
    });

    it('refuses a VIEWER, because seizing a thread stops the AI replying', async () => {
      const id = await makeConversation();
      const res = await request(app.getHttpServer())
        .patch(`/api/conversations/${id}/handoff`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ handoff: true });

      expect(res.status).toBe(403);
      // A VIEWER taking a thread is an outage for that citizen with nobody
      // handling it, so nothing is written and nothing is broadcast.
      expect((await prisma.conversation.findUnique({ where: { id } }))?.isHumanHandoffActive).toBe(false);
      expect(notified).toHaveLength(0);
    });

    it('refuses a VIEWER sending a message as the agency', async () => {
      const id = await makeConversation();
      const res = await request(app.getHttpServer())
        .post(`/api/conversations/${id}/messages`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ content: 'Speaking for the ministry' });

      expect(res.status).toBe(403);
    });

    it('still lets every member read the thread', async () => {
      const id = await makeConversation();
      const res = await request(app.getHttpServer())
        .get(`/api/conversations/${id}/messages`)
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(200);
    });
  });

  it('refuses a conversation belonging to another agency', async () => {
    const other = await createTenant(app, 'handoff-other', { role: 'OWNER' });
    try {
      const id = await makeConversation();
      const res = await request(app.getHttpServer())
        .patch(`/api/conversations/${id}/handoff`)
        .set('Authorization', `Bearer ${other.token}`)
        .send({ handoff: true });

      expect(res.status).toBe(404);
      expect((await prisma.conversation.findUnique({ where: { id } }))?.isHumanHandoffActive).toBe(false);
    } finally {
      await dropTenant(other.orgId);
    }
  });
});
