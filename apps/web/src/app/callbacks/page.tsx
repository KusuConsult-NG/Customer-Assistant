'use client';

/**
 * The queue of citizens we owe a call.
 *
 * ── Why this screen exists ──────────────────────────────────────────────────
 *
 * The AI can now promise a citizen a call back, with a time. A promise nobody
 * can see is not a promise — it is a row. This is where an officer sees who
 * was promised what, which promises are late, and what the carrier said when
 * one could not be placed.
 *
 * ── Every button here makes a request and reports the response ──────────────
 *
 * The scheduling screen once had four buttons that showed "Booking for Jane
 * Citizen cancelled." and made no request at all. So each action here awaits
 * the API, reports what came BACK (including the carrier's own refusal), and
 * reloads. "Call now" in particular reports the dispatcher's recorded outcome,
 * never the intention to dial.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { PhoneCall, Clock, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Phone } from 'lucide-react';
import { API_URL, apiFetch } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import EmptyState from '@/components/ui/EmptyState';
import { RoleNotice } from '@/components/RoleNotice';
import { useBrowserCallback, BrowserCallPanel } from '@/components/BrowserCallback';

/**
 * How this agency's promises get dialled — see `GET /api/callbacks/dialling`.
 * Null until known, and left null if it could not be read: the page then
 * offers "Call now", which the API refuses with the reason on an Infobip line.
 */
type Dialling = {
  mode: 'automatic' | 'officer-browser' | 'none';
  line: string | null;
  ready: boolean;
  blocked: string[];
};

type Callback = {
  id: string;
  reference: string;
  phoneNumber: string;
  reason: string;
  promisedText: string;
  dueAt: string;
  status: 'PENDING' | 'DUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  attempts: number;
  maxAttempts: number;
  failureReason: string | null;
  overdue: boolean;
  escalated?: boolean;
  preferredTime?: string | null;
  assignedUser?: { id: string; fullName: string } | null;
  attemptLog?: Array<{ id: string; outcome: string; via: string; note: string | null; createdAt: string }>;
  contact?: { id: string; fullName: string; phoneNumber: string } | null;
};

const ATTEMPT_OUTCOMES: Array<[string, string]> = [
  ['REACHED', 'Reached them'],
  ['NO_ANSWER', 'No answer'],
  ['BUSY', 'Line busy'],
  ['VOICEMAIL', 'Voicemail'],
  ['WRONG_NUMBER', 'Wrong number'],
  ['FAILED', 'Call would not connect'],
];

const STATUS_STYLES: Record<Callback['status'], string> = {
  PENDING: 'bg-slate-100 dark:bg-slate-500/20 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  DUE: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/30',
  IN_PROGRESS: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-500/30',
  COMPLETED: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30',
  FAILED: 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-500/30',
  CANCELLED: 'bg-slate-100 dark:bg-slate-500/20 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700',
};

/**
 * What each status means to the officer reading the queue.
 *
 * The raw enum names were shown, and two of them were actively misleading
 * once the dispatcher stopped claiming a dialled call had been answered:
 * IN_PROGRESS is "we are ringing them, nobody has answered yet", and
 * COMPLETED is "the carrier reported that they answered" — not "we tried".
 */
const STATUS_LABELS: Record<Callback['status'], string> = {
  PENDING: 'PROMISED',
  DUE: 'DUE NOW',
  IN_PROGRESS: 'DIALLING',
  COMPLETED: 'REACHED',
  FAILED: 'NOT REACHED',
  CANCELLED: 'CANCELLED',
};

