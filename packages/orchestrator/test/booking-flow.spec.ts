/**
 * Booking at a time the customer chose.
 *
 * Booking used to take the next free slot and write it, then say which slot it
 * had taken. Honest and reversible — but a time nobody picked, which for
 * somebody travelling to a facility is an appointment they will miss and a slot
 * the clinic holds empty.
 *
 * The tests that matter are the ones that fail if the old shape returns: a
 * write on the first message, a time parsed out of a sentence rather than
 * picked from what is free, or a booking reported for a write that clashed.
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
  ...jest.requireActual('../../database/src/booking-conflicts'),
  prisma: mockPrisma,
  upsertEnrollee: jest.fn(),
  Prisma: { DbNull: null },
}));

import { ConversationOrchestrator } from '../src/index';
import { advanceFlow, beginFlow, type FlowState } from '../src/flows';
import { BOOKING_FLOW, SLOTS_KEY, SERVICE_KEY, chosenSlot, type BookableSlot } from '../src/booking-flow';
import { ChannelType } from '@ace/shared-types';

const F = BOOKING_FLOW;
const CONV = 'conv_book_1';
const CALLER = '+2348031234567';

const HOUR = 60 * 60 * 1000;
const soon = (h: number) => new Date(Date.now() + h * HOUR);

const SLOTS: BookableSlot[] = [
  { startIso: soon(24).toISOString(), endIso: soon(24.5).toISOString(), label: 'Monday 24 August, 11:00' },
  { startIso: soon(30).toISOString(), endIso: soon(30.5).toISOString(), label: 'Monday 24 August, 15:30' },
  { startIso: soon(72).toISOString(), endIso: soon(72.5).toISOString(), label: 'Wednesday 26 August, 10:00' },
];

function seeded(service = 'Dental Check-up', slots = SLOTS): FlowState {
  const state = beginFlow(F);
  state.collected[SLOTS_KEY] = JSON.stringify(slots);
  state.collected[SERVICE_KEY] = service;
  return state;
}

describe('choosing a time', () => {
  it('offers the free slots and names the service', () => {
    const step = advanceFlow(F, seeded(), '', 'en');
    expect(step.kind).toBe('ask');
    if (step.kind === 'ask') {
      expect(step.reply).toContain('Dental Check-up');
      for (const s of SLOTS) expect(step.reply).toContain(s.label);
    }
  });

  it('books straight through on the pick, with no second confirmation', () => {
    // The pick IS the decision — there is one variable and the customer just
    // set it. A "yes" after it would confirm the thing they just said, and two
    // steps to mean one thing teaches people to answer without reading.
    const asked = advanceFlow(F, seeded(), '', 'en');
    if (asked.kind !== 'ask') throw new Error('expected a question');

    const step = advanceFlow(F, asked.state, '2', 'en');
    expect(step.kind).toBe('execute');
    if (step.kind === 'execute') {
      expect(chosenSlot(step.state.collected)?.label).toBe('Monday 24 August, 15:30');
    }
  });

  it('refuses a time nobody offered rather than parsing it', () => {
    const asked = advanceFlow(F, seeded(), '', 'en');
    if (asked.kind !== 'ask') throw new Error('expected a question');

    const step = advanceFlow(F, asked.state, 'how about next Tuesday afternoon', 'en');
    expect(step.kind).toBe('ask');
    if (step.kind === 'ask') {
      expect(step.reply).toMatch(/I can only book one of these/i);
      expect(step.state.collected.when).toBeUndefined();
    }
  });

  it('refuses an ambiguous pick rather than taking the first match', () => {
    const asked = advanceFlow(F, seeded(), '', 'en');
    if (asked.kind !== 'ask') throw new Error('expected a question');

    // Two slots are on Monday.
    const step = advanceFlow(F, asked.state, 'monday', 'en');
    expect(step.kind).toBe('ask');
    if (step.kind === 'ask') expect(step.state.collected.when).toBeUndefined();
  });

  it('lets the customer out', () => {
    const step = advanceFlow(F, seeded(), 'never mind', 'en');
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
    mockPrisma.organization.findUnique.mockResolvedValue({ name: 'PLASCHEMA', defaultLanguage: 'en' });
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
    mockPrisma.booking.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'booking_12345678', ...data })
    );
  });

  it('offers times instead of booking on the spot', async () => {
    const res = await orchestrator.processIncomingMessage(ctx(), 'i want to book an appointment');

    // The defect this replaces: a write on the very first message.
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
    expect(res.intentDetected).toBe('FLOW_COLLECTING');
    expect(res.replyText).toMatch(/here is what is free/i);
  });

  it('books the time the customer picked', async () => {
    const offered = await orchestrator.processIncomingMessage(ctx(), 'book an appointment');
    const firstOffered = offered.replyText.match(/1 — (.+)/)?.[1]?.trim();

    const res = await orchestrator.processIncomingMessage(ctx(), '1');

    expect(res.intentDetected).toBe('BOOK_APPOINTMENT');
    expect(res.shouldHandoff).toBe(false);
    expect(mockPrisma.booking.create).toHaveBeenCalledTimes(1);
    expect(res.replyText).toContain(firstOffered!);
    // And the flow is cleared, so the next message is not read as another pick.
    expect(flowState).toBeNull();
  });

  it('records that the customer chose the time, not us', async () => {
    await orchestrator.processIncomingMessage(ctx(), 'book an appointment');
    await orchestrator.processIncomingMessage(ctx(), '1');

    const notes = mockPrisma.booking.create.mock.calls[0][0].data.notes;
    expect(notes).toMatch(/chosen by the customer/i);
  });

  it('re-offers rather than lying when the slot went while we talked', async () => {
    await orchestrator.processIncomingMessage(ctx(), 'book an appointment');
    mockPrisma.booking.create.mockRejectedValueOnce(
      Object.assign(new Error('conflicting key value violates exclusion constraint "bookings_no_staff_overlap"'), {
        code: '23P01',
      })
    );

    const res = await orchestrator.processIncomingMessage(ctx(), '1');

    expect(res.replyText).toMatch(/while we were talking/i);
    expect(res.replyText).toMatch(/here is what is free/i);
    expect(res.replyText).not.toMatch(/put you down/i);
  });

  it('hands over honestly when nothing is free', async () => {
    const busy = [];
    for (let i = 1; i <= 24 * 14 * 2; i++) {
      busy.push({ startTime: soon(i * 0.5), endTime: soon(i * 0.5 + 0.5) });
    }
    mockPrisma.booking.findMany.mockResolvedValue(busy);

    const res = await orchestrator.processIncomingMessage(ctx(), 'book an appointment');

    expect(res.shouldHandoff).toBe(true);
    expect(res.replyText).toMatch(/fully booked/i);
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it('hands over instead of offering a list it cannot read the answer to', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    mockPrisma.conversation.upsert.mockRejectedValue(new Error('no thread'));

    const res = await orchestrator.processIncomingMessage(ctx(ChannelType.VOICE), 'book an appointment');

    expect(res.shouldHandoff).toBe(true);
    expect(res.replyText).toMatch(/can't take you through picking a time here/i);
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it('only offers slots inside business hours and in the future', async () => {
    await orchestrator.processIncomingMessage(ctx(), 'book an appointment');
    await orchestrator.processIncomingMessage(ctx(), '1');

    const start: Date = mockPrisma.booking.create.mock.calls[0][0].data.startTime;
    const watHour = (start.getUTCHours() + 1) % 24;
    const watDay = new Date(start.getTime() + HOUR).getUTCDay();

    expect(start.getTime()).toBeGreaterThan(Date.now());
    expect(watHour).toBeGreaterThanOrEqual(8);
    expect(watHour).toBeLessThan(18);
    expect(watDay).not.toBe(0);
    expect(watDay).not.toBe(6);
  });
});
