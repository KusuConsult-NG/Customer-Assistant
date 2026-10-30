'use client';

/**
 * The operating ministry's console.
 *
 * ── What this page deliberately does NOT show ────────────────────────────────
 *
 * Any citizen's name, phone number, message or transcript. The API does not
 * return them (see the privacy note in platform.service.ts), and this page is
 * built to match: it reports how agencies are PERFORMING, never what citizens
 * SAID. Reading an individual record stays inside the agency that holds the
 * relationship.
 *
 * ── Why the page re-checks access instead of trusting the stored flag ────────
 *
 * `isPlatformAdmin` in localStorage decides whether the sidebar shows a link.
 * It is not a permission — anyone can edit localStorage. So this page simply
 * calls the API and renders what comes back; a non-operator gets a 403 and the
 * "not available" panel below rather than a broken dashboard. The server is the
 * authority, and the UI never pretends otherwise.
 */

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import {
  Building2, Users, MessageCircle, PhoneCall, Calendar, AlertTriangle,
  ShieldAlert, Plus, RefreshCw, ScrollText, CheckCircle2, PauseCircle,
} from 'lucide-react';

type Metrics = {
  activeStaff: number;
  citizens: number;
  conversations: number;
  calls: number;
  appointments: number;
  openCases: number;
  handoverRatePercent: number | null;
};

type Agency = {
  id: string;
  name: string;
  slug: string;
  category: string;
  phone: string | null;
  inService: boolean;
  suspendedAt: string | null;
  suspendedReason: string | null;
  onboardedAt: string;
  metrics: Metrics;
};

type Overview = {
  agencies: {
    total: number; inService: number; suspended: number;
    withWhatsAppConnected: number; withTelephonyConnected: number;
  };
  volume: {
    activeStaff: number; citizens: number; conversations: number;
    calls: number; appointments: number; openCases: number;
  };
  service: { aiReplyRatePercent: number | null; handoverRatePercent: number | null };
};

type AuditEntry = {
  id: string; organizationId: string | null; actor: string; action: string;
  targetType: string; targetId: string; newValue: any; createdAt: string;
};

/** A rate that cannot honestly be computed shows as "—", never as 0%. */
const pct = (v: number | null) => (v === null || v === undefined ? '—' : `${v}%`);

const num = (v: number) => v.toLocaleString('en-NG');

