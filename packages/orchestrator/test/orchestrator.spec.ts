/**
 * Behavioural guards for ConversationOrchestrator.
 *
 * These lock in the fixes for things the orchestrator used to assert to real
 * customers: that it was a human, that a fabricated appointment was confirmed, and
 * that money should be sent to a hardcoded bank account.
 *
 * Prisma is mocked, so these run without a database.
 */

const mockPrisma = {
  organization: { findUnique: jest.fn() },
  booking: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  reservation: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  contact: { findFirst: jest.fn(), create: jest.fn() },
  ticket: { create: jest.fn() },
  deal: { findMany: jest.fn() },
  documentChunk: { findMany: jest.fn() },
};

jest.mock('@ace/database', () => ({ prisma: mockPrisma }));

import { ConversationOrchestrator } from '../src/index';
import { ChannelType, MessageSender } from '@ace/shared-types';

const baseContext = () => ({
  conversationId: 'conv_abc123def',
  organizationId: 'org_1',
  customerPhoneNumber: '+2348031234567',
  channel: ChannelType.WHATSAPP,
  history: [],
  slots: {},
  isHumanHandoffActive: false,
});

describe('ConversationOrchestrator', () => {
  let orchestrator: ConversationOrchestrator;

  beforeEach(() => {
    jest.clearAllMocks();
    // No OpenAI key: exercise the deterministic paths, not the LLM.
    delete process.env.OPENAI_API_KEY;

    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Apex Care',
      aiPersonaPrompt: null,
      welcomeMessage: 'Hello from Apex Care!',
      payoutBankName: null,
      payoutAccountName: null,
      payoutAccountNumber: null,
      payoutUssdCode: null,
    });
    mockPrisma.documentChunk.findMany.mockResolvedValue([]);
    mockPrisma.booking.findMany.mockResolvedValue([]);
    mockPrisma.contact.findFirst.mockResolvedValue({ id: 'contact_1', fullName: 'Ada' });

    orchestrator = new ConversationOrchestrator();
  });

  describe('AI disclosure', () => {
    const questions = [
      'are you an ai?',
      'is this a bot',
      'am i talking to a machine',
      'are you human?',
      'is this a real person',
    ];

    it.each(questions)('answers "%s" honestly', async (question) => {
      const result = await orchestrator.processIncomingMessage(baseContext(), question);

      expect(result.intentDetected).toBe('AI_DISCLOSURE');
      expect(result.replyText).toMatch(/AI assistant/i);

      // Regression guard: this used to reply "Haha, no! I'm a customer support
      // representative here at ${orgName}" under a "Stealth Human Persona" heading.
      expect(result.replyText).not.toMatch(/haha,?\s*no/i);
      expect(result.replyText).not.toMatch(/I'?m a customer support representative/i);
    });
  });

  describe('Payment guidance', () => {
    it('refuses to invent bank details when the organization has configured none', async () => {
      const result = await orchestrator.processIncomingMessage(baseContext(), 'how do i pay?');

      expect(result.intentDetected).toBe('PROVIDE_PAYMENT_GUIDANCE');
      // Regression guard: it used to read out a hardcoded Providus Bank account
      // number and three invented USSD codes for every tenant.
      expect(result.replyText).not.toContain('9928374102');
      expect(result.replyText).not.toMatch(/providus/i);
      expect(result.replyText).not.toMatch(/\*737\*/);
      // And it hands over rather than guessing.
      expect(result.shouldHandoff).toBe(true);
    });

    it('uses the organization\'s own configured details when present', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        name: 'Apex Care',
        payoutBankName: 'Zenith Bank',
        payoutAccountName: 'Apex Care Ltd',
        payoutAccountNumber: '1234567890',
        payoutUssdCode: '*966*1#',
      });

      const result = await orchestrator.processIncomingMessage(baseContext(), 'send me your account number');

      expect(result.replyText).toContain('Zenith Bank');
      expect(result.replyText).toContain('1234567890');
      expect(result.shouldHandoff).toBe(false);
    });
  });

  describe('Appointment booking', () => {
    it('books a real free slot inside business hours and reports the time it took', async () => {
      mockPrisma.booking.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'booking_12345678', ...data })
      );

      const result = await orchestrator.processIncomingMessage(
        baseContext(),
        'I want to book an appointment'
      );

      expect(result.intentDetected).toBe('BOOK_APPOINTMENT');
      expect(mockPrisma.booking.create).toHaveBeenCalledTimes(1);

      const created = mockPrisma.booking.create.mock.calls[0][0].data;
      const start: Date = created.startTime;

      // Inside Mon–Fri 08:00–18:00 West Africa Time (UTC+1).
      const watHour = (start.getUTCHours() + 1) % 24;
      const watDay = new Date(start.getTime() + 3600_000).getUTCDay();
      expect(watHour).toBeGreaterThanOrEqual(8);
      expect(watHour).toBeLessThan(18);
      expect(watDay).not.toBe(0);
      expect(watDay).not.toBe(6);
      expect(start.getTime()).toBeGreaterThan(Date.now());

      // Regression guard: the reply used to be an unconditional
      // "✅ Your appointment has been confirmed for <tomorrow 10am>" regardless of
      // what the customer asked for or whether the slot was free.
      expect(result.replyText).toMatch(/reschedule/i);
    });

    it('does not double-book an occupied slot', async () => {
      // Every slot in the search horizon is taken.
      const now = Date.now();
      mockPrisma.booking.findMany.mockResolvedValue([
        { startTime: new Date(now), endTime: new Date(now + 15 * 24 * 3600_000) },
      ]);

      const result = await orchestrator.processIncomingMessage(
        baseContext(),
        'book an appointment please'
      );

      expect(mockPrisma.booking.create).not.toHaveBeenCalled();
      expect(result.shouldHandoff).toBe(true);
    });

    it('hands over instead of guessing when there is no phone number to book under', async () => {
      mockPrisma.contact.findFirst.mockResolvedValue(null);
      mockPrisma.contact.create.mockRejectedValue(new Error('no phone'));

      const result = await orchestrator.processIncomingMessage(
        { ...baseContext(), customerPhoneNumber: undefined },
        'book an appointment'
      );

      expect(result.shouldHandoff).toBe(true);
      expect(mockPrisma.booking.create).not.toHaveBeenCalled();
    });
  });

  describe('Reservations', () => {
    it('reads the party size from the message instead of always assuming two', async () => {
      mockPrisma.reservation.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'res_12345678', ...data })
      );

      await orchestrator.processIncomingMessage(baseContext(), 'book a table for 6 please');

      expect(mockPrisma.reservation.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.reservation.create.mock.calls[0][0].data.partySize).toBe(6);
    });

    it('understands spelled-out party sizes', async () => {
      mockPrisma.reservation.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'res_1', ...data })
      );

      await orchestrator.processIncomingMessage(baseContext(), 'make a reservation for four');

      expect(mockPrisma.reservation.create.mock.calls[0][0].data.partySize).toBe(4);
    });
  });

  describe('Quotations', () => {
    it('refuses to quote a made-up price when there is no deal history', async () => {
      mockPrisma.deal.findMany.mockResolvedValue([]);

      const result = await orchestrator.processIncomingMessage(baseContext(), 'how much for a consultation?');

      expect(result.intentDetected).toBe('REQUEST_QUOTATION');
      // Regression guard: it used to return a flat "₦35,000" for every business, plus
      // a link to /api/documents/quotation/<n>.pdf — a route that does not exist.
      expect(result.replyText).not.toContain('35,000');
      expect(result.replyText).not.toContain('.pdf');
      expect(result.shouldHandoff).toBe(true);
    });

    it('quotes an indicative range from the organization\'s own closed deals', async () => {
      mockPrisma.deal.findMany.mockResolvedValue([
        { title: 'Retainer', amount: 200_000, currency: 'NGN' },
        { title: 'Retainer', amount: 500_000, currency: 'NGN' },
      ]);

      const result = await orchestrator.processIncomingMessage(baseContext(), 'what is your pricing?');

      expect(result.replyText).toContain('200,000');
      expect(result.replyText).toContain('500,000');
      expect(result.shouldHandoff).toBe(false);
    });
  });

  describe('Escalation', () => {
    it('hands over when the customer asks for a person', async () => {
      const result = await orchestrator.processIncomingMessage(baseContext(), 'I want to speak to human');
      expect(result.shouldHandoff).toBe(true);
    });

    it('stays silent while a human already has the conversation', async () => {
      const result = await orchestrator.processIncomingMessage(
        { ...baseContext(), isHumanHandoffActive: true },
        'hello?'
      );
      expect(result.replyText).toBe('');
      expect(result.shouldHandoff).toBe(true);
    });
  });

  describe('Greeting', () => {
    it('uses the organization welcome message', async () => {
      const result = await orchestrator.processIncomingMessage(baseContext(), 'hello');
      expect(result.intentDetected).toBe('GREETING');
      expect(result.replyText).toBe('Hello from Apex Care!');
    });
  });
});
