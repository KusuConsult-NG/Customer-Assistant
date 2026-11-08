'use client';

/**
 * An officer ringing a citizen back from the browser, over Infobip.
 *
 * ── Where this applies ──────────────────────────────────────────────────────
 *
 * Only to an agency whose line is on Infobip. There the API places no calls
 * itself: the promise is held on the Callback Queue, and an officer dials it
 * from here. Every other agency's promises are dialled by the API ("Call
 * now"), and this component is never shown to them.
 *
 * ── What it reports, and what it does not claim ─────────────────────────────
 *
 * The API claims the promise before the browser dials, so two officers
 * cannot both ring one citizen. When the call ends, this reports what
 * Infobip's SDK actually raised:
 *
 *   - `answered`      ESTABLISHED fired: the citizen picked up. Recorded as
 *                     REACHED — the same evidence the Twilio path settles on.
 *   - `not_answered`  it hung up without ever being established; Infobip's
 *                     own hangup reason goes with it.
 *   - `failed`        the call was placed and then went wrong.
 *   - `not_placed`    it never got as far as ringing (the SDK would not load,
 *                     Infobip refused the connection). The promise goes back
 *                     WITHOUT an attempt counted, because the citizen's phone
 *                     never rang.
 *
 * Exactly one report per call, whatever order the events arrive in. Two
 * reports would be two attempts counted against the citizen for one call.
 *
 * No real Infobip call has been placed through this yet. The SDK calls are
 * exactly those in Infobip's published reference for `infobip-rtc` 2.x
 * (`createInfobipRtc`, `connect`, `callPhone` with `PhoneCallOptions.setFrom`,
 * and the RINGING / EARLY_MEDIA / ESTABLISHED / HANGUP / ERROR events), and
 * the first real call is the test.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Loader2 } from 'lucide-react';
import { API_URL, apiFetch } from '@/lib/api';

export type BrowserCallTarget = { id: string; reference: string; name: string; phoneNumber: string };

type Outcome = 'answered' | 'not_answered' | 'failed' | 'not_placed';

type CallState =
  | { kind: 'idle' }
  | { kind: 'starting'; target: BrowserCallTarget }
  | { kind: 'connecting'; target: BrowserCallTarget }
  | { kind: 'ringing'; target: BrowserCallTarget }
  | { kind: 'on-call'; target: BrowserCallTarget; since: number }
  | { kind: 'reporting'; target: BrowserCallTarget };

/** How long Infobip gets to accept the connection before we stop waiting. */
const CONNECT_TIMEOUT_MS = 20_000;

/** Infobip's own words for why a call ended or erred, never "it failed". */
function describe(errorCode: any): string | null {
  if (!errorCode) return null;
  const name = typeof errorCode.name === 'string' ? errorCode.name : '';
  const description = typeof errorCode.description === 'string' ? errorCode.description : '';
  const text = [name, description].filter(Boolean).join(': ');
  return text || null;
}

