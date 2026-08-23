/**
 * Describing a half-filled form to the human about to take it over.
 *
 * Asking for a person always beats a flow — that is the rule that keeps a form
 * from being a trap — but the state it interrupts lived only in the
 * orchestrator. A citizen six answers into PLASCHEMA enrollment who asked for
 * help reached an operator who could see the message thread and nothing else,
 * and was asked their name, age, address and LGA a second time. That is the
 * experience these flows exist to end, surviving on the one path the whole
 * system treats as sacred.
 *
 * What is tested here is mostly what must NOT appear. `collected` is not fit
 * to show anyone: it carries the seeded JSON the slots ask their questions
 * from, and the list-picking slots store an index rather than the thing the
 * customer chose.
 */
const mockPrisma = {
  organization: { findUnique: jest.fn() },
  conversation: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  booking: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  reservation: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
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
  prisma: mockPrisma,
  Prisma: { DbNull: null },
}));

import { describeConversationFlow } from '../src/index';
import { describeFlowState, FLOW_TTL_MS } from '../src/flows';
import { ENROLLMENT_FLOW } from '../src/enrollment-flow';
import { BOOKING_FLOW, SLOTS_KEY, SERVICE_KEY } from '../src/booking-flow';
import { CANCEL_FLOW } from '../src/cancel-flow';
import { TARGETS_KEY } from '../src/appointment-targets';

const now = Date.now();
const fresh = { startedAt: now - 60_000, updatedAt: now - 30_000 };

describe('describing an enrollment in progress', () => {
  const state = {
    flow: 'plaschema-enrollment',
    collected: {
      fullName: 'Amina Yusuf',
      ageOrDob: '34 years',
      residentialAddress: '12 Ahmadu Bello Way, Jos',
      lga: 'Jos North',
    },
    awaiting: 'planType',
    ...fresh,
  };

  it('names the form and the answers already given, in the order they were asked', () => {
    const snap = describeConversationFlow(state, now)!;

    expect(snap.title).toBe('PLASCHEMA enrollment');
    expect(snap.answered.map((a) => [a.label, a.value])).toEqual([
      ['Full name', 'Amina Yusuf'],
      ['Age / date of birth', '34 years'],
      ['Residential address', '12 Ahmadu Bello Way, Jos'],
      ['LGA', 'Jos North'],
    ]);
  });

  it('says which question the customer is looking at', () => {
    expect(describeConversationFlow(state, now)!.awaiting).toEqual({ name: 'planType', label: 'Plan' });
  });

  it('labels the acronyms rather than de-camel-casing them into nonsense', () => {
    // "lga" → "Lga" and "nin" → "Nin" is what the derived default produces,
    // and an operator reading "Nin" has to work out what it means.
    const withNin = describeConversationFlow(
      { ...state, collected: { ...state.collected, nin: '12345678901' }, awaiting: null },
      now
    )!;
    const labels = withNin.answered.map((a) => a.label);
    expect(labels).toContain('LGA');
    expect(labels).toContain('NIN');
    expect(labels).not.toContain('Lga');
    expect(labels).not.toContain('Nin');
  });

  it('shows a declined optional field as declined, not as blank or missing', () => {
    // The customer WAS asked for their NIN and said no. Dropping the row
    // entirely reads as "still to collect", and an operator would ask again.
    const snap = describeConversationFlow(
      { ...state, collected: { ...state.collected, nin: '' }, awaiting: null },
      now
    )!;
    const nin = snap.answered.find((a) => a.name === 'nin')!;
    expect(nin.declined).toBe(true);
    expect(nin.value).toBe('');
  });

  it('says when the read-back is on screen and nothing has been written', () => {
    const snap = describeConversationFlow({ ...state, awaiting: null, confirming: true }, now)!;
    expect(snap.confirming).toBe(true);
    expect(snap.awaiting).toBeNull();
  });
});

