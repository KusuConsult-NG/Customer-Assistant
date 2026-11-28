"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { API_URL, apiFetch } from '@/lib/api';
import { RoleNotice } from '@/components/RoleNotice';
import { Activity, AlertTriangle, CheckCircle, HardDrive, PhoneCall, RefreshCw, Server, ShieldAlert, Archive } from 'lucide-react';

/** `GET /api/monitoring/status` — see MonitoringService. */
interface HealthStatus {
  checkedAt: string;
  overall: 'ok' | 'warning' | 'critical';
  alerts: Array<{ id: string; severity: 'critical' | 'warning'; title: string; detail: string }>;
  external: { last: { at: string; status: string; detail: any } | null; checks24h: number; failed24h: number; uptime24hPercent: number | null };
  providers: Array<{ id: string; label: string; state: 'ok' | 'failed' | 'not_configured'; detail: string; consequence: string }>;
  voice: { enabled: boolean; ready: boolean; missing: string[]; spitchCircuitOpen: boolean };
  phone: { callsToday: number; failoversLastHour: number; failovers24h: Array<{ reason: string; count: number }>; lastFailover: { at: string; reason: string } | null };
  backup: { last: { at: string; status: string; detail: any } | null };
  disk: { freePercent: number; freeGb: number } | null;
}

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

const REASONS: Record<string, string> = {
  openai_no_credit: 'OpenAI account out of credit',
  openai_rate_limit: 'OpenAI limit too low',
  openai_error: 'OpenAI error',
  spitch: 'Voice (Spitch) failing',
  deepgram: 'Speech recognition (Deepgram) failing',
  speech: 'Voice error',
  not_ready: 'Phone line not ready',
  busy: 'Line full',
  unknown_number: 'Unknown dialled number',
  other: 'Other',
};

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100 mb-3">
        {icon}
        {title}
      </h2>
      <div className="text-sm text-slate-600 dark:text-slate-300 space-y-1.5">{children}</div>
    </section>
  );
}

function Row({ label, value, bad }: { label: string; value: React.ReactNode; bad?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span>{label}</span>
      <span className={bad ? 'font-semibold text-red-600 dark:text-red-400' : 'font-medium text-slate-900 dark:text-slate-100'}>{value}</span>
    </div>
  );
}

