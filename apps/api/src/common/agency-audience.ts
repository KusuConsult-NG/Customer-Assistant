/**
 * The diagnostic reports, phrased for whoever is reading them.
 *
 * `GET /api/telephony/voice-readiness` and `GET /api/diagnostics/providers`
 * were written for the people who run the deployment, and they say so: server
 * variable names (`ELEVENLABS_API_KEY is not set`), the API's internal base
 * URL, log event names to grep for, a database-credential recovery command,
 * and providers' raw refusal text. Every agency OWNER/ADMIN in the State was
 * being shown all of it — the platform's configuration, on a tenant's screen.
 *
 * None of it is a credential, but it is not the agency's business, it tells a
 * reader exactly which parts of the deployment are missing, and the remedies
 * are ones an agency cannot carry out. So:
 *
 *   - a PLATFORM OPERATOR (`User.isPlatformAdmin`, read from the database on
 *     every request) gets the report unchanged;
 *   - everyone else gets the same checks with the same states, but platform-
 *     level checks are described in plain words, with "the State platform
 *     team" as the remedy, and the operator-only notes are dropped.
 *
 * States are never changed. A blocked check stays blocked for the agency: the
 * point is to stop disclosing HOW the platform is configured, not to hide
 * THAT something is wrong.
 */

const PLATFORM_TEAM = 'Contact the State platform team. This is set up for the whole platform, not per agency.';

/** Checks that describe the deployment rather than the agency. */
const PLATFORM_READINESS: Record<string, { label?: string; ok: string; problem: string; consequence: string }> = {
  api_base_url: {
    ok: 'The platform can receive calls from the phone network.',
    problem: 'The platform is not yet reachable by the phone network.',
    consequence: 'Calls to this agency cannot be accepted until this is fixed.',
  },
  tts: {
    ok: 'The assistant can speak to callers.',
    problem: 'The assistant’s voice is not set up.',
    consequence: 'Callers would hear silence instead of the assistant.',
  },
  stt: {
    ok: 'The assistant can hear callers.',
    problem: 'Speech recognition is not set up.',
    consequence: 'Callers would be heard but never answered.',
  },
  synthesis: {
    ok: 'The assistant can compose answers from the knowledge base.',
    problem: 'Answer writing is not set up.',
    consequence: 'Bookings, cases and callbacks still work; free-form questions get a fixed reply.',
  },
  engine: {
    ok: 'The platform’s voice assistant answers this agency’s calls.',
    problem: 'The platform’s voice assistant answers this agency’s calls.',
    consequence: '',
  },
  deployment_carrier: {
    ok: 'The platform has a phone line available to this agency.',
    problem: 'The platform has a phone line that is not fully set up.',
    consequence: '',
  },
};

const PLATFORM_PROVIDERS: Record<string, { consequence: string }> = {
  deepgram: { consequence: 'Callers cannot be understood by the assistant.' },
  elevenlabs: { consequence: 'The assistant cannot speak on calls.' },
  openai: { consequence: 'Free-form questions get a fixed reply instead of an answer from the knowledge base.' },
  qdrant: { consequence: 'Knowledge search matches exact words only, so differently phrased questions may find nothing.' },
  'supabase-storage': { consequence: 'Documents and photos cannot be uploaded.' },
  email: { consequence: 'Staff invitations and password resets cannot be emailed.' },
};

const PROVIDER_STATE_TEXT: Record<string, string> = {
  ok: 'Working.',
  failed: 'Not working right now.',
  not_configured: 'Not set up.',
};

export function isPlatformOperator(user: { isPlatformAdmin?: boolean } | undefined | null): boolean {
  return user?.isPlatformAdmin === true;
}

export function voiceReadinessForAgency<T extends { checks: any[]; note?: string; twilio?: any }>(report: T): T {
  const checks = report.checks.map((c: any) => {
    const plain = PLATFORM_READINESS[c.id];
    if (!plain) return c;
    return {
      ...c,
      detail: c.state === 'ready' ? plain.ok : plain.problem,
      consequence: c.state === 'ready' ? '' : plain.consequence,
      remedy: c.state === 'ready' ? '' : PLATFORM_TEAM,
    };
  });
  const { note: _operatorNote, ...rest } = report as any;
  return {
    ...rest,
    checks,
    // The two URLs an agency pastes into ITS OWN Twilio console stay: without
    // them it cannot connect its own number. The media-stream address is set
    // by the platform itself and is not something an agency ever enters.
    ...(report.twilio
      ? { twilio: { voiceWebhook: report.twilio.voiceWebhook, statusCallback: report.twilio.statusCallback } }
      : {}),
  } as T;
}

