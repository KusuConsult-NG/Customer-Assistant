/**
 * One place that sends email, over HTTPS, for any of several providers.
 *
 * ── Why not SMTP ────────────────────────────────────────────────────────────
 *
 * Because it cannot work here. Render blocks outbound traffic to SMTP ports
 * 25, 465 and 587 on free web services — platform-wide, every region — so
 * nodemailer against Brevo, Gmail or a self-hosted relay times out with a
 * network error that looks nothing like a configuration problem. Port 443 is
 * open, so every provider below is used through its HTTPS API.
 *
 * Port 25 is reportedly blocked on paid instances too, because the underlying
 * EC2 infrastructure blocks it. Treat the paid-tier position as unverified; an
 * HTTPS API is unaffected either way, which is the other reason to prefer one.
 *
 * ── Why more than one provider ──────────────────────────────────────────────
 *
 * The deployment's Resend key answers "API key is invalid", and every route
 * back into a staff account is an email: the invitation, the verification, the
 * password reset. With the provider hard-coded as `new Resend(key)` in three
 * services, replacing it meant a code change and a deploy — on the one
 * capability whose absence stops a new officer ever signing in.
 *
 * So the provider is chosen by configuration. Switching vendor is two
 * environment variables, and nothing in the calling code changes.
 *
 * ── What this does NOT abstract ─────────────────────────────────────────────
 *
 * Amazon SES is deliberately absent. Its API needs SigV4 request signing, and
 * a half-correct signing implementation fails in ways indistinguishable from a
 * bad credential — exactly the confusion this module exists to end. SES is
 * better reached through its own SDK if it is ever wanted.
 */

export type EmailProviderId = 'resend' | 'brevo' | 'sendgrid' | 'postmark' | 'mailgun';

export interface SendResult {
  ok: boolean;
  /** The provider's own words when it refused. Safe to log; never a credential. */
  error?: string;
  /**
   * The credential was ACCEPTED and a send will still be refused.
   *
   * A key is only half of what a provider needs: it also has to recognise the
   * address being sent FROM. Brevo accepts any valid key at `/v3/account`
   * while refusing every send from an address that is not one of its verified
   * senders — so a probe that stopped at the credential would report the
   * provider as working on exactly the deployment where no invitation can be
   * delivered. That is the green-screen failure this whole module exists to
   * end, one layer further in.
   */
  warning?: string;
  provider?: EmailProviderId;
}

interface ProviderConfig {
  id: EmailProviderId;
  key: string;
  /** Mailgun addresses a domain in its URL rather than a header. */
  domain?: string;
}

const FROM_FALLBACK = 'Customer Care Agent <noreply@kusuconsult.com>';

/**
 * Which provider is configured.
 *
 * `EMAIL_PROVIDER` is explicit. Without it, the first key present wins in a
 * fixed order — so a deployment that already has `RESEND_API_KEY` keeps
 * working with no new configuration at all, and adding a second key does not
 * silently change which one sends.
 */
export function resolveEmailProvider(): ProviderConfig | null {
  const named = process.env.EMAIL_PROVIDER?.trim().toLowerCase() as EmailProviderId | undefined;

  const candidates: Array<{ id: EmailProviderId; key?: string; domain?: string }> = [
    { id: 'resend', key: process.env.RESEND_API_KEY },
    { id: 'brevo', key: process.env.BREVO_API_KEY },
    { id: 'sendgrid', key: process.env.SENDGRID_API_KEY },
    { id: 'postmark', key: process.env.POSTMARK_SERVER_TOKEN },
    { id: 'mailgun', key: process.env.MAILGUN_API_KEY, domain: process.env.MAILGUN_DOMAIN },
  ];

  if (named) {
    const wanted = candidates.find((c) => c.id === named);
    // An explicitly named provider with no key is a misconfiguration worth
    // reporting as itself, rather than quietly falling back to another
    // provider and sending from an address nobody expected.
    if (!wanted?.key) return null;
    if (wanted.id === 'mailgun' && !wanted.domain) return null;
    return { id: wanted.id, key: wanted.key, domain: wanted.domain };
  }

  const found = candidates.find((c) => !!c.key && (c.id !== 'mailgun' || !!c.domain));
  return found ? { id: found.id, key: found.key!, domain: found.domain } : null;
}