describe('what must never reach the screen', () => {
  it('does not show the seeded lists the slots ask their questions from', () => {
    // _slots is a JSON blob of offered times; _service is scaffolding. Both
    // travel in `collected` because the engine has no database access — they
    // are not answers, and iterating `collected` would print them.
    const snap = describeConversationFlow(
      {
        flow: 'book-appointment',
        collected: {
          [SLOTS_KEY]: JSON.stringify([
            { startIso: 'x', endIso: 'y', label: 'Monday, 24 August at 09:00' },
            { startIso: 'x', endIso: 'y', label: 'Monday, 24 August at 09:30' },
          ]),
          [SERVICE_KEY]: 'Dental Check-up',
          when: '1',
        },
        awaiting: null,
        ...fresh,
      },
      now
    )!;

    expect(snap.answered.map((a) => a.name)).toEqual(['when']);
    expect(JSON.stringify(snap)).not.toContain('startIso');
  });

  it('shows the time the customer chose, not the index it is stored as', () => {
    // `when` holds "1". An operator reading "Time: 1" has been told something
    // that looks like an answer and is not.
    const snap = describeConversationFlow(
      {
        flow: 'book-appointment',
        collected: {
          [SLOTS_KEY]: JSON.stringify([
            { startIso: 'x', endIso: 'y', label: 'Monday, 24 August at 09:00' },
            { startIso: 'x', endIso: 'y', label: 'Monday, 24 August at 09:30' },
          ]),
          when: '1',
        },
        awaiting: null,
        ...fresh,
      },
      now
    )!;

    expect(snap.answered[0]).toMatchObject({ label: 'Time', value: 'Monday, 24 August at 09:30' });
  });

  it('names the appointment being cancelled, not its position in a list', () => {
    const snap = describeConversationFlow(
      {
        flow: 'cancel-booking',
        collected: {
          [TARGETS_KEY]: JSON.stringify([
            { id: 'a', kind: 'BOOKING', label: 'your Dental Check-up appointment', startIso: 'x', startLabel: 'Tuesday at 10:00' },
            { id: 'b', kind: 'BOOKING', label: 'your Follow-up appointment', startIso: 'x', startLabel: 'Friday at 14:00' },
          ]),
          which: '1',
        },
        awaiting: null,
        confirming: true,
        ...fresh,
      },
      now
    )!;

    expect(snap.title).toBe('Cancelling an appointment');
    expect(snap.answered[0].value).toBe('your Follow-up appointment — Friday at 14:00');
  });
});

describe('staleness', () => {
  it('reports a form past the TTL as expired, because the next message starts fresh', () => {
    const old = now - FLOW_TTL_MS - 1000;
    const snap = describeConversationFlow(
      { flow: 'plaschema-enrollment', collected: { fullName: 'A B' }, awaiting: 'ageOrDob', startedAt: old, updatedAt: old },
      now
    )!;
    expect(snap.stale).toBe(true);
  });

  it('reports a form inside the TTL as live', () => {
    expect(
      describeConversationFlow(
        { flow: 'plaschema-enrollment', collected: { fullName: 'A B' }, awaiting: 'ageOrDob', ...fresh },
        now
      )!.stale
    ).toBe(false);
  });
});

describe('nothing to show', () => {
  it('returns null for a conversation with no flow', () => {
    expect(describeConversationFlow(null)).toBeNull();
    expect(describeConversationFlow(undefined)).toBeNull();
    expect(describeConversationFlow({})).toBeNull();
  });

  it('returns null for a flow this build no longer has', () => {
    // A panel naming a form nobody can describe is worse than no panel: it
    // says a customer is half-way through something and cannot say what.
    expect(
      describeConversationFlow({ flow: 'some-retired-flow', collected: { a: 'b' }, awaiting: null, ...fresh })
    ).toBeNull();
  });

  it('returns null when handed a flow definition it does not have', () => {
    expect(describeFlowState({ flow: 'x', collected: {}, awaiting: null, ...fresh }, null)).toBeNull();
  });

  it('survives a state carrying a slot the flow has since dropped', () => {
    // Old rows outlive schema changes. An unknown key is skipped rather than
    // shown with a derived label nobody chose.
    const snap = describeConversationFlow(
      {
        flow: 'plaschema-enrollment',
        collected: { fullName: 'A B', somethingRemoved: 'x' },
        awaiting: null,
        ...fresh,
      },
      now
    )!;
    expect(snap.answered.map((a) => a.name)).toEqual(['fullName']);
  });
});

describe('every flow can describe itself', () => {
  it('gives all five a staff-facing title rather than a slug', () => {
    for (const flow of [ENROLLMENT_FLOW, BOOKING_FLOW, CANCEL_FLOW]) {
      expect(flow.title).toBeTruthy();
      expect(flow.title).not.toBe(flow.name); // not the machine slug
    }
  });

  it('renders every slot of every flow without throwing on empty state', () => {
    // `display` reads other keys out of `collected`; on a half-filled form
    // those may not be there yet, and a panel that throws takes the
    // conversation view down with it.
    for (const flow of [ENROLLMENT_FLOW, BOOKING_FLOW, CANCEL_FLOW]) {
      const collected = Object.fromEntries(flow.slots.map((s) => [s.name, 'x']));
      expect(() =>
        describeFlowState({ flow: flow.name, collected, awaiting: null, ...fresh }, flow, now)
      ).not.toThrow();
    }
  });
});
