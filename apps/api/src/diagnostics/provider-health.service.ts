import { Injectable } from '@nestjs/common';
import { prisma, withTelephonyCredentials, withWhatsAppCredentials, decryptSecret } from '@ace/database';
import { resolveEmailProvider, emailProviderProblem, verifyEmailProvider } from '../common/mailer';

/**
 * Does each provider actually answer us?
 *
 * ── Why "configured" was not an answer ──────────────────────────────────────
 *
 * Every readiness surface in this codebase reported a provider as working
 * because an environment variable was NOT EMPTY. `voice-readiness` said
 * "Text to speech (ElevenLabs): configured" on the strength of
 * `!!process.env.ELEVENLABS_API_KEY`, and the deployment check does the same
 * for the rest. A key that is revoked, mistyped, out of credit, or belongs to
 * a different account is indistinguishable from a working one — every screen
 * is green, and the first thing that discovers the truth is a citizen on the
 * phone hearing silence.
 *
 * That exact failure already happened once on the carrier: the deployment held
 * a valid Twilio SID and token beside a phone number from a different account,
 * and the voice report said "A call will connect and be answered" when no call
 * could ever arrive.
 *
 * So this ASKS each provider. One cheap, read-only request per provider —
 * listing projects, fetching models, naming the authenticated user — never a
 * request that sends a message, places a call, or spends credit.
 *
 * ── Three states, and the middle one is the point ───────────────────────────
 *
 *  - `ok`         the provider answered us and accepted the credential;
 *  - `failed`     it answered and REFUSED, or could not be reached. The reason
 *                 is reported verbatim, because "check your configuration" is
 *                 what somebody reads instead of the actual cause;
 *  - `not_configured` no credential is set. Not a fault on its own: this
 *                 platform serves citizens on WhatsApp and by phone, and most
 *                 of these are optional. What each one costs when absent is
 *                 stated rather than left to be discovered.
 *
 * Nothing here returns a credential, and no check writes anything anywhere.
 */

export type ProviderState = 'ok' | 'failed' | 'not_configured';

export interface ProviderCheck {
  id: string;
  label: string;
  state: ProviderState;
  /** What the provider said, or why it was not asked. Never a credential. */
  detail: string;
  /** What stops working while this is not ok. */
  consequence: string;
}

const TIMEOUT_MS = 8_000;

/** A provider answered, or it did not. Never throws — a failed check is data. */
async function probe(
  url: string,
  init: RequestInit & { headers?: Record<string, string> }
): Promise<{ ok: boolean; status?: number; body?: string; error?: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return { ok: true, status: res.status };
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: body.slice(0, 160) };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

@Injectable()
export class ProviderHealthService {
  async check(organizationId: string): Promise<{
    checkedAt: string;
    summary: string;
    providers: ProviderCheck[];
  }> {
    const providers: ProviderCheck[] = [];

    providers.push(await this.speechToText());
    providers.push(await this.textToSpeech(organizationId));
    providers.push(await this.languageModel());
    providers.push(await this.vectorSearch());
    providers.push(await this.objectStorage());
    providers.push(await this.email());
    providers.push(await this.whatsapp(organizationId));

    const failed = providers.filter((p) => p.state === 'failed');
    const absent = providers.filter((p) => p.state === 'not_configured');

    return {
      checkedAt: new Date().toISOString(),
      summary:
        failed.length > 0
          ? `${failed.length} provider(s) answered with a refusal or could not be reached: ${failed
              .map((p) => p.label)
              .join(', ')}.`
          : absent.length > 0
            ? `Every configured provider answered. ${absent.length} is/are not configured: ${absent
                .map((p) => p.label)
                .join(', ')}.`
            : 'Every provider answered and accepted its credential.',
      providers,
    };
  }

