'use client';

/**
 * What this agency offers, and where.
 *
 * These rows are not configuration in the ordinary sense — they are what the
 * AI reads out to a citizen and the places it tells them to go. So the page
 * says, at every turn, what the consequence of a change is: a service switched
 * off stops being offered, an LGA with no location means the AI will not ask
 * which office, and an agency with no services at all cannot register anyone.
 *
 * Writing is OWNER/ADMIN. The API enforces that; this page does not hide the
 * buttons, it surfaces the refusal — a disabled control that never explains
 * itself is worse than a clear "you do not have permission".
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  Briefcase, MapPin, Plus, Trash2, AlertTriangle, RefreshCw,
  CheckCircle2, CircleSlash, Info,
} from 'lucide-react';

type Service = {
  id: string;
  name: string;
  description: string | null;
  matchPhrases: string[];
  isNoCost: boolean;
  requiresReview: boolean;
  isActive: boolean;
  sortOrder: number;
};

type Location = {
  id: string;
  name: string;
  kind: string | null;
  address: string | null;
  lga: string;
  isActive: boolean;
};

export default function ServiceCataloguePage() {
  const [services, setServices] = useState<Service[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [lgas, setLgas] = useState<string[]>([]);
  const [tab, setTab] = useState<'services' | 'locations'>('services');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, l, g] = await Promise.all([
        api.catalogue.listServices(),
        api.catalogue.listLocations(),
        api.catalogue.lgas(),
      ]);
      setServices(s ?? []);
      setLocations(l ?? []);
      setLgas(g?.lgas ?? []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function run(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  const activeServices = services.filter((s) => s.isActive).length;
  const lgasCovered = new Set(locations.filter((l) => l.isActive).map((l) => l.lga)).size;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Services &amp; Locations</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            What the assistant offers citizens, and where it tells them to go.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-white shadow-md"
            style={{ background: 'linear-gradient(135deg, #558A02, #74BA03)' }}
          >
            <Plus className="w-3.5 h-3.5" />
            {tab === 'services' ? 'Add service' : 'Add location'}
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30">
          <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p>
        </div>
      )}

      {/* The consequence of an empty catalogue, stated rather than implied. */}
      {!loading && activeServices === 0 && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-amber-800 dark:text-amber-200">
            <strong>No active services.</strong> The assistant cannot register anyone — it will pass
            a citizen who asks to register to a colleague instead. Add a service to turn it on.
          </p>
        </div>
      )}

      {!loading && activeServices > 0 && lgasCovered < lgas.length && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40">
          <Info className="w-4 h-4 text-slate-500 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-slate-600 dark:text-slate-400">
            You have locations in <strong>{lgasCovered}</strong> of {lgas.length} LGAs. A citizen in
            one of the others can still register — the assistant simply will not ask which office,
            and a colleague assigns one afterwards.
          </p>
        </div>
      )}

      <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800">
        <TabButton active={tab === 'services'} onClick={() => setTab('services')}>
          Services ({services.length})
        </TabButton>
        <TabButton active={tab === 'locations'} onClick={() => setTab('locations')}>
          Locations ({locations.length})
        </TabButton>
      </div>

      {loading && <p className="text-xs text-slate-500 py-8 text-center">Loading…</p>}

      {!loading && tab === 'services' && (
        <section className="rounded-2xl border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
          {services.length === 0 && (
            <p className="px-4 py-10 text-center text-xs text-slate-500">
              Nothing yet. A service is what a citizen registers for.
            </p>
          )}
          {services.map((s) => (
            <div key={s.id} className="px-4 py-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Briefcase className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                  <span className="text-sm font-bold text-slate-900 dark:text-white">{s.name}</span>
                  {s.isNoCost && <Pill tone="green">No cost</Pill>}
                  {s.requiresReview && <Pill tone="amber">Needs review</Pill>}
                  {!s.isActive && <Pill tone="slate">Not offered</Pill>}
                </div>
                {s.description && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{s.description}</p>
                )}
                <p className="text-[11px] text-slate-400 mt-1">
                  {s.matchPhrases.length > 0
                    ? `Recognised from: ${s.matchPhrases.join(', ')}`
                    : 'No phrases — citizens can still pick it by number.'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => run(s.id, () => api.catalogue.updateService(s.id, { isActive: !s.isActive }))}
                  disabled={busy === s.id}
                  className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                >
                  {s.isActive ? 'Stop offering' : 'Offer'}
                </button>
                <DeleteButton
                  busy={busy === s.id}
                  label={s.name}
                  warning="Citizens already registered for it keep their records — the name is stored on them, not a link to this row."
                  onConfirm={() => run(s.id, () => api.catalogue.deleteService(s.id))}
                />
              </div>
            </div>
          ))}
        </section>
      )}

      {!loading && tab === 'locations' && (
        <section className="rounded-2xl border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
          {locations.length === 0 && (
            <p className="px-4 py-10 text-center text-xs text-slate-500">
              Nothing yet. A location is somewhere a citizen is told to go.
            </p>
          )}
          {locations.map((l) => (
            <div key={l.id} className="px-4 py-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <MapPin className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                  <span className="text-sm font-bold text-slate-900 dark:text-white">{l.name}</span>
                  <Pill tone="slate">{l.lga}</Pill>
                  {!l.isActive && <Pill tone="slate">Not offered</Pill>}
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  {[l.kind, l.address].filter(Boolean).join(' · ') || 'No further detail'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => run(l.id, () => api.catalogue.updateLocation(l.id, { isActive: !l.isActive }))}
                  disabled={busy === l.id}
                  className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                >
                  {l.isActive ? 'Stop offering' : 'Offer'}
                </button>
                <DeleteButton
                  busy={busy === l.id}
                  label={`${l.name} (${l.lga})`}
                  warning="Citizens already assigned here keep their records."
                  onConfirm={() => run(l.id, () => api.catalogue.deleteLocation(l.id))}
                />
              </div>
            </div>
          ))}
        </section>
      )}

      {adding && tab === 'services' && (
        <AddServiceDialog onClose={() => setAdding(false)} onDone={async () => { setAdding(false); await load(); }} />
      )}
      {adding && tab === 'locations' && (
        <AddLocationDialog lgas={lgas} onClose={() => setAdding(false)} onDone={async () => { setAdding(false); await load(); }} />
      )}
    </div>
  );
}

