'use client';

/**
 * Answering a citizen's call in the dashboard.
 *
 * ── What this is, and what it is not ────────────────────────────────────────
 *
 * A Twilio Voice device registered as this officer. When a citizen rings the
 * agency's number, the API's TwiML dials every signed-in officer as a
 * `<Client>`; this is the thing that rings. If nobody accepts within the ring
 * window, Twilio falls back to the AI exactly as before — so declining, or
 * never opening the dashboard at all, costs the citizen nothing.
 *
 * It is NOT a replacement for the AI and it is not a queue. There is no
 * hold, no transfer between officers, no presence. Those are real features
 * and their absence is deliberate: this is the smallest thing that lets a
 * human answer, and shipping it small is how it gets proven on a real call
 * before more is built on top.
 *
 * ── Why the state is explicit about not knowing ─────────────────────────────
 *
 * `ready` starts as null, not false. "Not registered yet" and "cannot
 * register" are different things to an officer deciding whether to rely on
 * this, and a phone that looks switched off when it is merely starting is one
 * somebody stops trusting.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff, Mic, MicOff } from 'lucide-react';
import { apiFetch, API_URL } from '@/lib/api';

type Status =
  | { kind: 'unknown' }
  | { kind: 'off'; detail: string; blocked: string[] }
  | { kind: 'registering' }
  | { kind: 'ready' }
  | { kind: 'ringing'; from: string }
  | { kind: 'on-call'; from: string }
  | { kind: 'error'; detail: string };

export function OfficerPhone() {
  const [status, setStatus] = useState<Status>({ kind: 'unknown' });
  const [muted, setMuted] = useState(false);
  const deviceRef = useRef<any>(null);
  const callRef = useRef<any>(null);

  /** Hang up and forget, used by every exit so no call object is left live. */
  const clearCall = useCallback(() => {
    callRef.current = null;
    setMuted(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let device: any = null;

    (async () => {
      setStatus({ kind: 'registering' });
      let body: any;
      try {
        const token = localStorage.getItem('ace_token');
        if (!token) {
          setStatus({ kind: 'unknown' });
          return;
        }
        const res = await apiFetch(`${API_URL}/api/telephony/browser/token`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStatus({ kind: 'error', detail: body?.message || `Could not get a token (HTTP ${res.status}).` });
          return;
        }
      } catch (err: any) {
        setStatus({ kind: 'error', detail: err?.message || 'Could not reach the API.' });
        return;
      }

      // Not an error. A deployment that has not switched this on is a normal
      // deployment, and the officer should be told plainly rather than shown
      // a phone that never rings.
      if (!body?.enabled) {
        setStatus({ kind: 'off', detail: body?.detail ?? 'Not configured.', blocked: body?.blocked ?? [] });
        return;
      }

      try {
        const { Device } = await import('@twilio/voice-sdk');
        if (cancelled) return;

        device = new Device(body.token, { closeProtection: true });
        deviceRef.current = device;

        device.on('registered', () => !cancelled && setStatus({ kind: 'ready' }));
        device.on('error', (e: any) =>
          !cancelled && setStatus({ kind: 'error', detail: e?.message ?? 'The phone reported an error.' })
        );

        device.on('incoming', (call: any) => {
          if (cancelled) return;
          callRef.current = call;
          setStatus({ kind: 'ringing', from: call?.parameters?.From ?? 'a citizen' });

          // Every way a call can end, so the UI cannot be left showing a call
          // that is over. Twilio fires `cancel` when the caller hangs up while
          // ringing, `disconnect` when an answered call ends, and `reject`
          // when this officer declines.
          const finish = () => {
            if (cancelled) return;
            clearCall();
            setStatus({ kind: 'ready' });
          };
          call.on('cancel', finish);
          call.on('disconnect', finish);
          call.on('reject', finish);
          call.on('accept', () =>
            !cancelled && setStatus({ kind: 'on-call', from: call?.parameters?.From ?? 'a citizen' })
          );
        });

        await device.register();
      } catch (err: any) {
        if (!cancelled) setStatus({ kind: 'error', detail: err?.message ?? 'The phone could not start.' });
      }
    })();

    return () => {
      cancelled = true;
      // Destroy on unmount, or an officer who navigates away keeps ringing
      // for calls they cannot see — which looks to a citizen like a phone
      // nobody answers.
      try {
        callRef.current?.disconnect?.();
        device?.destroy?.();
      } catch {
        /* tearing down a half-built device is not a failure worth showing */
      }
    };
    // EMPTY on purpose. A dependency that is a new object or function on
    // every render — an `authHeaders` object, say — tears the device down and
    // rebuilds it continuously, which means a phone that is registering far
    // more often than it is registered and a citizen hearing it ring out.
    // The agent-console socket in this codebase had exactly that bug.
    //
    // The token is read inside, once, rather than passed in for the same
    // reason. Refreshing it before expiry is a later change and belongs
    // inside this effect, not in its dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accept = () => {
    try {
      callRef.current?.accept?.();
    } catch (err: any) {
      setStatus({ kind: 'error', detail: err?.message ?? 'Could not answer.' });
    }
  };

  const hangUp = () => {
    try {
      // `reject` while ringing, `disconnect` once answered — using the wrong
      // one leaves the call live.
      if (status.kind === 'ringing') callRef.current?.reject?.();
      else callRef.current?.disconnect?.();
    } catch {
      /* the call is going away either way */
    }
    clearCall();
    setStatus({ kind: 'ready' });
  };

  const toggleMute = () => {
    const next = !muted;
    try {
      callRef.current?.mute?.(next);
      setMuted(next);
    } catch {
      /* leave the indicator where it was rather than lying about it */
    }
  };

  // Nothing to show on a deployment that has not switched this on, beyond
  // saying so once. A dead phone icon on every page is worse than no icon.
  if (status.kind === 'unknown' || status.kind === 'off') return null;

  const label =
    status.kind === 'registering'
      ? 'Phone starting…'
      : status.kind === 'ready'
        ? 'Ready for calls'
        : status.kind === 'ringing'
          ? `Incoming call from ${status.from}`
          : status.kind === 'on-call'
            ? `On a call with ${status.from}`
            : status.detail;

  const ringing = status.kind === 'ringing';
  const onCall = status.kind === 'on-call';

  return (
    <div
      className={`fixed bottom-4 right-4 z-50 rounded-2xl border shadow-lg px-4 py-3 text-sm ${
        ringing
          ? 'bg-emerald-50 dark:bg-emerald-500/15 border-emerald-300 dark:border-emerald-500/40 animate-pulse'
          : status.kind === 'error'
            ? 'bg-red-50 dark:bg-red-500/10 border-red-300 dark:border-red-500/30'
            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
      }`}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        <Phone className={`w-4 h-4 ${ringing ? 'text-emerald-600' : 'text-slate-500'}`} />
        <span className="font-medium">{label}</span>

        {ringing && (
          <>
            <button
              type="button"
              onClick={accept}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-semibold hover:bg-emerald-700"
            >
              Answer
            </button>
            <button
              type="button"
              onClick={hangUp}
              className="px-3 py-1.5 rounded-lg bg-slate-200 dark:bg-slate-700 font-semibold"
            >
              Decline
            </button>
          </>
        )}

        {onCall && (
          <>
            <button
              type="button"
              onClick={toggleMute}
              aria-pressed={muted}
              className="px-2 py-1.5 rounded-lg bg-slate-200 dark:bg-slate-700"
              title={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={hangUp}
              className="px-3 py-1.5 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-700 flex items-center gap-1.5"
            >
              <PhoneOff className="w-4 h-4" /> Hang up
            </button>
          </>
        )}
      </div>

      {/* Declining is not a dead end for the citizen, and an officer deciding
          whether to decline should know that. */}
      {ringing && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          If nobody answers, the AI takes the call.
        </p>
      )}
    </div>
  );
}
