'use client';

/**
 * Cases — citizens' complaints and reports, worked to an outcome (PRD §10, §14, §15).
 *
 * Built around three facts the screen must never blur:
 *  - a referral to an MDA is not a resolution (the API refuses to resolve
 *    without an outcome, and this screen asks for one);
 *  - an anonymous reporter is anonymous to the people handling the case — the
 *    API withholds the contact and the screen says so rather than showing a
 *    blank;
 *  - an MDA liaison sees only their own referrals and answers them; they do
 *    not move the State's case.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { RoleNotice } from '@/components/RoleNotice';
import { AlertTriangle, ClipboardList, Clock, EyeOff, Lock, RefreshCw, Send, ShieldCheck } from 'lucide-react';

const STAGES = ['RECEIVED', 'CLASSIFIED', 'ASSIGNED', 'UNDER_REVIEW', 'ACTION_IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED'] as const;
const CATEGORIES = ['roads', 'water', 'waste', 'electricity', 'health', 'education', 'security', 'misconduct', 'environment', 'project', 'service_delay', 'other'];
const label = (s: string) => s.toLowerCase().replace(/_/g, ' ');

const card = 'rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900';
const input = 'w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100';
const btn = 'inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50';
const primary = 'inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-white bg-[#3b6102] hover:bg-[#2f4e02] disabled:opacity-50';

function stageTone(stage: string) {
  if (stage === 'RESOLVED' || stage === 'CLOSED') return 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300';
  if (stage === 'RECEIVED' || stage === 'REOPENED') return 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300';
  return 'bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300';
}

export default function CasesPage() {
  const [filters, setFilters] = useState<{ stage?: string; category?: string; overdue?: boolean; mine?: boolean }>({});
  const [cases, setCases] = useState<any[] | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [selected, setSelected] = useState<any>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState<{ role?: string; mdaName?: string | null }>({});

  useEffect(() => {
    try {
      setMe(JSON.parse(localStorage.getItem('ace_user') || '{}'));
    } catch {
      /* the API is the authority; this only shapes the view */
    }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, s] = await Promise.all([api.cases.list(filters), api.cases.summary()]);
      setCases(list);
      setSummary(s);
    } catch (e: any) {
      setCases(null);
      setError(`Could not load cases: ${e?.message ?? e}`);
    }
  }, [filters]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.organizations.getTeamMembers().then(setMembers).catch(() => setMembers([]));
  }, []);

  async function open(id: string) {
    setError(null);
    try {
      setSelected(await api.cases.get(id));
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  async function act(fn: () => Promise<unknown>) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await Promise.all([open(selected.id), load()]);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const isLiaison = !!me.mdaName;

  return (
    <div className="space-y-6">
      <RoleNotice path="/cases" />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Cases</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-2xl">
            Reports from citizens: damaged roads, water, waste, misconduct, delays. A case stays open until its outcome is
            recorded. Referring it to an MDA does not resolve it.
            {isLiaison && <> You are signed in as the liaison for <strong>{me.mdaName}</strong> and see only cases referred to it.</>}
          </p>
        </div>
        <button onClick={load} className={btn}><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
      </header>

      {summary && (
        <section aria-label="Summary" className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          {[
            ['Open', STAGES.filter((s) => s !== 'RESOLVED' && s !== 'CLOSED').reduce((n, s) => n + (summary.byStage[s] ?? 0), 0)],
            ['Overdue', summary.overdue],
            ['Awaiting MDA response', summary.referralsAwaitingResponse],
            ['Resolved', (summary.byStage.RESOLVED ?? 0) + (summary.byStage.CLOSED ?? 0)],
          ].map(([k, v]) => (
            <div key={k as string} className={`${card} p-4`}>
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{k}</p>
              <p className={`text-2xl font-bold tabular-nums mt-1 ${k === 'Overdue' && Number(v) > 0 ? 'text-rose-700 dark:text-rose-400' : 'text-slate-900 dark:text-white'}`}>{v as number}</p>
            </div>
          ))}
        </section>
      )}

      <section aria-label="Filters" className="flex flex-wrap gap-2 items-end">
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 mb-1" htmlFor="f-stage">Stage</label>
          <select id="f-stage" className={input} value={filters.stage ?? ''} onChange={(e) => setFilters({ ...filters, stage: e.target.value || undefined })}>
            <option value="">Any</option>
            {STAGES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 mb-1" htmlFor="f-cat">Category</label>
          <select id="f-cat" className={input} value={filters.category ?? ''} onChange={(e) => setFilters({ ...filters, category: e.target.value || undefined })}>
            <option value="">Any</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </select>
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 px-2 py-2">
          <input type="checkbox" checked={!!filters.overdue} onChange={(e) => setFilters({ ...filters, overdue: e.target.checked || undefined })} /> Overdue only
        </label>
        <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 px-2 py-2">
          <input type="checkbox" checked={!!filters.mine} onChange={(e) => setFilters({ ...filters, mine: e.target.checked || undefined })} /> Assigned to me
        </label>
      </section>

      {error && (
        <div role="alert" className="flex items-start gap-3 p-4 rounded-xl border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30">
          <AlertTriangle className="w-4 h-4 text-rose-600 mt-0.5 shrink-0" />
          <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section aria-label="Cases" className={`${card} overflow-hidden`}>
          {cases === null ? (
            <p className="p-4 text-xs text-slate-500">{error ? 'Not loaded.' : 'Loading…'}</p>
          ) : cases.length === 0 ? (
            <p className="p-4 text-xs text-slate-600 dark:text-slate-300">No cases match.</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {cases.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => open(c.id)}
                    className={`w-full text-left p-4 hover:bg-slate-50 dark:hover:bg-slate-800/50 ${selected?.id === c.id ? 'bg-slate-50 dark:bg-slate-800/50' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono text-slate-500">{c.ticketNumber}</span>
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${stageTone(c.caseStage)}`}>{label(c.caseStage)}</span>
                    </div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-white mt-1 line-clamp-2">{c.summary || c.subject}</p>
                    <p className="text-[11px] text-slate-500 mt-1 flex flex-wrap gap-x-3 gap-y-1">
                      <span>{label(c.category ?? 'unclassified')}</span>
                      {c.lga && <span>{c.lga}</span>}
                      {c.responsibleMda && <span>{c.responsibleMda}</span>}
                      {c.isAnonymous && <span className="inline-flex items-center gap-1"><EyeOff className="w-3 h-3" /> anonymous</span>}
                      {c.isSensitive && <span className="inline-flex items-center gap-1"><Lock className="w-3 h-3" /> sensitive</span>}
                      {c.overdue && <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-400 font-semibold"><Clock className="w-3 h-3" /> overdue</span>}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Case detail">
          {!selected ? (
            <div className={`${card} p-6 text-xs text-slate-500 flex items-center gap-2`}><ClipboardList className="w-4 h-4" /> Choose a case to work it.</div>
          ) : (
            <CaseDetail c={selected} members={members} busy={busy} isLiaison={isLiaison} liaisonMda={me.mdaName ?? null} act={act} />
          )}
        </section>
      </div>
    </div>
  );
}

function CaseDetail({ c, members, busy, isLiaison, liaisonMda, act }: {
  c: any; members: any[]; busy: boolean; isLiaison: boolean; liaisonMda: string | null; act: (fn: () => Promise<unknown>) => void;
}) {
  const [nextStage, setNextStage] = useState('');
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [refer, setRefer] = useState({ mdaName: '', liaisonName: '', liaisonContact: '', note: '', dueAt: '' });
  const [reply, setReply] = useState<Record<string, string>>({});
  const [notified, setNotified] = useState({ channel: 'phone', note: '' });

  return (
    <div className="space-y-4">
      <article className={`${card} p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-mono text-slate-500">{c.ticketNumber}</p>
            <h2 className="text-base font-bold text-slate-900 dark:text-white mt-1">{c.summary || c.subject}</h2>
          </div>
          <span className={`text-[11px] font-bold px-2 py-1 rounded-full ${stageTone(c.caseStage)}`}>{label(c.caseStage)}</span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs mt-4">
          <dt className="text-slate-500">Reporter</dt>
          <dd className="text-slate-900 dark:text-slate-100">
            {c.isAnonymous && !c.contactId ? (
              <span className="inline-flex items-center gap-1"><EyeOff className="w-3 h-3" /> Withheld: the citizen asked not to be named</span>
            ) : (
              <>{c.contact?.fullName} {c.contact?.phoneNumber ? `· ${c.contact.phoneNumber}` : ''}</>
            )}
          </dd>
          <dt className="text-slate-500">Category</dt><dd>{label(c.category ?? 'unclassified')}</dd>
          <dt className="text-slate-500">Where</dt><dd>{[c.community, c.ward, c.lga].filter(Boolean).join(', ') || 'Not given yet'}</dd>
          <dt className="text-slate-500">Responsible MDA</dt><dd>{c.responsibleMda ?? 'Not set'}</dd>
          <dt className="text-slate-500">Assigned to</dt><dd>{c.assignedUser?.fullName ?? 'Nobody'}</dd>
          <dt className="text-slate-500">Deadline</dt>
          <dd className={c.overdue ? 'text-rose-700 dark:text-rose-400 font-semibold' : ''}>{c.dueAt ? new Date(c.dueAt).toLocaleDateString() : 'None'}{c.overdue ? ' (overdue)' : ''}</dd>
          {c.resolutionOutcome && (<><dt className="text-slate-500">Outcome</dt><dd>{c.resolutionOutcome}</dd></>)}
          {c.citizenNotifiedAt && (<><dt className="text-slate-500">Citizen told</dt><dd>{new Date(c.citizenNotifiedAt).toLocaleString()}</dd></>)}
        </dl>
        <div className="mt-4">
          <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">In the citizen&apos;s words</p>
          <p className="text-sm text-slate-800 dark:text-slate-200 mt-1 whitespace-pre-wrap">{c.description}</p>
        </div>
      </article>

      {!isLiaison && (
        <article className={`${card} p-5 space-y-4`}>
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">Work the case</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1" htmlFor="assign">Assign to</label>
              <select id="assign" className={input} value={c.assignedUserId ?? ''} disabled={busy}
                onChange={(e) => act(() => api.cases.assign(c.id, e.target.value || null))}>
                <option value="">Nobody</option>
                {members.filter((m) => m.isActive && !m.mdaName).map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1" htmlFor="cat">Category</label>
              <select id="cat" className={input} value={c.category ?? ''} disabled={busy}
                onChange={(e) => act(() => api.cases.classify(c.id, { category: e.target.value }))}>
                <option value="">Unclassified</option>
                {CATEGORIES.map((k) => <option key={k} value={k}>{label(k)}</option>)}
              </select>
            </div>
          </div>

          <form className="space-y-2" onSubmit={(e) => {
            e.preventDefault();
            if (!nextStage) return;
            act(() => api.cases.moveStage(c.id, { stage: nextStage, ...(outcome ? { outcome } : {}), ...(note ? { note } : {}) }).then(() => { setNextStage(''); setOutcome(''); setNote(''); }));
          }}>
            <label className="block text-[11px] font-semibold text-slate-500" htmlFor="stage">Move to</label>
            <div className="flex flex-wrap gap-2">
              <select id="stage" className={`${input} sm:w-56`} value={nextStage} onChange={(e) => setNextStage(e.target.value)}>
                <option value="">Choose a stage…</option>
                {STAGES.filter((s) => s !== c.caseStage).map((s) => <option key={s} value={s}>{label(s)}</option>)}
              </select>
              <button type="submit" className={primary} disabled={busy || !nextStage}>Move</button>
            </div>
            {nextStage === 'RESOLVED' && (
              <textarea className={input} rows={2} required value={outcome} onChange={(e) => setOutcome(e.target.value)}
                placeholder="What was actually done? (required: a referral is not an outcome)" />
            )}
            <input className={input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the history (optional)" />
          </form>

          <form className="space-y-2" onSubmit={(e) => {
            e.preventDefault();
            act(() => api.cases.refer(c.id, {
              mdaName: refer.mdaName,
              ...(refer.liaisonName ? { liaisonName: refer.liaisonName } : {}),
              ...(refer.liaisonContact ? { liaisonContact: refer.liaisonContact } : {}),
              ...(refer.note ? { note: refer.note } : {}),
              ...(refer.dueAt ? { dueAt: refer.dueAt } : {}),
            }).then(() => setRefer({ mdaName: '', liaisonName: '', liaisonContact: '', note: '', dueAt: '' })));
          }}>
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Refer to an MDA</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input className={input} required value={refer.mdaName} onChange={(e) => setRefer({ ...refer, mdaName: e.target.value })} placeholder="MDA name" aria-label="MDA name" />
              <input type="date" className={input} value={refer.dueAt} onChange={(e) => setRefer({ ...refer, dueAt: e.target.value })} aria-label="Response due" />
              <input className={input} value={refer.liaisonName} onChange={(e) => setRefer({ ...refer, liaisonName: e.target.value })} placeholder="Liaison officer (optional)" aria-label="Liaison officer" />
              <input className={input} value={refer.liaisonContact} onChange={(e) => setRefer({ ...refer, liaisonContact: e.target.value })} placeholder="Liaison contact (optional)" aria-label="Liaison contact" />
            </div>
            <input className={input} value={refer.note} onChange={(e) => setRefer({ ...refer, note: e.target.value })} placeholder="What you are asking the MDA to do" aria-label="Referral note" />
            {c.isAnonymous && <p className="text-[11px] text-slate-500 flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> The reporter&apos;s identity is not shared with the MDA.</p>}
            <button type="submit" className={btn} disabled={busy}><Send className="w-3.5 h-3.5" /> Refer</button>
          </form>

          {(c.caseStage === 'RESOLVED' || c.caseStage === 'CLOSED') && !c.citizenNotifiedAt && (
            <form className="space-y-2" onSubmit={(e) => {
              e.preventDefault();
              act(() => api.cases.citizenNotified(c.id, { channel: notified.channel, ...(notified.note ? { note: notified.note } : {}) }));
            }}>
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Record that the citizen was told the outcome</p>
              <div className="flex flex-wrap gap-2">
                <select className={`${input} sm:w-40`} value={notified.channel} onChange={(e) => setNotified({ ...notified, channel: e.target.value })} aria-label="How they were told">
                  <option value="phone">Phone call</option><option value="WhatsApp">WhatsApp</option><option value="in person">In person</option><option value="letter">Letter</option>
                </select>
                <input className={`${input} flex-1`} value={notified.note} onChange={(e) => setNotified({ ...notified, note: e.target.value })} placeholder="What they were told" aria-label="What they were told" />
                <button type="submit" className={btn} disabled={busy}>Record</button>
              </div>
            </form>
          )}
        </article>
      )}

      <article className={`${card} p-5`}>
        <h3 className="text-sm font-bold text-slate-900 dark:text-white">MDA referrals</h3>
        {(c.referrals ?? []).length === 0 ? (
          <p className="text-xs text-slate-500 mt-2">Not referred.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {c.referrals.map((r: any) => (
              <li key={r.id} className="rounded-xl border border-slate-100 dark:border-slate-800 p-3 text-xs">
                <p className="font-semibold text-slate-900 dark:text-white">{r.mdaName} · {label(r.status)}</p>
                {r.note && <p className="text-slate-600 dark:text-slate-300 mt-1">{r.note}</p>}
                {r.response && <p className="mt-1"><strong>Response:</strong> {r.response}</p>}
                {(!isLiaison || r.mdaName === liaisonMda) && ['SENT', 'ACKNOWLEDGED'].includes(r.status) && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {r.status === 'SENT' && (
                      <button className={btn} disabled={busy} onClick={() => act(() => api.cases.respondToReferral(r.id, { status: 'ACKNOWLEDGED' }))}>Acknowledge</button>
                    )}
                    <input className={`${input} flex-1 min-w-[12rem]`} value={reply[r.id] ?? ''} onChange={(e) => setReply({ ...reply, [r.id]: e.target.value })} placeholder="What the MDA did, or why it declined" aria-label={`Response from ${r.mdaName}`} />
                    <button className={btn} disabled={busy || !reply[r.id]} onClick={() => act(() => api.cases.respondToReferral(r.id, { status: 'RESPONDED', response: reply[r.id] }))}>Respond</button>
                    <button className={btn} disabled={busy || !reply[r.id]} onClick={() => act(() => api.cases.respondToReferral(r.id, { status: 'DECLINED', response: reply[r.id] }))}>Decline</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </article>

      <article className={`${card} p-5`}>
        <h3 className="text-sm font-bold text-slate-900 dark:text-white">History</h3>
        <ol className="mt-3 space-y-2">
          {(c.events ?? []).map((e: any) => (
            <li key={e.id} className="text-xs">
              <span className="text-slate-400">{new Date(e.createdAt).toLocaleString()}</span>{' '}
              <span className="font-semibold text-slate-700 dark:text-slate-200">{label(e.type)}</span>
              {e.toStage && <span className="text-slate-500"> → {label(e.toStage)}</span>}
              {e.body && <p className="text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{e.body}</p>}
            </li>
          ))}
        </ol>
        <form className="flex gap-2 mt-4" onSubmit={(e) => {
          e.preventDefault();
          const f = e.currentTarget.elements.namedItem('note') as HTMLInputElement;
          const text = f.value;
          act(() => api.cases.addNote(c.id, text).then(() => { f.value = ''; }));
        }}>
          <input name="note" className={input} placeholder="Add an internal note" aria-label="Internal note" required />
          <button type="submit" className={btn} disabled={busy}>Add</button>
        </form>
      </article>
    </div>
  );
}
