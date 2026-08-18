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

const ENV_SPECS: EnvSpec[] = [
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
  { key: 'PAYSTACK_SECRET_KEY', required: false, description: 'Paystack secret key (sk_live_... or sk_test_...)' },
  { key: 'PAYSTACK_WEBHOOK_SECRET', required: false, description: 'Paystack webhook signature secret' },

  // ─── Vector Search & Caching (Optional — falls back gracefully) ────────────────
  { key: 'QDRANT_URL', required: false, description: 'Qdrant Vector Engine URL' },
  { key: 'REDIS_URL', required: false, description: 'Redis URL for BullMQ job queues and Socket.IO adapter' },

  // ─── Optional but warn if missing ─────────────────────────────────────────────
  { key: 'DEEPGRAM_API_KEY', required: false, description: 'Deepgram STT API key (required for voice calls)' },
  { key: 'ELEVENLABS_API_KEY', required: false, description: 'ElevenLabs API key — TTS, and the fallback for hosted-agent outbound calls' },
  { key: 'ELEVENLABS_BASE_URL', required: false, description: 'ElevenLabs host; set to a residency endpoint (api.eu.residency.elevenlabs.io) to keep data in-jurisdiction' },
  { key: 'ENCRYPTION_KEY', required: false, description: 'AES-256 key (openssl rand -base64 32) for credentials at rest — unset, storing a tenant workspace key is REFUSED rather than written in the clear' },
  { key: 'ENCRYPTION_KEY_PREVIOUS', required: false, description: 'The key retired at the last rotation, tried only on decrypt; remove once scripts/encrypt-secrets.js --apply has re-encrypted everything' },
  { key: 'ELEVENLABS_WEBHOOK_SECRET', required: false, description: 'Signing secret for post-call webhooks — unset, /api/webhooks/elevenlabs returns 500 and every transcript is retried rather than trusted' },
  { key: 'ELEVENLABS_SIGNATURE_HEADER', required: false, description: 'Override the post-call signature header name (default ElevenLabs-Signature)' },
  { key: 'TWILIO_ACCOUNT_SID', required: false, description: 'Twilio Account SID (required for Voice AI telephony)' },
  { key: 'TWILIO_AUTH_TOKEN', required: false, description: 'Twilio Auth Token (required for Voice AI telephony)' },
  { key: 'TELNYX_PUBLIC_KEY', required: false, description: 'Telnyx Ed25519 public key (required to verify Telnyx webhooks)' },
  { key: 'SUPABASE_URL', required: false, description: 'Supabase project URL (required for knowledge-base file uploads)' },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', required: false, description: 'Supabase service role key (required for knowledge-base file uploads)' },
  { key: 'RESEND_API_KEY', required: false, description: 'Resend API key (required for verification/reset/booking emails)' },
  { key: 'API_BASE_URL', required: false, description: 'Public API base URL (used in Paystack callbacks and TwiML stream URLs)' },
  { key: 'WEB_BASE_URL', required: false, description: 'Public dashboard URL (used in emailed links; defaults to localhost)' },
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
