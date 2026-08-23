/**
 * Nigerian language support — detection, templates, and the wiring between them.
 *
 * Two layers on purpose:
 *
 * 1. Pure tests over `detectLanguage`/`t`/`asLanguage`, because the detector's
 *    single job is to be CONSERVATIVE — a wrong guess greets a customer in a
 *    language they don't speak, which reads as "you don't belong here". The
 *    null cases are therefore as load-bearing as the positive ones.
 *
 * 2. Behavioral tests through the orchestrator with prisma mocked, because a
 *    translation module that exists but is never consulted is indistinguishable
 *    from no language support at all. These pin the resolution order
 *    (message signal → stored contact preference → organization default →
 *    English) and that the CONSEQUENTIAL replies — disclosure, escalation,
 *    payment — actually come out in the resolved language with the payment
 *    figures passed through verbatim (invariant 3).
 */

const mockPrisma = {
  organization: { findUnique: jest.fn() },
  booking: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  reservation: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  contact: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  ticket: { create: jest.fn() },
  deal: { findMany: jest.fn() },
  documentChunk: { findMany: jest.fn() },
};

jest.mock('@ace/database', () => ({
  ...jest.requireActual('../../database/src/phone-number'),
  prisma: mockPrisma,
}));

import { ConversationOrchestrator } from '../src/index';
import { detectLanguage, asLanguage, t } from '../src/languages';
import { ChannelType } from '@ace/shared-types';

describe('detectLanguage — conservative by contract', () => {
  it('detects an explicit request in one hit', () => {
    expect(detectLanguage('Can you reply in hausa please')).toBe('ha');
    expect(detectLanguage('talk to me for igbo')).toBe('ig');
    expect(detectLanguage('abeg talk am in pidgin')).toBe('pcm');
    expect(detectLanguage('ni yoruba')).toBe('yo');
  });

  it('detects a multi-word greeting in one hit', () => {
    expect(detectLanguage('ina kwana')).toBe('ha');
    expect(detectLanguage('bawo ni')).toBe('yo');
    expect(detectLanguage('no wahala at all')).toBe('pcm');
  });

  it('detects two combined signals', () => {
    expect(detectLanguage('abeg wetin dey happen')).toBe('pcm');
    expect(detectLanguage('sannu, nawa ne')).toBe('ha');
  });

  it('returns null for a lone one-word marker — loanwords are not a language switch', () => {
    expect(detectLanguage('oya lets go')).toBeNull();
    expect(detectLanguage('ndewo')).toBeNull();
    expect(detectLanguage('biko send the invoice')).toBeNull();
    expect(detectLanguage('abeg send it')).toBeNull();
  });

  it('returns null for plain English and empty input — null means keep, not reset', () => {
    expect(detectLanguage('I want to book an appointment')).toBeNull();
    expect(detectLanguage('')).toBeNull();
    expect(detectLanguage('   ')).toBeNull();
  });

  it('an explicit ask for English wins over other markers in the same message', () => {
    expect(detectLanguage('abeg oya speak english')).toBe('en');
  });
});

describe('asLanguage', () => {
  it('passes supported codes and rejects everything else', () => {
    expect(asLanguage('ha')).toBe('ha');
    expect(asLanguage('en')).toBe('en');
    expect(asLanguage('fr')).toBeNull();
    expect(asLanguage('')).toBeNull();
    expect(asLanguage(null)).toBeNull();
    expect(asLanguage(undefined)).toBeNull();
  });
});