/** What is wrong, when nothing is configured. For diagnostics and env reporting. */
export function emailProviderProblem(): string | null {
  const named = process.env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (resolveEmailProvider()) return null;
  if (!named) {
    return 'No email provider is configured. Set one of RESEND_API_KEY, BREVO_API_KEY, SENDGRID_API_KEY, POSTMARK_SERVER_TOKEN, or MAILGUN_API_KEY with MAILGUN_DOMAIN.';
  }
  if (named === 'mailgun') {
    return 'EMAIL_PROVIDER=mailgun needs both MAILGUN_API_KEY and MAILGUN_DOMAIN.';
  }
  const expected: Record<string, string> = {
    resend: 'RESEND_API_KEY',
    brevo: 'BREVO_API_KEY',
    sendgrid: 'SENDGRID_API_KEY',
    postmark: 'POSTMARK_SERVER_TOKEN',
  };
  return expected[named]
    ? `EMAIL_PROVIDER=${named} is set but ${expected[named]} is not.`
    : `EMAIL_PROVIDER=${named} is not a provider this platform can use. Use one of resend, brevo, sendgrid, postmark, mailgun.`;
}

/** `Name <addr@example.org>` split into parts, for the providers that want them apart. */
function splitFrom(from: string): { email: string; name?: string } {
  const match = from.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  if (match) return { name: match[1] || undefined, email: match[2] };
  return { email: from.trim() };
}

/**
 * Send one message. Never throws: a refusal is a RESULT.
 *
 * Every caller decides what to do about a failure — the password reset logs at
 * error level and tells the operator how to recover without email, the
 * invitation hands the setup link back to the administrator. A thrown
 * exception would make those decisions impossible to express.
 */
export async function sendTransactionalEmail(args: {
  to: string;
  subject: string;
  html: string;
  from?: string;
}): Promise<SendResult> {
  const provider = resolveEmailProvider();
  if (!provider) {
    return { ok: false, error: emailProviderProblem() ?? 'No email provider configured.' };
  }

  const from = args.from || process.env.EMAIL_FROM || FROM_FALLBACK;
  const { email: fromEmail, name: fromName } = splitFrom(from);

  try {
    const res = await dispatch(provider, { ...args, from, fromEmail, fromName });
    return res;
  } catch (err: any) {
    // A network failure is not a rejected credential, and saying so saves an
    // operator checking the key when the request never left the service.
    return {
      ok: false,
      provider: provider.id,
      error: `Could not reach ${provider.id}: ${err?.message ?? err}`,
    };
  }
}

async function dispatch(
  provider: ProviderConfig,
  m: { to: string; subject: string; html: string; from: string; fromEmail: string; fromName?: string }
): Promise<SendResult> {
  const timeout = AbortSignal.timeout(15_000);
  const fail = async (res: Response): Promise<SendResult> => {
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      provider: provider.id,
      error: `${provider.id} refused it (HTTP ${res.status}). ${body.slice(0, 220)}`,
    };
  };

  switch (provider.id) {
    case 'resend': {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: m.from, to: m.to, subject: m.subject, html: m.html }),
        signal: timeout,
      });
      if (!res.ok) return fail(res);
      // Resend's SDK resolves with `{ data, error }` rather than throwing, and
      // the REST API returns a 4xx — but read the body anyway, so a future
      // change of theirs cannot turn a refusal into a reported success.
      const body: any = await res.json().catch(() => null);
      if (body?.error) {
        return { ok: false, provider: 'resend', error: body.error?.message ?? JSON.stringify(body.error) };
      }
      return { ok: true, provider: 'resend' };
    }

    case 'brevo': {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': provider.key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: m.fromEmail, ...(m.fromName ? { name: m.fromName } : {}) },
          to: [{ email: m.to }],
          subject: m.subject,
          htmlContent: m.html,
        }),
        signal: timeout,
      });
      return res.ok ? { ok: true, provider: 'brevo' } : fail(res);
    }

    case 'sendgrid': {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: m.to }] }],
          from: { email: m.fromEmail, ...(m.fromName ? { name: m.fromName } : {}) },
          subject: m.subject,
          content: [{ type: 'text/html', value: m.html }],
        }),
        signal: timeout,
      });
      // SendGrid answers 202 Accepted, which `res.ok` covers.
      return res.ok ? { ok: true, provider: 'sendgrid' } : fail(res);
    }

    case 'postmark': {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'X-Postmark-Server-Token': provider.key,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ From: m.from, To: m.to, Subject: m.subject, HtmlBody: m.html }),
        signal: timeout,
      });
      if (!res.ok) return fail(res);
      const body: any = await res.json().catch(() => null);
      // Postmark can answer 200 with a non-zero ErrorCode — an inactive
      // recipient, a suppressed address. That is a refusal, not a delivery.
      if (body && typeof body.ErrorCode === 'number' && body.ErrorCode !== 0) {
        return { ok: false, provider: 'postmark', error: `${body.ErrorCode}: ${body.Message ?? ''}` };
      }
      return { ok: true, provider: 'postmark' };
    }

    case 'mailgun': {
      const form = new URLSearchParams({
        from: m.from,
        to: m.to,
        subject: m.subject,
        html: m.html,
      });
      const res = await fetch(`https://api.mailgun.net/v3/${provider.domain}/messages`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`api:${provider.key}`).toString('base64'),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: timeout,
      });
      return res.ok ? { ok: true, provider: 'mailgun' } : fail(res);
    }
  }
}

