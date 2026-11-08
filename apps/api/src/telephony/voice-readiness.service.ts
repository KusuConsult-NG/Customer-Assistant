import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InfobipVoiceService } from './infobip/infobip-voice.service';
import {
  prisma,
  withTelephonyCredentials,
  sealTelephonyCredentials,
  normalizePhoneNumber,
} from '@ace/database';

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
  constructor(private readonly infobip: InfobipVoiceService) {}

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

    // ── 1b. Infobip lines ────────────────────────────────────────────────────
    //
    // Checked on their own terms. The Twilio checks below are filtered to
    // Twilio lines, so an Infobip line was never MISreported — but it was
    // reported as nothing at all, which on the screen an operator uses to ask
    // "will a call work" reads as "nothing to fix".
    for (const line of lines.filter((l) => l.provider === 'INFOBIP')) {
      const r = this.infobip.readiness();
      checks.push({
        id: `infobip:${line.id}`,
        label: `Infobip carries ${line.phoneNumber}`,
        state: r.enabled ? 'ready' : 'blocked',
        detail: r.detail,
        consequence: r.enabled
          ? ''
          : 'Calls to this number reach Infobip and are not answered here: events are refused, the AI ' +
            'cannot be attached, or the media stream is refused.',
        remedy: r.enabled ? '' : 'Set the missing INFOBIP_* values on the API service, as listed.',
      });
    }

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

    // ── 2b. The deployment's own carrier credentials ─────────────────────────
    //
    // `handleInboundCall` falls back to `process.env.TWILIO_AUTH_TOKEN` when a
    // line has no stored token, and `env.validation.ts` describes
    // TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN as "required for Voice AI
    // telephony" — which reads as though setting them connects a line.
    //
    // It does not, and that is worth saying out loud. Tenant resolution runs
    // FIRST: the dialled number is looked up in `TelephonyConfig`, and with no
    // row the caller already hears "This number is not currently configured"
    // and the call ends, long before any auth token matters. So on an agency
    // with no line those variables are dead configuration that looks live.
    //
    // Reported as PRESENT or ABSENT only. The values never appear here.
    const envCarrier = {
      accountSid: !!process.env.TWILIO_ACCOUNT_SID,
      authToken: !!process.env.TWILIO_AUTH_TOKEN,
      phoneNumber: !!process.env.TWILIO_PHONE_NUMBER,
    };
    const envCarrierComplete = envCarrier.accountSid && envCarrier.authToken && envCarrier.phoneNumber;
    const anyEnvCarrier = envCarrier.accountSid || envCarrier.authToken || envCarrier.phoneNumber;

    if (anyEnvCarrier) {
      const held = Object.entries(envCarrier)
        .filter(([, present]) => present)
        .map(([name]) => name);
      checks.push({
        id: 'deployment_carrier',
        label: "The deployment's own Twilio credentials",
        // Not a fault either way. It is only a BLOCKER when there is no line,
        // and that is already reported as its own blocker above.
        state: lines.length === 0 && !envCarrierComplete ? 'degraded' : 'ready',
        detail: `This deployment holds ${held.join(', ')} in its environment.`,
        consequence:
          lines.length === 0
            ? 'They do NOT connect a line on their own. A call is matched to an agency by ' +
              'the dialled number in its telephony configuration, and with no row the caller ' +
              'is told the number is not configured before any credential is read. ' +
              (envCarrierComplete
                ? 'All three are present, so this agency can adopt them as its line in one step.'
                : 'Not all three are present, so a line still has to be saved by hand.')
            : '',
        remedy: envCarrierComplete
          ? 'POST /api/telephony/adopt-deployment-line, or the button on this panel.'
          : 'Settings → Voice & Telephony: save the number and its credentials.',
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

    // ── 8. What the CARRIER will actually do ─────────────────────────────────
    //
    // Everything above describes what WE hold. None of it can see the one
    // thing that decides whether a citizen's call arrives: whether the carrier
    // has the number, and where it sends it.
    //
    // This report said "A call will connect and be answered" against a live
    // deployment whose Twilio account held NO NUMBERS AT ALL. Every local
    // check was genuinely green — line saved, credentials stored, speech
    // configured — and no call could ever have arrived. A readiness report
    // that is confidently wrong is worse than none, because it is the thing
    // somebody believes instead of picking up the phone.
    //
    // So it ASKS Twilio. A failure to reach them is reported as unknown, never
    // as ready: not knowing is not the same as working.
    await this.appendCarrierCheck(checks, lines, base);

    const blocked = checks.filter((c) => c.state === 'blocked');
    const degraded = checks.filter((c) => c.state === 'degraded');

    return {
      organization: org?.name ?? null,
      /**
       * Whether this agency could adopt the deployment's Twilio credentials as
       * its line. Drives the button on the telephony panel; the endpoint
       * re-checks every condition itself rather than trusting this.
       */
      canAdoptDeploymentLine: lines.length === 0 && envCarrierComplete,
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

  /**
   * Ask Twilio whether it holds each line, and where it sends the calls.
   *
   * Three outcomes, and the distinction between them is the point:
   *
   *  - BLOCKED when the account does not hold the number, or when its Voice
   *    webhook points somewhere else. In both cases a citizen's call does not
   *    arrive here, however complete the local configuration looks;
   *  - DEGRADED when Twilio could not be asked — no credentials stored, or the
   *    request failed. Unknown is reported as unknown. Treating "we could not
   *    check" as "it works" is exactly how the report came to claim a call
   *    would be answered on an account with no numbers;
   *  - READY only when Twilio itself says the number is there and pointed
   *    here.
   */
  private async appendCarrierCheck(
    checks: ReadinessCheck[],
    lines: Array<{ phoneNumber: string; provider: string; accountSid?: string | null; authToken?: string | null }>,
    base: string
  ): Promise<void> {
    const twilio = lines.filter((l) => l.provider === 'TWILIO');
    if (twilio.length === 0) return;

    const voiceUrl = `${base}/api/telephony/inbound/twilio`;

    for (const line of twilio) {
      const id = `carrier:${line.phoneNumber}`;
      const label = `Twilio actually routes ${line.phoneNumber}`;

      if (!line.accountSid || !line.authToken) {
        checks.push({
          id,
          label,
          state: 'degraded',
          detail: 'Not checked — no stored credentials to ask Twilio with.',
          consequence:
            'Whether a call reaches this platform is unknown. Everything above describes ' +
            'what this platform holds, not what the carrier will do with a call.',
          remedy: 'Settings → Voice & Telephony: save the Account SID and Auth Token.',
        });
        continue;
      }

      const auth = 'Basic ' + Buffer.from(`${line.accountSid}:${line.authToken}`).toString('base64');
      let payload: { incoming_phone_numbers?: Array<{ voice_url?: string }> } | null = null;
      let failure: string | null = null;

      try {
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${line.accountSid}/IncomingPhoneNumbers.json` +
            `?PhoneNumber=${encodeURIComponent(normalizePhoneNumber(line.phoneNumber))}`,
          { headers: { Authorization: auth }, signal: AbortSignal.timeout(8_000) }
        );
        if (!res.ok) failure = `Twilio answered HTTP ${res.status}`;
        else payload = (await res.json()) as any;
      } catch (err: any) {
        failure = err?.message ?? String(err);
      }

      if (failure) {
        checks.push({
          id,
          label,
          state: 'degraded',
          detail: `Could not ask Twilio: ${failure}`,
          consequence:
            'Unknown, not confirmed. This report cannot tell you a call will arrive when it ' +
            'could not reach the carrier to find out.',
          remedy: 'Check the stored Account SID and Auth Token, and that Twilio is reachable.',
        });
        continue;
      }

      const remote = payload?.incoming_phone_numbers?.[0];
      if (!remote) {
        checks.push({
          id,
          label,
          state: 'blocked',
          detail: `Twilio account ${line.accountSid} does not hold ${line.phoneNumber}.`,
          consequence:
            'No call can arrive on this number, because the account that would deliver it ' +
            'does not have it. Everything else being configured changes nothing.',
          remedy:
            'Buy or transfer the number into that account, or save the credentials of the ' +
            'account that does hold it.',
        });
        continue;
      }

      const pointedHere = remote.voice_url === voiceUrl;
      checks.push({
        id,
        label,
        state: pointedHere ? 'ready' : 'blocked',
        detail: pointedHere
          ? `Twilio sends it to ${remote.voice_url}`
          : `Twilio sends it to ${remote.voice_url || '(nothing)'}, not to ${voiceUrl}`,
        consequence: pointedHere
          ? ''
          : "The number exists and rings somewhere else — on a new Twilio number that is a demo " +
            'greeting. The caller hears whatever that answers with, and nothing reaches this platform.',
        remedy: pointedHere ? '' : 'Use "Point the number at this platform", or set the Voice webhook in the Twilio console.',
      });
    }
  }

  /**
   * Adopt the deployment's own Twilio credentials as this agency's line.
   *
   * A deployment can hold `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and
   * `TWILIO_PHONE_NUMBER` and still answer every caller with "This number is
   * not currently configured", because tenant resolution reads
   * `TelephonyConfig` and nothing ever writes a row from those variables. The
   * operator is then told to retype into a settings form credentials the
   * server already holds — and the auth-token fallback in `handleInboundCall`
   * quietly implies those variables are doing something. They are not: the
   * dialled number is matched first, and with no row the call is already over.
   *
   * This writes the row. Four guards, because the credentials belong to the
   * DEPLOYMENT while the row belongs to ONE agency:
   *
   *  - all three variables must be present; two of three is not a line;
   *  - the agency must have no line, so this can never overwrite a configured
   *    number or quietly add a second one;
   *  - the deployment must serve exactly one agency. One agency claiming the
   *    deployment's number is only correct when there is nobody else it could
   *    belong to. The check is a COUNT — no names, no identities;
   *  - `confirmAdoptsDeploymentNumber` must be true, the same shape as
   *    `confirmVoiceCutover`. This decides which agency answers the State's
   *    phone number, and that is not a default.
   */
  async adoptDeploymentLine(
    organizationId: string,
    body: { confirmAdoptsDeploymentNumber?: boolean }
  ) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const phoneNumber = process.env.TWILIO_PHONE_NUMBER;

    const missing = [
      !accountSid && 'TWILIO_ACCOUNT_SID',
      !authToken && 'TWILIO_AUTH_TOKEN',
      !phoneNumber && 'TWILIO_PHONE_NUMBER',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new BadRequestException(
        `This deployment does not hold a complete Twilio line: ${missing.join(', ')} ` +
          'is not set. Save the number and its credentials at Settings → Voice & Telephony instead.'
      );
    }

    const existing = await prisma.telephonyConfig.findMany({
      where: { organizationId },
      select: { id: true, phoneNumber: true },
    });
    if (existing.length > 0) {
      throw new ConflictException(
        `This agency already has ${existing.length} line(s) (${existing
          .map((l) => l.phoneNumber)
          .join(', ')}). Edit them at Settings → Voice & Telephony; this cannot know which to replace.`
      );
    }

    const agencyCount = await prisma.organization.count();
    if (agencyCount > 1) {
      throw new ConflictException(
        `This deployment serves ${agencyCount} agencies, so its own Twilio number does not ` +
          "belong to any one of them. Save this agency's own number at Settings → Voice & Telephony."
      );
    }

    if (!body?.confirmAdoptsDeploymentNumber) {
      throw new BadRequestException(
        `This will make ${phoneNumber} answer as this agency, using the deployment's own Twilio ` +
          'credentials. Re-send with confirmAdoptsDeploymentNumber: true to go ahead.'
      );
    }

    // Canonical and encrypted, exactly as the settings form writes them. A row
    // written any other way is a row the credential helpers cannot read, which
    // surfaces as a carrier rejecting the token — pointing at Twilio for a
    // fault that is ours.
    const created = await prisma.telephonyConfig.create({
      data: sealTelephonyCredentials({
        organizationId,
        provider: 'TWILIO' as any,
        phoneNumber: normalizePhoneNumber(phoneNumber!),
        accountSid: accountSid!,
        authToken: authToken!,
        isDefault: true,
      }),
      select: { id: true, phoneNumber: true, provider: true },
    });

    return {
      line: created,
      // Nothing is claimed about a call working. Twilio still has to be told
      // where to send it, and the readiness report is what says whether the
      // rest holds.
      nextStep:
        `Point this number's Voice webhook at ${apiBaseUrl()}/api/telephony/inbound/twilio ` +
        `(HTTP POST) — POST /api/telephony/point-number-at-platform does it, or set it in ` +
        'the Twilio console — then re-check readiness.',
    };
  }

  /**
   * Tell Twilio to send this number's calls here.
   *
   * This was the last step in the chain that was only manual because nothing
   * had been written to do it. Everything else can be in place — line saved,
   * credentials stored, speech configured, agent provisioned — and the number
   * still rings to whatever its Voice webhook was pointed at, which on a fresh
   * Twilio number is a demo TwiML bin. The readiness report cannot see that:
   * it knows what WE hold, not what Twilio will do with a call.
   *
   * We already hold the tenant's `accountSid` and `authToken`, and already use
   * them to redirect live calls (`transferCallToHuman`) and to import numbers
   * into ElevenLabs. Pointing the webhook is the same authority applied to the
   * same number.
   *
   * It is behind a confirmation because it CHANGES WHERE A CITIZEN'S CALL
   * GOES, in the tenant's own Twilio account — the same reason
   * `confirmVoiceCutover` exists. It reports what Twilio actually did, read
   * back from Twilio's own response, never from the intention: the whole
   * handoff rule of this codebase is act, then announce.
   */
  async pointNumberAtPlatform(
    organizationId: string,
    body: { phoneNumber?: string; confirmRepointsCarrierWebhook?: boolean }
  ) {
    const base = apiBaseUrl();
    if (/localhost|127\.0\.0\.1|^http:/i.test(base)) {
      throw new BadRequestException(
        `API_BASE_URL is ${base}. Twilio cannot reach that, and pointing a real number at it ` +
          'would take the line out of service. Set the public https origin first.'
      );
    }

    const lines = (
      await prisma.telephonyConfig.findMany({
        where: { organizationId, provider: 'TWILIO' as any },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      })
    ).map((row) => withTelephonyCredentials(row)!);

    if (lines.length === 0) {
      throw new BadRequestException(
        'This agency has no Twilio line to point. Save one at Settings → Voice & Telephony first.'
      );
    }

    // Named explicitly when there are several, because this decides which
    // number starts ringing here and the others keep whatever they had.
    const target = body?.phoneNumber
      ? lines.find((l) => normalizePhoneNumber(l.phoneNumber) === normalizePhoneNumber(body.phoneNumber!))
      : lines.length === 1
        ? lines[0]
        : undefined;

    if (!target) {
      throw new BadRequestException(
        body?.phoneNumber
          ? `This agency has no Twilio line for ${body.phoneNumber}.`
          : `This agency has ${lines.length} Twilio lines (${lines
              .map((l) => l.phoneNumber)
              .join(', ')}). Say which one with phoneNumber.`
      );
    }

    if (!target.accountSid || !target.authToken) {
      throw new BadRequestException(
        `${target.phoneNumber} has no stored Twilio credentials, so Twilio cannot be asked to ` +
          'change anything. Save the Account SID and Auth Token at Settings → Voice & Telephony.'
      );
    }

    const voiceUrl = `${base}/api/telephony/inbound/twilio`;
    const statusCallback = `${base}/api/telephony/status/twilio`;

    if (!body?.confirmRepointsCarrierWebhook) {
      throw new BadRequestException(
        `This will change ${target.phoneNumber} in Twilio so its calls arrive at ${voiceUrl}. ` +
          'Whatever it points at now stops receiving them. Re-send with ' +
          'confirmRepointsCarrierWebhook: true to go ahead.'
      );
    }

    const auth = 'Basic ' + Buffer.from(`${target.accountSid}:${target.authToken}`).toString('base64');
    const canonical = normalizePhoneNumber(target.phoneNumber);

    // Twilio addresses a number by its OWN sid, not by the number, so it has
    // to be looked up first. A number absent from the account is the useful
    // failure: it means the credentials and the number belong to different
    // accounts, which no amount of webhook configuration would fix.
    const lookup = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${target.accountSid}/IncomingPhoneNumbers.json` +
        `?PhoneNumber=${encodeURIComponent(canonical)}`,
      { headers: { Authorization: auth }, signal: AbortSignal.timeout(15_000) }
    ).catch((err: any) => {
      throw new BadRequestException(`Twilio could not be reached: ${err?.message ?? err}`);
    });

    if (!lookup.ok) {
      const detail = await lookup.text().catch(() => '');
      throw new BadRequestException(
        `Twilio refused the credential check for ${target.phoneNumber} (HTTP ${lookup.status}). ` +
          `${detail.slice(0, 200)}`
      );
    }

    const found = (await lookup.json()) as { incoming_phone_numbers?: Array<{ sid: string; voice_url?: string }> };
    const number = found.incoming_phone_numbers?.[0];
    if (!number) {
      // "Not on this account" is true but a dead end. The credentials just
      // answered, so the account's own numbers can be listed — and that turns
      // the refusal into the answer: these credentials work, here is what they
      // can actually reach, one of these is the number you meant.
      //
      // This is the shape the deployment's own environment was in: a valid
      // TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN alongside a
      // TWILIO_PHONE_NUMBER from a different account, which no amount of
      // webhook configuration would reconcile.
      const owned = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${target.accountSid}/IncomingPhoneNumbers.json?PageSize=20`,
        { headers: { Authorization: auth }, signal: AbortSignal.timeout(15_000) }
      )
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

      const list = (owned as { incoming_phone_numbers?: Array<{ phone_number?: string }> } | null)
        ?.incoming_phone_numbers?.map((n) => n.phone_number)
        .filter(Boolean) as string[] | undefined;

      throw new BadRequestException(
        `${target.phoneNumber} is not on the Twilio account these credentials belong to ` +
          `(${target.accountSid}). ` +
          (list && list.length > 0
            ? `That account holds: ${list.join(', ')}. Save one of those as this agency's line instead.`
            : list
              ? 'That account holds NO phone numbers at all — buy or transfer one in the Twilio console first.'
              : 'Its numbers could not be listed, so check in the Twilio console which account holds it.')
      );
    }

    const previousVoiceUrl = number.voice_url || null;

    const update = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${target.accountSid}/IncomingPhoneNumbers/${number.sid}.json`,
      {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          VoiceUrl: voiceUrl,
          VoiceMethod: 'POST',
          StatusCallback: statusCallback,
          StatusCallbackMethod: 'POST',
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      }
    ).catch((err: any) => {
      throw new BadRequestException(`Twilio could not be reached: ${err?.message ?? err}`);
    });

    if (!update.ok) {
      const detail = await update.text().catch(() => '');
      throw new BadRequestException(
        `Twilio refused the change to ${target.phoneNumber} (HTTP ${update.status}). ${detail.slice(0, 300)}`
      );
    }

    // Read back from Twilio's OWN response. Reporting the intention would make
    // this the one place in the voice path that claims an outcome it did not
    // verify, which is the bug the act-then-announce rule exists for.
    const after = (await update.json()) as { voice_url?: string; status_callback?: string };

    return {
      phoneNumber: target.phoneNumber,
      twilioSid: number.sid,
      previousVoiceUrl,
      voiceUrl: after.voice_url ?? null,
      statusCallback: after.status_callback ?? null,
      /** True only when Twilio echoed back the URL we asked for. */
      pointedHere: after.voice_url === voiceUrl,
    };
  }
}
