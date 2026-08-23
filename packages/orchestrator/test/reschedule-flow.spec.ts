/**
 * Moving an appointment: what it must ask, and what it must never assume.
 *
 * The behaviour being replaced silently relocated the customer's next booking
 * to tomorrow at 10:00 and told them it "has been rescheduled". So the tests
 * that matter here are the ones that fail if any of that creeps back: writing
 * before confirming, picking a time nobody chose, moving the wrong appointment
 * when there were two, or reporting success for a write that did not happen.
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
import {
  RESCHEDULE_FLOW, OPTIONS_KEY, chosenOption, type RescheduleOption,
} from '../src/reschedule-flow';
import { TARGETS_KEY, chosenTarget, type AppointmentTarget } from '../src/appointment-targets';
import { ChannelType } from '@ace/shared-types';

const F = RESCHEDULE_FLOW;
const CONV = 'conv_resched_1';
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

const OPTIONS: RescheduleOption[] = [
  { startIso: soon(24).toISOString(), endIso: soon(24.5).toISOString(), label: 'Monday 24 August, 11:00' },
  { startIso: soon(30).toISOString(), endIso: soon(30.5).toISOString(), label: 'Monday 24 August, 15:30' },
  { startIso: soon(72).toISOString(), endIso: soon(72.5).toISOString(), label: 'Wednesday 26 August, 10:00' },
];

/** A flow state seeded the way the orchestrator seeds it. */
function seeded(targets = TARGETS, options = OPTIONS): FlowState {
  const state = beginFlow(F);
  state.collected[TARGETS_KEY] = JSON.stringify(targets);
  state.collected[OPTIONS_KEY] = JSON.stringify(options);
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

describe('choosing which appointment and when', () => {
  it('asks which one when there is more than one, and does not when there is not', () => {
    const two = play([], seeded());
    expect(two.replies[0]).toMatch(/more than one/i);
    expect(two.replies[0]).toContain('Dental Check-up');
    expect(two.replies[0]).toContain('Eye Test');

    const one = play([], seeded([TARGETS[0]]));
    // Straight to the times — asking "which one?" about a single appointment is
    // a question whose answer we already have.
    expect(one.replies[0]).not.toMatch(/more than one/i);
    expect(one.replies[0]).toContain('Monday 24 August, 11:00');
  });

  it('moves the one the customer picked, not the soonest', () => {
    // The old behaviour always took the earliest. Picking #2 must mean #2.
    const { state } = play(['2', '1']);
    expect(chosenTarget(state.collected)?.id).toBe('bk_2');
  });

  it('offers only times that were actually free, and never invents one', () => {
    const { replies } = play(['1']);
    const offered = replies[1];
    for (const option of OPTIONS) expect(offered).toContain(option.label);

    // A time nobody offered is refused rather than parsed into a timestamp.
    const step = advanceFlow(F, play(['1']).state, 'next Tuesday at 2pm', 'en');
    expect(step.kind).toBe('ask');
    if (step.kind === 'ask') {
      expect(step.reply).toMatch(/I can only move it to one of these/i);
      expect(step.state.collected.when).toBeUndefined();
    }
  });

  it('accepts a time named instead of numbered, when it is unambiguous', () => {
    const afterWhich = play(['1']);
    const step = advanceFlow(F, afterWhich.state, 'the Wednesday one please', 'en');
    if (step.kind === 'confirm') {
      expect(chosenOption(step.state.collected)?.label).toContain('Wednesday');
    }
  });

  it('refuses an ambiguous time rather than picking the first match', () => {
    // Two options are on Monday, so "monday" identifies nothing on its own.
    const afterWhich = play(['1']);
    const step = advanceFlow(F, afterWhich.state, 'monday', 'en');
    expect(step.kind).toBe('ask');
    if (step.kind === 'ask') expect(step.state.collected.when).toBeUndefined();
  });

  it('reads the move back and writes nothing until it is confirmed', () => {
    const { last, executed } = play(['1', '1']);
    expect(executed).toBe(false);
    expect(last).toMatch(/before I change anything/i);
    expect(last).toContain('Dental Check-up');
    expect(last).toContain('Tuesday 25 August, 09:00');  // from
    expect(last).toContain('Monday 24 August, 11:00');   // to
  });

  it('executes only after yes', () => {
    const { executed } = play(['1', '1', 'yes']);
    expect(executed).toBe(true);
  });

  it('lets the customer out at any point', () => {
    const step = advanceFlow(F, play(['1']).state, 'cancel', 'en');
    expect(step.kind).toBe('abandon');
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
      {
        id: 'bk_1', serviceName: 'Dental Check-up',
        startTime: soon(48), endTime: soon(48.5),
      },
    ]);
  });

  it('offers times instead of moving the appointment on the spot', async () => {
    const res = await orchestrator.processIncomingMessage(ctx(), 'can i reschedule my appointment');

    expect(res.intentDetected).toBe('FLOW_COLLECTING');
    // The defect this replaces: a write on the very first message.
    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    expect(res.replyText).toMatch(/here is what is free/i);
  });

  it('says so honestly when there is nothing to move it to', async () => {
    // Every half-hour in the horizon is taken.
    const busy = [];
    for (let i = 1; i <= 24 * 14 * 2; i++) {
      busy.push({ id: `b${i}`, serviceName: 'x', startTime: soon(i * 0.5), endTime: soon(i * 0.5 + 0.5) });
    }
    mockPrisma.booking.findMany.mockResolvedValue(busy);

    const res = await orchestrator.processIncomingMessage(ctx(), 'reschedule my appointment');

    expect(res.shouldHandoff).toBe(true);
    expect(res.replyText).toMatch(/nothing free/i);
    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
  });

  it('does not claim a move it could not make', async () => {
    // The booking was cancelled between being listed and being confirmed.
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: CONV,
      flowState: {
        flow: 'reschedule-booking',
        collected: {
          [TARGETS_KEY]: JSON.stringify([TARGETS[0]]),
          [OPTIONS_KEY]: JSON.stringify(OPTIONS),
          when: '0',
        },
        awaiting: null, confirming: true,
        startedAt: Date.now(), updatedAt: Date.now(),
      },
    });
    mockPrisma.booking.findFirst.mockResolvedValue(null);

    const res = await orchestrator.processIncomingMessage(ctx(), 'yes');

    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    expect(res.shouldHandoff).toBe(true);
    expect(res.replyText).toMatch(/no longer active/i);
    expect(res.replyText).not.toMatch(/has moved/i);
  });

  it('re-offers rather than lying when the slot was taken meanwhile', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: CONV,
      flowState: {
        flow: 'reschedule-booking',
        collected: {
          [TARGETS_KEY]: JSON.stringify([TARGETS[0]]),
          [OPTIONS_KEY]: JSON.stringify(OPTIONS),
          when: '0',
        },
        awaiting: null, confirming: true,
        startedAt: Date.now(), updatedAt: Date.now(),
      },
    });
    mockPrisma.booking.findFirst.mockResolvedValue({ id: 'bk_1', serviceName: 'Dental Check-up' });
    mockPrisma.booking.update.mockRejectedValue(
      Object.assign(new Error('conflicting key value violates exclusion constraint "bookings_no_staff_overlap"'), {
        code: '23P01',
      })
    );

    const res = await orchestrator.processIncomingMessage(ctx(), 'yes');

    expect(res.replyText).toMatch(/while we were talking/i);
    expect(res.replyText).toMatch(/left your appointment where it is/i);
    // And it offers a fresh set rather than ending in an apology.
    expect(res.replyText).toMatch(/here is what is free/i);
  });

  it('reports the move only after the write succeeded', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: CONV,
      flowState: {
        flow: 'reschedule-booking',
        collected: {
          [TARGETS_KEY]: JSON.stringify([TARGETS[0]]),
          [OPTIONS_KEY]: JSON.stringify(OPTIONS),
          when: '0',
        },
        awaiting: null, confirming: true,
        startedAt: Date.now(), updatedAt: Date.now(),
      },
    });
    mockPrisma.booking.findFirst.mockResolvedValue({ id: 'bk_1', serviceName: 'Dental Check-up' });
    mockPrisma.booking.update.mockResolvedValue({ id: 'bk_1' });

    const res = await orchestrator.processIncomingMessage(ctx(), 'yes');

    expect(res.intentDetected).toBe('RESCHEDULE_BOOKING');
    expect(mockPrisma.booking.update).toHaveBeenCalledTimes(1);
    const written = mockPrisma.booking.update.mock.calls[0][0].data;
    // The time written is the one the customer chose, not a default.
    expect(written.startTime.toISOString()).toBe(OPTIONS[0].startIso);
    expect(written.status).toBe('RESCHEDULED');
    expect(res.replyText).toContain('has moved');
    expect(res.replyText).toContain(OPTIONS[0].label);
  });

  it('hands over instead of asking a question it cannot hear the answer to', async () => {
    // VOICE has no conversation row and no contact to make one from here.
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    mockPrisma.conversation.upsert.mockRejectedValue(new Error('no thread'));

    const res = await orchestrator.processIncomingMessage(ctx(ChannelType.VOICE), 'reschedule my appointment');

    expect(res.shouldHandoff).toBe(true);
    expect(res.replyText).toMatch(/can't take you through changing it here/i);
    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
  });
});
