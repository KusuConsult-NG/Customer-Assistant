/**
 * LLM intent routing — the second chance the keyword lists never had.
 *
 * The classifier reads a message the keywords could not place (a Hausa
 * registration request, an English paraphrase) and names one of the EXISTING
 * intents, which is then dispatched to the SAME executors the keyword branches
 * use. Its output is model output, so these tests are mostly about the
 * boundary: the whitelist, the per-intent confidence thresholds, and that
 * every possible failure — junk JSON, invented intents, low confidence, no
 * key — lands on "fall through to the RAG path", never on a wrong action and
 * never on a throw.
 */

const mockPrisma = {
  organization: { findUnique: jest.fn() },
  conversation: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), upsert: jest.fn() },
  booking: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  reservation: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  contact: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  ticket: { create: jest.fn() },
  deal: { findMany: jest.fn() },
  documentChunk: { findMany: jest.fn() },
  faqEntry: { findMany: jest.fn() },
  note: { create: jest.fn() },
};

jest.mock('@ace/database', () => ({
  ...jest.requireActual('../../database/src/phone-number'),
  ...jest.requireActual('../../database/src/ticket-number'),
  prisma: mockPrisma,
  upsertEnrollee: jest.fn(),
  Prisma: { DbNull: null },
}));

// Pinned BEFORE the orchestrators below are constructed. The RAG service
// captures OPENAI_API_KEY at construction, so an ambient key (CI exports a
// dummy one) would send its embeddings call through the fetch mock and break
// the "no fetch when keyless" accounting. The classifier and the synthesis
// tier both read the env per call, so beforeEach can still enable them.
delete process.env.OPENAI_API_KEY;

import { ConversationOrchestrator } from '../src/index';
import { t } from '../src/languages';
import { ChannelType } from '@ace/shared-types';

/** One OpenAI-compatible chat response whose content is `content`. */
const llmReply = (content: string) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content } }] }),
  text: async () => '',
});

