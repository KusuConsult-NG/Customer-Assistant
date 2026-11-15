/**
 * Customer Care Agent — Startup Environment Validation
 *
 * Validates all required environment variables at bootstrap time.
 * The application will refuse to start (process.exit(1)) if any
 * required variable is missing or still set to a placeholder value.
 *
 * Principle: Fail loudly at startup, not silently at runtime.
 */

import { Logger } from '@nestjs/common';

const logger = new Logger('EnvValidation');

interface EnvSpec {
  key: string;
  required: boolean;
  description: string;
  // If true, throws if value contains substring "placeholder"
  rejectPlaceholder?: boolean;
}

/**
 * Exported so a test can assert that an OPTIONAL variable still states what
 * is lost without it. `RESEND_API_KEY` is the case that matters: optional is
 * correct, and "optional" must not read as "costs nothing".
 */
export const ENV_SPECS: EnvSpec[] = [
  // ─── Database ────────────────────────────────────────────────────────────────
  { key: 'DATABASE_URL', required: true, description: 'PostgreSQL connection string', rejectPlaceholder: true },

  // ─── JWT Auth ─────────────────────────────────────────────────────────────────
  { key: 'JWT_SECRET', required: true, description: 'JWT signing secret (min 32 chars)', rejectPlaceholder: true },
  { key: 'JWT_REFRESH_SECRET', required: true, description: 'JWT refresh signing secret', rejectPlaceholder: true },

  // ─── AI Provider ─────────────────────────────────────────────────────────────
  // The key authenticates whichever OpenAI-COMPATIBLE provider LLM_BASE_URL
  // points at — OpenAI itself by default, or a free-tier provider serving the
  // same wire format (Groq, Gemini's OpenAI-compat endpoint, OpenRouter).
  { key: 'OPENAI_API_KEY', required: true, description: 'API key for the OpenAI-compatible LLM provider', rejectPlaceholder: true },
  { key: 'LLM_BASE_URL', required: false, description: 'OpenAI-compatible API base URL (default https://api.openai.com/v1)' },
  { key: 'LLM_CHAT_MODEL', required: false, description: 'Chat model id on that provider (default gpt-4o-mini)' },
  { key: 'EMBEDDING_MODEL', required: false, description: 'Embedding model id (default text-embedding-3-small)' },
  { key: 'EMBEDDING_DIMENSIONS', required: false, description: 'Embedding vector width; must match the Qdrant collection (default 1536)' },

  // ─── WhatsApp / Meta ─────────────────────────────────────────────────────────
  { key: 'WHATSAPP_APP_SECRET', required: true, description: 'Meta App Secret for X-Hub-Signature-256 verification', rejectPlaceholder: true },
  { key: 'WHATSAPP_VERIFY_TOKEN', required: true, description: 'Webhook verify token set on Meta Developer Console', rejectPlaceholder: true },

  // ─── Paystack (Optional until payments enabled) ────────────────────────────────

  // ─── Vector Search & Caching (Optional — falls back gracefully) ────────────────
  { key: 'QDRANT_URL', required: false, description: 'Qdrant Vector Engine URL' },
  { key: 'REDIS_URL', required: false, description: 'Redis URL for BullMQ job queues and Socket.IO adapter' },

  // ─── Optional but warn if missing ─────────────────────────────────────────────
  { key: 'DEEPGRAM_API_KEY', required: false, description: 'Deepgram STT API key (required for voice calls)' },
  { key: 'ELEVENLABS_API_KEY', required: false, description: 'ElevenLabs API key — TTS, and the SHARED hosted-agent workspace, usable only when ELEVENLABS_ALLOW_SHARED_WORKSPACE is set' },
  { key: 'ELEVENLABS_ALLOW_SHARED_WORKSPACE', required: false, description: 'Set only on a single-tenant deployment: lets tenants without their own key run in the shared ELEVENLABS_API_KEY workspace, where one workspace holds every tenant’s numbers, WhatsApp lines and transcripts' },
  { key: 'ELEVENLABS_BASE_URL', required: false, description: 'ElevenLabs host; set to a residency endpoint (api.eu.residency.elevenlabs.io) to keep data in-jurisdiction' },
  { key: 'ENCRYPTION_KEY', required: false, description: 'AES-256 key (openssl rand -base64 32) for credentials at rest — unset, storing a tenant workspace key is REFUSED rather than written in the clear' },
  { key: 'ENCRYPTION_KEY_PREVIOUS', required: false, description: 'The key retired at the last rotation, tried only on decrypt; remove once scripts/encrypt-secrets.js --apply has re-encrypted everything' },
  { key: 'ELEVENLABS_WEBHOOK_SECRET', required: false, description: 'Signing secret for the SHARED workspace’s post-call webhook — unset, /api/webhooks/elevenlabs returns 500 and every transcript is retried rather than trusted. A tenant with its own workspace stores its own secret and receives on /api/webhooks/elevenlabs/:organizationId instead' },
  { key: 'ELEVENLABS_SIGNATURE_HEADER', required: false, description: 'Override the post-call signature header name (default ElevenLabs-Signature)' },
  { key: 'TWILIO_ACCOUNT_SID', required: false, description: 'Twilio Account SID (required for Voice AI telephony)' },
  { key: 'TWILIO_AUTH_TOKEN', required: false, description: 'Twilio Auth Token (required for Voice AI telephony)' },
  { key: 'TELNYX_PUBLIC_KEY', required: false, description: 'Telnyx Ed25519 public key (required to verify Telnyx webhooks)' },
  { key: 'SUPABASE_URL', required: false, description: 'Supabase project URL (required for knowledge-base file uploads)' },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', required: false, description: 'Supabase service role key (required for knowledge-base file uploads)' },
  // ── Email, over HTTPS, from whichever provider is configured ──────────────
  //
  // SMTP is NOT an alternative on this host: Render blocks outbound traffic to
  // ports 25, 465 and 587 on free web services, so nodemailer against any
  // relay times out with a network error that reads nothing like a
  // configuration problem. Every provider below is used through its HTTPS API
  // on 443.
  //
  // One of these is enough. `EMAIL_PROVIDER` names which to use when several
  // are present; without it the first one set wins, in the order listed, so a
  // deployment already holding RESEND_API_KEY keeps working unchanged.
  {
    key: 'EMAIL_PROVIDER',
    required: false,
    description:
      'Which email provider to use: resend | brevo | sendgrid | postmark | mailgun. ' +
      'Optional — without it, the first configured key wins.',
  },
  {
    key: 'BREVO_API_KEY',
    required: false,
    description:
      'Brevo (ex-Sendinblue) HTTPS API key. An alternative to RESEND_API_KEY. Brevo also ' +
      'requires EMAIL_FROM to be one of the account\'s VERIFIED senders — a valid key with ' +
      'an unverified sender accepts every probe and refuses every send, so check ' +
      'GET /api/diagnostics/providers after setting it.',
  },
  {
    key: 'SENDGRID_API_KEY',
    required: false,
    description: 'SendGrid HTTPS API key. An alternative to RESEND_API_KEY.',
  },
  {
    key: 'POSTMARK_SERVER_TOKEN',
    required: false,
    description: 'Postmark server token. An alternative to RESEND_API_KEY.',
  },
  {
    key: 'MAILGUN_API_KEY',
    required: false,
    description: 'Mailgun private API key. Needs MAILGUN_DOMAIN as well.',
  },
  {
    key: 'MAILGUN_DOMAIN',
    required: false,
    description: 'The Mailgun sending domain. Required with MAILGUN_API_KEY, useless without it.',
  },
  {
    key: 'RESEND_API_KEY',
    required: false,
    // Optional because the platform serves citizens on WhatsApp and by phone,
    // and those work with no email provider at all. But say what is lost:
    // without it NOBODY can be invited, verify an address or reset a password,
    // and every one of those endpoints still answers 200. The way back in is
    // `npm run user:password`, which needs database credentials and no email.
    description:
      'Resend API key. WITHOUT IT no staff invitation, email verification or password ' +
      'reset can be delivered — those endpoints still answer 200, so the failure is silent. ' +
      'Recover an account with: npm run user:password -- <email> --apply',
  },
  {
    key: 'WHATSAPP_CALL_ANSWER',
    required: false,
    // Optional and OFF by default, and the cost of switching it on wrongly is
    // worse than the cost of leaving it off — which is the opposite of most
    // optional vars here, so say so.
    description:
      'Set to 1 to ANSWER inbound WhatsApp calls instead of recording them and replying by message. ' +
      'Needs a relay as well, and there are two ways to have one: TURN_PROVIDER=twilio reuses the ' +
      "deployment's own TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN (nothing new to sign up for), or " +
      'TURN_URL/TURN_USERNAME/TURN_CREDENTIAL point at your own relay. Without either the service ' +
      'refuses to answer, because an answered call with no media route consumes the citizen and ' +
      'suppresses the message fallback. NO REAL CALL HAS PROVEN THIS PATH — treat the first one as the test.',
  },
  {
    key: 'TWILIO_RING_OFFICERS_FIRST',
    required: false,
    description:
      'Set to 1 to ring signed-in officers in the dashboard BEFORE the AI answers an inbound call. ' +
      'OFF by default: the Twilio browser credentials exist so an officer can place a CALLBACK from ' +
      'the dashboard, and setting them for that must not silently change who answers the agency\'s ' +
      'main line. With it off, the AI answers, takes the citizen\'s name, address and reason, and ' +
      'promises a callback for anything it cannot resolve.',
  },
  {
    key: 'TWILIO_API_KEY_SID',
    required: false,
    description:
      'Twilio API Key SID (starts SK…) for BROWSER answering — officers picking up a citizen\'s call ' +
      'in the dashboard. This is NOT the Account SID and NOT the Auth Token: it is a separate ' +
      'credential pair created in the Twilio console. Without all four TWILIO_* browser variables, ' +
      'inbound calls go straight to the AI exactly as before.',
  },
  {
    key: 'TWILIO_API_KEY_SECRET',
    required: false,
    description:
      'The secret half of TWILIO_API_KEY_SID. Twilio shows it ONCE, when the key is created.',
  },
  {
    key: 'TWILIO_TWIML_APP_SID',
    required: false,
    description:
      'Twilio TwiML App SID (starts AP…). What a browser client dials OUT through; without it ' +
      'officers can answer calls but not place them.',
  },
  {
    key: 'DEEPGRAM_MODEL',
    required: false,
    description:
      'Deepgram speech model (default nova-2, which is what this platform has always used). ' +
      'nova-3 is more accurate and is what Deepgram now recommends, but changing which model hears ' +
      'every citizen wants evidence on Nigerian English rather than being flipped as a default. Set ' +
      'DEEPGRAM_MODEL=nova-3 to try it without a deploy; this is also the lever if nova-2 is ever ' +
      'retired. Ignored unless it looks like a model id.',
  },
  {
    key: 'ELEVENLABS_MODEL_EN',
    required: false,
    description:
      'ElevenLabs model id for ENGLISH speech (default eleven_flash_v2). Exists because a model id ' +
      'ages out: the hardcoded eleven_turbo_v2 is deprecated, and ElevenLabs has removed models ' +
      'outright before. On a removal every call on BOTH channels goes silent at once, because a ' +
      'rejected TTS request returns no audio to a caller who is already connected. Set this to a ' +
      'model the workspace offers; GET /api/diagnostics/providers lists them. Ignored unless it ' +
      'looks like a model id.',
  },
  {
    key: 'ELEVENLABS_MODEL_MULTILINGUAL',
    required: false,
    description:
      'ElevenLabs model id for every NON-English language (default eleven_flash_v2_5). Same reason ' +
      'as ELEVENLABS_MODEL_EN.',
  },
  {
    key: 'META_GRAPH_VERSION',
    required: false,
    description:
      "Graph API version for the WhatsApp CALLING settings calls (e.g. v24.0; default v24.0). A Graph " +
      'version decides which edges exist, and a version older than the Calling API refuses it with ' +
      '"Object with ID … does not exist, cannot be loaded due to missing permissions, or does not ' +
      'support this operation" — a sentence covering three unrelated faults, of which the id is only ' +
      'one. Set this to try a newer version without a code change. Ignored unless it looks like vNN.N.',
  },
  {
    key: 'TURN_URL',
    required: false,
    description:
      'TURN relay for WhatsApp call media (e.g. turn:relay.example.com:3478). WebRTC media is UDP and this ' +
      'deployment exposes no inbound UDP, so media must relay through TURN. Useless without TURN_USERNAME ' +
      'and TURN_CREDENTIAL.',
  },
  {
    key: 'TURN_PROVIDER',
    required: false,
    description:
      "Set to 'twilio' to mint ephemeral TURN credentials from the deployment's Twilio account (Network " +
      'Traversal Service) instead of running your own relay. Needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN, ' +
      'and makes TURN_URL/TURN_USERNAME/TURN_CREDENTIAL unnecessary.',
  },
  { key: 'TURN_USERNAME', required: false, description: 'TURN username. Required with TURN_URL, useless without it.' },
  { key: 'TURN_CREDENTIAL', required: false, description: 'TURN credential. Required with TURN_URL, useless without it.' },
  { key: 'API_BASE_URL', required: false, description: 'Public API base URL (used in TwiML stream URLs and agent tool callbacks)' },
  { key: 'WEB_BASE_URL', required: false, description: 'Public dashboard URL (used in emailed links; defaults to localhost)' },
  {
    key: 'ALLOW_MISSING_ENUM_VALUES',
    required: false,
    description:
      'Set to 1 to boot WITHOUT checking that the database has every enum value the client declares. ' +
      'A write of a missing value fails at that statement and nothing after it runs, while every other ' +
      'request succeeds \u2014 the failure is invisible to health checks',
  },
  {
    key: 'ALLOW_MISSING_BOOKING_CONSTRAINT',
    required: false,
    description:
      'Set to 1 to boot WITHOUT the double-booking guarantee. Only for a deployment that takes no bookings — concurrent bookings for one slot will all succeed',
  },
];