export default function CallbacksPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Callback[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialling, setDialling] = useState<Dialling | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`${API_URL}/api/callbacks`);
      if (!res.ok) throw new Error(`The queue could not be loaded (${res.status})`);
      setRows(await res.json());
      setError(null);
    } catch (e: any) {
      // A failed load must NOT render the empty state: "no callbacks" is a
      // statement about the agency's promises, and it would be made here
      // while nothing at all is known about them.
      setError(e?.message || 'The callback queue could not be loaded');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    apiFetch(`${API_URL}/api/callbacks/dialling`)
      .then(async (res) => (res.ok ? setDialling(await res.json()) : null))
      .catch(() => null);
  }, []);

  const browserCall = useBrowserCallback({
    onSettled: (message, tone) => {
      if (tone === 'success') toast.success(message);
      else if (tone === 'info') toast.info(message);
      else toast.error(message);
      load();
    },
  });
  const officerDials = dialling?.mode === 'officer-browser';

  // The action segment is written out at each call site rather than passed in
  // as a variable. `apps/api/test/route-accounting.spec.ts` matches a caller
  // to a route by its LAST LITERAL segment, so `/${id}/${path}` makes three
  // real endpoints invisible to it — and an endpoint no screen appears to
  // reach is exactly what that test exists to catch.
  /**
   * An officer rang from their own phone. What the server decided — reached,
   * retry at a time, or given up — is what is reported back, not the request.
   */
  const logAttempt = async (r: Callback, outcome: string) => {
    if (!outcome) return;
    const note = outcome === 'REACHED' ? '' : (window.prompt('Anything to note about this attempt? (optional)') ?? '');
    setBusy(r.id);
    try {
      const res = await apiFetch(`${API_URL}/api/callbacks/${r.id}/attempt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome, ...(note ? { note } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body?.message || `Could not record the attempt (${res.status})`);
        return;
      }
      if (body.status === 'COMPLETED') toast.success(`Recorded as reached — ${body.reference}`);
      else if (body.status === 'FAILED') toast.error(`No attempts left — ${body.reference} is now NOT REACHED for a supervisor`);
      else toast.success(`Attempt ${body.attempts} recorded — next try ${new Date(body.dueAt).toLocaleString('en-NG')}`);
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Could not record the attempt');
    } finally {
      setBusy(null);
    }
  };

  /** Send a JSON PATCH and report what the server said. */
  const patchJson = async (r: Callback, path: 'assign' | 'reschedule', body: Record<string, unknown>, done: string) => {
    setBusy(r.id);
    try {
      // Written out per path: a route checker reads the last segment literally.
      const url = path === 'assign' ? `${API_URL}/api/callbacks/${r.id}/assign` : `${API_URL}/api/callbacks/${r.id}/reschedule`;
      const res = await apiFetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(out?.message || `Failed (${res.status})`);
        return;
      }
      toast.success(`${done} — ${out.reference ?? r.reference}`);
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const assignToMe = (r: Callback) => {
    let me: { id?: string; userId?: string } = {};
    try { me = JSON.parse(localStorage.getItem('ace_user') || '{}'); } catch { /* the API decides */ }
    const userId = me.id ?? me.userId;
    if (!userId) { toast.error('Sign in again to take this callback.'); return; }
    patchJson(r, 'assign', { userId }, 'Assigned to you');
  };

  const reschedule = (r: Callback) => {
    const when = window.prompt('New time agreed with the citizen (e.g. 2026-11-12 16:00)');
    if (!when) return;
    const parsed = new Date(when.replace(' ', 'T'));
    if (Number.isNaN(parsed.getTime())) { toast.error('That is not a date and time.'); return; }
    const preferredTime = window.prompt('What did they say suits them? (optional, e.g. "after 4pm")') ?? '';
    patchJson(r, 'reschedule', { dueAt: parsed.toISOString(), ...(preferredTime ? { preferredTime } : {}) }, 'Rescheduled');
  };

  const act = async (id: string, url: string, method: 'POST' | 'PATCH', label: string, path: string) => {
    setBusy(id);
    try {
      const res = await apiFetch(url, { method });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body?.message || `${label} failed (${res.status})`);
        return;
      }
      // Reports what the server recorded, not what was asked for.
      if (path === 'call-now') {
        // DIALLING is the honest success state. The dispatcher no longer writes
        // COMPLETED when the carrier accepts a dial — the citizen may not pick
        // up — so this must not report a kept promise either. COMPLETED can
        // still arrive here if the carrier's status callback beat the response.
        if (body.status === 'COMPLETED') toast.success(`Answered — ${body.reference}`);
        else if (body.status === 'IN_PROGRESS') toast.success(`Dialling now — ${body.reference}`);
        else if (body.failureReason) toast.error(`Not placed: ${body.failureReason}`);
        else toast.error(`Not placed — the callback is now ${body.status}`);
      } else {
        toast.success(`${label} — ${body.reference ?? id}`);
      }
      await load();
    } catch (e: any) {
      toast.error(e?.message || `${label} failed`);
    } finally {
      setBusy(null);
    }
  };

  const open = rows.filter((r) => ['PENDING', 'DUE', 'IN_PROGRESS'].includes(r.status));
  const late = open.filter((r) => r.overdue);

  return (
    <div className="space-y-6">
      <RoleNotice path="/callbacks" />
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <PhoneCall className="w-6 h-6 text-brand-700 dark:text-brand-300" /> Callback Queue
          </h2>
          <p className="text-slate-600 dark:text-slate-400 text-sm mt-1">
            Citizens the assistant promised a call back, and whether that promise was kept.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-sm transition-all shadow-sm"
        >
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {/* On an Infobip line the officer is the dialler. Said once, up front,
          so a queue of DUE promises does not read as a dialler that stalled. */}
      {officerDials && (
        <div
          data-testid="officer-dialling-notice"
          className={`rounded-2xl border px-4 py-3 text-sm ${
            dialling?.ready
              ? 'bg-sky-50 dark:bg-sky-500/10 border-sky-200 dark:border-sky-500/30 text-sky-900 dark:text-sky-200'
              : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-800 dark:text-red-300'
          }`}
        >
          {dialling?.ready ? (
            <>
              This agency&apos;s line ({dialling.line}) is on Infobip, so promises are not dialled
              automatically. Use <strong>Call from browser</strong> to ring a citizen back from this
              screen — you will need a headset or microphone.
            </>
          ) : (
            <>
              <strong>Calling from the browser is not available yet.</strong>{' '}
              {dialling?.blocked.join(' ')}
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Stat label="Open promises" value={open.length} icon={<Clock className="w-4 h-4" />} />
        <Stat label="Overdue" value={late.length} icon={<AlertTriangle className="w-4 h-4" />} tone={late.length ? 'warn' : undefined} />
        {/* "Reached", not "Completed": COMPLETED now means the carrier reported
            the citizen actually answered. A dialled-but-unanswered promise is
            still open, and counting it here was the console's version of
            recording a call that never happened. */}
        <Stat label="Reached" value={rows.filter((r) => r.status === 'COMPLETED').length} icon={<CheckCircle2 className="w-4 h-4" />} />
      </div>

      {loading ? (
        <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">Loading the queue…</div>
      ) : error ? (
        <EmptyState
          icon={XCircle}
          title="Could not load the callback queue"
          description={error}
          actions={[{ label: 'Try again', primary: true, onClick: load }]}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={PhoneCall}
          title="No callbacks promised yet"
          description="When a citizen asks to be called back — on WhatsApp or on a call — the promise and its deadline appear here."
        />
      ) : (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-900">
          <table className="w-full text-left">
            <thead className="bg-slate-50 dark:bg-slate-800/60">
              <tr className="text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">
                <th className="px-5 py-3">Reference</th>
                <th className="px-5 py-3">Citizen</th>
                <th className="px-5 py-3">About</th>
                <th className="px-5 py-3">Promised</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-callback-row={r.reference} className="border-t border-slate-200 dark:border-slate-800">
                  <td className="px-5 py-4 text-xs font-mono font-bold text-slate-800 dark:text-slate-200">{r.reference}</td>
                  <td className="px-5 py-4">
                    <div className="text-sm font-semibold text-slate-900 dark:text-white">{r.contact?.fullName || '—'}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">{r.phoneNumber}</div>
                  </td>
                  <td className="px-5 py-4 text-xs text-slate-700 dark:text-slate-300 max-w-[260px]">{r.reason}</td>
                  <td className="px-5 py-4 text-xs text-slate-700 dark:text-slate-300">
                    <div>{r.promisedText}</div>
                    <div className={`text-[11px] ${r.overdue ? 'text-red-700 dark:text-red-400 font-bold' : 'text-slate-500 dark:text-slate-400'}`}>
                      {r.overdue ? 'Overdue — ' : ''}due {new Date(r.dueAt).toLocaleString('en-NG')}
                    </div>
                    {r.escalated && (
                      <div className="text-[10px] font-bold text-red-700 dark:text-red-400 mt-1">ESCALATED — over an hour late</div>
                    )}
                    {r.preferredTime && <div className="text-[11px] text-slate-500 mt-1">Prefers: {r.preferredTime}</div>}
                    {r.assignedUser && <div className="text-[11px] text-slate-500 mt-1">With {r.assignedUser.fullName}</div>}
                  </td>
                  <td className="px-5 py-4">
                    <span className={`px-2.5 py-1 text-[10px] font-bold rounded-lg border ${STATUS_STYLES[r.status]}`}>{STATUS_LABELS[r.status] ?? r.status}</span>
                    {r.attempts > 0 && (
                      <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                        {r.attempts} of {r.maxAttempts} attempts
                      </div>
                    )}
                    {/* The carrier's own words. An officer explaining a missed
                        call needs the reason, not "it failed". */}
                    {r.failureReason && (
                      <div className="text-[10px] text-red-700 dark:text-red-400 mt-1 max-w-[220px]">{r.failureReason}</div>
                    )}
                    {(r.attemptLog?.length ?? 0) > 0 && (
                      <ol className="mt-1 space-y-0.5" aria-label={`Attempts for ${r.reference}`}>
                        {r.attemptLog!.map((a) => (
                          <li key={a.id} className="text-[10px] text-slate-500 dark:text-slate-400">
                            {new Date(a.createdAt).toLocaleString('en-NG')} · {a.outcome.toLowerCase().replace(/_/g, ' ')}
                            {a.via === 'OWN_PHONE' ? ' (own phone)' : a.via === 'BROWSER' ? ' (browser)' : ''}
                          </li>
                        ))}
                      </ol>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center justify-end gap-2">
                      {['PENDING', 'DUE'].includes(r.status) && officerDials && (
                        <button
                          disabled={!dialling?.ready || browserCall.active}
                          title={
                            !dialling?.ready
                              ? 'Calling from the browser is not configured yet'
                              : browserCall.active
                                ? 'Finish the call in progress first'
                                : undefined
                          }
                          onClick={() =>
                            browserCall.start({
                              id: r.id,
                              reference: r.reference,
                              name: r.contact?.fullName || 'Citizen',
                              phoneNumber: r.phoneNumber,
                            })
                          }
                          className="px-3 py-1.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold disabled:opacity-50 inline-flex items-center gap-1"
                        >
                          <Phone className="w-3.5 h-3.5" /> Call from browser
                        </button>
                      )}
                      {['PENDING', 'DUE'].includes(r.status) && !officerDials && (
                        <button
                          disabled={busy === r.id}
                          onClick={() => act(r.id, `${API_URL}/api/callbacks/${r.id}/call-now`, 'POST', 'Call placed', 'call-now')}
                          className="px-3 py-1.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold disabled:opacity-50 inline-flex items-center gap-1"
                        >
                          <Phone className="w-3.5 h-3.5" /> Call now
                        </button>
                      )}
                      {['PENDING', 'DUE', 'IN_PROGRESS'].includes(r.status) && (
                        <select
                          aria-label={`Record an attempt from your own phone for ${r.reference}`}
                          disabled={busy === r.id}
                          value=""
                          onChange={(e) => logAttempt(r, e.target.value)}
                          className="px-2 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-bold text-slate-800 dark:text-slate-200"
                        >
                          <option value="">I rang from my phone…</option>
                          {ATTEMPT_OUTCOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      )}
                      {['PENDING', 'DUE', 'FAILED'].includes(r.status) && (
                        <>
                          {!r.assignedUser && (
                            <button disabled={busy === r.id} onClick={() => assignToMe(r)}
                              className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-800 dark:text-slate-200 disabled:opacity-50">
                              Take it
                            </button>
                          )}
                          <button disabled={busy === r.id} onClick={() => reschedule(r)}
                            className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-800 dark:text-slate-200 disabled:opacity-50">
                            Reschedule
                          </button>
                        </>
                      )}
                      {!['COMPLETED', 'CANCELLED'].includes(r.status) && (
                        <>
                          <button
                            disabled={busy === r.id}
                            onClick={() => act(r.id, `${API_URL}/api/callbacks/${r.id}/complete`, 'PATCH', 'Marked complete', 'complete')}
                            className="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 text-xs font-bold disabled:opacity-50"
                          >
                            Mark done
                          </button>
                          <button
                            disabled={busy === r.id}
                            onClick={() => act(r.id, `${API_URL}/api/callbacks/${r.id}/cancel`, 'PATCH', 'Callback cancelled', 'cancel')}
                            className="px-3 py-1.5 rounded-xl bg-red-50 dark:bg-red-500/10 hover:bg-red-100 dark:hover:bg-red-500/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-500/30 text-xs font-bold disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <BrowserCallPanel call={browserCall} />
    </div>
  );
}

function Stat({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone?: 'warn' }) {
  return (
    <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <div className={`flex items-center gap-2 text-xs font-bold uppercase tracking-wider ${tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`}>
        {icon} {label}
      </div>
      <div className="text-2xl font-black text-slate-900 dark:text-white mt-1">{value}</div>
    </div>
  );
}
