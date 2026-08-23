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
  ...jest.requireActual('../../database/src/availability'),
  prisma: mockPrisma,
}));

import { ConversationOrchestrator } from '../src/index';
import {
  detectLanguage, asLanguage, t,
  explicitLanguageRequest, wantsLanguageMenu, parseLanguageChoice, LANGUAGE_MENU_MARKER,
} from '../src/languages';
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
      'language_menu', 'language_set', 'language_voice_unavailable',
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

/**
 * Choosing a language, as opposed to merely being detected in one.
 *
 * The distinction is the whole point of this layer: a customer who writes in
 * Hausa mid-conversation gets a silent switch, because confirming would
 * interrupt what they came for. A customer who ASKS gets an acknowledgement,
 * because a request that produces no visible response reads as ignored.
 */
describe('explicitLanguageRequest', () => {
  it.each([
    ['hausa', 'ha'],
    ['Hausa please', 'ha'],
    ['in igbo', 'ig'],
    ['speak to me in yoruba', 'yo'],
    ['change to pidgin', 'pcm'],
    ['I want it in english', 'en'],
    ['abeg hausa', 'ha'],
  ])('reads %j as a request for %s', (text, expected) => {
    expect(explicitLanguageRequest(text as string)).toBe(expected);
  });

  it('does not fire for a message merely WRITTEN in a language', () => {
    // The silent-switch path owns these — see detectLanguage.
    expect(explicitLanguageRequest('ina kwana, i want to book an appointment')).toBeNull();
    expect(explicitLanguageRequest('biko, when is my appointment')).toBeNull();
  });

  it('does not fire for a passing mention inside a real sentence', () => {
    expect(explicitLanguageRequest('my son is learning hausa at school and i need a booking')).toBeNull();
    expect(explicitLanguageRequest('do you have any staff who studied yoruba literature at university')).toBeNull();
  });

  it('ignores a long message even if it names a language', () => {
    const long = 'hausa ' + 'x'.repeat(200);
    expect(explicitLanguageRequest(long)).toBeNull();
  });
});

describe('wantsLanguageMenu', () => {
  it.each(['change language', 'change my language', 'language options', 'what languages do you speak', 'language'])(
    'recognises %j', (text) => {
      expect(wantsLanguageMenu(text)).toBe(true);
    }
  );

  it('does not fire on unrelated text', () => {
    expect(wantsLanguageMenu('i want to book an appointment')).toBe(false);
    expect(wantsLanguageMenu('')).toBe(false);
  });
});

describe('parseLanguageChoice', () => {
  it('maps the menu numbers to the menu order', () => {
    expect(parseLanguageChoice('1')).toBe('en');
    expect(parseLanguageChoice('2')).toBe('pcm');
    expect(parseLanguageChoice('3')).toBe('ha');
    expect(parseLanguageChoice('4')).toBe('ig');
    expect(parseLanguageChoice('5')).toBe('yo');
  });

  it('accepts a named language as well as a number', () => {
    expect(parseLanguageChoice('hausa')).toBe('ha');
  });

  it('rejects numbers outside the menu', () => {
    expect(parseLanguageChoice('6')).toBeNull();
    expect(parseLanguageChoice('0')).toBeNull();
    expect(parseLanguageChoice('12')).toBeNull();
  });

  it('every rendering of the menu carries the marker the next turn looks for', () => {
    for (const lang of ['en', 'pcm', 'ha', 'ig', 'yo'] as const) {
      expect(t(lang, 'language_menu')).toContain(LANGUAGE_MENU_MARKER);
    }
  });
});

describe('orchestrator — language selection', () => {
  const orchestrator = new ConversationOrchestrator();

  const baseContext = (over: any = {}) => ({
    conversationId: 'conv_langsel_1',
    organizationId: 'org_1',
    customerPhoneNumber: '+2348031234567',
    channel: ChannelType.WHATSAPP,
    history: [],
    slots: {},
    isHumanHandoffActive: false,
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    mockPrisma.contact.findFirst.mockResolvedValue({ id: 'c1', preferredLanguage: null });
    mockPrisma.contact.update.mockResolvedValue({});
    mockPrisma.organization.findUnique.mockResolvedValue({ name: 'Test Clinic', defaultLanguage: 'en' });
  });

  it('confirms an explicit request IN the language chosen, and stores it', async () => {
    const res = await orchestrator.processIncomingMessage(baseContext(), 'hausa please');

    expect(res.intentDetected).toBe('SET_LANGUAGE');
    expect(res.replyText).toBe(t('ha', 'language_set'));
    expect(res.replyText).toContain('Hausa'); // the confirmation names it
    expect(mockPrisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { preferredLanguage: 'ha' },
    });
  });

  it('offers the menu when asked which languages exist', async () => {
    const res = await orchestrator.processIncomingMessage(baseContext(), 'change language');

    expect(res.intentDetected).toBe('LANGUAGE_MENU');
    expect(res.replyText).toBe(t('en', 'language_menu'));
    expect(mockPrisma.contact.update).not.toHaveBeenCalled();
  });

  it('accepts a numbered reply only when the menu was the previous turn', async () => {
    const withMenu = baseContext({
      history: [
        { sender: 'CUSTOMER', content: 'change language' },
        { sender: 'AI', content: t('en', 'language_menu') },
      ],
    });
    const res = await orchestrator.processIncomingMessage(withMenu, '3');

    expect(res.intentDetected).toBe('SET_LANGUAGE');
    expect(res.replyText).toBe(t('ha', 'language_set'));
  });

  it('treats a bare number as a language ONLY after the menu — never otherwise', async () => {
    // Same message, no menu behind it: this is an answer to something else
    // (a party size, a plan choice) and must not silently repoint the language.
    const res = await orchestrator.processIncomingMessage(baseContext(), '3');

    expect(res.intentDetected).not.toBe('SET_LANGUAGE');
    expect(mockPrisma.contact.update).not.toHaveBeenCalled();
  });

  it('leaves a message merely WRITTEN in another language on its normal path', async () => {
    // Hausa greeting + a booking request: the customer came to book, so the
    // language switch stays silent and the booking branch still runs.
    const res = await orchestrator.processIncomingMessage(
      baseContext(),
      'ina kwana, i want to book an appointment'
    );

    expect(res.intentDetected).not.toBe('SET_LANGUAGE');
    expect(res.intentDetected).not.toBe('LANGUAGE_MENU');
  });

  it('refuses to promise a language it cannot speak on a call', async () => {
    const res = await orchestrator.processIncomingMessage(
      baseContext({ channel: ChannelType.VOICE }),
      'hausa please'
    );

    expect(res.intentDetected).toBe('SET_LANGUAGE_UNAVAILABLE');
    // Says what is true, names the language, and offers the two real routes.
    expect(res.replyText).toContain('cannot speak Hausa');
    expect(res.replyText).toMatch(/colleague/i);
    expect(res.replyText).toMatch(/WhatsApp/i);
    // And it does NOT record a preference it cannot honour on this channel.
    expect(mockPrisma.contact.update).not.toHaveBeenCalled();
  });

  it('still switches spoken-capable languages on a call', async () => {
    const res = await orchestrator.processIncomingMessage(
      baseContext({ channel: ChannelType.VOICE }),
      'pidgin please'
    );

    expect(res.intentDetected).toBe('SET_LANGUAGE');
    expect(res.replyText).toBe(t('pcm', 'language_set'));
  });
});
