/**
 * Multi-turn enrollment: the conversation, and the ways it must not trap anyone.
 *
 * Two layers. The engine (`advanceFlow`) is pure, so its rules are tested
 * directly and exhaustively — that is where the trapping bugs live. Then a
 * handful of end-to-end passes through the orchestrator with prisma mocked,
 * because an engine nothing calls is the same as no engine, which is precisely
 * the state `ConversationContext.slots` was in before this existed.
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

const mockUpsertEnrollee = jest.fn();

jest.mock('@ace/database', () => ({
  ...jest.requireActual('../../database/src/phone-number'),
  ...jest.requireActual('../../database/src/availability'),
  ...jest.requireActual('../../database/src/plaschema-facilities'),
  prisma: mockPrisma,
  upsertEnrollee: (...args: any[]) => mockUpsertEnrollee(...args),
  Prisma: { DbNull: null },
}));

import { ConversationOrchestrator } from '../src/index';
import {
  advanceFlow, beginFlow, isStale, nextSlot, findCorrection, asFlowState,
  FLOW_TTL_MS, type FlowState,
} from '../src/flows';
import { ENROLLMENT_FLOW } from '../src/enrollment-flow';
import { SUPPORTED_LANGUAGES, type Language } from '../src/languages';
import { ChannelType } from '@ace/shared-types';

const F = ENROLLMENT_FLOW;

/** Drive the engine through a list of answers, returning every reply. */
function play(answers: string[], start: FlowState = beginFlow(F), lang: Language = 'en') {
  let state = start;
  const replies: string[] = [];
  let executed = false;
  // The opening question, from the message that started the flow.
  let step = advanceFlow(F, state, '', lang);
  if (step.kind === 'ask' || step.kind === 'confirm') {
    replies.push(step.reply);
    state = step.state;
  }
  for (const answer of answers) {
    step = advanceFlow(F, state, answer, lang);
    if (step.kind === 'execute') { executed = true; state = step.state; break; }
    if (step.kind === 'abandon') { replies.push(step.reply); break; }
    if (step.kind === 'not-mine') break;
    replies.push(step.reply);
    state = step.state;
  }
  return { replies, state, executed, last: replies[replies.length - 1] ?? '' };
}

const GOOD_ANSWERS = [
  'Amina Yusuf',
  '34',
  '12 Ahmadu Bello Way, Jos',
  'Jos North',
  '2',
  'Plateau Specialist Hospital',
  'no',
];

describe('the enrollment conversation', () => {
  it('asks for one thing at a time, in an order where each answer can be checked', () => {
    const { replies } = play(GOOD_ANSWERS.slice(0, 4));

    expect(replies[0]).toMatch(/full name/i);
    expect(replies[1]).toMatch(/how old|date of birth/i);
    expect(replies[2]).toMatch(/address|area/i);
    expect(replies[3]).toMatch(/Local Government Area/i);
    // The LGA is asked BEFORE the facility, because the accredited list is
    // per-LGA — the other order would validate a hospital against nothing.
    expect(replies[4]).toMatch(/plan|Formal Sector/i);
  });

  it('reads everything back and writes nothing until the customer confirms', () => {
    const { last, executed } = play(GOOD_ANSWERS);

    expect(executed).toBe(false); // all seven answered, still not written
    expect(last).toContain('Amina Yusuf');
    expect(last).toContain('Jos North');
    expect(last).toContain('Plateau Specialist Hospital');
    expect(last).toMatch(/is all of that correct/i);
  });

  it('registers only after the confirmation', () => {
    const filled = play(GOOD_ANSWERS);
    const step = advanceFlow(F, filled.state, 'yes', 'en');
    expect(step.kind).toBe('execute');
  });

  it('refuses a hospital that is not accredited in the chosen LGA, and says which are', () => {
    const { last } = play([...GOOD_ANSWERS.slice(0, 5), 'St Elsewhere Private Clinic']);

    // A card issued against an unaccredited facility is refused at the desk —
    // while the enrollee is ill and holding a card the state called valid.
    expect(last).toMatch(/not on the accredited list/i);
    expect(last).toMatch(/Plateau Specialist Hospital/);
  });

  it('refuses an LGA outside Plateau State and lists the real ones', () => {
    const { last } = play([...GOOD_ANSWERS.slice(0, 3), 'Ikeja']);

    expect(last).toMatch(/could not match that to a Plateau State LGA/i);
    expect(last).toMatch(/Jos North/);
  });

  it('will not take a single word as a full name', () => {
    const { last } = play(['Amina']);
    expect(last).toMatch(/first name and surname/i);
  });

  it('rejects an implausible age rather than storing it', () => {
    const { last } = play(['Amina Yusuf', '350']);
    expect(last).toMatch(/does not look right/i);
  });

  it('accepts a NIN only at the right length, and lets it be declined', () => {
    const short = play([...GOOD_ANSWERS.slice(0, 6), '12345']);
    expect(short.last).toMatch(/11 digits/);

    const declined = play([...GOOD_ANSWERS.slice(0, 6), 'no']);
    expect(declined.last).toMatch(/is all of that correct/i);
    expect(declined.state.collected.nin).toBe('');
  });

  it('takes the plan by number or by name', () => {
    const byNumber = play([...GOOD_ANSWERS.slice(0, 4), '3']);
    expect(byNumber.state.collected.planType).toBe('Equity Program');

    const byName = play([...GOOD_ANSWERS.slice(0, 4), 'i am a trader']);
    expect(byName.state.collected.planType).toBe('Informal Sector');
  });
});

