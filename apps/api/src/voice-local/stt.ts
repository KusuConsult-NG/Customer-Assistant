import { PLATEAU_ORG_WORDS, plateauPlaceWords } from '../agent-tools/plateau-vocabulary';
import WebSocket from 'ws';
import { deepgramListenUrl, deepgramModel } from '../telephony/voice-ai.service';
import { SAMPLE_RATE } from './audiosocket';

export interface SttEvents {
  /** Words heard so far in the current stretch (interim results included). */
  onInterim(text: string): void;
  /** A finalised piece; `endOfTurn` when Deepgram judged the caller stopped. */
  onFinal(text: string, endOfTurn: boolean): void;
  /** Deepgram's word-gap detector: the caller has stopped, whatever endpointing said. */
  onUtteranceEnd(): void;
  onError(err: Error): void;
}

export interface SttStream {
  send(slin: Buffer): void;
  close(): void;
}

export type SttFactory = (events: SttEvents) => Promise<SttStream>;

/**
 * The Deepgram URL for AudioSocket audio: linear16 at 8 kHz — what Asterisk
 * sends, untranscoded. Interim results drive barge-in; endpointing plus
 * utterance-end decide when the caller has finished a turn. Plateau's LGA
 * names are boosted, because phone ASR otherwise hears "Bokkos" as "books".
 */
export function deepgramUrl(): string {
  const params = new URLSearchParams({
    model: deepgramModel(),
    language: 'en',
    encoding: 'linear16',
    sample_rate: String(SAMPLE_RATE),
    channels: '1',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    endpointing: process.env.LOCAL_VOICE_ENDPOINTING_MS?.trim() || '400',
    utterance_end_ms: '1200',
    vad_events: 'true',
  });
  // Keywords are a nova-2 feature; nova-3 calls the same thing keyterm.
  const boostKey = deepgramModel().startsWith('nova-3') ? 'keyterm' : 'keywords';
  // The same Plateau places the ElevenLabs agent is told (plateau-vocabulary.ts).
  // "Rantya" was heard as "Rainbow", and "Gyel B" as "Galby", on real calls.
  for (const word of [...plateauPlaceWords(), ...PLATEAU_ORG_WORDS]) {
    params.append(boostKey, boostKey === 'keywords' ? `${word}:2` : word);
  }
  return deepgramListenUrl(params);
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
    if (msg.type === 'UtteranceEnd') return events.onUtteranceEnd();
    if (msg.type !== 'Results') return;
    const text: string = msg.channel?.alternatives?.[0]?.transcript ?? '';
    if (msg.is_final) {
      if (text.trim() || msg.speech_final) events.onFinal(text.trim(), msg.speech_final === true);
    } else if (text.trim()) {
      events.onInterim(text.trim());
    }
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