function Pill({ tone, children }: { tone: 'green' | 'amber' | 'slate'; children: React.ReactNode }) {
  const cls = {
    green: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/20',
    amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/20',
    slate: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
  }[tone];
  return <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${cls}`}>{children}</span>;
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2.5 text-xs font-bold border-b-2 -mb-px transition-colors ${
        active
          ? 'border-[#74BA03] text-[#558A02] dark:text-[#74BA03]'
          : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
      }`}
    >
      {children}
    </button>
  );
}

/** Two-step, because removing a service changes what citizens are offered. */
function DeleteButton({
  busy, label, warning, onConfirm,
}: { busy: boolean; label: string; warning: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button
        onClick={() => setArmed(true)}
        disabled={busy}
        aria-label={`Remove ${label}`}
        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-slate-500 max-w-[16rem]">{warning}</span>
      <button
        onClick={onConfirm}
        disabled={busy}
        className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
      >
        Remove
      </button>
      <button
        onClick={() => setArmed(false)}
        className="px-2 py-1.5 rounded-lg text-[11px] font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        Cancel
      </button>
    </div>
  );
}

const fieldCls =
  'w-full px-3 py-2.5 rounded-xl text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400';
const labelCls = 'block text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-1.5';

function Dialog({ title, intro, children, onClose, onSubmit, saving, error }: {
  title: string; intro: string; children: React.ReactNode;
  onClose: () => void; onSubmit: (e: React.FormEvent) => void; saving: boolean; error: string | null;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-white">{title}</h2>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{intro}</p>
        </div>
        {error && (
          <p className="text-[11px] text-rose-600 dark:text-rose-400 p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/30">{error}</p>
        )}
        {children}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 rounded-xl text-xs font-bold text-white shadow-md disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, #558A02, #74BA03)' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

function AddServiceDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [phrases, setPhrases] = useState('');
  const [isNoCost, setIsNoCost] = useState(false);
  const [requiresReview, setRequiresReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      await api.catalogue.createService({
        name: name.trim(),
        description: description.trim() || undefined,
        matchPhrases: phrases.split(',').map((p) => p.trim()).filter(Boolean),
        isNoCost,
        requiresReview,
      });
      onDone();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setSaving(false);
    }
  }

  return (
    <Dialog
      title="Add a service"
      intro="What a citizen can register for. The name is written on their record and read at a desk, so use the words the agency actually uses."
      onClose={onClose} onSubmit={submit} saving={saving} error={err}
    >
      <div>
        <label className={labelCls} htmlFor="svc-name">Service name</label>
        <input id="svc-name" className={fieldCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Vehicle Licence Renewal" required />
      </div>
      <div>
        <label className={labelCls} htmlFor="svc-desc">Description (optional)</label>
        <input id="svc-desc" className={fieldCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Annual renewal for private vehicles." />
      </div>
      <div>
        <label className={labelCls} htmlFor="svc-phrases">Words that pick it, comma separated</label>
        <input id="svc-phrases" className={fieldCls} value={phrases} onChange={(e) => setPhrases(e.target.value)} placeholder="vehicle, licence, renew my car" />
        <p className="text-[11px] text-slate-500 mt-1.5">
          What a citizen might say. Leave blank and they can still choose it by number from the list.
        </p>
      </div>
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" checked={isNoCost} onChange={(e) => setIsNoCost(e.target.checked)} className="mt-0.5" />
        <span className="text-xs text-slate-700 dark:text-slate-300">
          <strong>Free to the citizen.</strong> Tick only if they pay nothing — this decides whether
          the assistant asks for payment, and it is taken from here, not from the name.
        </span>
      </label>
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" checked={requiresReview} onChange={(e) => setRequiresReview(e.target.checked)} className="mt-0.5" />
        <span className="text-xs text-slate-700 dark:text-slate-300">
          <strong>Needs a person to approve it.</strong> The registration is recorded as awaiting
          review rather than completed on the call.
        </span>
      </label>
    </Dialog>
  );
}

function AddLocationDialog({ lgas, onClose, onDone }: { lgas: string[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [lga, setLga] = useState(lgas[0] ?? '');
  const [kind, setKind] = useState('');
  const [address, setAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      await api.catalogue.createLocation({
        name: name.trim(),
        lga,
        kind: kind.trim() || undefined,
        address: address.trim() || undefined,
      });
      onDone();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setSaving(false);
    }
  }

  return (
    <Dialog
      title="Add a location"
      intro="Somewhere a citizen is told to go. The assistant offers only the locations in the LGA they say they live in."
      onClose={onClose} onSubmit={submit} saving={saving} error={err}
    >
      <div>
        <label className={labelCls} htmlFor="loc-name">Location name</label>
        <input id="loc-name" className={fieldCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Jos North Area Office" required />
      </div>
      <div>
        {/* Chosen from the State's own list, never typed. A misspelled LGA
            stores an office the assistant can never match a citizen to. */}
        <label className={labelCls} htmlFor="loc-lga">Local Government Area</label>
        <select id="loc-lga" className={fieldCls} value={lga} onChange={(e) => setLga(e.target.value)} required>
          {lgas.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>
      <div>
        <label className={labelCls} htmlFor="loc-kind">What kind of place (optional)</label>
        <input id="loc-kind" className={fieldCls} value={kind} onChange={(e) => setKind(e.target.value)} placeholder="Area Office" />
      </div>
      <div>
        <label className={labelCls} htmlFor="loc-address">Address (optional)</label>
        <input id="loc-address" className={fieldCls} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="12 Ahmadu Bello Way, Jos" />
      </div>
      <p className="text-[11px] text-slate-500 flex items-start gap-1.5">
        <CheckCircle2 className="w-3.5 h-3.5 mt-px flex-shrink-0 text-slate-400" />
        The same place can be added under more than one LGA if it serves them all.
      </p>
      <p className="text-[11px] text-slate-500 flex items-start gap-1.5">
        <CircleSlash className="w-3.5 h-3.5 mt-px flex-shrink-0 text-slate-400" />
        An LGA with no location is not a problem — the assistant just will not ask which office.
      </p>
    </Dialog>
  );
}