export default function PlatformConsolePage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [tab, setTab] = useState<'agencies' | 'audit'>('agencies');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [o, a, l] = await Promise.all([
        api.platform.getOverview(),
        api.platform.listAgencies(),
        api.platform.getAudit({ limit: 50 }),
      ]);
      setOverview(o);
      setAgencies(a.agencies ?? []);
      setAudit(l.entries ?? []);
      setForbidden(false);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // A 403 here is a legitimate answer, not a fault: this account is simply
      // not a platform operator. Saying so plainly beats an error toast over an
      // empty dashboard.
      if (/permission|forbidden|403/i.test(msg)) setForbidden(true);
      else setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function suspend(agency: Agency) {
    // A reason is required by the API and recorded against the suspension, so
    // it is collected here rather than sent blank and rejected.
    const reason = window.prompt(
      `Suspend ${agency.name}?\n\nThis stops the agency answering citizens immediately — every member is signed out on their next action.\n\nState the reason (recorded, and shown to the agency):`
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setError('A suspension must state a reason.');
      return;
    }
    setBusyId(agency.id);
    setError(null);
    try {
      await api.platform.suspendAgency(agency.id, reason.trim());
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusyId(null);
    }
  }

  async function reinstate(agency: Agency) {
    setBusyId(agency.id);
    setError(null);
    try {
      await api.platform.reinstateAgency(agency.id);
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusyId(null);
    }
  }

  if (forbidden) {
    return (
      <div className="max-w-2xl mx-auto mt-16 p-8 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-center">
        <ShieldAlert className="w-10 h-10 mx-auto text-slate-400" />
        <h1 className="mt-4 text-lg font-bold text-slate-900 dark:text-white">
          Platform console unavailable
        </h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          This console is for the ministry that operates the platform. Your account administers
          its own agency, which is everything else in the dashboard.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Platform Console</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Every agency on the platform. Service levels and configuration — not citizen records.
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
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-white shadow-md"
            style={{ background: 'linear-gradient(135deg, #558A02, #74BA03)' }}
          >
            <Plus className="w-3.5 h-3.5" />
            Onboard agency
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30">
          <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p>
        </div>
      )}

      {/* ── State-wide ─────────────────────────────────────────────────────── */}
      {overview && (
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Agencies in service" value={`${num(overview.agencies.inService)} / ${num(overview.agencies.total)}`} icon={<Building2 className="w-4 h-4" />} />
          <Stat label="Citizens on record" value={num(overview.volume.citizens)} icon={<Users className="w-4 h-4" />} />
          <Stat label="Conversations" value={num(overview.volume.conversations)} icon={<MessageCircle className="w-4 h-4" />} />
          <Stat label="Calls handled" value={num(overview.volume.calls)} icon={<PhoneCall className="w-4 h-4" />} />
          <Stat label="Appointments" value={num(overview.volume.appointments)} icon={<Calendar className="w-4 h-4" />} />
          <Stat label="Open cases" value={num(overview.volume.openCases)} icon={<ScrollText className="w-4 h-4" />} tone={overview.volume.openCases > 0 ? 'warn' : undefined} />
          <Stat label="Answered by AI" value={pct(overview.service.aiReplyRatePercent)} icon={<MessageCircle className="w-4 h-4" />} />
          <Stat label="Escalated to staff" value={pct(overview.service.handoverRatePercent)} icon={<Users className="w-4 h-4" />} />
        </section>
      )}

      {/* Readiness is a different question from activity: an agency with no
          channel connected cannot receive a citizen at all. */}
      {overview && (overview.agencies.withWhatsAppConnected < overview.agencies.total ||
        overview.agencies.withTelephonyConnected < overview.agencies.total) && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-amber-800 dark:text-amber-200">
            <strong>{overview.agencies.withWhatsAppConnected}</strong> of {overview.agencies.total} agencies
            have WhatsApp connected and <strong>{overview.agencies.withTelephonyConnected}</strong> have a
            telephone line. An agency with neither cannot be reached by a citizen, however it is configured.
          </p>
        </div>
      )}

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800">
        <TabButton active={tab === 'agencies'} onClick={() => setTab('agencies')}>
          Agencies ({agencies.length})
        </TabButton>
        <TabButton active={tab === 'audit'} onClick={() => setTab('audit')}>
          Audit trail
        </TabButton>
      </div>

      {loading && <p className="text-xs text-slate-500 py-8 text-center">Loading…</p>}

      {!loading && tab === 'agencies' && (
        <section className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800">
          <table className="w-full text-left">
            <thead className="bg-slate-50 dark:bg-slate-900/60">
              <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3 font-bold">Agency</th>
                <th className="px-3 py-3 font-bold">Status</th>
                <th className="px-3 py-3 font-bold text-right">Staff</th>
                <th className="px-3 py-3 font-bold text-right">Citizens</th>
                <th className="px-3 py-3 font-bold text-right">Conversations</th>
                <th className="px-3 py-3 font-bold text-right">Calls</th>
                <th className="px-3 py-3 font-bold text-right">Open cases</th>
                <th className="px-3 py-3 font-bold text-right">Escalated</th>
                <th className="px-3 py-3 font-bold text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {agencies.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-xs text-slate-500">
                    No agencies yet. Onboard the first one to begin.
                  </td>
                </tr>
              )}
              {agencies.map((a) => (
                <tr key={a.id} className="text-xs hover:bg-slate-50/60 dark:hover:bg-slate-900/40">
                  <td className="px-4 py-3">
                    <p className="font-bold text-slate-900 dark:text-white">{a.name}</p>
                    <p className="text-[10px] text-slate-400">{a.category}</p>
                  </td>
                  <td className="px-3 py-3">
                    {a.inService ? (
                      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-semibold">
                        <CheckCircle2 className="w-3 h-3" /> In service
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400 font-semibold"
                        title={a.suspendedReason ?? undefined}
                      >
                        <PauseCircle className="w-3 h-3" /> Suspended
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">{num(a.metrics.activeStaff)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{num(a.metrics.citizens)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{num(a.metrics.conversations)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{num(a.metrics.calls)}</td>
                  <td className={`px-3 py-3 text-right tabular-nums ${a.metrics.openCases > 0 ? 'text-amber-600 dark:text-amber-400 font-bold' : ''}`}>
                    {num(a.metrics.openCases)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">{pct(a.metrics.handoverRatePercent)}</td>
                  <td className="px-3 py-3 text-right">
                    {a.inService ? (
                      <button
                        onClick={() => suspend(a)}
                        disabled={busyId === a.id}
                        className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold border border-rose-200 dark:border-rose-900/60 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50"
                      >
                        Suspend
                      </button>
                    ) : (
                      <button
                        onClick={() => reinstate(a)}
                        disabled={busyId === a.id}
                        className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold border border-emerald-200 dark:border-emerald-900/60 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 disabled:opacity-50"
                      >
                        Reinstate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {!loading && tab === 'audit' && (
        <section className="rounded-2xl border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
          <div className="px-4 py-3 bg-slate-50 dark:bg-slate-900/60">
            <p className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
              Append-only. This console cannot edit the record of its own actions.
            </p>
          </div>
          {audit.length === 0 && (
            <p className="px-4 py-10 text-center text-xs text-slate-500">Nothing recorded yet.</p>
          )}
          {audit.map((e) => (
            <div key={e.id} className="px-4 py-3 text-xs">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-bold text-slate-900 dark:text-white">{e.action}</span>
                <span className="text-[10px] text-slate-400">
                  {new Date(e.createdAt).toLocaleString('en-NG')}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                {e.targetType} {e.targetId.slice(0, 8)} · by {e.actor.slice(0, 8)}
                {e.newValue?.reason ? ` · "${e.newValue.reason}"` : ''}
              </p>
            </div>
          ))}
        </section>
      )}

      {showCreate && (
        <CreateAgencyDialog
          onClose={() => setShowCreate(false)}
          onCreated={async () => { setShowCreate(false); await load(); }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, icon, tone }: { label: string; value: string; icon: React.ReactNode; tone?: 'warn' }) {
  return (
    <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <div className="flex items-center gap-2 text-slate-400">
        {icon}
        <span className="text-[10px] uppercase tracking-wider font-bold">{label}</span>
      </div>
      <p className={`mt-2 text-xl font-black tabular-nums ${tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-900 dark:text-white'}`}>
        {value}
      </p>
    </div>
  );
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

const CATEGORIES = [
  'GOVERNMENT', 'HOSPITAL', 'CLINIC', 'SCHOOL', 'UNIVERSITY',
  'BANK', 'INSURANCE', 'LOGISTICS', 'REAL_ESTATE', 'OTHER',
];

function CreateAgencyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('GOVERNMENT');
  const [ownerFullName, setOwnerFullName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      await api.platform.createAgency({
        name: name.trim(),
        category,
        ownerFullName: ownerFullName.trim(),
        ownerEmail: ownerEmail.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      });
      onCreated();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-white">Onboard an agency</h2>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
            The owner is sent an invitation link to set their own password. Nobody — including this
            console — ever sees their credentials.
          </p>
        </div>

        {err && (
          <p className="text-[11px] text-rose-600 dark:text-rose-400 p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/30">
            {err}
          </p>
        )}

        <Field label="Agency name" value={name} onChange={setName} placeholder="Ministry of Works and Transport" required />
        <div>
          <label className="block text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-1.5">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full px-3 py-2.5 rounded-xl text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <Field label="Owner full name" value={ownerFullName} onChange={setOwnerFullName} placeholder="Permanent Secretary" required />
        <Field label="Owner email" value={ownerEmail} onChange={setOwnerEmail} placeholder="ps@works.plateaustate.gov.ng" type="email" required />
        <Field label="Public phone (optional)" value={phone} onChange={setPhone} placeholder="+2348031234567" />

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
            {saving ? 'Creating…' : 'Create agency'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, type = 'text', required,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; required?: boolean;
}) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2.5 rounded-xl text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400"
      />
    </div>
  );
}