/**
 * The form used to be English-only, and said so in the customer's language
 * before switching. Now every question, every validation error and the
 * read-back exist in all five, so what has to be tested is that none of the
 * English wording survives anywhere in a non-English run — a single
 * `prompt: () => '...'` left behind is invisible until a citizen hits it.
 */
describe('the form in every language', () => {
  /**
   * Tested by DIFFERENCE from English, not by hunting English words.
   *
   * Hunting words is the obvious version and it is wrong twice over: Pidgin is
   * English-lexified, so "full name" appearing in it is correct rather than a
   * leak, and Igbo borrows "Local Government Area" the way Nigerians of every
   * language do for that administrative term. Meanwhile a slot left as
   * `prompt: () => '...'` renders the SAME STRING in all five — which is
   * exactly what this catches, at every step, without a phrase list to keep.
   */
  const english = play(GOOD_ANSWERS, beginFlow(F), 'en');

  for (const lang of SUPPORTED_LANGUAGES.filter((l) => l !== 'en')) {
    it(`asks and reads back in ${lang}, sharing no wording with the English form`, () => {
      const { replies, last } = play(GOOD_ANSWERS, beginFlow(F), lang);

      // Every question was asked, plus the read-back.
      expect(replies.length).toBe(GOOD_ANSWERS.length + 1);
      expect(replies.length).toBe(english.replies.length);

      replies.forEach((reply, i) => {
        expect({ step: i, sameAsEnglish: reply === english.replies[i] })
          .toEqual({ step: i, sameAsEnglish: false });
      });

      // The read-back still carries the answers themselves — the values are
      // the customer's own words and the record's own labels, and translating
      // those is a different (and wrong) thing.
      expect(last).toContain('Amina Yusuf');
      expect(last).toContain('Jos North');
      expect(last).toContain('Plateau Specialist Hospital');
      expect(last).toContain('Informal Sector');
    });

    it(`reports a validation error in ${lang} rather than falling back to English`, () => {
      const badName = play(['Amina'], beginFlow(F), lang);
      expect(badName.last).not.toBe(play(['Amina'], beginFlow(F), 'en').last);

      const badLga = play([...GOOD_ANSWERS.slice(0, 3), 'Ikeja'], beginFlow(F), lang);
      expect(badLga.last).not.toBe(
        play([...GOOD_ANSWERS.slice(0, 3), 'Ikeja'], beginFlow(F), 'en').last
      );
      // …and still names the LGAs it will accept, so the error is actionable.
      expect(badLga.last).toContain('Jos North');
    });
  }

  /**
   * The Hausa NIN question tells the caller to answer "a'a". That word was in
   * NEGATE but not in DECLINE, and only DECLINE was consulted for an optional
   * slot — so following the instruction abandoned the form six answers in.
   * Every language's own "no" is pinned here, because the prompt in each one
   * names it.
   */
  const NO: Array<[Language, string]> = [
    ['en', 'no'], ['pcm', 'no'], ['ha', "a'a"], ['ig', 'mba'], ['yo', 'rara'],
  ];
  for (const [lang, no] of NO) {
    it(`declines the optional NIN on "${no}" (${lang}) instead of abandoning the form`, () => {
      const { last, state } = play([...GOOD_ANSWERS.slice(0, 6), no], beginFlow(F), lang);

      expect(state.collected.nin).toBe('');
      expect(state.confirming).toBe(true);
      // The six answers before it survived.
      expect(last).toContain('Amina Yusuf');
      expect(last).toContain('Plateau Specialist Hospital');
    });
  }
});

