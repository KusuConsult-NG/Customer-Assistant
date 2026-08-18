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

/**
 * Only `prisma` is replaced. The pure helpers stay real.
 *
 * Replacing the whole module used to be fine — it exported little else that the
 * orchestrator touched. Then phone-number normalisation landed, the orchestrator
 * started calling `phoneNumberVariants` on the contact lookup, and this mock
 * handed it `undefined`. Every tool that resolves a contact first threw, took
 * the honest `toolFailureReply()` path, and three tests failed claiming bookings
 * were no longer created — a real-looking regression in code that was fine.
 *
 * Required from the source file rather than the package entrypoint on purpose:
 * the entrypoint constructs a PrismaClient at import time, which is the whole
 * reason `prisma` is mocked here.
 */
jest.mock('@ace/database', () => ({
  ...jest.requireActual('../../database/src/phone-number'),
  prisma: mockPrisma,
}));

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

  /**
   * The service name written into a real calendar and read back to the customer.
   *
   * "book me an appointment" produced the service name "Me an" — scraped out of
   * "book **me an** appointment" — and the customer was told "I've put you down
   * for *Me an*". Nothing failed; it wrote nonsense into a real booking and
   * asserted it as fact, which is invariant 1 in the engine serving every
   * customer today.
   *
   * Found by `npm run parity`: the agent path refused the same input, so a
   * cutover would have silently changed the answer.
   */
  describe('The service a booking is filed under', () => {
    const bookedService = async (message: string) => {
      mockPrisma.booking.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'booking_12345678', ...data })
      );
      const result = await orchestrator.processIncomingMessage(baseContext(), message);
      expect(mockPrisma.booking.create).toHaveBeenCalledTimes(1);
      return {
        stored: mockPrisma.booking.create.mock.calls[0][0].data.serviceName,
        said: result.replyText,
      };
    };

    it('does not file a booking under filler scraped from the sentence', async () => {
      const { stored, said } = await bookedService('book me an appointment');

      expect(stored).toBe('General Consultation');
      // The bug as the customer met it.
      expect(said).not.toMatch(/\bMe an\b/);
    });

    it.each([
      // Filler scraped from between the verb and "appointment".
      'book me an appointment for the 45th of Neveruary at 99:99',
      'schedule me an appointment',
      // No filler, but no service either — the customer named only the generic
      // word for a booking. Filed as "Appointment", it reads in a calendar
      // exactly like a service the business offers.
      'i want an appointment',
      'i need an appointment please',
      // The pattern anchors on the first trigger verb, so a second one lands
      // inside the capture. This filed as "Book".
      'i want to book an appointment',
      'i would like to schedule an appointment',
      'can i set up an appointment',
    ])('falls back to the default rather than inventing a service for %j', async (message) => {
      const { stored } = await bookedService(message);
      // Honest: it says a service was not identified, instead of naming one the
      // business does not offer.
      expect(stored).toBe('General Consultation');
    });

    it('still keeps a real service the customer named', async () => {
      // The whole point of extracting at all — a regression here would file
      // every booking as "General Consultation" and lose the detail.
      const { stored } = await bookedService('i want to book a dental cleaning appointment');
      expect(stored).toMatch(/dental cleaning/i);
    });

    it("keeps the customer's own casing for a named service", async () => {
      const { stored } = await bookedService('book an MRI Scan appointment');
      expect(stored).toBe('MRI Scan');
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