  /** Deepgram. Without it a caller is never transcribed. */
  private async speechToText(): Promise<ProviderCheck> {
    const key = process.env.DEEPGRAM_API_KEY;
    const base = {
      id: 'deepgram',
      label: 'Speech to text (Deepgram)',
      consequence:
        'A caller hears the greeting, speaks, and nothing answers — they are never transcribed.',
    };
    if (!key) {
      return { ...base, state: 'not_configured', detail: 'DEEPGRAM_API_KEY is not set.' };
    }
    // Listing projects is the cheapest authenticated read Deepgram offers.
    const r = await probe('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${key}` },
    });
    return {
      ...base,
      state: r.ok ? 'ok' : 'failed',
      detail: r.ok
        ? 'Deepgram accepted the key.'
        : r.error
          ? `Could not reach Deepgram: ${r.error}`
          : `Deepgram refused the key (HTTP ${r.status}). ${r.body ?? ''}`,
    };
  }

  /**
   * ElevenLabs. The TENANT's key is checked when it has one, because that is
   * the key its calls actually use — the shared env key proves nothing about a
   * tenant with its own workspace.
   */
  private async textToSpeech(organizationId: string): Promise<ProviderCheck> {
    const agent = await prisma.hostedAgentConfig
      .findUnique({ where: { organizationId }, select: { apiKey: true } })
      .catch(() => null);

    // The label is what a legacy-plaintext warning names, so it must say which
    // row this came from rather than just "apiKey".
    const tenantKey = agent?.apiKey
      ? decryptSecret(agent.apiKey, `HostedAgentConfig[${organizationId}].apiKey`)
      : null;
    const key = tenantKey || process.env.ELEVENLABS_API_KEY;
    const whose = tenantKey ? "this agency's own workspace key" : 'the shared ELEVENLABS_API_KEY';

    const base = {
      id: 'elevenlabs',
      label: 'Text to speech (ElevenLabs)',
      consequence:
        'The inbound TwiML carries no <Say>, so the greeting is spoken over the socket. ' +
        'With no working key the caller hears SILENCE for the whole call while Twilio ' +
        'reports it answered and completed.',
    };
    if (!key) {
      return { ...base, state: 'not_configured', detail: 'No ElevenLabs key, tenant or shared.' };
    }

    const r = await probe(`${process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io'}/v1/user`, {
      headers: { 'xi-api-key': key },
    });
    return {
      ...base,
      state: r.ok ? 'ok' : 'failed',
      detail: r.ok
        ? `ElevenLabs accepted ${whose}.`
        : r.error
          ? `Could not reach ElevenLabs: ${r.error}`
          : `ElevenLabs refused ${whose} (HTTP ${r.status}). ${r.body ?? ''}`,
    };
  }

  /** OpenAI. Without it, unmatched questions fall back to a fixed reply. */
  private async languageModel(): Promise<ProviderCheck> {
    const key = process.env.OPENAI_API_KEY;
    const base = {
      id: 'openai',
      label: 'Answer synthesis (OpenAI)',
      consequence:
        'Keyword intents and flows still work — bookings, tickets, callbacks. Anything ' +
        'unmatched falls back to a fixed reply instead of an answer from the knowledge base.',
    };
    if (!key) {
      return { ...base, state: 'not_configured', detail: 'OPENAI_API_KEY is not set.' };
    }
    const r = await probe(`${process.env.LLM_BASE_URL || 'https://api.openai.com/v1'}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    return {
      ...base,
      state: r.ok ? 'ok' : 'failed',
      detail: r.ok
        ? 'OpenAI accepted the key.'
        : r.error
          ? `Could not reach OpenAI: ${r.error}`
          : `OpenAI refused the key (HTTP ${r.status}). ${r.body ?? ''}`,
    };
  }

  /** Qdrant. Without it RAG falls back to a Postgres ILIKE scan. */
  private async vectorSearch(): Promise<ProviderCheck> {
    const url = process.env.QDRANT_URL;
    const base = {
      id: 'qdrant',
      label: 'Knowledge search (Qdrant)',
      consequence:
        'Retrieval falls back to a Postgres ILIKE scan — it still answers, but on literal ' +
        'word matches rather than meaning, so a question phrased differently finds nothing.',
    };
    if (!url) {
      return { ...base, state: 'not_configured', detail: 'QDRANT_URL is not set; the ILIKE fallback is in use.' };
    }
    const headers: Record<string, string> = {};
    if (process.env.QDRANT_API_KEY) headers['api-key'] = process.env.QDRANT_API_KEY;
    const r = await probe(`${url.replace(/\/+$/, '')}/collections`, { headers });
    return {
      ...base,
      state: r.ok ? 'ok' : 'failed',
      detail: r.ok
        ? 'Qdrant answered.'
        : r.error
          ? `Could not reach Qdrant: ${r.error}`
          : `Qdrant refused (HTTP ${r.status}). ${r.body ?? ''}`,
    };
  }

  /**
   * Supabase Storage. Both buckets must exist and be PRIVATE — this reports
   * what is there rather than creating anything.
   */
  private async objectStorage(): Promise<ProviderCheck> {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const base = {
      id: 'supabase-storage',
      label: 'File storage (Supabase)',
      consequence:
        'Knowledge uploads and citizen selfies cannot be stored. A binary upload is marked ' +
        'FAILED rather than silently lost, but nothing is captured.',
    };
    if (!url || !key) {
      return {
        ...base,
        state: 'not_configured',
        detail: `${!url ? 'SUPABASE_URL' : 'SUPABASE_SERVICE_ROLE_KEY'} is not set.`,
      };
    }

    // Both headers, deliberately: with only the bearer token every Supabase
    // Storage request fails with a misleading 400/403.
    const r = await probe(`${url.replace(/\/+$/, '')}/storage/v1/bucket`, {
      headers: { Authorization: `Bearer ${key}`, apikey: key },
    });
    if (!r.ok) {
      return {
        ...base,
        state: 'failed',
        detail: r.error
          ? `Could not reach Supabase Storage: ${r.error}`
          : `Supabase Storage refused (HTTP ${r.status}). ${r.body ?? ''}`,
      };
    }

    // It answered; now say whether the buckets the code writes to exist, and
    // whether either is PUBLIC — a public selfie bucket is citizens' faces on
    // an open URL.
    const listed = await fetch(`${url.replace(/\/+$/, '')}/storage/v1/bucket`, {
      headers: { Authorization: `Bearer ${key}`, apikey: key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then((res) => res.json())
      .catch(() => null);

    const buckets: Array<{ name?: string; public?: boolean }> = Array.isArray(listed) ? listed : [];
    const want = ['knowledge-documents', 'onboarding-selfies'];
    const missing = want.filter((n) => !buckets.some((b) => b.name === n));
    const exposed = buckets.filter((b) => b.public && want.includes(b.name ?? '')).map((b) => b.name);

    if (exposed.length > 0) {
      return {
        ...base,
        state: 'failed',
        detail: `PUBLIC bucket(s): ${exposed.join(', ')}. Anything stored there is readable by anyone with the URL.`,
        consequence:
          'Citizens’ uploaded photographs and the agency’s documents are world-readable. ' +
          'This is reported and not changed automatically: objects are already in them.',
      };
    }

    return {
      ...base,
      state: missing.length > 0 ? 'failed' : 'ok',
      detail:
        missing.length > 0
          ? `Supabase answered, but these buckets do not exist: ${missing.join(', ')}. Run npm run storage:buckets -- --apply.`
          : `Supabase answered; both buckets exist and are private.`,
    };
  }

  /** Whichever email provider is configured. Every route into a staff account is an email. */
  private async email(): Promise<ProviderCheck> {
    const provider = resolveEmailProvider();
    const base = {
      id: 'email',
      label: provider ? `Email delivery (${provider.id})` : 'Email delivery',
      consequence:
        'No staff invitation, email verification or password reset can be delivered, and ' +
        'those endpoints still answer 200. Recovery is then npm run user:password, which ' +
        'needs database credentials.',
    };
    if (!provider) {
      return {
        ...base,
        state: 'not_configured',
        detail: emailProviderProblem() ?? 'No email provider is configured.',
      };
    }

    // Asks the provider, whichever it is. Reading an env var cannot tell a
    // working key from a revoked one — this deployment's Resend key is present
    // and answers "API key is invalid".
    const verified = await verifyEmailProvider();

    // A WARNING here is not a lesser finding — it means the key was accepted
    // and a send will still be refused, which costs exactly what a bad key
    // costs: no invitation, no verification, no password reset. Reporting it
    // as `ok` with a note beside it is how a screen stays green on a
    // deployment where nothing can be delivered.
    const blocked = !verified.ok || !!verified.warning;
    return {
      ...base,
      state: blocked ? 'failed' : 'ok',
      detail: verified.warning
        ? verified.warning
        : verified.ok
          ? `${provider.id} accepted the credential.`
          : verified.error ?? `${provider.id} refused the credential.`,
    };
  }

  /** Meta WhatsApp, per line, with the tenant's own stored token. */
  private async whatsapp(organizationId: string): Promise<ProviderCheck> {
    const base = {
      id: 'whatsapp',
      label: 'WhatsApp (Meta)',
      consequence:
        'Citizens cannot reach this agency on WhatsApp, and nothing sent to it is received. ' +
        'It is one of the two channels this platform exists to answer.',
    };

    const rows = (
      await prisma.whatsAppConfig.findMany({ where: { organizationId, isActive: true } }).catch(() => [])
    ).map((r) => withWhatsAppCredentials(r)!);

    if (rows.length === 0) {
      // Naming the trap, because the deployment-level variables LOOK like the
      // line. `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` and
      // `WHATSAPP_BUSINESS_ID` are declared in render.yaml and read NOWHERE:
      // sending always uses the agency's own stored row, and inbound messages
      // are resolved by Meta's `phoneNumberId` against that same table. So a
      // deployment can hold all three, show them set in the Render dashboard,
      // and still log "no config found" for every message a citizen sends.
      // Only WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN are used, and both
      // are for verifying the webhook rather than for being reachable on it.
      const inertEnv = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ID']
        .filter((k) => !!process.env[k]?.trim());
      return {
        ...base,
        state: 'not_configured',
        detail:
          'This agency has no WhatsApp line configured. Store one at Settings → WhatsApp ' +
          '(POST /api/organizations/whatsapp-config), which is the only place the platform ' +
          'reads a line from.' +
          (inertEnv.length
            ? ` This deployment sets ${inertEnv.join(', ')}, and nothing reads ${
                inertEnv.length === 1 ? 'it' : 'them'
              } — a deployment-level token does not make any agency reachable.`
            : ''),
      };
    }

    const results: string[] = [];
    let anyFailed = false;
    for (const row of rows) {
      if (!row.accessToken || !row.phoneNumberId) {
        anyFailed = true;
        results.push(`${row.displayPhoneNumber || row.phoneNumberId}: no stored access token`);
        continue;
      }
      // Reading the phone number's own record proves the token AND that it can
      // still see that number — an expired token is the usual cause of a line
      // the dashboard shows as connected and that answers nobody.
      const r = await probe(`https://graph.facebook.com/v21.0/${row.phoneNumberId}`, {
        headers: { Authorization: `Bearer ${row.accessToken}` },
      });
      if (r.ok) {
        results.push(`${row.displayPhoneNumber || row.phoneNumberId}: Meta accepted the token`);
      } else {
        anyFailed = true;
        results.push(
          `${row.displayPhoneNumber || row.phoneNumberId}: ${
            r.error ? `unreachable (${r.error})` : `refused (HTTP ${r.status}) ${r.body ?? ''}`
          }`
        );
      }
    }

    return {
      ...base,
      state: anyFailed ? 'failed' : 'ok',
      detail: results.join('; '),
    };
  }
}
