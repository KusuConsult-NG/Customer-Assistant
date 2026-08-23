/**
 * Reserving a table for the number of people who are actually coming.
 *
 * The party size is the point of this file. It used to be:
 *
 *     const partySize = extractPartySize(messageText) ?? 2;
 *
 * so a message that named no number became a table for TWO — written into a
 * real reservation, read back as though the customer had said it, and the
 * restaurant set two covers for a group of eight. Nothing failed and nothing
 * was logged, which is what makes it worse than a crash.
 */

const mockPrisma = {
  organization: { findUnique: jest.fn() },
  conversation: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), upsert: jest.fn() },
  booking: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  reservation: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  contact: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  ticket: { create: jest.fn() },
  deal: { findMany: jest.fn() },
  documentChunk: { findMany: jest.fn() },
  faqEntry: { findMany: jest.fn() },
  note: { create: jest.fn() },
};

jest.mock('@ace/database', () => ({
  ...jest.requireActual('../../database/src/phone-number'),
  ...jest.requireActual('../../database/src/availability'),
  ...jest.requireActual('../../database/src/booking-conflicts'),
  prisma: mockPrisma,
  upsertEnrollee: jest.fn(),
  Prisma: { DbNull: null },
}));

import { ConversationOrchestrator } from '../src/index';
import { advanceFlow, beginFlow, type FlowState } from '../src/flows';
import {
  RESERVATION_FLOW, TABLE_SLOTS_KEY, partySizeOf, chosenTableSlot, type TableSlot,
} from '../src/reservation-flow';
import { ChannelType } from '@ace/shared-types';

const F = RESERVATION_FLOW;
const CONV = 'conv_res_1';
const CALLER = '+2348031234567';

const HOUR = 60 * 60 * 1000;
const soon = (h: number) => new Date(Date.now() + h * HOUR);

const TABLES: TableSlot[] = [
  { startIso: soon(24).toISOString(), endIso: soon(25.5).toISOString(), label: 'Monday 24 August, 11:00' },
  { startIso: soon(30).toISOString(), endIso: soon(31.5).toISOString(), label: 'Monday 24 August, 15:30' },
  { startIso: soon(72).toISOString(), endIso: soon(73.5).toISOString(), label: 'Wednesday 26 August, 10:00' },
];

function seeded(partySize?: number): FlowState {
  const state = beginFlow(F);
  state.collected[TABLE_SLOTS_KEY] = JSON.stringify(TABLES);
  if (partySize !== undefined) state.collected.partySize = String(partySize);
  return state;
}

describe('the party size', () => {
  it('is ASKED FOR when the message did not name one', () => {
    // The defect: this silently became a table for two.
    const step = advanceFlow(F, seeded(), '', 'en');

    expect(step.kind).toBe('ask');
    if (step.kind === 'ask') {
      expect(step.state.awaiting).toBe('partySize');
      expect(step.reply).toMatch(/how many people/i);
      // And nothing has been assumed in the meantime.
      expect(partySizeOf(step.state.collected)).toBeNull();
    }
  });

  it('is not asked for again when the message named one', () => {
    const step = advanceFlow(F, seeded(6), '', 'en');

    expect(step.kind).toBe('ask');
    if (step.kind === 'ask') {
      expect(step.state.awaiting).toBe('when');
      expect(step.reply).toMatch(/table for 6 guests/i);
    }
  });

  it('takes a number or a word, including the local ones', () => {
    for (const [said, expected] of [
      ['8', 8], ['just 3 of us', 3], ['four', 4], ['twelve', 12],
      ['mu biyar ne', 5],   // Hausa: we are five
      ['anyị bụ ise', 5],   // Igbo: we are five
      ['awa merin', 4],     // Yoruba: we are four
    ] as Array<[string, number]>) {
      const asked = advanceFlow(F, seeded(), '', 'en');
      if (asked.kind !== 'ask') throw new Error('expected the party-size question');
      const step = advanceFlow(F, asked.state, said, 'en');
      if (step.kind === 'ask') {
        expect(partySizeOf(step.state.collected)).toBe(expected);
      }
    }
  });

  it('refuses a number it cannot seat, and says what to do instead', () => {
    const asked = advanceFlow(F, seeded(), '', 'en');
    if (asked.kind !== 'ask') throw new Error('expected the party-size question');

    const step = advanceFlow(F, asked.state, '80', 'en');
    expect(step.kind).toBe('ask');
    if (step.kind === 'ask') {
      // Pinned on STILL AWAITING the party size, not on the reply text.
      //
      // The obvious assertions here both pass when the bound is removed, by
      // coincidence: the TIME question also contains "speak to an agent", and
      // `partySizeOf` does its own bounds check so it reads null either way.
      // Mutation testing caught that — the test looked right and tested
      // nothing.
      expect(step.state.awaiting).toBe('partySize');
      expect(step.state.collected.partySize).toBeUndefined();
      expect(step.reply).toMatch(/more than we can seat/i);
      expect(step.reply).not.toMatch(/here is what is free/i);
    }
  });

  it('re-asks rather than assuming when the answer is not a number', () => {
    const asked = advanceFlow(F, seeded(), '', 'en');
    if (asked.kind !== 'ask') throw new Error('expected the party-size question');

    const step = advanceFlow(F, asked.state, 'the usual', 'en');
    expect(step.kind).toBe('ask');
    if (step.kind === 'ask') {
      expect(step.reply).toMatch(/how many people/i);
      expect(partySizeOf(step.state.collected)).toBeNull();
    }
  });
});

