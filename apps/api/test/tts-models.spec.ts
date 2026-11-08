/**
 * Which model speaks, and what happens when a provider retires it.
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * `voice-ai.service.ts` hardcoded `eleven_turbo_v2` for English and
 * `eleven_turbo_v2_5` for everything else, with a comment calling the first
 * "confirmed". Both are deprecated. ElevenLabs' own documentation says the
 * Turbo models are functionally equivalent to the Flash models except that
 * Flash latency is lower, and tells developers to set the replacement
 * explicitly — and ElevenLabs has already REMOVED models outright
 * (Multilingual v1, Scribe v1, July 2026).
 *
 * Deprecated is not removed, so nothing was broken. What matters is the shape
 * of the failure when it IS removed: a rejected TTS request returns no audio
 * for a caller who is already connected, so every call on BOTH channels goes
 * silent at the same moment, from a third party's release notes, with a valid
 * API key and a green credential check.
 *
 * That is the exact failure `provider-health` exists to prevent, and it could
 * not see it: the check asked `/v1/user`, which proves the credential and
 * nothing about the model.
 */
import { ttsModelFor, configuredTtsModels, DEFAULT_ENGLISH_MODEL, DEFAULT_MULTILINGUAL_MODEL } from '../src/telephony/tts-models';

describe('ElevenLabs model selection', () => {
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('does not default to a deprecated Turbo model', () => {
    setEnv('ELEVENLABS_MODEL_EN', undefined);
    setEnv('ELEVENLABS_MODEL_MULTILINGUAL', undefined);
    // The specific ids matter less than that neither is the deprecated line.
    expect(ttsModelFor('en')).not.toMatch(/turbo/);
    expect(ttsModelFor('ha')).not.toMatch(/turbo/);
    expect(ttsModelFor('en')).toBe(DEFAULT_ENGLISH_MODEL);
    expect(ttsModelFor('ha')).toBe(DEFAULT_MULTILINGUAL_MODEL);
  });

  it('uses the English-only model for English and the multilingual one otherwise', () => {
    setEnv('ELEVENLABS_MODEL_EN', undefined);
    setEnv('ELEVENLABS_MODEL_MULTILINGUAL', undefined);
    expect(ttsModelFor('en')).toBe(DEFAULT_ENGLISH_MODEL);
    expect(ttsModelFor('en-NG')).toBe(DEFAULT_ENGLISH_MODEL);
    expect(ttsModelFor('EN')).toBe(DEFAULT_ENGLISH_MODEL);
    for (const lang of ['ha', 'yo', 'ig', 'fr', 'pcm']) {
      expect(ttsModelFor(lang)).toBe(DEFAULT_MULTILINGUAL_MODEL);
    }
    // An unset language is English, matching the rest of the platform.
    expect(ttsModelFor(undefined)).toBe(DEFAULT_ENGLISH_MODEL);
  });

  it('takes an override, so the next deprecation needs no deploy', () => {
    // This is the whole point. A model removal is a third party's decision on
    // a date we do not control, and the fix must not require a code change and
    // a build while every call is silent.
    setEnv('ELEVENLABS_MODEL_EN', 'eleven_v4_turbo');
    setEnv('ELEVENLABS_MODEL_MULTILINGUAL', 'eleven_multilingual_v2');
    expect(ttsModelFor('en')).toBe('eleven_v4_turbo');
    expect(ttsModelFor('yo')).toBe('eleven_multilingual_v2');
  });

  it('ignores a malformed override rather than putting it in the request', () => {
    // A value with a slash or a space does not fail as "bad model" — it
    // corrupts the request body and comes back as something else entirely.
    for (const bad of ['', '  ', 'a', 'has space', 'has/slash', 'x'.repeat(200), '{"model":"x"}']) {
      setEnv('ELEVENLABS_MODEL_EN', bad);
      expect(ttsModelFor('en')).toBe(DEFAULT_ENGLISH_MODEL);
    }
  });

  it('reports every model this deployment could ask for, de-duplicated', () => {
    setEnv('ELEVENLABS_MODEL_EN', undefined);
    setEnv('ELEVENLABS_MODEL_MULTILINGUAL', undefined);
    const models = configuredTtsModels();
    expect(models).toContain(DEFAULT_ENGLISH_MODEL);
    expect(models).toContain(DEFAULT_MULTILINGUAL_MODEL);

    // One id set for both languages must be listed once, or the health check
    // reports the same missing model twice.
    setEnv('ELEVENLABS_MODEL_EN', 'eleven_multilingual_v2');
    setEnv('ELEVENLABS_MODEL_MULTILINGUAL', 'eleven_multilingual_v2');
    expect(configuredTtsModels()).toEqual(['eleven_multilingual_v2']);
  });
});