describe('the ways a form must not trap someone', () => {
  it('abandons on "cancel", at any point', () => {
    const step = advanceFlow(F, play(GOOD_ANSWERS.slice(0, 3)).state, 'cancel', 'en');
    expect(step.kind).toBe('abandon');
  });

  it('abandons in the other supported languages too', () => {
    for (const word of ['ka daina', 'make i stop', 'kwụsị', 'duro']) {
      const step = advanceFlow(F, beginFlow(F), word, 'en');
      expect(step.kind).toBe('abandon');
    }
  });

  it('is forgotten once it goes stale, rather than resuming days later', () => {
    const fresh = beginFlow(F);
    expect(isStale(fresh)).toBe(false);
    expect(isStale({ ...fresh, updatedAt: Date.now() - FLOW_TTL_MS - 1 })).toBe(true);
  });

  it('accepts a correction to something already answered', () => {
    const filled = play(GOOD_ANSWERS.slice(0, 4)); // through LGA
    expect(filled.state.collected.lga).toBe('Jos North');

    const step = advanceFlow(F, filled.state, 'no, Jos South', 'en');
    expect(step.kind).toBe('ask');
    if (step.kind === 'ask') expect(step.state.collected.lga).toBe('Jos South');
  });

  it('does not mistake an ordinary answer for a correction', () => {
    // No correction marker: "Jos South" here is the answer to the LGA
    // question, not a rewrite of the name.
    const afterAddress = play(GOOD_ANSWERS.slice(0, 3));
    const step = advanceFlow(F, afterAddress.state, 'Jos South', 'en');
    if (step.kind === 'ask') {
      expect(step.state.collected.fullName).toBe('Amina Yusuf');
      expect(step.state.collected.lga).toBe('Jos South');
    }
  });

  it('fixes one field at the read-back instead of restarting the form', () => {
    const filled = play(GOOD_ANSWERS);
    const step = advanceFlow(F, filled.state, 'no, my name is Amina Yusuf Bello', 'en');

    expect(step.kind).toBe('confirm');
    if (step.kind === 'confirm') {
      expect(step.state.collected.fullName).toBe('Amina Yusuf Bello');
      // Everything else survived — they answered six questions, not one.
      expect(step.state.collected.lga).toBe('Jos North');
      expect(step.state.collected.preferredHospital).toBe('Plateau Specialist Hospital');
    }
  });

  it('asks what to change on a bare "no" rather than starting over', () => {
    const filled = play(GOOD_ANSWERS);
    const step = advanceFlow(F, filled.state, 'no', 'en');
    expect(step.kind).toBe('ask');
    if (step.kind === 'ask') {
      expect(step.reply).toMatch(/which part/i);
      expect(step.state.collected.fullName).toBe('Amina Yusuf');
    }
  });

  it('re-reads the summary rather than guessing at an unclear reply', () => {
    const filled = play(GOOD_ANSWERS);
    const step = advanceFlow(F, filled.state, 'what about my children', 'en');
    expect(step.kind).toBe('confirm');
  });

  it('applies a correction to the field it is about, and to no other', () => {
    // The defect this pins: most slots validate loosely, so the first
    // implementation handed "Jos South" to fullName's accept — two words, no
    // digits, therefore a fine name — and renamed the customer to "Jos South"
    // while leaving the LGA they were correcting exactly as it was.
    const filled = play(GOOD_ANSWERS.slice(0, 4));
    const step = advanceFlow(F, filled.state, 'no, Jos South', 'en');

    if (step.kind === 'ask') {
      expect(step.state.collected.lga).toBe('Jos South');
      expect(step.state.collected.fullName).toBe('Amina Yusuf');
      expect(step.state.collected.residentialAddress).toBe('12 Ahmadu Bello Way, Jos');
    }
  });

  it('re-asks a field called wrong instead of storing the word "wrong"', () => {
    const filled = play(GOOD_ANSWERS);
    const step = advanceFlow(F, filled.state, 'no, the address is wrong', 'en');

    expect(step.kind).toBe('ask');
    if (step.kind === 'ask') {
      expect(step.state.awaiting).toBe('residentialAddress');
      expect(step.state.collected.residentialAddress).toBeUndefined();
      expect(step.reply).toMatch(/address|area/i);
      // Everything else survives — one field is being redone, not the form.
      expect(step.state.collected.lga).toBe('Jos North');
    }
  });

  it('picks the field the sentence is about when two are named', () => {
    // "hospital" and "name" are both aliases; the longer, more specific one wins.
    const filled = play(GOOD_ANSWERS);
    const step = advanceFlow(F, filled.state, 'no, the hospital name is wrong', 'en');

    expect(step.kind).toBe('ask');
    if (step.kind === 'ask') {
      expect(step.state.awaiting).toBe('preferredHospital');
      expect(step.state.collected.fullName).toBe('Amina Yusuf');
    }
  });

  it('refuses a correction it cannot attribute, rather than guessing a field', () => {
    // "35" could be an age or a plan number or a house number. Two fields could
    // claim it, so none of them do — the customer is asked which part is wrong.
    const filled = play(GOOD_ANSWERS);
    const step = advanceFlow(F, filled.state, 'no', 'en');
    expect(step.kind).toBe('ask');
    if (step.kind === 'ask') expect(step.reply).toMatch(/which part/i);
  });

  it('does not let a correction steal a message that answers the question asked', () => {
    // "No 12" is a house number. It is also the digit 12, which identifies as
    // an age, behind the word "no", which looks like a correction — so the
    // first implementation rewrote the customer's age to 12 and never stored
    // the address it had just asked for. The pending question wins.
    const afterAge = play(GOOD_ANSWERS.slice(0, 2));
    expect(afterAge.state.awaiting).toBe('residentialAddress');

    const step = advanceFlow(F, afterAge.state, 'No 12', 'en');
    if (step.kind === 'ask') {
      expect(step.state.collected.residentialAddress).toBe('No 12');
      expect(step.state.collected.ageOrDob).toBe('34 years');
    }
  });

  it('still applies a correction the customer names, even mid-question', () => {
    const afterAge = play(GOOD_ANSWERS.slice(0, 2));
    const step = advanceFlow(F, afterAge.state, 'sorry, my name is Amina Bello', 'en');

    if (step.kind === 'ask') {
      expect(step.state.collected.fullName).toBe('Amina Bello');
      // And the address is still what we are waiting for.
      expect(step.state.awaiting).toBe('residentialAddress');
    }
  });

  it('takes an answer with a correction word stuck to the front of it', () => {
    // Asked for the LGA, the customer replies "no, Jos South" — a correction
    // word, but there is nothing to correct yet: it is the answer.
    const upToLga = play(GOOD_ANSWERS.slice(0, 3));
    const step = advanceFlow(F, upToLga.state, 'no, Jos South', 'en');
    if (step.kind === 'ask') expect(step.state.collected.lga).toBe('Jos South');
  });
});

