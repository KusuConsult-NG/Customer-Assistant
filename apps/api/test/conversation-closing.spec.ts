import { randomBytes } from 'crypto';
import { prisma, encryptSecret } from '@ace/database';
import { MessageSender } from '@ace/shared-types';
import { ConversationClosingService, closingMessage } from '../src/whatsapp/conversation-closing.service';

/**
 * Closing a conversation that has gone quiet.
 *
 * Every assertion here is about NOT sending: a sweeper that messages citizens
 * on its own is one wrong predicate away from writing to people mid-booking,
 * under an officer's handoff, or twice from two pods.
 */
describe('closing a WhatsApp conversation after silence', () => {
  let orgId: string;
  let contactId: string;
  let service: ConversationClosingService;
  const sent: Array<{ to: string; text: string }> = [];
  let realFetch: typeof globalThis.fetch;

  jest.setTimeout(60000);

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    realFetch = globalThis.fetch;
    const org = await prisma.organization.create({
      data: { name: 'Quiet Agency', slug: `quiet-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
    });
    orgId = org.id;
    await prisma.whatsAppConfig.create({
      data: {
        organizationId: orgId,
        phoneNumberId: 'pnid_quiet',
        whatsappBusinessId: 'waba_quiet',
        accessToken: encryptSecret(`EAA${'q'.repeat(60)}`),
        webhookVerifyToken: encryptSecret('verify'),
        displayPhoneNumber: '+234 708 107 8679',
        isActive: true,
      },
    });
    const contact = await prisma.contact.create({
      data: { organizationId: orgId, fullName: 'Citizen', phoneNumber: `+23480${Date.now() % 100000000}` },
    });
    contactId = contact.id;
    service = new ConversationClosingService();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await prisma.message.deleteMany({ where: { conversation: { organizationId: orgId } } });
    await prisma.conversation.deleteMany({ where: { organizationId: orgId } });
    await prisma.contact.deleteMany({ where: { organizationId: orgId } });
    await prisma.whatsAppConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  });

  beforeEach(async () => {
    sent.length = 0;
    delete process.env.CONVERSATION_CLOSING_DISABLED;
    process.env.CONVERSATION_CLOSING_MINUTES = '5';
    await prisma.message.deleteMany({ where: { conversation: { organizationId: orgId } } });
    await prisma.conversation.deleteMany({ where: { organizationId: orgId } });
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes('graph.facebook.com')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        sent.push({ to: body.to, text: body.text?.body ?? '' });
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.test' }] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as any;
  });

  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

  const conversationWith = async (opts: {
    lastMessageAt: Date;
    lastSender?: MessageSender;
    handoff?: boolean;
    flowState?: any;
  }) => {
    const c = await prisma.conversation.create({
      data: {
        organizationId: orgId,
        contactId,
        channel: 'WHATSAPP',
        lastMessageAt: opts.lastMessageAt,
        isHumanHandoffActive: opts.handoff ?? false,
        ...(opts.flowState ? { flowState: opts.flowState } : {}),
      },
    });
    await prisma.message.create({
      data: {
        conversationId: c.id,
        sender: opts.lastSender ?? MessageSender.AI,
        content: 'Earlier reply',
        sentAt: opts.lastMessageAt,
      },
    });
    return c;
  };

  it('closes a conversation quiet for longer than the window', async () => {
    await conversationWith({ lastMessageAt: minutesAgo(7) });
    const r = await service.sweep();
    expect(r.closed).toBe(1);
    expect(sent).toHaveLength(1);
    // The State's channels, and an explicit invitation to come back — a
    // sign-off that reads like a door shutting is worse than none.
    expect(sent[0].text).toContain('facebook.com/PLSGov');
    expect(sent[0].text).toContain('@plsgovt');
    expect(sent[0].text).toMatch(/send another message any time/i);
  });

  it('leaves a conversation that has only just gone quiet', async () => {
    await conversationWith({ lastMessageAt: minutesAgo(2) });
    expect((await service.sweep()).closed).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('does not close under a HUMAN HANDOFF', async () => {
    await conversationWith({ lastMessageAt: minutesAgo(30), handoff: true });
    // An officer is holding that conversation. A bot closing it underneath
    // them is worse than no closing at all.
    expect((await service.sweep()).closed).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('does not close a flow in progress', async () => {
    await conversationWith({
      lastMessageAt: minutesAgo(30),
      flowState: { flow: 'BOOK_APPOINTMENT', step: 'pick-time' },
    });
    // The citizen is part-way through a booking. Closing abandons it.
    expect((await service.sweep()).closed).toBe(0);
  });

  it('does not close when the CITIZEN spoke last', async () => {
    await conversationWith({ lastMessageAt: minutesAgo(30), lastSender: MessageSender.CUSTOMER });
    // They are owed a reply, not a sign-off.
    expect((await service.sweep()).closed).toBe(0);
  });

  it('does not close outside the 24-hour window', async () => {
    await conversationWith({ lastMessageAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    // Meta refuses free-form messages past it; attempting one spends a
    // request to be told no.
    expect((await service.sweep()).closed).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('closes once when two sweeps run together', async () => {
    await conversationWith({ lastMessageAt: minutesAgo(7) });
    const [a, b] = await Promise.all([service.sweep(), service.sweep()]);
    // Message.externalId is unique, so the insert IS the claim.
    expect(a.closed + b.closed).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('records NOTHING when the send fails', async () => {
    await conversationWith({ lastMessageAt: minutesAgo(7) });
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 400 })) as any;

    await service.sweep();
    const messages = await prisma.message.findMany({
      where: { conversation: { organizationId: orgId } },
    });
    // A row saying the agency sent something it did not send is a lie an
    // officer reading the thread has no way to detect.
    expect(messages.filter((m) => m.content.includes('PLSGov'))).toHaveLength(0);
  });

  /**
   * The bug this file missed the first time.
   *
   * "Closes once when two sweeps run together" tested CONCURRENCY and passed,
   * so the suite looked like it covered idempotence. It did not test
   * REPETITION OVER TIME, which is the axis that actually broke: closing
   * bumped `lastMessageAt`, so five minutes later the conversation was quiet
   * again, its last message was still ours, and the claim key had moved with
   * `lastMessageAt` — so nothing blocked it. A citizen received the same
   * sign-off every five minutes until the 24-hour window shut.
   */
  describe('never closes the same quiet spell twice', () => {
    it('stays closed across repeated sweeps', async () => {
      await conversationWith({ lastMessageAt: minutesAgo(7) });

      expect((await service.sweep()).closed).toBe(1);
      for (let i = 0; i < 5; i++) {
        // Each sweep is a later one in real time; nothing has changed but the
        // clock, which is exactly the situation that produced the repeat.
        expect((await service.sweep(new Date(Date.now() + (i + 1) * 6 * 60_000))).closed).toBe(0);
      }
      expect(sent).toHaveLength(1);
    });

    it('does not move lastMessageAt, which is when the CITIZEN was last active', async () => {
      const c = await conversationWith({ lastMessageAt: minutesAgo(7) });
      await service.sweep();
      const after = await prisma.conversation.findUnique({ where: { id: c.id } });
      // Moving it re-arms the sweep and invalidates the claim built from it.
      expect(after!.lastMessageAt.toISOString()).toBe(c.lastMessageAt.toISOString());
    });

    it('closes AGAIN only once the citizen has written back', async () => {
      const c = await conversationWith({ lastMessageAt: minutesAgo(7) });
      expect((await service.sweep()).closed).toBe(1);

      // The citizen returns AFTER the sign-off — which is the only order
      // that can happen in reality, and the order the first version of this
      // test got wrong by dating the reply before the close.
      const returned = new Date(Date.now() + 60_000);
      await prisma.message.create({
        data: { conversationId: c.id, sender: MessageSender.CUSTOMER, content: 'One more thing', sentAt: returned },
      });
      await prisma.message.create({
        data: {
          conversationId: c.id,
          sender: MessageSender.AI,
          content: 'Here you are',
          sentAt: new Date(returned.getTime() + 1000),
        },
      });
      await prisma.conversation.update({ where: { id: c.id }, data: { lastMessageAt: returned } });

      // Seven minutes after they went quiet again.
      expect((await service.sweep(new Date(returned.getTime() + 7 * 60_000))).closed).toBe(1);
      expect(sent).toHaveLength(2);
    });
  });

  it('is off when disabled', async () => {
    process.env.CONVERSATION_CLOSING_DISABLED = '1';
    await conversationWith({ lastMessageAt: minutesAgo(30) });
    expect((await service.sweep()).closed).toBe(0);
  });

  it('honours a configured window', async () => {
    process.env.CONVERSATION_CLOSING_MINUTES = '60';
    await conversationWith({ lastMessageAt: minutesAgo(10) });
    expect((await service.sweep()).closed).toBe(0);
  });

  it('names the agency in the sign-off', () => {
    expect(closingMessage('Plateau Customer Care')).toContain('Plateau Customer Care');
  });
});