export function useBrowserCallback(handlers: {
  /** The server's verdict on the call, for the page to show and reload on. */
  onSettled: (message: string, tone: 'success' | 'error' | 'info') => void;
}) {
  const [state, setState] = useState<CallState>({ kind: 'idle' });
  const [muted, setMuted] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const callRef = useRef<any>(null);
  const rtcRef = useRef<any>(null);
  /** The current call's one-shot reporter, so Cancel can settle it with its real reason. */
  const reportRef = useRef<((outcome: Outcome, reason: string | null) => Promise<void>) | null>(null);
  const mountedRef = useRef(true);
  // Read at report time, not captured: the handlers object is new each render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const set = (next: CallState) => {
    if (mountedRef.current) setState(next);
  };

  const attachAudio = (stream: MediaStream | undefined) => {
    const el = audioRef.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    // Autoplay can be refused; the officer pressed a button to get here, so
    // a user gesture exists, but a refusal must not take the call down.
    el.play?.().catch(() => {});
  };

  const start = useCallback(async (target: BrowserCallTarget) => {
    if (callRef.current || rtcRef.current) return; // one call at a time
    set({ kind: 'starting', target });
    setNote(null);
    setMuted(false);

    // ── 1. Claim the promise and get a token for THIS officer ──────────────
    let session: { token: string; to: string; from: string; reference: string };
    try {
      const res = await apiFetch(`${API_URL}/api/callbacks/${target.id}/browser-call`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        set({ kind: 'idle' });
        handlersRef.current.onSettled(body?.message || `The call could not be started (${res.status}).`, 'error');
        return;
      }
      session = body;
    } catch (err: any) {
      set({ kind: 'idle' });
      handlersRef.current.onSettled(err?.message || 'Could not reach the API.', 'error');
      return;
    }

    // ── 2. Report exactly once ─────────────────────────────────────────────
    let reported = false;
    let answered = false;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;

    const report = async (outcome: Outcome, reason: string | null) => {
      if (reported) return;
      reported = true;
      reportRef.current = null;
      if (connectTimer) clearTimeout(connectTimer);
      const call = callRef.current;
      let callId: string | null = null;
      let durationSeconds = 0;
      try {
        callId = call?.id?.() ?? null;
        durationSeconds = Number(call?.duration?.() ?? 0) || 0;
      } catch {
        /* a half-built call has neither; the report still goes */
      }
      callRef.current = null;
      try {
        rtcRef.current?.disconnect?.();
      } catch {
        /* disconnecting a client that never connected */
      }
      rtcRef.current = null;
      if (audioRef.current) audioRef.current.srcObject = null;
      set({ kind: 'reporting', target });

      try {
        const res = await apiFetch(`${API_URL}/api/callbacks/${target.id}/browser-call/result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callId, outcome, durationSeconds, reason }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          handlersRef.current.onSettled(
            `The call ended, but it could not be recorded: ${body?.message || `HTTP ${res.status}`}`,
            'error'
          );
        } else if (body.status === 'COMPLETED') {
          handlersRef.current.onSettled(`Reached — ${body.reference}`, 'success');
        } else if (outcome === 'not_placed') {
          handlersRef.current.onSettled(
            `Not placed${reason ? `: ${reason}` : ''}. The callback is back in the queue; no attempt was counted.`,
            'error'
          );
        } else if (body.status === 'FAILED') {
          handlersRef.current.onSettled(
            `Not reached after ${body.attempts} attempts — ${body.failureReason ?? 'no reason given'}`,
            'error'
          );
        } else {
          handlersRef.current.onSettled(
            `Not reached — ${body.failureReason ?? 'no reason given'}. It is back in the queue.`,
            'info'
          );
        }
      } catch (err: any) {
        handlersRef.current.onSettled(
          `The call ended, but it could not be recorded: ${err?.message || 'the API could not be reached'}`,
          'error'
        );
      } finally {
        set({ kind: 'idle' });
      }
    };

    reportRef.current = report;

    // ── 3. Connect and dial ────────────────────────────────────────────────
    let sdk: any;
    try {
      sdk = await import('infobip-rtc');
    } catch (err: any) {
      await report('not_placed', `The calling library could not load: ${err?.message ?? err}`);
      return;
    }

    const { createInfobipRtc, PhoneCallOptions, CallsApiEvent, InfobipRTCEvent } = sdk;
    let rtc: any;
    try {
      rtc = createInfobipRtc(session.token, { debug: false });
    } catch (err: any) {
      await report('not_placed', `The calling client could not start: ${err?.message ?? err}`);
      return;
    }
    rtcRef.current = rtc;
    set({ kind: 'connecting', target });

    rtc.on(InfobipRTCEvent.CONNECTED, () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (reported) return;
      let call: any;
      try {
        call = rtc.callPhone(session.to, PhoneCallOptions.builder().setFrom(session.from).build());
      } catch (err: any) {
        void report('not_placed', `Infobip did not place the call: ${err?.message ?? err}`);
        return;
      }
      callRef.current = call;

      call.on(CallsApiEvent.RINGING, () => !reported && set({ kind: 'ringing', target }));
      call.on(CallsApiEvent.EARLY_MEDIA, (e: any) => {
        // The citizen's network's ringback tone, so the officer hears ringing.
        attachAudio(e?.stream);
        if (!reported) set({ kind: 'ringing', target });
      });
      call.on(CallsApiEvent.ESTABLISHED, (e: any) => {
        answered = true;
        attachAudio(e?.stream);
        if (!reported) set({ kind: 'on-call', target, since: Date.now() });
      });
      call.on(CallsApiEvent.HANGUP, (e: any) => {
        void report(answered ? 'answered' : 'not_answered', describe(e?.errorCode));
      });
      // ERROR does not hang the call up (Infobip's reference says so), so it is
      // shown, not reported. HANGUP follows if the call actually ends.
      call.on(CallsApiEvent.ERROR, (e: any) => {
        if (mountedRef.current) setNote(describe(e?.errorCode));
      });
    });

    rtc.on(InfobipRTCEvent.DISCONNECTED, (e: any) => {
      const why = `Lost the connection to Infobip${e?.reason ? `: ${e.reason}` : ''}`;
      // After an answer the conversation happened, however it ended. Before a
      // call object exists, nothing rang.
      if (answered) void report('answered', why);
      else if (callRef.current) void report('failed', why);
      else void report('not_placed', why);
    });

    connectTimer = setTimeout(() => {
      void report('not_placed', `Infobip did not accept the connection within ${CONNECT_TIMEOUT_MS / 1000} seconds.`);
    }, CONNECT_TIMEOUT_MS);

    try {
      rtc.connect();
    } catch (err: any) {
      await report('not_placed', `Could not connect to Infobip: ${err?.message ?? err}`);
    }
  }, []);

  const hangUp = useCallback(() => {
    const call = callRef.current;
    if (call) {
      try {
        call.hangup();
      } catch {
        /* HANGUP or DISCONNECTED will still settle it */
      }
      return;
    }
    // Still connecting: nothing has rung, so it is settled as not placed —
    // with the officer's cancel as the reason, not the disconnect it causes.
    void reportRef.current?.('not_placed', 'Cancelled by the officer before it rang.');
  }, []);

  const toggleMute = useCallback(async () => {
    const next = !muted;
    try {
      await callRef.current?.mute?.(next);
      setMuted(next);
    } catch {
      /* leave the indicator where it was rather than lying about it */
    }
  }, [muted]);

  const active = state.kind !== 'idle';

  // Closing the tab mid-call drops the citizen. Ask first; if the officer
  // closes anyway, the API's grace sweep reopens the promise and says why.
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);

  // Navigating away inside the app hangs up rather than leaving a call with
  // no controls; the HANGUP that follows still reports it.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      try {
        callRef.current?.hangup?.();
        if (!callRef.current) rtcRef.current?.disconnect?.();
      } catch {
        /* tearing down */
      }
    };
  }, []);

  return { state, muted, note, start, hangUp, toggleMute, audioRef, active };
}

/** The call in progress, pinned to the corner while it lasts. */
export function BrowserCallPanel({ call }: { call: ReturnType<typeof useBrowserCallback> }) {
  const { state, muted, note, hangUp, toggleMute, audioRef } = call;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (state.kind !== 'on-call') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state.kind]);

  // The element exists for the whole life of the page so a stream can be
  // attached the instant it arrives, before React re-renders.
  const audio = <audio ref={audioRef} autoPlay className="hidden" data-testid="browser-call-audio" />;
  if (state.kind === 'idle') return audio;

  const { target } = state;
  const elapsed =
    state.kind === 'on-call' ? Math.max(0, Math.floor((now - state.since) / 1000)) : 0;
  const label =
    state.kind === 'starting'
      ? 'Starting the call…'
      : state.kind === 'connecting'
        ? 'Connecting to Infobip…'
        : state.kind === 'ringing'
          ? 'Ringing…'
          : state.kind === 'on-call'
            ? `On the call · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
            : 'Recording the outcome…';

  return (
    <>
      {audio}
      <div
        className="fixed bottom-20 right-4 z-50 rounded-2xl border shadow-lg px-4 py-3 text-sm bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 max-w-sm"
        role="status"
        aria-live="polite"
        data-testid="browser-call-panel"
      >
        <div className="flex items-center gap-3">
          {state.kind === 'on-call' ? (
            <Phone className="w-4 h-4 text-emerald-600" />
          ) : (
            <Loader2 className="w-4 h-4 animate-spin text-slate-500" />
          )}
          <div className="min-w-0">
            <div className="font-semibold text-slate-900 dark:text-white truncate">
              {target.name} <span className="font-mono text-xs text-slate-500">{target.phoneNumber}</span>
            </div>
            <div className="text-xs text-slate-600 dark:text-slate-400">
              {label} · {target.reference}
            </div>
          </div>
          {state.kind === 'on-call' && (
            <button
              type="button"
              onClick={toggleMute}
              aria-pressed={muted}
              className="px-2 py-1.5 rounded-lg bg-slate-200 dark:bg-slate-700"
              title={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          )}
          {state.kind !== 'reporting' && state.kind !== 'starting' && (
            <button
              type="button"
              onClick={hangUp}
              className="px-3 py-1.5 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-700 flex items-center gap-1.5"
            >
              <PhoneOff className="w-4 h-4" /> {state.kind === 'on-call' ? 'Hang up' : 'Cancel'}
            </button>
          )}
        </div>
        {note && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{note}</p>}
      </div>
    </>
  );
}