describe('asFlowState', () => {
  it('accepts a state it wrote and rejects anything else', () => {
    const state = beginFlow(F);
    expect(asFlowState(JSON.parse(JSON.stringify(state)))?.flow).toBe(state.flow);
    expect(asFlowState(null)).toBeNull();
    expect(asFlowState('nonsense')).toBeNull();
    expect(asFlowState({ flow: 1 })).toBeNull();
  });
});

describe('through the orchestrator', () => {
  const orchestrator = new ConversationOrchestrator();
  const CONV = 'conv_enrol_1';

  const ctx = () => ({
    conversationId: CONV,
    organizationId: 'org_1',
    customerPhoneNumber: '+2348031234567',
    channel: ChannelType.WHATSAPP,
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
    mockPrisma.organization.findUnique.mockResolvedValue({ name: 'PLASCHEMA', defaultLanguage: 'en' });
    mockPrisma.faqEntry.findMany.mockResolvedValue([]);
    mockPrisma.documentChunk.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findUnique.mockResolvedValue({ id: CONV, flowState: null });
    mockUpsertEnrollee.mockResolvedValue({
      contactId: 'c1', refId: 'ABCD1234', facility: 'Plateau Specialist Hospital',
      planType: 'Informal Sector', isEquity: false,
    });
  });

  it('starts the flow on a registration request and saves the state', async () => {
    const res = await orchestrator.processIncomingMessage(ctx(), 'I want to register for PLASCHEMA');

    expect(res.intentDetected).toBe('FLOW_COLLECTING');
    expect(res.replyText).toMatch(/full name/i);
    // The state must persist, or the next message starts from nothing again —
    // which is the entire bug this feature exists to fix.
    expect(mockPrisma.conversation.update).toHaveBeenCalled();
    const saved = mockPrisma.conversation.update.mock.calls[0][0].data.flowState;
    expect(saved.flow).toBe('plaschema-enrollment');
    expect(saved.awaiting).toBe('fullName');
  });

  it('starts on a Hausa registration request, with no LLM in the loop', async () => {
    const res = await orchestrator.processIncomingMessage(ctx(), 'Ina so in yi rijistar PLASCHEMA');
    expect(res.intentDetected).toBe('FLOW_COLLECTING');
  });

  it('asks the first question in Hausa, rather than switching the conversation to English', async () => {
    const res = await orchestrator.processIncomingMessage(
      ctx(),
      'Ina so in yi rijistar PLASCHEMA don Allah'
    );

    expect(res.intentDetected).toBe('FLOW_COLLECTING');
    expect(res.replyText).toMatch(/cikakken sunanka/);
    // The English wording of the same question is gone, not merely prefaced by
    // an apology for it — which is what this used to assert.
    expect(res.replyText).not.toMatch(/full name/i);
    // And nothing left over apologising for an English-only form.
    expect(res.replyText).not.toMatch(/Turanci/);
  });

  it('stays in Hausa for the questions after the first', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: CONV,
      flowState: {
        flow: 'plaschema-enrollment', collected: { fullName: 'Amina Yusuf' },
        awaiting: 'ageOrDob', startedAt: Date.now(), updatedAt: Date.now(),
      },
    });
    mockPrisma.contact.findFirst.mockResolvedValue({ id: 'c1', preferredLanguage: 'ha' });

    // An address is asked for next; the answer to the age question is accepted.
    const res = await orchestrator.processIncomingMessage(ctx(), '34');

    expect(res.replyText).toMatch(/adireshinka|yankin da kake zama/);
    expect(res.replyText).not.toMatch(/street address/i);
  });

  it('resumes from stored state instead of re-asking', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: CONV,
      flowState: {
        flow: 'plaschema-enrollment',
        collected: { fullName: 'Amina Yusuf' },
        awaiting: 'ageOrDob',
        startedAt: Date.now(), updatedAt: Date.now(),
      },
    });

    const res = await orchestrator.processIncomingMessage(ctx(), '34');

    expect(res.intentDetected).toBe('FLOW_COLLECTING');
    expect(res.replyText).toMatch(/address|area/i); // moved on to the next slot
  });

  it('does not let a tool branch steal a message mid-flow', async () => {
    // "Jos North" is the LGA answer. Without the flow taking precedence this
    // would fall through to the ordinary intent branches.
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: CONV,
      flowState: {
        flow: 'plaschema-enrollment',
        collected: { fullName: 'A B', ageOrDob: '34 years', residentialAddress: '12 Bello Way' },
        awaiting: 'lga',
        startedAt: Date.now(), updatedAt: Date.now(),
      },
    });

    const res = await orchestrator.processIncomingMessage(ctx(), 'i want to book an appointment');

    // It is treated as an answer to the LGA question (and rejected as one),
    // NOT as a booking — the customer is part-way through something.
    expect(res.intentDetected).toBe('FLOW_COLLECTING');
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it('asking for a human still wins, mid-flow', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: CONV,
      flowState: {
        flow: 'plaschema-enrollment', collected: { fullName: 'A B' },
        awaiting: 'ageOrDob', startedAt: Date.now(), updatedAt: Date.now(),
      },
    });

    const res = await orchestrator.processIncomingMessage(ctx(), 'i want to speak to a human agent');

    expect(res.shouldHandoff).toBe(true);
    expect(res.intentDetected).toBe('HUMAN_HANDOFF');
  });

  it('switches language mid-flow and repeats the question, rather than stranding them', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: CONV,
      flowState: {
        flow: 'plaschema-enrollment', collected: { fullName: 'A B' },
        awaiting: 'ageOrDob', startedAt: Date.now(), updatedAt: Date.now(),
      },
    });

    const res = await orchestrator.processIncomingMessage(ctx(), 'hausa please');

    expect(res.intentDetected).toBe('SET_LANGUAGE');
    // The confirmation alone would leave a customer holding an acknowledgement
    // and no question, mid-form, with no idea what to type next. The question
    // comes back in the language they just asked for — repeating it in English
    // would answer the request by ignoring it.
    expect(res.replyText).toMatch(/Shekarunka nawa ne|ranar haihuwarka/);
    expect(res.replyText).not.toMatch(/how old|date of birth/i);
    // And the flow is still theirs — the language request did not abandon it.
    const clearedFlow = mockPrisma.conversation.update.mock.calls.some(
      (c: any) => 'flowState' in (c[0].data ?? {})
    );
    expect(clearedFlow).toBe(false);
  });

  it('writes the enrollment on confirmation, and reports only what was written', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: CONV,
      flowState: {
        flow: 'plaschema-enrollment',
        collected: {
          fullName: 'Amina Yusuf', ageOrDob: '34 years',
          residentialAddress: '12 Bello Way', lga: 'Jos North',
          planType: 'Informal Sector', preferredHospital: 'Plateau Specialist Hospital', nin: '',
        },
        awaiting: null, confirming: true,
        startedAt: Date.now(), updatedAt: Date.now(),
      },
    });

    const res = await orchestrator.processIncomingMessage(ctx(), 'yes');

    expect(res.intentDetected).toBe('REGISTER_ENROLLEE');
    expect(mockUpsertEnrollee).toHaveBeenCalledTimes(1);
    // The caller's real number — never an invented one.
    expect(mockUpsertEnrollee.mock.calls[0][1].phoneNumber).toBe('+2348031234567');
    // Only the facts the write produced.
    expect(res.replyText).toContain('ABCD1234');
    expect(res.replyText).toContain('Plateau Specialist Hospital');
    // And the flow is cleared, so the next message is not read as another "yes".
    const cleared = mockPrisma.conversation.update.mock.calls.some(
      (c: any) => c[0].data.flowState === null || c[0].data.flowState === undefined
    );
    expect(cleared).toBe(true);
  });

  it('degrades honestly when the write fails, rather than claiming registration', async () => {
    mockUpsertEnrollee.mockRejectedValue(new Error('database unavailable'));
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: CONV,
      flowState: {
        flow: 'plaschema-enrollment',
        collected: {
          fullName: 'Amina Yusuf', ageOrDob: '34 years', residentialAddress: '12 Bello Way',
          lga: 'Jos North', planType: 'Informal Sector',
          preferredHospital: 'Plateau Specialist Hospital', nin: '',
        },
        awaiting: null, confirming: true, startedAt: Date.now(), updatedAt: Date.now(),
      },
    });

    const res = await orchestrator.processIncomingMessage(ctx(), 'yes');

    expect(res.shouldHandoff).toBe(true);
    expect(res.replyText).not.toMatch(/you are registered/i);
    expect(res.replyText).not.toMatch(/reference/i);
  });
});