describe('LLM intent routing', () => {
  const orchestrator = new ConversationOrchestrator();
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  const baseContext = () => ({
    conversationId: 'conv_cls_test01',
    organizationId: 'org_1',
    customerPhoneNumber: '+2348031234567',
    channel: ChannelType.WHATSAPP,
    history: [],
    slots: {},
    isHumanHandoffActive: false,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-key-not-real';
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    mockPrisma.contact.findFirst.mockResolvedValue({ id: 'c1', preferredLanguage: null, fullName: 'Test Customer' });
    mockPrisma.contact.update.mockResolvedValue({});
    mockPrisma.faqEntry.findMany.mockResolvedValue([]);
    mockPrisma.documentChunk.findMany.mockResolvedValue([]);
    mockPrisma.booking.findFirst.mockResolvedValue(null);
    mockPrisma.booking.findMany.mockResolvedValue([]);
    mockPrisma.reservation.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findUnique.mockResolvedValue({ id: 'conv_1', flowState: null });
    mockPrisma.conversation.upsert.mockResolvedValue({ id: 'conv_1' });
    mockPrisma.conversation.update.mockResolvedValue({});
    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Test Clinic',
      defaultLanguage: 'en',
      payoutBankName: null,
      payoutAccountName: null,
      payoutAccountNumber: null,
      payoutUssdCode: null,
    });
  });

  afterAll(() => {
    global.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  });

  it('does not consult the model at all for a Hausa registration request', async () => {
    // This used to be the classifier's showcase: "Ina so in yi rijistar
    // PLASCHEMA" reached the model, came back BOOK_APPOINTMENT, and booked a
    // "Health Insurance Registration" appointment — which is not what the
    // citizen asked for. Registration is a form, and the entry patterns cover
    // all five languages, so it is now settled before any model is asked.
    const res = await orchestrator.processIncomingMessage(
      baseContext(),
      'Ina so in yi rijistar PLASCHEMA don Allah'
    );

    expect(res.intentDetected).toBe('FLOW_COLLECTING');
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
    // No model call: a deterministic path that still pays for an LLM round trip
    // is not deterministic, it is just lucky.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes a non-English booking request to the real booking executor, with the translated service name', async () => {
    fetchMock.mockResolvedValueOnce(
      llmReply('{"intent":"BOOK_APPOINTMENT","confidence":0.92,"serviceName":"General Consultation"}')
    );
    mockPrisma.booking.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'booking_12345678', ...data })
    );

    // "I want to see a doctor, please" — zero English keywords, and not a
    // registration, so the keyword branches genuinely cannot place it.
    const res = await orchestrator.processIncomingMessage(
      baseContext(),
      'Ina so in ga likita, don Allah'
    );

    expect(res.intentDetected).toBe('BOOK_APPOINTMENT');
    expect(mockPrisma.booking.create).toHaveBeenCalledTimes(1);
    // The classifier's English rendering is what lands in the calendar — not
    // Hausa scraped through an English regex.
    expect(mockPrisma.booking.create.mock.calls[0][0].data.serviceName).toBe(
      'General Consultation'
    );
    // "don Allah" made this a Hausa message, so the confirmation is Hausa.
    expect(res.replyText).toContain('Lambar tunani');
  });

  it('routes a classified handoff to the escalation reply, not to synthesis', async () => {
    fetchMock.mockResolvedValueOnce(
      llmReply('{"intent":"HUMAN_HANDOFF","confidence":0.9,"serviceName":null}')
    );

    const res = await orchestrator.processIncomingMessage(
      baseContext(),
      'Biko, achorom ikwu okwu na mmadu' // Igbo: please, I want to speak with a person
    );

    expect(res.intentDetected).toBe('HUMAN_HANDOFF');
    expect(res.shouldHandoff).toBe(true);
    expect(res.handoffReason).toBe('CUSTOMER_REQUEST');
  });

  it('ignores an intent the whitelist does not know, however confident', async () => {
    fetchMock
      .mockResolvedValueOnce(llmReply('{"intent":"DELETE_ALL_BOOKINGS","confidence":0.99}'))
      // The message then falls through to synthesis, which also calls fetch.
      .mockResolvedValueOnce(llmReply('General answer.'));

    const res = await orchestrator.processIncomingMessage(baseContext(), 'random unmatched text here');

    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
    expect(res.intentDetected).not.toBe('DELETE_ALL_BOOKINGS');
  });

  it('refuses a write on classifier confidence a read would accept', async () => {
    // 0.7 clears the read threshold (0.6) but not CANCEL_BOOKING's 0.8.
    fetchMock
      .mockResolvedValueOnce(llmReply('{"intent":"CANCEL_BOOKING","confidence":0.7}'))
      .mockResolvedValueOnce(llmReply('General answer.'));

    const res = await orchestrator.processIncomingMessage(baseContext(), 'hmm maybe the thing tomorrow');

    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    expect(res.intentDetected).not.toBe('CANCEL_BOOKING');
  });

  it('survives junk classifier output and falls through', async () => {
    fetchMock
      .mockResolvedValueOnce(llmReply('I think they want to book something?'))
      .mockResolvedValueOnce(llmReply('General answer.'));

    const res = await orchestrator.processIncomingMessage(baseContext(), 'some unmatched message');

    expect(typeof res.replyText).toBe('string');
    expect(res.replyText.length).toBeGreaterThan(0);
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it('never calls the LLM when no key is configured', async () => {
    delete process.env.OPENAI_API_KEY;

    const res = await orchestrator.processIncomingMessage(baseContext(), 'some unmatched message');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(typeof res.replyText).toBe('string');
    expect(res.replyText.length).toBeGreaterThan(0);
  });

  it('keyword intents never reach the classifier — no LLM spend on solved routing', async () => {
    const res = await orchestrator.processIncomingMessage(baseContext(), 'how do i pay?');

    expect(res.intentDetected).toBe('PROVIDE_PAYMENT_GUIDANCE');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('capabilities reply', () => {
  const orchestrator = new ConversationOrchestrator();

  const baseContext = () => ({
    conversationId: 'conv_cap_test01',
    organizationId: 'org_1',
    customerPhoneNumber: '+2348031234567',
    channel: ChannelType.WHATSAPP,
    history: [],
    slots: {},
    isHumanHandoffActive: false,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENAI_API_KEY; // deterministic branch — must work keyless
    mockPrisma.contact.findFirst.mockResolvedValue({ id: 'c1', preferredLanguage: null });
    mockPrisma.contact.update.mockResolvedValue({});
    mockPrisma.faqEntry.findMany.mockResolvedValue([]);
    mockPrisma.documentChunk.findMany.mockResolvedValue([]);
    mockPrisma.organization.findUnique.mockResolvedValue({ name: 'Test Clinic', defaultLanguage: 'en' });
  });

  it('answers "what can you do" with the real capability list, keyless', async () => {
    const res = await orchestrator.processIncomingMessage(baseContext(), 'What can you do?');

    expect(res.intentDetected).toBe('CAPABILITIES');
    expect(res.replyText).toBe(t('en', 'capabilities', { org: 'Test Clinic' }));
    // The escape hatch is always named.
    expect(res.replyText).toContain('speak to an agent');
  });

  it('renders the capability list in the customer’s stored language', async () => {
    mockPrisma.contact.findFirst.mockResolvedValue({ id: 'c1', preferredLanguage: 'pcm' });

    const res = await orchestrator.processIncomingMessage(baseContext(), 'what can you do for me');

    expect(res.replyText).toBe(t('pcm', 'capabilities', { org: 'Test Clinic' }));
    expect(res.replyText).toContain('wetin I fit do');
  });

  it('does not swallow a tool question that happens to mention helping', async () => {
    // "what can you do about my broken product" is a complaint, not a menu ask.
    mockPrisma.ticket.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'tck1', ...data })
    );
    mockPrisma.contact.create.mockResolvedValue({ id: 'c1', phoneNumber: '+2348031234567' });

    const res = await orchestrator.processIncomingMessage(
      baseContext(),
      'my product is broken, please report problem'
    );

    expect(res.intentDetected).toBe('CREATE_TICKET');
    expect(res.shouldHandoff).toBe(false); // the ticket genuinely filed
    expect(mockPrisma.ticket.create).toHaveBeenCalledTimes(1);
  });
});
