import { providerHealthForAgency, voiceReadinessForAgency, isPlatformOperator } from '../src/common/agency-audience';

/**
 * Every agency OWNER/ADMIN was shown the deployment's own configuration on the
 * Telephone Service screen: server variable names, the API's base URL, log
 * event names and raw provider errors. The audience filter keeps the STATE of
 * every check and replaces only the operator-level wording.
 */
const OPERATOR_WORDS = /[A-Z]{3,}_[A-Z_]{3,}|TwiML|ILIKE|npm run|telephony_call_log_created|localhost|fetch failed/;

const readiness = {
  state: 'blocked',
  summary: '2 thing(s) will stop a call from working: Public API address, Text to speech (ElevenLabs).',
  note: 'Watch the API log for telephony_call_log_created, then telephony_mediastream_routing.',
  twilio: {
    voiceWebhook: { method: 'POST', url: 'https://api.example/api/telephony/inbound/twilio' },
    statusCallback: { method: 'POST', url: 'https://api.example/api/telephony/status/twilio' },
    mediaStream: 'wss://api.example/telephony/stream/<callSid>',
  },
  checks: [
    { id: 'api_base_url', label: 'Public API address', state: 'blocked', detail: 'API_BASE_URL = http://localhost:4000', consequence: 'signature computed over it', remedy: 'Set API_BASE_URL to the public origin.' },
    { id: 'tts', label: 'Text to speech (ElevenLabs)', state: 'blocked', detail: 'ELEVENLABS_API_KEY is not set', consequence: 'The inbound TwiML carries no <Say>.', remedy: 'Set ELEVENLABS_API_KEY on the API service.' },
    { id: 'synthesis', label: 'Answer synthesis (OpenAI)', state: 'ready', detail: 'configured', consequence: '', remedy: '' },
    { id: 'telephony_config', label: 'A phone line is configured', state: 'blocked', detail: 'This agency has no telephony configuration.', consequence: 'x', remedy: 'Settings → Voice & Telephony: save the provider and the number.' },
  ],
};

const providers = {
  checkedAt: 'now',
  summary: '1 provider(s) answered with a refusal',
  providers: [
    { id: 'email', label: 'Email delivery', state: 'not_configured', detail: 'Set one of RESEND_API_KEY, BREVO_API_KEY.', consequence: 'Recovery is then npm run user:password.' },
    { id: 'openai', label: 'Answer synthesis (OpenAI)', state: 'failed', detail: 'Could not reach OpenAI: fetch failed', consequence: 'ILIKE fallback' },
    { id: 'whatsapp', label: 'WhatsApp (Meta)', state: 'failed', detail: '+2348099990000: token expired', consequence: 'Citizens cannot reach this agency on WhatsApp.' },
  ],
};

describe('diagnostic reports, as an agency sees them', () => {
  it('only a platform operator is an operator', () => {
    expect(isPlatformOperator({ isPlatformAdmin: true })).toBe(true);
    expect(isPlatformOperator({ isPlatformAdmin: false })).toBe(false);
    expect(isPlatformOperator(undefined)).toBe(false);
  });

  it('voice readiness: no server variable, log event, URL or internals — but every state is unchanged', () => {
    const out = voiceReadinessForAgency(structuredClone(readiness));
    const platformChecks = out.checks.filter((c: any) => c.id !== 'telephony_config');
    expect(JSON.stringify(platformChecks)).not.toMatch(OPERATOR_WORDS);
    expect((out as any).note).toBeUndefined();
    expect(out.checks.map((c: any) => c.state)).toEqual(readiness.checks.map((c) => c.state));
    expect(out.state).toBe('blocked');
    expect(out.checks.find((c: any) => c.id === 'tts')!.remedy).toMatch(/State platform team/);
  });

  it("keeps the agency's own check and the two URLs it must paste into its own Twilio console", () => {
    const out = voiceReadinessForAgency(structuredClone(readiness));
    expect(out.checks.find((c: any) => c.id === 'telephony_config')).toEqual(readiness.checks[3]);
    expect(out.twilio.voiceWebhook.url).toBe(readiness.twilio.voiceWebhook.url);
    expect(out.twilio.statusCallback.url).toBe(readiness.twilio.statusCallback.url);
    expect(out.twilio.mediaStream).toBeUndefined();
  });

  it("provider health: platform providers in plain words; the agency's own WhatsApp line untouched", () => {
    const out = providerHealthForAgency(structuredClone(providers));
    const platform = out.providers.filter((p: any) => p.id !== 'whatsapp');
    expect(JSON.stringify(platform)).not.toMatch(OPERATOR_WORDS);
    expect(out.providers.map((p: any) => p.state)).toEqual(['not_configured', 'failed', 'failed']);
    expect(out.providers.find((p: any) => p.id === 'whatsapp')).toEqual(providers.providers[2]);
  });
});

import { errorBodyForAudience, namesOperatorDetail, PLATFORM_ISSUE_MESSAGE } from '../src/common/agency-audience';

// The dashboard shows an error's message to whoever pressed the button. Dozens
// of refusals name the server variable that fixes them; the exception filter
// rewords those once, for everyone who is not a platform operator.
describe('error messages, as an agency sees them', () => {
  const ref = () => 'ab12cd34';
  const sync = { statusCode: 400, error: 'Bad Request', message: 'API_BASE_URL points at localhost, which ElevenLabs cannot reach.' };

  it('recognises operator wording, and not ordinary validation text', () => {
    expect(namesOperatorDetail('Set REDIS_URL in your .env file')).toBe(true);
    expect(namesOperatorDetail('Qdrant is running at http://localhost:6333')).toBe(true);
    expect(namesOperatorDetail('Recovery is npm run user:password')).toBe(true);
    // Enum values in a validation message are not server settings.
    expect(namesOperatorDetail('industry must be one of: LAW_FIRM, REAL_ESTATE, GOVERNMENT')).toBe(false);
    expect(namesOperatorDetail('provider must be SIP_TRUNK or TWILIO')).toBe(false);
    expect(namesOperatorDetail('That email address is already in use.')).toBe(false);
  });

  it('rewords it for a non-operator, with a reference, and keeps the status', () => {
    const out = errorBodyForAudience(structuredClone(sync), false, ref);
    expect(out.reference).toBe('ab12cd34');
    expect(out.body).toEqual({ statusCode: 400, error: 'Bad Request', message: `${PLATFORM_ISSUE_MESSAGE} (reference ab12cd34).` });
  });

  it('leaves it whole for a platform operator', () => {
    expect(errorBodyForAudience(structuredClone(sync), true, ref)).toEqual({ body: sync });
  });

  it('leaves an ordinary refusal untouched for everyone', () => {
    const plain = { statusCode: 403, message: 'Only OWNER and ADMIN can do this.' };
    expect(errorBodyForAudience(plain, false, ref)).toEqual({ body: plain });
  });

  it('rewords each message in a validation array that carries operator wording', () => {
    const out = errorBodyForAudience({ statusCode: 400, message: ['name must be a string', 'Set OPENAI_API_KEY'] }, false, ref);
    expect((out.body as any).message).toEqual(['name must be a string', `${PLATFORM_ISSUE_MESSAGE} (reference ab12cd34).`]);
  });
});
