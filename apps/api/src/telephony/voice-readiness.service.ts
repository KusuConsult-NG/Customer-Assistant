import { Injectable } from '@nestjs/common';
import { prisma, withTelephonyCredentials } from '@ace/database';

/**
 * Can this agency actually complete a phone call right now?
 *
 * Nothing answered that question before, and the answer is spread across four
 * places that each fail differently and none of which say so to an officer:
 *
 *   - `/api/health` is liveness and touches nothing; `/api/health/ready`
 *     checks PostgreSQL and Redis. Neither knows anything about voice.
 *   - The inbound TwiML for Twilio is `<Connect><Stream/>` and NOTHING else —
 *     `generateInboundWebhookResponse` discards the `promptText` it is given.
 *     The greeting is spoken by the media-stream handler over the socket, so
 *     with no TTS key the call connects and the caller hears PURE SILENCE,
 *     with Twilio reporting the call as answered and completed.
 *   - The Twilio signature is computed over `API_BASE_URL + the route path`.
 *     If that does not match the URL Twilio actually requested, byte for byte,
 *     every call is refused with "This call could not be authenticated" — and
 *     from the outside that is indistinguishable from a wrong auth token.
 *   - `DEEPGRAM_API_KEY` missing means the caller is never TRANSCRIBED: they
 *     hear the greeting, speak, and nothing happens.
 *
 * Each of those produces a call that connects and goes nowhere. So this
 * reports every prerequisite, what breaks when it is absent, and the exact URL
 * to paste into the Twilio console — rather than leaving an operator to infer
 * it from a silent call.
 *
 * It reports CONFIGURATION ONLY. No credential value is returned: the stored
 * ones are decrypted and masked the same way the settings screen masks them,
 * and the env-held ones are reported as present or absent and never echoed.
 */

export type ReadinessState = 'ready' | 'degraded' | 'blocked';

export interface ReadinessCheck {
  id: string;
  label: string;
  state: ReadinessState;
  detail: string;
  /** What a caller experiences if this is not fixed. Empty when ready. */
  consequence: string;
  /** Where the operator fixes it. */
  remedy: string;
}

function apiBaseUrl(): string {
  // The SAME expression the signature check uses (telephony.service.ts). If
  // this is reported wrong, it is wrong there too — which is the point.
  return (process.env.API_BASE_URL || process.env.API_URL || 'http://localhost:4000').replace(/\/+$/, '');
}

