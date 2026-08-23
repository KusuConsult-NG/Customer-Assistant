/**
 * Cancelling: the confirmation that was never there.
 *
 * The behaviour being replaced cancelled the soonest appointment on the first
 * message, with no question and no read-back, and replied that it had been
 * "successfully cancelled". So these tests are the ones that fail if any of
 * that returns: writing before asking, taking the earliest when the customer
 * has two, or reporting a cancellation that did not happen.
 *
 * Cancelling is the destructive verb. A rescheduled appointment still exists
 * somewhere; a cancelled one is gone and its slot is released.
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
  ...jest.requireActual('../../database/src/plaschema-facilities'),
  ...jest.requireActual('../../database/src/booking-conflicts'),
  prisma: mockPrisma,
  upsertEnrollee: jest.fn(),
  Prisma: { DbNull: null },
}));

import { ConversationOrchestrator } from '../src/index';
import { advanceFlow, beginFlow, type FlowState } from '../src/flows';
import { CANCEL_FLOW } from '../src/cancel-flow';
import { TARGETS_KEY, chosenTarget, type AppointmentTarget } from '../src/appointment-targets';
import { ChannelType } from '@ace/shared-types';

const F = CANCEL_FLOW;
const CONV = 'conv_cancel_1';
const CALLER = '+2348031234567';

const HOUR = 60 * 60 * 1000;
const soon = (h: number) => new Date(Date.now() + h * HOUR);

const TARGETS: AppointmentTarget[] = [
  {
    id: 'bk_1', kind: 'BOOKING', label: 'your Dental Check-up appointment',
    startIso: soon(48).toISOString(), startLabel: 'Tuesday 25 August, 09:00',
  },
  {
    id: 'bk_2', kind: 'BOOKING', label: 'your Eye Test appointment',
    startIso: soon(96).toISOString(), startLabel: 'Thursday 27 August, 14:00',
  },
];

function seeded(targets = TARGETS): FlowState {
  const state = beginFlow(F);
  state.collected[TARGETS_KEY] = JSON.stringify(targets);
  return state;
}

function play(answers: string[], start: FlowState = seeded()) {
  let state = start;
  const replies: string[] = [];
  let executed = false;
  let step = advanceFlow(F, state, '', 'en');
  if (step.kind === 'ask' || step.kind === 'confirm') {
    replies.push(step.reply);
    state = step.state;
  }
  for (const answer of answers) {
    step = advanceFlow(F, state, answer, 'en');
    if (step.kind === 'execute') { executed = true; state = step.state; break; }
    if (step.kind === 'abandon') { replies.push(step.reply); break; }
    if (step.kind === 'not-mine') break;
    replies.push(step.reply);
    state = step.state;
  }
  return { replies, state, executed, last: replies[replies.length - 1] ?? '' };
}

describe('the cancellation conversation', () => {
  it('goes straight to the read-back when there is only one appointment', () => {
    const { replies, executed } = play([], seeded([TARGETS[0]]));

    expect(executed).toBe(false);
    expect(replies[0]).toMatch(/cannot be undone/i);
    expect(replies[0]).toContain('Dental Check-up');
    expect(replies[0]).toContain('Tuesday 25 August, 09:00');
  });

  it('asks which one first when there is more than one', () => {
    const { replies, executed } = play([]);

    expect(executed).toBe(false);
    expect(replies[0]).toMatch(/more than one/i);
    expect(replies[0]).toMatch(/cancel/i);
    expect(replies[0]).toContain('Dental Check-up');
    expect(replies[0]).toContain('Eye Test');
  });

  it('cancels the one the customer picked, not the soonest', () => {
    // The defect: it always took the earliest, whichever they meant.
    const { state, executed } = play(['2', 'yes']);

    expect(executed).toBe(true);
    expect(chosenTarget(state.collected)?.id).toBe('bk_2');
  });

  it('does nothing on "no" at the read-back', () => {
    const { executed } = play(['no'], seeded([TARGETS[0]]));
    expect(executed).toBe(false);
  });

  it('treats a bare "no" to "which one?" as backing out, not as an answer', () => {
    // Without this it loops: "no" fails validation, we re-ask, they say "no"
    // again. The words that do escape — "cancel", "stop" — are not what someone
    // reaches for when they have just been asked a question, and "cancel" is a
    // particularly bad thing to have to type inside a cancellation flow.
    const { executed, last } = play(['no']);
    expect(executed).toBe(false);
    expect(last).toMatch(/stopped that/i);
  });

  it('reads "cancel" as leaving the flow, never as consent to cancel', () => {
    // The ambiguity is real and only dangerous in one direction: abandoning
    // when they meant "cancel the appointment" costs them a retry; the reverse
    // destroys an appointment they were still deciding about.
    const step = advanceFlow(F, play([], seeded([TARGETS[0]])).state, 'cancel', 'en');
    expect(step.kind).toBe('abandon');
  });

  it('lets the customer out at any point', () => {
    const step = advanceFlow(F, seeded([TARGETS[0]]), 'forget it', 'en');
    expect(step.kind).toBe('abandon');
  });

  it('re-reads rather than guessing at an unclear reply', () => {
    const step = advanceFlow(F, play([], seeded([TARGETS[0]])).state, 'hmm what about the other one', 'en');
    expect(step.kind).toBe('confirm');
  });
});

describe('through the orchestrator', () => {
  const orchestrator = new ConversationOrchestrator();

  const ctx = (channel: ChannelType = ChannelType.WHATSAPP) => ({
    conversationId: CONV,
    organizationId: 'org_1',
    customerPhoneNumber: CALLER,
    channel,
    history: [],
    slots: {},
    isHumanHandoffActive: false,
  });

  const confirming = (targets = [TARGETS[0]], extra: Record<string, string> = {}) => ({
    id: CONV,
    flowState: {
      flow: 'cancel-booking',
      collected: { [TARGETS_KEY]: JSON.stringify(targets), ...extra },
      awaiting: null, confirming: true,
      startedAt: Date.now(), updatedAt: Date.now(),
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    mockPrisma.contact.findFirst.mockResolvedValue({ id: 'c1', preferredLanguage: null });
    mockPrisma.contact.update.mockResolvedValue({});
    mockPrisma.conversation.update.mockResolvedValue({});
    mockPrisma.conversation.upsert.mockResolvedValue({ id: CONV });
    mockPrisma.organization.findUnique.mockResolvedValue({ name: 'PLASCHEMA', defaultLanguage: 'en' });
    mockPrisma.faqEntry.findMany.mockResolvedValue([]);
    mockPrisma.documentChunk.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findUnique.mockResolvedValue({ id: CONV, flowState: null });
    mockPrisma.reservation.findMany.mockResolvedValue([]);
    mockPrisma.booking.findMany.mockResolvedValue([
      { id: 'bk_1', serviceName: 'Dental Check-up', startTime: soon(48), endTime: soon(48.5) },
    ]);
  });

  it('asks before cancelling anything', async () => {
    const res = await orchestrator.processIncomingMessage(ctx(), 'cancel my appointment');

    // The defect this replaces: an irreversible write on the first message.
    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    expect(res.intentDetected).toBe('FLOW_CONFIRM');
    expect(res.replyText).toMatch(/cannot be undone/i);
  });

  it('cancels only after the customer confirms', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(confirming());
    mockPrisma.booking.findFirst.mockResolvedValue({
      id: 'bk_1', serviceName: 'Dental Check-up', notes: 'Booked by AI assistant from: "..."',
    });
    mockPrisma.booking.update.mockResolvedValue({ id: 'bk_1' });

    const res = await orchestrator.processIncomingMessage(ctx(), 'yes');

    expect(mockPrisma.booking.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.booking.update.mock.calls[0][0].data.status).toBe('CANCELLED');
    expect(res.intentDetected).toBe('CANCEL_BOOKING');
  });

  it('keeps the original notes instead of overwriting them', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(confirming());
    mockPrisma.booking.findFirst.mockResolvedValue({
      id: 'bk_1', serviceName: 'Dental Check-up',
      notes: 'Booked by AI assistant from: "i need to see a dentist"',
    });
    mockPrisma.booking.update.mockResolvedValue({ id: 'bk_1' });

    await orchestrator.processIncomingMessage(ctx(), 'yes');

    const notes = mockPrisma.booking.update.mock.calls[0][0].data.notes;
    // The original said how the booking came to exist. Destroying it at the
    // moment somebody is most likely to ask what happened is the wrong trade.
    expect(notes).toContain('i need to see a dentist');
    expect(notes).toContain('Cancelled by customer via AI assistant');
  });

  it('keeps the customer’s special requests on a reservation', async () => {
    const reservationTarget: AppointmentTarget = {
      id: 'rs_1', kind: 'RESERVATION', label: 'your reservation for 4 guest(s)',
      startIso: soon(48).toISOString(), startLabel: 'Tuesday 25 August, 19:00',
    };
    mockPrisma.conversation.findUnique.mockResolvedValue(confirming([reservationTarget]));
    mockPrisma.reservation.findFirst.mockResolvedValue({
      id: 'rs_1', partySize: 4, specialRequests: 'severe nut allergy, wheelchair access',
    });
    mockPrisma.reservation.update.mockResolvedValue({ id: 'rs_1' });

    await orchestrator.processIncomingMessage(ctx(), 'yes');

    const requests = mockPrisma.reservation.update.mock.calls[0][0].data.specialRequests;
    // This field holds what the CUSTOMER asked for. Overwriting it threw away
    // an allergy and an access need.
    expect(requests).toContain('severe nut allergy');
    expect(requests).toContain('wheelchair access');
  });

  it('does not claim a cancellation it could not make', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(confirming());
    mockPrisma.booking.findFirst.mockResolvedValue(null); // already cancelled meanwhile

    const res = await orchestrator.processIncomingMessage(ctx(), 'yes');

    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    expect(res.replyText).toMatch(/no longer active/i);
    expect(res.replyText).toMatch(/nothing has been altered/i);
  });

  it('says so when there is nothing to cancel', async () => {
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const res = await orchestrator.processIncomingMessage(ctx(), 'cancel my appointment');

    expect(res.intentDetected).toBe('CANCEL_BOOKING');
    expect(res.replyText).toMatch(/couldn't find an active booking/i);
    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
  });

  it('hands over instead of asking a question it cannot hear the answer to', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    mockPrisma.conversation.upsert.mockRejectedValue(new Error('no thread'));

    const res = await orchestrator.processIncomingMessage(ctx(ChannelType.VOICE), 'cancel my appointment');

    expect(res.shouldHandoff).toBe(true);
    expect(res.replyText).toMatch(/can't take you through cancelling it here/i);
    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
  });

  it('does not let an unrelated message mid-flow cancel anything', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(confirming());

    const res = await orchestrator.processIncomingMessage(ctx(), 'what are your opening hours');

    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    // Re-reads the confirmation rather than treating anything as consent.
    expect(res.replyText).toMatch(/cannot be undone/i);
  });
});
