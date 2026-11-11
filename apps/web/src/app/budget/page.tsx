'use client';

/**
 * Budget & Projects — the figures the assistant reads to citizens (PRD §03, §04).
 *
 * The page is organised around the one thing that must not go wrong: a figure
 * read to the public that is not in a published document. So it shows, for
 * every document, its stage of approval, whether its lines add up to the total
 * the document itself states, and who approved it — and the "check a figure"
 * panel returns exactly what a citizen would be told, including "no verified
 * figure" and "the documents disagree".
 *
 * Upload and approval are separate people. The API refuses approval by the
 * uploader; this page shows that refusal rather than hiding the button.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { RoleNotice } from '@/components/RoleNotice';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Landmark, MapPin, RefreshCw, Search, Upload } from 'lucide-react';

type Doc = {
  id: string; title: string; documentType: string; fiscalYear: number; status: 'DRAFT' | 'APPROVED' | 'WITHDRAWN';
  sourceUrl: string | null; reportingPeriod: string | null; declaredTotal: string | null;
  approvedAt: string | null; createdAt: string; _count: { lines: number };
};
type Validation = {
  lineCount: number; totalsByStage: Record<string, string>; declaredTotal: string | null;
  matchesDeclared: boolean | null; problems: string[];
};
type Project = {
  id: string; name: string; responsibleMda: string; lga: string | null; community: string | null;
  status: string; publicationStatus: string; approvedAllocation: string | null; contractValue: string | null;
  reportedExpenditure: string | null; physicalProgress: number | null; sourceUrl: string | null;
  sourceDocument: string | null; _count: { observations: number };
};
type Observation = {
  id: string; text: string; channel: string | null; referred: boolean; createdAt: string;
  project: { id: string; name: string; lga: string | null; status: string };
};

const DOC_TYPES: Array<[string, string]> = [
  ['APPROPRIATION_LAW', 'Appropriation law (approved)'],
  ['PROPOSED_BUDGET', 'Proposed budget'],
  ['SUPPLEMENTARY_BUDGET', 'Supplementary budget'],
  ['REVISED_APPROPRIATION', 'Revised appropriation'],
  ['CITIZENS_BUDGET', "Citizens' budget"],
  ['IMPLEMENTATION_REPORT', 'Budget implementation report'],
  ['AUDITED_STATEMENT', 'Audited financial statement'],
  ['PROCUREMENT_PLAN', 'Procurement plan'],
  ['OTHER', 'Other'],
];
const STAGES: Array<[string, string]> = [
  ['APPROVED', 'Approved allocation'],
  ['PROPOSED', 'Proposed'],
  ['REVISED', 'Revised'],
  ['RELEASED', 'Released'],
  ['ACTUAL_EXPENDITURE', 'Reported expenditure'],
];

const naira = (v: string | null | undefined) => {
  if (v == null) return '—';
  const [w, k] = Number(v).toFixed(2).split('.');
  return `₦${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${k === '00' ? '' : `.${k}`}`;
};

const card = 'rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5';
const input = 'w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100';
const label = 'block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1';
const btn = 'inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50';
const primary = 'inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-white bg-[#3b6102] hover:bg-[#2f4e02] disabled:opacity-50';

const statusChip = (s: string) =>
  s === 'APPROVED'
    ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
    : s === 'WITHDRAWN'
      ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
      : 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300';

export default function BudgetPage() {
  const [tab, setTab] = useState<'documents' | 'check' | 'projects'>('documents');
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [observations, setObservations] = useState<Observation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [validations, setValidations] = useState<Record<string, Validation>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, p, o] = await Promise.all([api.budget.documents(), api.budget.projects(), api.budget.observations()]);
      setDocs(d); setProjects(p); setObservations(o);
    } catch (e: any) {
      setError(`Could not load the register: ${e?.message ?? e}`);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function run(id: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(id); setError(null); setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <RoleNotice path="/budget" />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Budget &amp; Projects</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-2xl">
            The assistant answers budget and project questions only from documents approved here, and always says
            which stage a figure is: approved, released or spent. A draft is never read to anyone.
          </p>
        </div>
        <button onClick={load} className={btn}><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
      </header>

      <div role="tablist" className="flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {([
          ['documents', 'Budget documents'],
          ['check', 'Check a figure'],
          ['projects', 'Projects'],
        ] as const).map(([k, l]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px ${tab === k ? 'border-[#3b6102] text-slate-900 dark:text-white' : 'border-transparent text-slate-500'}`}
          >
            {l}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-3 p-4 rounded-xl border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30">
          <AlertTriangle className="w-4 h-4 text-rose-600 mt-0.5 shrink-0" />
          <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p>
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-start gap-3 p-4 rounded-xl border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30">
          <CheckCircle2 className="w-4 h-4 text-emerald-700 mt-0.5 shrink-0" />
          <p className="text-xs text-emerald-800 dark:text-emerald-200">{notice}</p>
        </div>
      )}

      {tab === 'documents' && (
        <Documents
          docs={docs}
          busy={busy}
          validations={validations}
          onCreate={(body) => run('create', () => api.budget.createDocument(body), 'Draft created. Import its lines next.')}
          onImport={(id, csv) =>
            run(`import-${id}`, async () => {
              const r = await api.budget.importLines(id, csv);
              setNotice(
                `${r.imported} line(s) imported.` +
                  (r.rejected.length
                    ? ` ${r.rejected.length} rejected: ` + r.rejected.slice(0, 5).map((x: any) => `line ${x.line}: ${x.message}`).join(' ')
                    : ''),
              );
            })
          }
          onValidate={(id) =>
            run(`validate-${id}`, async () => {
              const v = await api.budget.validation(id);
              setValidations((prev) => ({ ...prev, [id]: v }));
            })
          }
          onApprove={(id) => run(`approve-${id}`, () => api.budget.approve(id), 'Approved. The assistant can now quote these figures.')}
          onWithdraw={(id) => {
            const reason = window.prompt('Why is this document being withdrawn? This is recorded in the audit log.');
            if (reason) run(`withdraw-${id}`, () => api.budget.withdraw(id, reason), 'Withdrawn. The assistant no longer quotes it.');
          }}
        />
      )}

      {tab === 'check' && <CheckFigure />}

      {tab === 'projects' && (
        <Projects
          projects={projects}
          observations={observations}
          busy={busy}
          onImport={(csv) =>
            run('projects-import', async () => {
              const r = await api.budget.importProjects(csv);
              setNotice(
                `${r.imported} project(s) added as drafts.` +
                  (r.rejected.length ? ` ${r.rejected.length} rejected: ` + r.rejected.slice(0, 5).map((x: any) => `line ${x.line}: ${x.message}`).join(' ') : ''),
              );
            })
          }
          onApprove={(id) => run(`p-${id}`, () => api.budget.approveProject(id), 'Project published.')}
          onReferred={(id) => run(`o-${id}`, () => api.budget.markReferred(id), 'Marked as referred.')}
        />
      )}
    </div>
  );
}

function readFile(e: React.ChangeEvent<HTMLInputElement>, then: (text: string) => void) {
  const f = e.target.files?.[0];
  if (!f) return;
  f.text().then(then);
  e.target.value = '';
}

function Documents(props: {
  docs: Doc[] | null;
  busy: string | null;
  validations: Record<string, Validation>;
  onCreate: (b: { title: string; documentType: string; fiscalYear: number; sourceUrl?: string; reportingPeriod?: string; declaredTotal?: string }) => void;
  onImport: (id: string, csv: string) => void;
  onValidate: (id: string) => void;
  onApprove: (id: string) => void;
  onWithdraw: (id: string) => void;
}) {
  const [form, setForm] = useState({ title: '', documentType: 'APPROPRIATION_LAW', fiscalYear: new Date().getFullYear(), sourceUrl: '', reportingPeriod: '', declaredTotal: '' });
  const { docs } = props;

  return (
    <div className="space-y-6">
      <section className={card} aria-labelledby="new-doc">
        <h2 id="new-doc" className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <FileSpreadsheet className="w-4 h-4" /> Add a published document
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Enter the total the document itself states. Approval is refused until the imported lines add up to it, so a
          dropped page cannot pass as the whole budget.
        </p>
        <form
          className="grid gap-3 mt-4 sm:grid-cols-2 lg:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            props.onCreate({
              title: form.title,
              documentType: form.documentType,
              fiscalYear: Number(form.fiscalYear),
              ...(form.sourceUrl ? { sourceUrl: form.sourceUrl } : {}),
              ...(form.reportingPeriod ? { reportingPeriod: form.reportingPeriod } : {}),
              ...(form.declaredTotal ? { declaredTotal: form.declaredTotal } : {}),
            });
          }}
        >
          <div className="sm:col-span-2">
            <label className={label} htmlFor="doc-title">Title</label>
            <input id="doc-title" required className={input} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="2025 Appropriation Law" />
          </div>
          <div>
            <label className={label} htmlFor="doc-type">Type</label>
            <select id="doc-type" className={input} value={form.documentType} onChange={(e) => setForm({ ...form, documentType: e.target.value })}>
              {DOC_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="doc-year">Fiscal year</label>
            <input id="doc-year" type="number" required className={input} value={form.fiscalYear} onChange={(e) => setForm({ ...form, fiscalYear: Number(e.target.value) })} />
          </div>
          <div>
            <label className={label} htmlFor="doc-total">Total stated in the document (₦)</label>
            <input id="doc-total" inputMode="decimal" className={input} value={form.declaredTotal} onChange={(e) => setForm({ ...form, declaredTotal: e.target.value })} placeholder="e.g. 456,123,000,000" />
          </div>
          <div>
            <label className={label} htmlFor="doc-period">Reporting period (reports only)</label>
            <input id="doc-period" className={input} value={form.reportingPeriod} onChange={(e) => setForm({ ...form, reportingPeriod: e.target.value })} placeholder="Q2 2025" />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <label className={label} htmlFor="doc-url">Official link</label>
            <input id="doc-url" type="url" className={input} value={form.sourceUrl} onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })} placeholder="https://…" />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <button type="submit" className={primary} disabled={props.busy === 'create'}>Create draft</button>
          </div>
        </form>
      </section>

      <section aria-label="Budget documents" className="space-y-3">
        {docs === null ? (
          <p className="text-xs text-slate-500">Loading…</p>
        ) : docs.length === 0 ? (
          <div className={card}>
            <p className="text-sm text-slate-700 dark:text-slate-200 font-semibold">No budget documents yet.</p>
            <p className="text-xs text-slate-500 mt-1">
              Until one is approved, the assistant answers budget questions by saying it has no verified figure.
            </p>
          </div>
        ) : (
          docs.map((d) => {
            const v = props.validations[d.id];
            return (
              <article key={d.id} className={card}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white">{d.title}</h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {DOC_TYPES.find(([k]) => k === d.documentType)?.[1]} · FY {d.fiscalYear}
                      {d.reportingPeriod ? ` · ${d.reportingPeriod}` : ''} · {d._count.lines} line(s) · stated total {naira(d.declaredTotal)}
                    </p>
                    {d.sourceUrl && (
                      <a href={d.sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-[#3b6102] underline break-all">{d.sourceUrl}</a>
                    )}
                  </div>
                  <span className={`text-[11px] font-bold px-2 py-1 rounded-full ${statusChip(d.status)}`}>{d.status}</span>
                </div>

                {v && (
                  <div className={`mt-3 text-xs rounded-xl p-3 ${v.problems.length ? 'bg-rose-50 dark:bg-rose-950/30 text-rose-800 dark:text-rose-200' : 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200'}`}>
                    <p className="font-semibold">
                      {v.problems.length ? 'Does not validate' : 'Validates'} — {v.lineCount} line(s):{' '}
                      {Object.entries(v.totalsByStage).map(([s, t]) => `${s.toLowerCase()} ${naira(t)}`).join(', ') || 'none'}
                    </p>
                    {v.problems.map((p) => <p key={p} className="mt-1">{p}</p>)}
                  </div>
                )}

                <div className="flex flex-wrap gap-2 mt-4">
                  {d.status === 'DRAFT' && (
                    <label className={`${btn} cursor-pointer`}>
                      <Upload className="w-3.5 h-3.5" /> Import lines (CSV)
                      <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => readFile(e, (t) => props.onImport(d.id, t))} />
                    </label>
                  )}
                  <button className={btn} onClick={() => props.onValidate(d.id)} disabled={props.busy === `validate-${d.id}`}>Check totals</button>
                  {d.status === 'DRAFT' && (
                    <button className={primary} onClick={() => props.onApprove(d.id)} disabled={props.busy === `approve-${d.id}`}>Approve for citizens</button>
                  )}
                  {d.status === 'APPROVED' && (
                    <button className={btn} onClick={() => props.onWithdraw(d.id)} disabled={props.busy === `withdraw-${d.id}`}>Withdraw</button>
                  )}
                </div>
              </article>
            );
          })
        )}
      </section>

      <details className={card}>
        <summary className="text-sm font-bold text-slate-900 dark:text-white cursor-pointer">CSV format for budget lines</summary>
        <p className="text-xs text-slate-500 mt-2">
          Required columns: <code>mda</code>, <code>amount</code>. Optional: <code>stage</code> (APPROVED, PROPOSED, REVISED, RELEASED,
          ACTUAL_EXPENDITURE — taken from the document type when omitted), <code>sector</code>, <code>programme</code>, <code>lineCode</code>,{' '}
          <code>description</code>, <code>economicClass</code>, <code>lga</code>, <code>period</code>, <code>sourcePage</code>, <code>sourceTable</code>.
          Amounts are read exactly as written (e.g. <code>1,250,000.00</code>). Anything that is not an exact amount is rejected with its line
          number, never rounded or guessed.
        </p>
        <pre className="mt-3 text-[11px] bg-slate-50 dark:bg-slate-950 p-3 rounded-xl overflow-x-auto">{`mda,sector,economicClass,amount,sourcePage
Ministry of Education,Education,CAPITAL,"12,500,000,000",p. 214
Universal Basic Education Board (PLSUBEB),Education,RECURRENT,"4,100,000,000",p. 216`}</pre>
      </details>
    </div>
  );
}

function CheckFigure() {
  const [facets, setFacets] = useState<{ mdas: string[]; sectors: string[]; years: number[] } | null>(null);
  const [q, setQ] = useState({ year: '', stage: 'APPROVED', mda: '', sector: '' });
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.budget.facets().then((f: any) => {
      setFacets(f);
      if (f.years?.length) setQ((prev) => ({ ...prev, year: String(f.years[0]) }));
    }).catch((e: any) => setErr(String(e?.message ?? e)));
  }, []);

  const noData = facets && facets.years.length === 0;

  return (
    <section className={card} aria-labelledby="check">
      <h2 id="check" className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
        <Search className="w-4 h-4" /> What would a citizen be told?
      </h2>
      <p className="text-xs text-slate-500 mt-1">
        This is the same figure the assistant would give, from approved documents only, never added across documents.
      </p>
      {err && <p role="alert" className="text-xs text-rose-700 mt-3">{err}</p>}
      {noData ? (
        <p className="text-xs text-slate-600 dark:text-slate-300 mt-4">No approved budget figures yet.</p>
      ) : (
        <form
          className="grid gap-3 mt-4 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null); setResult(null);
            try {
              setResult(await api.budget.query({ year: Number(q.year), stage: q.stage, mda: q.mda || undefined, sector: q.sector || undefined }));
            } catch (x: any) {
              setErr(String(x?.message ?? x));
            }
          }}
        >
          <div>
            <label className={label} htmlFor="q-year">Year</label>
            <select id="q-year" className={input} value={q.year} onChange={(e) => setQ({ ...q, year: e.target.value })}>
              {(facets?.years ?? []).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="q-stage">Stage</label>
            <select id="q-stage" className={input} value={q.stage} onChange={(e) => setQ({ ...q, stage: e.target.value })}>
              {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="q-mda">MDA</label>
            <select id="q-mda" className={input} value={q.mda} onChange={(e) => setQ({ ...q, mda: e.target.value, sector: '' })}>
              <option value="">Whole State</option>
              {(facets?.mdas ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="q-sector">or Sector</label>
            <select id="q-sector" className={input} value={q.sector} onChange={(e) => setQ({ ...q, sector: e.target.value, mda: '' })}>
              <option value="">—</option>
              {(facets?.sectors ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <button className={primary} type="submit" disabled={!q.year}>Check</button>
          </div>
        </form>
      )}
      {result && (
        <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-800 p-4 text-sm" role="status">
          {result.kind === 'figure' && (
            <>
              <p className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">{naira(result.total)}</p>
              <p className="text-xs text-slate-500 mt-1">
                {STAGES.find(([k]) => k === result.stage)?.[1]} · FY {result.fiscalYear} · {result.lineCount} line(s)
              </p>
              <ul className="text-xs mt-3 space-y-1">
                {result.sources.map((s: any) => (
                  <li key={s.documentId}>Source: {s.title}{s.references.length ? ` (${s.references.join('; ')})` : ''}</li>
                ))}
              </ul>
            </>
          )}
          {result.kind === 'none' && <p>No verified figure. The assistant will say so and will not estimate one.</p>}
          {result.kind === 'conflict' && (
            <>
              <p className="font-semibold text-rose-700">The approved documents disagree. The assistant will not give a figure and will ask an officer to verify.</p>
              <ul className="text-xs mt-2 space-y-1">
                {result.candidates.map((c: any) => <li key={c.source.documentId}>{c.source.title}: {naira(c.total)}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Projects(props: {
  projects: Project[] | null;
  observations: Observation[] | null;
  busy: string | null;
  onImport: (csv: string) => void;
  onApprove: (id: string) => void;
  onReferred: (id: string) => void;
}) {
  const open = useMemo(() => (props.observations ?? []).filter((o) => !o.referred), [props.observations]);
  return (
    <div className="space-y-6">
      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2"><MapPin className="w-4 h-4" /> Project register</h2>
            <p className="text-xs text-slate-500 mt-1">Projects are added as drafts and need a source before another administrator can publish them.</p>
          </div>
          <label className={`${btn} cursor-pointer`}>
            <Upload className="w-3.5 h-3.5" /> Import projects (CSV)
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => readFile(e, props.onImport)} />
          </label>
        </div>
        <p className="text-[11px] text-slate-500 mt-3">
          Columns: <code>name</code>, <code>responsibleMda</code> (required); <code>projectCode</code>, <code>fiscalYear</code>, <code>lga</code>, <code>ward</code>,{' '}
          <code>community</code>, <code>approvedAllocation</code>, <code>contractValue</code>, <code>contractor</code>, <code>reportedExpenditure</code>, <code>status</code>,{' '}
          <code>physicalProgress</code>, <code>startDate</code>, <code>expectedCompletion</code>, <code>sourceUrl</code>, <code>sourceDocument</code>.
        </p>
      </section>

      {open.length > 0 && (
        <section className={card} aria-labelledby="obs">
          <h2 id="obs" className="text-sm font-bold text-slate-900 dark:text-white">Citizen reports awaiting referral ({open.length})</h2>
          <p className="text-xs text-slate-500 mt-1">What citizens said about a project. These never change its official status.</p>
          <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
            {open.map((o) => (
              <li key={o.id} className="py-3 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{o.project.name}{o.project.lga ? ` · ${o.project.lga}` : ''}</p>
                  <p className="text-xs text-slate-600 dark:text-slate-300 mt-1">"{o.text}"</p>
                  <p className="text-[11px] text-slate-400 mt-1">{new Date(o.createdAt).toLocaleString()} {o.channel ? `· ${o.channel}` : ''}</p>
                </div>
                <button className={btn} onClick={() => props.onReferred(o.id)} disabled={props.busy === `o-${o.id}`}>Mark referred</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Projects" className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800">
        {props.projects === null ? (
          <p className="text-xs text-slate-500 p-4">Loading…</p>
        ) : props.projects.length === 0 ? (
          <p className="text-xs text-slate-600 dark:text-slate-300 p-4">No projects yet. The assistant will say it has no published record rather than guess.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 dark:bg-slate-900 text-left text-slate-500">
              <tr>
                <th className="p-3">Project</th><th className="p-3">LGA</th><th className="p-3">Status</th>
                <th className="p-3 text-right">Allocation</th><th className="p-3 text-right">Contract</th><th className="p-3 text-right">Reported spend</th>
                <th className="p-3">Published</th><th className="p-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {props.projects.map((p) => (
                <tr key={p.id} className="bg-white dark:bg-slate-950">
                  <td className="p-3">
                    <p className="font-semibold text-slate-900 dark:text-white">{p.name}</p>
                    <p className="text-slate-500">{p.responsibleMda}{p._count.observations ? ` · ${p._count.observations} citizen report(s)` : ''}</p>
                  </td>
                  <td className="p-3">{[p.community, p.lga].filter(Boolean).join(', ') || '—'}</td>
                  <td className="p-3">{p.status.toLowerCase()}{p.physicalProgress != null ? ` · ${p.physicalProgress}%` : ''}</td>
                  <td className="p-3 text-right tabular-nums">{naira(p.approvedAllocation)}</td>
                  <td className="p-3 text-right tabular-nums">{naira(p.contractValue)}</td>
                  <td className="p-3 text-right tabular-nums">{naira(p.reportedExpenditure)}</td>
                  <td className="p-3"><span className={`px-2 py-0.5 rounded-full font-bold ${statusChip(p.publicationStatus)}`}>{p.publicationStatus}</span></td>
                  <td className="p-3">
                    {p.publicationStatus === 'DRAFT' && (
                      <button className={btn} onClick={() => props.onApprove(p.id)} disabled={props.busy === `p-${p.id}`}>Publish</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="text-[11px] text-slate-500 flex items-center gap-1"><Landmark className="w-3 h-3" /> A contract value is not money paid, and physical progress is not expenditure.</p>
    </div>
  );
}
