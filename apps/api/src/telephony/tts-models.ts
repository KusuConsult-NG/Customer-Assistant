/**
 * Which ElevenLabs model speaks, in one place and overridable without a deploy.
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * The models were hardcoded as `eleven_turbo_v2` (English) and
 * `eleven_turbo_v2_5` (other languages), with a comment calling the first
 * "confirmed". Both are now DEPRECATED. ElevenLabs' own model documentation
 * states the Turbo models are functionally equivalent to `eleven_flash_v2_5`
 * and `eleven_flash_v2` except that Flash latency is lower, and tells
 * developers to set the replacement explicitly.
 *
 * Deprecated is not removed, so this was not broken. The point is what happens
 * when it IS removed, and that ElevenLabs has already done it to other models:
 * Multilingual v1 and Scribe v1 were removed in July 2026. On that day every
 * call on BOTH channels — WhatsApp and the telephone — would have gone silent
 * at once, because a rejected TTS request produces no audio and the caller is
 * already connected. That is the single failure every readiness surface in
 * this repo exists to prevent, arriving from a third party's release notes.
 *
 * So the ids are:
 *   - moved to the supported models, which are also FASTER (Flash is the
 *     low-latency line, and a voice agent is judged on how quickly it answers);
 *   - overridable by env, so the next deprecation is a dashboard change rather
 *     than a code change and a deploy;
 *   - VERIFIED against `/v1/models` by the provider health check, so a removal
 *     is reported as a failure instead of discovered by a citizen hearing
 *     nothing.
 *
 * `eleven_multilingual_v2` stays available as a choice: it is the
 * highest-quality line and some agencies may prefer it over latency.
 */

/** English-only, lowest latency. Replaces `eleven_turbo_v2`. */
export const DEFAULT_ENGLISH_MODEL = 'eleven_flash_v2';
/** Multilingual, low latency. Replaces `eleven_turbo_v2_5`. */
export const DEFAULT_MULTILINGUAL_MODEL = 'eleven_flash_v2_5';

/**
 * A model id is a bare token — letters, digits and underscores.
 *
 * Validated rather than passed through, for the same reason the Graph version
 * is: a value with a slash or a space in it does not fail as "bad model", it
 * corrupts the request body and comes back as something else entirely.
 */
function sane(id: string | undefined, fallback: string): string {
  const trimmed = id?.trim();
  if (!trimmed) return fallback;
  return /^[A-Za-z0-9_.-]{3,64}$/.test(trimmed) ? trimmed : fallback;
}

/** The model for a given language tag. `en` gets the English-only model. */
export function ttsModelFor(language: string | undefined): string {
  const lang = (language ?? 'en').trim().toLowerCase();
  return lang === 'en' || lang.startsWith('en-')
    ? sane(process.env.ELEVENLABS_MODEL_EN, DEFAULT_ENGLISH_MODEL)
    : sane(process.env.ELEVENLABS_MODEL_MULTILINGUAL, DEFAULT_MULTILINGUAL_MODEL);
}

/** Every model this deployment could ask for, for the health check to verify. */
export function configuredTtsModels(): string[] {
  return [...new Set([ttsModelFor('en'), ttsModelFor('ha')])];
}