export function validateEnvironment(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const spec of ENV_SPECS) {
    const value = process.env[spec.key];

    if (!value || value.trim() === '') {
      if (spec.required) {
        errors.push(`  ✗ [MISSING] ${spec.key}: ${spec.description}`);
      } else {
        warnings.push(`  ⚠ [OPTIONAL] ${spec.key}: ${spec.description}`);
      }
      continue;
    }

    if (spec.rejectPlaceholder && value.toLowerCase().includes('placeholder')) {
      errors.push(`  ✗ [PLACEHOLDER] ${spec.key} still contains the word "placeholder". Set a real value.`);
    }

    // Validate JWT_SECRET length
    if (spec.key === 'JWT_SECRET' && value.length < 32) {
      errors.push(`  ✗ [WEAK_SECRET] JWT_SECRET must be at least 32 characters long. Current length: ${value.length}`);
    }
    // Warn (not fail — existing deployments may have shorter values) on weak refresh secret
    if (spec.key === 'JWT_REFRESH_SECRET' && value.length < 32) {
      warnings.push(`  ⚠ [WEAK_SECRET] JWT_REFRESH_SECRET is shorter than 32 characters (${value.length}). Rotate to a longer value.`);
    }
  }

  if (warnings.length > 0) {
    logger.warn(`Optional environment variables not configured:\n${warnings.join('\n')}`);
  }

  if (errors.length > 0) {
    logger.error(
      `\n╔═══════════════════════════════════════════════════════════════╗\n` +
      `║   Customer Care Agent: STARTUP CONFIGURATION ERRORS           ║\n` +
      `╠═══════════════════════════════════════════════════════════════╣\n` +
      `${errors.join('\n')}\n` +
      `╚═══════════════════════════════════════════════════════════════╝\n` +
      `Fix the above environment variables in your .env file and restart.`
    );
    process.exit(1);
  }

  logger.log('✅ All required environment variables validated successfully.');
}