describe('choosing a table time', () => {
  it('reserves on the pick, with the size stated in the question that was answered', () => {
    const asked = advanceFlow(F, seeded(4), '', 'en');
    if (asked.kind !== 'ask') throw new Error('expected the time question');
    expect(asked.reply).toMatch(/table for 4 guests/i);

    const step = advanceFlow(F, asked.state, '3', 'en');
    expect(step.kind).toBe('execute');
    if (step.kind === 'execute') {
      expect(chosenTableSlot(step.state.collected)?.label).toBe('Wednesday 26 August, 10:00');
      expect(partySizeOf(step.state.collected)).toBe(4);
    }
  });

  it('refuses a time nobody offered rather than parsing it', () => {
    const asked = advanceFlow(F, seeded(2), '', 'en');
    if (asked.kind !== 'ask') throw new Error('expected the time question');

    const step = advanceFlow(F, asked.state, 'friday evening around 8', 'en');
    expect(step.kind).toBe('ask');
    if (step.kind === 'ask') expect(step.state.collected.when).toBeUndefined();
  });

  it('lets the customer out', () => {
    const step = advanceFlow(F, seeded(2), 'forget it', 'en');
    expect(step.kind).toBe('abandon');
  });
});

describe('through the orchestrator', () => {
  const orchestrator = new ConversationOrchestrator();
  let flowState: any = null;

  const ctx = (channel: ChannelType = ChannelType.WHATSAPP) => ({
    conversationId: CONV,
    organizationId: 'org_1',
    customerPhoneNumber: CALLER,
    channel,
    history: [],
    slots: {},
    isHumanHandoffActive: false,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    flowState = null;
    mockPrisma.contact.findFirst.mockResolvedValue({ id: 'c1', preferredLanguage: null });
    mockPrisma.contact.create.mockResolvedValue({ id: 'c1' });
    mockPrisma.contact.update.mockResolvedValue({});
    mockPrisma.organization.findUnique.mockResolvedValue({ name: 'Ikoyi Grill', defaultLanguage: 'en' });
    mockPrisma.faqEntry.findMany.mockResolvedValue([]);
    mockPrisma.documentChunk.findMany.mockResolvedValue([]);
    mockPrisma.booking.findMany.mockResolvedValue([]);
    mockPrisma.reservation.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findUnique.mockImplementation(async () => ({ id: CONV, flowState }));
    mockPrisma.conversation.findFirst.mockImplementation(async () => ({ id: CONV, flowState }));
    mockPrisma.conversation.upsert.mockResolvedValue({ id: CONV });
    mockPrisma.conversation.update.mockImplementation(async ({ data }: any) => {
      flowState = data.flowState ?? null;
      return {};
    });
    mockPrisma.reservation.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'res_12345678', ...data })
    );
  });

  it('asks how many, rather than booking a table for two', async () => {
    const res = await orchestrator.processIncomingMessage(ctx(), 'can i book a table for friday');

    expect(mockPrisma.reservation.create).not.toHaveBeenCalled();
    expect(res.replyText).toMatch(/how many people/i);
  });

  it('reserves for the number the customer gave, at the time they picked', async () => {
    await orchestrator.processIncomingMessage(ctx(), 'i want to make a reservation');
    await orchestrator.processIncomingMessage(ctx(), '8');
    const res = await orchestrator.processIncomingMessage(ctx(), '1');

    expect(res.intentDetected).toBe('MANAGE_RESERVATION');
    expect(res.shouldHandoff).toBe(false);
    const written = mockPrisma.reservation.create.mock.calls[0][0].data;
    expect(written.partySize).toBe(8);
    expect(written.status).toBe('CONFIRMED');
    expect(res.replyText).toContain('8 guests');
    expect(flowState).toBeNull();
  });

  it('does not file the raw message as a special request', async () => {
    await orchestrator.processIncomingMessage(ctx(), 'book a table for 2');
    await orchestrator.processIncomingMessage(ctx(), '1');

    const written = mockPrisma.reservation.create.mock.calls[0][0].data;
    // This field is what a kitchen reads as the customer's REQUIREMENTS. It
    // used to hold `Requested via AI assistant: "<the raw message>"`, so a
    // transcript of "book a table for 2" arrived as a requirement nobody made.
    expect(written.specialRequests).toBeUndefined();
  });

  it('hands over honestly when nothing is free', async () => {
    const busy = [];
    for (let i = 1; i <= 24 * 14 * 2; i++) {
      busy.push({ startTime: soon(i * 0.5), endTime: soon(i * 0.5 + 0.5) });
    }
    mockPrisma.booking.findMany.mockResolvedValue(busy);

    const res = await orchestrator.processIncomingMessage(ctx(), 'book a table for 4');

    expect(res.shouldHandoff).toBe(true);
    expect(res.replyText).toMatch(/fully booked/i);
    expect(mockPrisma.reservation.create).not.toHaveBeenCalled();
  });

  it('hands over instead of asking a question it cannot hear the answer to', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    mockPrisma.conversation.upsert.mockRejectedValue(new Error('no thread'));

    const res = await orchestrator.processIncomingMessage(ctx(ChannelType.VOICE), 'book a table for 4');

    expect(res.shouldHandoff).toBe(true);
    expect(mockPrisma.reservation.create).not.toHaveBeenCalled();
  });

  it('holds a table for longer than a consultation', async () => {
    await orchestrator.processIncomingMessage(ctx(), 'book a table for 2');
    const res = await orchestrator.processIncomingMessage(ctx(), '1');

    // The slots offered are 90-minute ones, so two of them cannot start 30
    // minutes apart the way appointment slots do.
    expect(res.intentDetected).toBe('MANAGE_RESERVATION');
    expect(mockPrisma.reservation.create).toHaveBeenCalledTimes(1);
  });
});