/**
 * Is the address we send FROM one this Brevo account will accept?
 *
 * `undefined` means NO VERDICT, and that is deliberate in three cases: the
 * senders list could not be read (a restricted key can be refused here while
 * sending perfectly well), the body was not the documented shape, or the
 * request failed outright. Treating "could not check" as "broken" is the same
 * mistake in the opposite direction, and it buries the real blockers among
 * invented ones.
 */
async function brevoSenderWarning(key: string, from: string): Promise<string | undefined> {
  const { email } = splitFrom(from);
  const wanted = email.trim().toLowerCase();
  try {
    const res = await fetch('https://api.brevo.com/v3/senders', {
      headers: { 'api-key': key, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return undefined;
    const body: any = await res.json().catch(() => null);
    const senders: any[] | null = Array.isArray(body?.senders) ? body.senders : null;
    if (!senders) return undefined;

    const match = senders.find(
      (s) => typeof s?.email === 'string' && s.email.trim().toLowerCase() === wanted
    );
    if (!match) {
      // Naming what the account DOES hold turns a dead end into the answer:
      // the credentials have just answered, so the list is free to report.
      const held = senders
        .map((s) => (typeof s?.email === 'string' ? s.email : null))
        .filter(Boolean)
        .slice(0, 5)
        .join(', ');
      return (
        `Brevo accepted the key, but ${email} is not a sender on this account, so every ` +
        `send is refused. Add and verify it at Brevo → Senders, Domains & Dedicated IPs, ` +
        `or set EMAIL_FROM to one the account already holds` +
        (held ? ` (${held}).` : ' — it currently holds none.')
      );
    }
    // `active` is the verification flag. It is not in every documented
    // response, so only an explicit `false` is treated as unverified; absent
    // is no verdict rather than a guess.
    if (match.active === false) {
      return (
        `Brevo accepted the key, but the sender ${email} is not verified yet, so sends from ` +
        `it are refused. Confirm the verification email Brevo sent to that address.`
      );
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * A cheap read-only check that the configured provider accepts the credential,
 * and — for Brevo — that it will accept the address we send FROM.
 * Sends nothing — see `ProviderHealthService`.
 */
export async function verifyEmailProvider(): Promise<SendResult> {
  const provider = resolveEmailProvider();
  if (!provider) return { ok: false, error: emailProviderProblem() ?? 'No email provider configured.' };

  const probes: Record<EmailProviderId, { url: string; headers: Record<string, string> }> = {
    resend: { url: 'https://api.resend.com/domains', headers: { Authorization: `Bearer ${provider.key}` } },
    brevo: { url: 'https://api.brevo.com/v3/account', headers: { 'api-key': provider.key } },
    sendgrid: {
      url: 'https://api.sendgrid.com/v3/scopes',
      headers: { Authorization: `Bearer ${provider.key}` },
    },
    postmark: {
      url: 'https://api.postmarkapp.com/server',
      headers: { 'X-Postmark-Server-Token': provider.key, accept: 'application/json' },
    },
    mailgun: {
      url: `https://api.mailgun.net/v3/domains/${provider.domain}`,
      headers: { Authorization: 'Basic ' + Buffer.from(`api:${provider.key}`).toString('base64') },
    },
  };

  const probe = probes[provider.id];
  try {
    const res = await fetch(probe.url, { headers: probe.headers, signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      const from = process.env.EMAIL_FROM || FROM_FALLBACK;
      const warning =
        provider.id === 'brevo' ? await brevoSenderWarning(provider.key, from) : undefined;
      return { ok: true, provider: provider.id, ...(warning ? { warning } : {}) };
    }
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      provider: provider.id,
      error: `${provider.id} refused the credential (HTTP ${res.status}). ${body.slice(0, 180)}`,
    };
  } catch (err: any) {
    return { ok: false, provider: provider.id, error: `Could not reach ${provider.id}: ${err?.message ?? err}` };
  }
}