@Injectable()
export class VoiceReadinessService {
  async forOrganization(organizationId: string) {
    const base = apiBaseUrl();
    const checks: ReadinessCheck[] = [];

    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, welcomeMessage: true, timezone: true },
    });

    const lines = (
      await prisma.telephonyConfig.findMany({
        where: { organizationId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      })
    ).map((row) => withTelephonyCredentials(row)!);

    // ── 1. A number at all ───────────────────────────────────────────────────
    if (lines.length === 0) {
      checks.push({
        id: 'telephony_config',
        label: 'A phone line is configured',
        state: 'blocked',
        detail: 'This agency has no telephony configuration.',
        consequence:
          'Any call to any number resolves no tenant, so the caller hears ' +
          '"This number is not currently configured" and the call ends.',
        remedy: 'Settings → Voice & Telephony: save the provider and the number.',
      });
    } else {
      checks.push({
        id: 'telephony_config',
        label: 'A phone line is configured',
        state: 'ready',
        detail:
          `${lines.length} line(s): ` +
          lines.map((l) => `${l.phoneNumber} (${l.provider})`).join(', '),
        consequence: '',
        remedy: '',
      });
    }

    const twilio = lines.filter((l) => l.provider === 'TWILIO');

    // ── 2. Carrier credentials ───────────────────────────────────────────────
    for (const line of twilio) {
      const hasSid = !!line.accountSid;
      const hasToken = !!line.authToken;
      checks.push({
        id: `twilio_credentials:${line.id}`,
        label: `Twilio credentials for ${line.phoneNumber}`,
        state: hasSid && hasToken ? 'ready' : 'blocked',
        detail: hasSid && hasToken
          ? `accountSid ${line.accountSid}, authToken set (${line.authToken!.length} chars ending ${line.authToken!.slice(-4)})`
          : `accountSid ${hasSid ? 'set' : 'MISSING'}, authToken ${hasToken ? 'set' : 'MISSING'}`,
        consequence: hasSid && hasToken
          ? ''
          : 'Without the auth token the webhook signature cannot be verified, so ' +
            'the platform cannot tell a real Twilio call from a forged one. It ' +
            'logs a warning and answers anyway — and outbound calls, live ' +
            'transfers and status callbacks all fail outright.',
        remedy: 'Settings → Voice & Telephony: paste the Account SID and Auth Token.',
      });
    }

    // ── 3. The webhook URL, spelled out ──────────────────────────────────────
    //
    // Twilio signs the URL IT requested. The platform rebuilds that URL from
    // API_BASE_URL and compares. A mismatch — http for https, a trailing
    // slash, the web app's host instead of the API's — rejects every call with
    // a message about authentication, which sends the operator to look at
    // their auth token, which is fine.
    const baseLooksLocal = /localhost|127\.0\.0\.1|^http:/i.test(base);
    checks.push({
      id: 'api_base_url',
      label: 'Public API address',
      state: process.env.API_BASE_URL || process.env.API_URL
        ? baseLooksLocal ? 'blocked' : 'ready'
        : 'blocked',
      detail: `API_BASE_URL = ${base}`,
      consequence: baseLooksLocal
        ? 'Twilio cannot reach this address, and the signature is computed over ' +
          'it — so even a reachable deployment refuses every call with "This ' +
          'call could not be authenticated" when the value does not match the ' +
          'URL Twilio requested exactly (scheme included).'
        : '',
      remedy: 'Set API_BASE_URL to the API\'s own public https:// origin, with no trailing slash.',
    });

    // ── 4. Speech, both directions ───────────────────────────────────────────
    const hasTts = !!process.env.ELEVENLABS_API_KEY;
    checks.push({
      id: 'tts',
      label: 'Text to speech (ElevenLabs)',
      state: hasTts ? 'ready' : 'blocked',
      detail: hasTts
        ? `configured; voice ${process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL (default)'}`
        : 'ELEVENLABS_API_KEY is not set',
      consequence: hasTts
        ? ''
        : 'The inbound TwiML is <Connect><Stream/> with no <Say> in it, so the ' +
          'greeting is spoken over the socket. With no TTS key the call ' +
          'connects and the caller hears SILENCE from beginning to end, while ' +
          'Twilio reports the call answered and completed.',
      remedy: 'Set ELEVENLABS_API_KEY on the API service.',
    });

    const hasStt = !!process.env.DEEPGRAM_API_KEY;
    checks.push({
      id: 'stt',
      label: 'Speech to text (Deepgram)',
      state: hasStt ? 'ready' : 'blocked',
      detail: hasStt ? 'configured' : 'DEEPGRAM_API_KEY is not set',
      consequence: hasStt
        ? ''
        : 'The caller is never transcribed: they hear the greeting, speak, and ' +
          'nothing answers. The call stays open until they hang up.',
      remedy: 'Set DEEPGRAM_API_KEY on the API service.',
    });

    const hasLlm = !!process.env.OPENAI_API_KEY;
    checks.push({
      id: 'synthesis',
      label: 'Answer synthesis (OpenAI)',
      state: hasLlm ? 'ready' : 'degraded',
      detail: hasLlm ? 'configured' : 'OPENAI_API_KEY is not set',
      consequence: hasLlm
        ? ''
        : 'Keyword intents and flows still work — bookings, tickets, callbacks. ' +
          'Anything unmatched falls back to a fixed reply instead of an answer ' +
          'drawn from the agency\'s knowledge base.',
      remedy: 'Set OPENAI_API_KEY on the API service.',
    });

    // ── 5. Which engine will answer ──────────────────────────────────────────
    const agent = await prisma.hostedAgentConfig.findUnique({
      where: { organizationId },
      select: { agentId: true, phoneNumberId: true, isActive: true },
    });
    const elevenLabsOwnsTheNumber = !!(agent?.isActive && agent.agentId && agent.phoneNumberId);
    checks.push({
      id: 'engine',
      label: 'Which engine answers',
      state: 'ready',
      detail: elevenLabsOwnsTheNumber
        ? 'The ElevenLabs hosted agent owns this number — it answers Twilio directly and our media-stream path is bypassed.'
        : 'The media-stream path (Deepgram STT + ElevenLabs TTS + the orchestrator).',
      consequence: '',
      remedy: elevenLabsOwnsTheNumber
        ? 'POST /api/agent-provisioning/numbers/release reverses the cutover.'
        : '',
    });

    // ── 6. What happens when the AI hands over ───────────────────────────────
    // `forwardingNumber` lives on the LINE, not on the organization — the
    // media-stream handler reads `session.carrier.forwardingNumber` — so it is
    // reported per line. An agency with three numbers can have a handoff
    // target on one of them and none on the others, and only the line that was
    // dialled decides what that caller gets.
    const withForwarding = lines.filter((l) => !!l.forwardingNumber);
    checks.push({
      id: 'forwarding',
      label: 'Human handoff target',
      state: lines.length > 0 && withForwarding.length === lines.length ? 'ready' : 'degraded',
      detail: lines.length === 0
        ? 'No line configured'
        : lines
            .map((l) => `${l.phoneNumber} → ${l.forwardingNumber || 'nobody'}`)
            .join(', '),
      consequence: withForwarding.length === lines.length && lines.length > 0
        ? ''
        : 'On a line with no forwarding number a handoff cannot move the call. ' +
          'The AI does NOT claim a transfer — it files a HIGH-priority ticket ' +
          'against the caller\'s number and reads back the reference — but ' +
          'nobody picks up during the call.',
      remedy: 'Settings → Voice & Telephony: set the forwarding number on each line.',
    });

    // ── 7. The greeting the caller will actually hear ────────────────────────
    checks.push({
      id: 'greeting',
      label: 'Greeting',
      state: 'ready',
      detail:
        org?.welcomeMessage ||
        'Hello! Thank you for calling. How can I help you today? (platform default — no agency greeting saved)',
      consequence: '',
      remedy: 'Settings → General: set the welcome message.',
    });

    const blocked = checks.filter((c) => c.state === 'blocked');
    const degraded = checks.filter((c) => c.state === 'degraded');

    return {
      organization: org?.name ?? null,
      /** Honest overall verdict, derived from the checks and nothing else. */
      state: blocked.length > 0 ? 'blocked' : degraded.length > 0 ? 'degraded' : 'ready',
      summary:
        blocked.length > 0
          ? `${blocked.length} thing(s) will stop a call from working: ${blocked.map((c) => c.label).join(', ')}.`
          : degraded.length > 0
            ? `A call will connect and be answered. ${degraded.length} thing(s) are reduced: ${degraded.map((c) => c.label).join(', ')}.`
            : 'Every prerequisite for an inbound call is in place.',
      /**
       * Paste these into the Twilio console for the number under test. The
       * voice URL is the one the signature is verified against, so it is
       * generated from the same value rather than written out by hand.
       */
      twilio: {
        voiceWebhook: { method: 'POST', url: `${base}/api/telephony/inbound/twilio` },
        statusCallback: { method: 'POST', url: `${base}/api/telephony/status/twilio` },
        mediaStream: `${base.replace(/^http/, 'ws')}/telephony/stream/<callSid>`,
      },
      /**
       * Stated rather than implied: no real call has ever completed on this
       * path under either engine, so the first live call IS the test.
       */
      note:
        'No real inbound call has ever been completed on this platform under either engine. ' +
        'Watch the API log for telephony_call_log_created, then telephony_mediastream_routing, ' +
        'then the media-stream start event — whichever of those is missing is where the call stopped.',
      checks,
    };
  }
}
