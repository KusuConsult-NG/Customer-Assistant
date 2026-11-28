import { localLineRecognitionTerms } from '../agent-tools/plateau-vocabulary';
import WebSocket from 'ws';
import { deepgramListenUrl } from '../telephony/voice-ai.service';
import { SAMPLE_RATE } from './audiosocket';

export interface SttEvents {
  /** Words heard so far in the current stretch (interim results included). */
  onInterim(text: string): void;
  /**
   * A finalised piece; `endOfTurn` when Deepgram judged the caller stopped.
   * `silenceMs`: how much silence after the last word Deepgram had heard when
   * it judged so (its own audio clock), when it says.
   */
  onFinal(text: string, endOfTurn: boolean, silenceMs?: number): void;
  /** Deepgram's word-gap detector: the caller has stopped, whatever endpointing said. */
  onUtteranceEnd(silenceMs?: number): void;
  onError(err: Error): void;
}

export interface SttStream {
  send(slin: Buffer): void;
  close(): void;
}

export type SttFactory = (events: SttEvents) => Promise<SttStream>;

/**
 * The line's recognition model. nova-3, measured on the caller's side of four
 * real calls on 26 Nov 2026: nova-2 heard "In 10/26?" for "in 2026" and lost
 * "calling" and "projects"; nova-3 got all three in every setting.
 * LOCAL_VOICE_STT_MODEL overrides it; DEEPGRAM_MODEL is the old Twilio path's.
 */
export function localSttModel(): string {
  const m = process.env.LOCAL_VOICE_STT_MODEL?.trim();
  return m && /^[A-Za-z0-9_.-]{3,40}$/.test(m) ? m : 'nova-3';
}

/**
 * The Deepgram URL for AudioSocket audio: linear16 at 8 kHz — what Asterisk
 * sends, untranscoded. Interim results drive barge-in; endpointing plus
 * utterance-end decide when the caller has finished a turn. Plateau's LGA
 * names are boosted, because phone ASR otherwise hears "Bokkos" as "books".
 */
export function deepgramUrl(): string {
  const model = localSttModel();
  const params = new URLSearchParams({
    model,
    language: 'en',
    encoding: 'linear16',
    sample_rate: String(SAMPLE_RATE),
    channels: '1',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    endpointing: process.env.LOCAL_VOICE_ENDPOINTING_MS?.trim() || '400',
    utterance_end_ms: String(utteranceEndMs()),
    vad_events: 'true',
  });
  // Keywords are a nova-2 feature; nova-3 calls the same thing keyterm.
  const boostKey = model.startsWith('nova-3') ? 'keyterm' : 'keywords';
  // A short, measured list: boosting community names put them into ordinary
  // speech (plateau-vocabulary.ts, localLineRecognitionTerms).
  for (const word of localLineRecognitionTerms()) {
    params.append(boostKey, boostKey === 'keywords' ? `${word}:2` : word);
  }
  return deepgramListenUrl(params);
}

/**
 * Deepgram's word-gap fallback: a turn ends this long after the last word
 * even when line noise keeps its silence detector (endpointing) from firing.
 * 1000 ms is the least Deepgram accepts (was 1200). LOCAL_VOICE_UTTERANCE_END_MS
 * sets it, 1000–3000.
 */
export function utteranceEndMs(): number {
  const n = Number(process.env.LOCAL_VOICE_UTTERANCE_END_MS?.trim() || 1000);
  return Number.isFinite(n) ? Math.min(3_000, Math.max(1_000, Math.round(n))) : 1_000;
}

/** Silence Deepgram had heard after the last word: the audio window's end minus that word's end, in ms. */
export function silenceAfterLastWord(windowEndSecs: unknown, lastWordEndSecs: unknown): number | undefined {
  const a = Number(windowEndSecs);
  const b = Number(lastWordEndSecs);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < b) return undefined;
  return Math.round((a - b) * 1000);
}

/** One Deepgram message, handed to the session's events. Exported for tests. */
export function dispatchDeepgram(msg: any, events: SttEvents): void {
  if (msg?.type === 'UtteranceEnd') {
    // Sent once the gap after the last word reached utterance_end_ms.
    return events.onUtteranceEnd(utteranceEndMs());
  }
  if (msg?.type !== 'Results') return;
  const alt = msg.channel?.alternatives?.[0];
  const text: string = alt?.transcript ?? '';
  if (msg.is_final) {
    if (text.trim() || msg.speech_final) {
      const words: any[] = Array.isArray(alt?.words) ? alt.words : [];
      const silence = msg.speech_final && words.length
        ? silenceAfterLastWord(Number(msg.start) + Number(msg.duration), words[words.length - 1]?.end)
        : undefined;
      events.onFinal(text.trim(), msg.speech_final === true, silence);
    }
  } else if (text.trim()) {
    events.onInterim(text.trim());
  }
}

export const deepgramStt: SttFactory = async (events) => {
  const key = process.env.DEEPGRAM_API_KEY?.trim();
  if (!key) throw new Error('Speech recognition key is not set');
  const ws = new WebSocket(deepgramUrl(), { headers: { Authorization: `Token ${key}` } });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Speech recognition did not connect within 5 s')), 5_000);
    ws.once('open', () => {
      clearTimeout(t);
      resolve();
    });
    ws.once('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  ws.on('message', (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    dispatchDeepgram(msg, events);
  });
  // Deepgram closes a stream that gets no audio for ~10 s (code 1011). A
  // carrier with silence suppression sends nothing while the caller is quiet,
  // so a KeepAlive every few seconds holds the stream open regardless.
  const keepAlive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
  }, 4_000);
  keepAlive.unref?.();
  ws.on('error', (e) => events.onError(e as Error));
  ws.on('close', (code) => {
    clearInterval(keepAlive);
    if (code !== 1000) events.onError(new Error(`Speech recognition closed (${code})`));
  });
  return {
    send: (slin) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(slin);
    },
    close: () => {
      clearInterval(keepAlive);
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
        ws.close(1000);
      } catch {
        /* closing anyway */
      }
    },
  };
};