export function providerHealthForAgency<T extends { providers: any[]; summary: string }>(report: T): T {
  return {
    ...report,
    providers: report.providers.map((p: any) => {
      const plain = PLATFORM_PROVIDERS[p.id];
      // The agency's OWN lines (WhatsApp) stay as they are: the number and
      // what Meta said about it are the agency's to act on.
      if (!plain) return p;
      return {
        ...p,
        detail: `${PROVIDER_STATE_TEXT[p.state] ?? ''} ${p.state === 'ok' ? '' : PLATFORM_TEAM}`.trim(),
        consequence: p.state === 'ok' ? '' : plain.consequence,
      };
    }),
  };
}

// ── Error messages ─────────────────────────────────────────────────────────
//
// Dozens of refusals across the API name the server variable that fixes them
// ("API_BASE_URL points at localhost…", "Set REDIS_URL…", "Ensure
// OPENAI_API_KEY has credits and Qdrant is running at http://…:6333"), and
// the dashboard shows an error's message to whoever pressed the button. That
// wording is right for an operator and wrong for an officer, and chasing it
// message by message would miss the next one written. So it is settled ONCE,
// at the exception filter: a message that names a server setting, an internal
// host or a maintenance command is replaced for anyone who is not a platform
// operator, with a reference that finds the original in the log.

const OPERATOR_TEXT = new RegExp(
  [
    // Server variable names, by the prefixes this deployment uses.
    String.raw`\b(?:TWILIO|ELEVENLABS|INFOBIP|DEEPGRAM|OPENAI|REDIS|SUPABASE|RESEND|BREVO|SENDGRID|POSTMARK|MAILGUN|META|WHATSAPP_APP|WHATSAPP_CALL|ENCRYPTION|JWT|DATABASE|DIRECT|QDRANT|TURN|API|TELNYX|PLIVO|AFRICAS_TALKING|SMTP|EMAIL|ANTHROPIC|GOOGLE|AWS|CORS|FRONTEND)_[A-Z0-9_]+\b`,
    // Internal addresses.
    String.raw`\blocalhost\b|\b127\.0\.0\.1\b|\bngrok`,
    // Maintenance commands.
    String.raw`\bnpm run\b`,
  ].join('|'),
);

export const PLATFORM_ISSUE_MESSAGE =
  'This could not be completed because part of the platform is not set up yet. Contact the State platform team';

export function namesOperatorDetail(text: unknown): boolean {
  return typeof text === 'string' && OPERATOR_TEXT.test(text);
}

/**
 * The response body an HttpException produces, reworded for a non-operator
 * when it carries operator detail. Returns the body unchanged otherwise, and
 * `reference` when something was replaced so the caller can log the original.
 */
export function errorBodyForAudience(
  body: unknown,
  operator: boolean,
  reference: () => string,
): { body: unknown; reference?: string } {
  if (operator || body === null || typeof body !== 'object') {
    if (!operator && namesOperatorDetail(body)) {
      const ref = reference();
      return { body: `${PLATFORM_ISSUE_MESSAGE} (reference ${ref}).`, reference: ref };
    }
    return { body };
  }
  let ref: string | undefined;
  const replace = (v: unknown): unknown => {
    if (namesOperatorDetail(v)) {
      ref ??= reference();
      return `${PLATFORM_ISSUE_MESSAGE} (reference ${ref}).`;
    }
    if (Array.isArray(v)) return v.map(replace);
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) out[k] = replace(v);
  // An operator-only remedy is dropped rather than replaced: the message
  // already says who to contact.
  if (ref && typeof out.remedy === 'string' && out.remedy.startsWith(PLATFORM_ISSUE_MESSAGE)) delete out.remedy;
  return ref ? { body: out, reference: ref } : { body };
}