export default function SystemHealthPage() {
  const [status, setStatus] = useState<HealthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('ace_token');
      const res = await apiFetch(`${API_URL}/api/monitoring/status`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 403) {
        setError('System health is for owners and administrators.');
      } else if (!res.ok) {
        setError(`System health could not be loaded (the server answered ${res.status}).`);
      } else {
        setStatus(await res.json());
        setError(null);
      }
    } catch {
      // The page is served by the same server it reports on.
      setError('The server could not be reached. If this persists, the outside monitor will have opened a "Production alert" issue on GitHub.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const banner = status
    ? status.overall === 'ok'
      ? { cls: 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/40 dark:border-emerald-900 dark:text-emerald-200', icon: <CheckCircle className="w-5 h-5" />, text: 'Everything checked is working.' }
      : status.overall === 'warning'
        ? { cls: 'bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-950/40 dark:border-amber-900 dark:text-amber-200', icon: <AlertTriangle className="w-5 h-5" />, text: `${status.alerts.length} thing(s) need attention.` }
        : { cls: 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950/40 dark:border-red-900 dark:text-red-200', icon: <ShieldAlert className="w-5 h-5" />, text: `${status.alerts.filter((a) => a.severity === 'critical').length} critical problem(s).` }
    : null;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
      <RoleNotice path="/system-health" />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900 dark:text-white">
            <Activity className="w-5 h-5" /> System Health
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Checked by this server and by the monitor outside it, which opens a GitHub issue when something fails.
            {status && <> Updated {ago(status.checkedAt)}.</>}
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 px-3 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> {loading ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {error && <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 text-red-800 dark:bg-red-950/40 dark:border-red-900 dark:text-red-200 p-4 text-sm">{error}</div>}
      {!status && !error && <div className="text-sm text-slate-500">Checking every service… this takes a few seconds.</div>}

      {status && banner && (
        <>
          <div className={`flex items-center gap-2 rounded-2xl border p-4 text-sm font-semibold ${banner.cls}`}>
            {banner.icon} {banner.text}
          </div>

          {status.alerts.length > 0 && (
            <ul className="space-y-2" aria-label="Alerts">
              {status.alerts.map((a) => (
                <li key={a.id} className={`rounded-xl border p-3 text-sm ${a.severity === 'critical' ? 'border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/30' : 'border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30'}`}>
                  <p className="font-semibold text-slate-900 dark:text-white">{a.severity === 'critical' ? 'Critical' : 'Warning'}: {a.title}</p>
                  {a.detail && <p className="text-slate-600 dark:text-slate-300 mt-0.5">{a.detail}</p>}
                </li>
              ))}
            </ul>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <Card icon={<Server className="w-4 h-4" />} title="Outside monitor">
              {status.external.last ? (
                <>
                  <Row label="Last check" value={`${ago(status.external.last.at)} — ${status.external.last.status === 'ok' ? 'all OK' : 'PROBLEM'}`} bad={status.external.last.status !== 'ok'} />
                  <Row label="Checks in the last 24 h" value={status.external.checks24h} />
                  <Row label="Uptime (24 h)" value={status.external.uptime24hPercent === null ? '—' : `${status.external.uptime24hPercent}%`} bad={(status.external.uptime24hPercent ?? 100) < 99} />
                  {status.external.last.status !== 'ok' && <p className="text-red-600 dark:text-red-400">{String(status.external.last.detail?.summary ?? '')}</p>}
                </>
              ) : (
                <p>Not reporting yet. Alerts still open as GitHub issues; to see the checks here, set MONITOR_TOKEN.</p>
              )}
            </Card>

            <Card icon={<PhoneCall className="w-4 h-4" />} title="Phone line">
              <Row label="Answering calls itself" value={!status.voice.enabled ? 'Off (backup line answers)' : status.voice.ready ? 'Yes' : 'NO'} bad={status.voice.enabled && !status.voice.ready} />
              <Row label="Voice (Spitch)" value={status.voice.spitchCircuitOpen ? 'FAILING' : 'OK'} bad={status.voice.spitchCircuitOpen} />
              <Row label="Calls today" value={status.phone.callsToday} />
              <Row label="Sent to the backup line (last hour)" value={status.phone.failoversLastHour} bad={status.phone.failoversLastHour > 0} />
              {status.phone.failovers24h.length > 0 && (
                <div className="pt-1">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Why, last 24 h</p>
                  {status.phone.failovers24h.map((f) => (
                    <Row key={f.reason} label={REASONS[f.reason] ?? f.reason} value={f.count} />
                  ))}
                </div>
              )}
              {status.phone.lastFailover && <p className="text-xs text-slate-500">Last: {ago(status.phone.lastFailover.at)} — {status.phone.lastFailover.reason}</p>}
            </Card>

            <Card icon={<Archive className="w-4 h-4" />} title="Backups">
              {status.backup.last ? (
                <>
                  <Row label="Last backup" value={`${ago(status.backup.last.at)} — ${status.backup.last.status === 'ok' ? 'OK' : 'FAILED'}`} bad={status.backup.last.status !== 'ok'} />
                  <Row label="Copied off the server" value={status.backup.last.detail?.offsite ? 'Yes' : 'No'} bad={!status.backup.last.detail?.offsite} />
                </>
              ) : (
                <p className="text-red-600 dark:text-red-400">No backup has been recorded.</p>
              )}
            </Card>

            <Card icon={<HardDrive className="w-4 h-4" />} title="Server">
              {status.disk ? (
                <Row label="Disk free (data volume)" value={`${status.disk.freePercent}% (${status.disk.freeGb} GB)`} bad={status.disk.freePercent < 15} />
              ) : (
                <p>Disk space could not be read.</p>
              )}
            </Card>
          </div>

          <Card icon={<Activity className="w-4 h-4" />} title="Providers">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-1.5 pr-3">Service</th>
                  <th className="py-1.5 pr-3">State</th>
                  <th className="py-1.5">What it said</th>
                </tr>
              </thead>
              <tbody>
                {status.providers.map((p) => (
                  <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800 align-top">
                    <td className="py-2 pr-3 font-medium text-slate-900 dark:text-slate-100">{p.label}</td>
                    <td className={`py-2 pr-3 font-semibold ${p.state === 'ok' ? 'text-emerald-700 dark:text-emerald-400' : p.state === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-slate-500'}`}>
                      {p.state === 'ok' ? 'Working' : p.state === 'failed' ? 'Not working' : 'Not set up'}
                    </td>
                    <td className="py-2">{p.detail}{p.state === 'failed' && <span className="block text-xs text-slate-500">{p.consequence}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