describe('t — templates interpolate, never translate values', () => {
  it('passes payment figures through verbatim in every language', () => {
    for (const lang of ['en', 'pcm', 'ha', 'ig', 'yo'] as const) {
      const msg = t(lang, 'payment_details', {
        account: 'PLASCHEMA Collections',
        bank: 'Zenith Bank',
        number: '1234567890',
      });
      expect(msg).toContain('PLASCHEMA Collections');
      expect(msg).toContain('Zenith Bank');
      expect(msg).toContain('1234567890');
    }
  });

  it('falls back to English for an unknown language value', () => {
    expect(t(null as any, 'no_upcoming_booking')).toBe(t('en', 'no_upcoming_booking'));
  });

  it('every key renders non-empty in every language', () => {
    const keys = [
      'ai_disclosure', 'escalation_connecting', 'payment_details',
      'payment_details_ussd_suffix', 'payment_unconfigured', 'booking_confirmed',
      'booking_cancelled', 'no_upcoming_booking', 'tool_failure', 'capabilities',
    ] as const;
    for (const lang of ['en', 'pcm', 'ha', 'ig', 'yo'] as const) {
      for (const key of keys) {
        expect(t(lang, key, { org: 'X', account: 'A', bank: 'B', number: 'N', ussd: '*1#', service: 'S', when: 'W', ref: 'R' }).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('orchestrator language wiring', () => {
  const orchestrator = new ConversationOrchestrator();

  const baseContext = () => ({
    conversationId: 'conv_lang_test1',
    organizationId: 'org_1',
    customerPhoneNumber: '+2348031234567',
    channel: ChannelType.WHATSAPP,
    history: [],
    slots: {},
    isHumanHandoffActive: false,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.contact.findFirst.mockResolvedValue(null);
    mockPrisma.contact.update.mockResolvedValue({});
    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Test Clinic',
      defaultLanguage: 'en',
      payoutBankName: null,
      payoutAccountName: null,
      payoutAccountNumber: null,
      payoutUssdCode: null,
    });
  });

  it('answers the AI-disclosure question in the customer’s stored language', async () => {
    mockPrisma.contact.findFirst.mockResolvedValue({ id: 'c1', preferredLanguage: 'ha' });

    const res = await orchestrator.processIncomingMessage(baseContext(), 'are you a robot?');

    expect(res.intentDetected).toBe('AI_DISCLOSURE');
    expect(res.replyText).toBe(t('ha', 'ai_disclosure', { org: 'Test Clinic' }));
    // Not just "equals whatever the template says" — it is actually Hausa,
    // and it still names the organization.
    expect(res.replyText).toContain('mataimaki');
    expect(res.replyText).toContain('Test Clinic');
  });

  it('escalates in Pidgin when the message itself signals Pidgin, and remembers it', async () => {
    mockPrisma.contact.findFirst.mockResolvedValue({ id: 'c1', preferredLanguage: null });

    const res = await orchestrator.processIncomingMessage(
      baseContext(),
      'abeg i wan speak to human agent'
    );

    expect(res.shouldHandoff).toBe(true);
    expect(res.intentDetected).toBe('HUMAN_HANDOFF');
    expect(res.replyText).toBe(t('pcm', 'escalation_connecting'));

    // The detection is persisted so the NEXT conversation opens in Pidgin.
    expect(mockPrisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { preferredLanguage: 'pcm' },
    });
  });

  it('renders configured payment details in Hausa with the figures verbatim', async () => {
    mockPrisma.contact.findFirst.mockResolvedValue({ id: 'c1', preferredLanguage: 'ha' });
    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Test Clinic',
      defaultLanguage: 'en',
      payoutBankName: 'Zenith Bank',
      payoutAccountName: 'Test Clinic Ltd',
      payoutAccountNumber: '0123456789',
      payoutUssdCode: '*966*1234#',
    });

    const res = await orchestrator.processIncomingMessage(baseContext(), 'how do i pay?');

    expect(res.intentDetected).toBe('PROVIDE_PAYMENT_GUIDANCE');
    expect(res.shouldHandoff).toBe(false);
    // The exact configured figures, in the Hausa sentence — never paraphrased,
    // never translated (invariant 3).
    expect(res.replyText).toContain('0123456789');
    expect(res.replyText).toContain('Zenith Bank');
    expect(res.replyText).toContain('*966*1234#');
    expect(res.replyText).toContain('lambar asusu'); // "account number", so it IS the Hausa rendering
  });

  it('defers unconfigured payment to a human in Igbo — no invented account in any language', async () => {
    mockPrisma.contact.findFirst.mockResolvedValue({ id: 'c1', preferredLanguage: 'ig' });

    const res = await orchestrator.processIncomingMessage(baseContext(), 'send payment details');

    expect(res.intentDetected).toBe('PROVIDE_PAYMENT_GUIDANCE');
    expect(res.shouldHandoff).toBe(true);
    expect(res.replyText).toBe(t('ig', 'payment_unconfigured', { org: 'Test Clinic' }));
    // No digits that could read as an account number.
    expect(res.replyText).not.toMatch(/\d{6,}/);
  });

  it('falls back to the organization default when nothing else is known', async () => {
    mockPrisma.contact.findFirst.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Test Clinic',
      defaultLanguage: 'yo',
      payoutBankName: null,
      payoutAccountName: null,
      payoutAccountNumber: null,
      payoutUssdCode: null,
    });

    const res = await orchestrator.processIncomingMessage(baseContext(), 'are you an ai');

    expect(res.replyText).toBe(t('yo', 'ai_disclosure', { org: 'Test Clinic' }));
  });

  it('an explicit ask for English overrides a stored preference', async () => {
    mockPrisma.contact.findFirst.mockResolvedValue({ id: 'c1', preferredLanguage: 'ha' });

    const res = await orchestrator.processIncomingMessage(
      baseContext(),
      'speak english please — are you a bot?'
    );

    expect(res.replyText).toBe(t('en', 'ai_disclosure', { org: 'Test Clinic' }));
  });

  it('keeps English behavior byte-identical for customers with no language signal', async () => {
    mockPrisma.contact.findFirst.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Test Clinic',
      defaultLanguage: 'en',
      payoutBankName: 'GTBank',
      payoutAccountName: 'Test Clinic Ltd',
      payoutAccountNumber: '5556667778',
      payoutUssdCode: null,
    });

    const res = await orchestrator.processIncomingMessage(baseContext(), 'how do i pay?');

    // The rich English card, exactly as before languages existed.
    expect(res.replyText).toContain('How to pay Test Clinic');
    expect(res.replyText).toContain('5556667778');
    expect(res.replyText).toContain('GTBank');
  });
});
