"use client";
/**
 * Operational analytics — what customers ask for, why threads reach a human,
 * when demand arrives, and where the work is.
 *
 * Design notes (dataviz method, applied):
 *  - Series colors are the validated reference palette, re-validated against
 *    THIS app's real surfaces (white / #0f172a). Light mode carries contrast
 *    WARNs on aqua/yellow/magenta, so the relief rule applies everywhere:
 *    every chart ships visible value labels AND a table view toggle.
 *  - Categorical hues are assigned in fixed slot order, never cycled; ranked
 *    bars (intents, reasons, services) encode MAGNITUDE, so they stay one hue.
 *  - One axis per chart. Ticket priorities are status colors with icon+label,
 *    never bare color.
 *  - The shell's dark mode is a manual toggle in localStorage('ace_theme') and
 *    no `dark` class ever reaches <html>, so `dark:` variants are inert in this
 *    app. Tokens are resolved in JS from the same source the shell uses; the
 *    layout re-renders children on toggle, which re-reads it.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { authFetch } from '@/lib/api';
import {
  BarChart3, Loader2, AlertCircle, Table2, LineChart as LineChartIcon,
  AlertTriangle, ArrowUp, Minus, CheckCircle2,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, LabelList, Cell,
} from 'recharts';

type Period = '7d' | '30d' | '90d';

interface Insights {
  period: Period;
  since: string;
  volumeTrend: Array<{ date: string; customerMessages: number; aiMessages: number; calls: number; bookings: number }>;
  intentDistribution: Array<{ intent: string; count: number }>;
  handoffReasons: Array<{ reason: string; count: number }>;
  hourlyDemand: Array<{ hour: number; messages: number; calls: number }>;
  bookingFunnel: {
    byStatus: Array<{ status: string; count: number }>;
    topServices: Array<{ serviceName: string; count: number }>;
    upcomingWeek: Array<{ date: string; count: number }>;
  };
  ticketFlow: {
    opened: number; resolved: number;
    openByPriority: Array<{ priority: string; count: number }>;
    refundRequests: number;
  };
  languages: Array<{ language: string; count: number }>;
  callsNotConnected: number;
}

/** Validated palette (reference instance), stepped per mode for our surfaces. */
const TOKENS = {
  light: {
    surface: '#ffffff', page: '#f8fafc',
    ink: '#0b0b0b', inkSecondary: '#52514e', muted: '#898781',
    grid: '#e1e0d9', axis: '#c3c2b7',
    s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', s4: '#eda100', s5: '#e87ba4', s6: '#008300',
    status: { critical: '#d03b3b', serious: '#ec835a', warning: '#fab219', good: '#0ca30c' },
  },
  dark: {
    surface: '#0f172a', page: '#0b0f19',
    ink: '#ffffff', inkSecondary: '#c3c2b7', muted: '#898781',
    grid: '#2c2c2a', axis: '#383835',
    s1: '#3987e5', s2: '#d95926', s3: '#199e70', s4: '#c98500', s5: '#d55181', s6: '#008300',
    status: { critical: '#d03b3b', serious: '#ec835a', warning: '#fab219', good: '#0ca30c' },
  },
};

const HUMAN_INTENTS: Record<string, string> = {
  BOOK_APPOINTMENT: 'Book appointment', CHECK_BOOKING_STATUS: 'Check booking',
  CANCEL_BOOKING: 'Cancel booking', RESCHEDULE_BOOKING: 'Reschedule',
  MANAGE_RESERVATION: 'Reservation', REQUEST_REFUND: 'Refund request',
  REQUEST_QUOTATION: 'Price / quote', CREATE_TICKET: 'Complaint / issue',
  PROVIDE_PAYMENT_GUIDANCE: 'How to pay', HUMAN_HANDOFF: 'Asked for a person',
  HUMAN_HANDOFF_ACTIVE: 'Waiting on staff', AI_DISCLOSURE: '"Are you a bot?"',
  GENERAL_INQUIRY: 'General question', REQUEST_SELFIE: 'Selfie / verification',
  EMPTY_MESSAGE: 'Empty message',
};

const HUMAN_REASONS: Record<string, string> = {
  CUSTOMER_REQUEST: 'Customer asked for a person', TOOL_FAILURE: 'A tool failed',
  LOW_CONFIDENCE: 'AI was unsure', SENTIMENT: 'Customer upset', UNSPECIFIED: 'Not recorded',
};

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', pcm: 'Nigerian Pidgin', ha: 'Hausa', ig: 'Igbo', yo: 'Yoruba', unknown: 'Not yet known',
};

export default function AnalyticsPage() {
  // Same source of truth as the shell; the shell re-renders us when it flips.
  const theme = typeof window !== 'undefined'
    ? ((localStorage.getItem('ace_theme') as 'light' | 'dark') ?? 'dark')
    : 'dark';
  const T = TOKENS[theme];

  const [period, setPeriod] = useState<Period>('7d');
  const [data, setData] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (p: Period) => {
    setLoading(true);
    setError(null);
    try {
      setData(await authFetch(`/api/analytics/insights?period=${p}`));
    } catch (e: any) {
      setError(e?.message || 'Could not load analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(period); }, [period, load]);

  const card = `rounded-2xl border shadow-sm ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`;
  const heading = theme === 'dark' ? 'text-white' : 'text-slate-900';
  const sub = theme === 'dark' ? 'text-slate-400' : 'text-slate-500';

  const axisProps = {
    stroke: T.axis, tick: { fill: T.muted, fontSize: 11 }, tickLine: false, axisLine: { stroke: T.axis },
  } as const;
  const tooltipStyle = {
    backgroundColor: T.surface, border: `1px solid ${T.grid}`, borderRadius: 8,
    color: T.ink, fontSize: 12,
  } as const;

  const trendRows = useMemo(() => (data?.volumeTrend ?? []).map((d) => ({
    ...d, label: d.date.slice(5),
  })), [data]);

  if (loading && !data) {
    return <div className="flex items-center justify-center py-24"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>;
  }
  if (error && !data) {
    return (
      <div className={`${card} p-6 flex items-center gap-3 max-w-xl`}>
        <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
        <div><p className={`font-semibold ${heading}`}>Analytics unavailable</p><p className={`text-sm ${sub}`}>{error}</p></div>
      </div>
    );
  }
  if (!data) return null;

  const totalHandoffs = data.handoffReasons.reduce((s, r) => s + r.count, 0);
  const sinceDate = new Date(data.since).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className={`text-2xl font-bold flex items-center gap-2 ${heading}`}>
            <BarChart3 className="w-6 h-6 text-blue-500" /> Analytics
          </h1>
          <p className={`text-sm mt-1 ${sub}`}>What customers ask for, why threads reach your team, and when the demand arrives.</p>
        </div>
        {/* Filter row — presets, one row above the charts */}
        <div className={`flex gap-1 p-1 rounded-xl border ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
          {(['7d', '30d', '90d'] as Period[]).map((p) => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all ${
                period === p ? 'bg-blue-600 text-white' : `${sub} hover:opacity-80`}`}>
              {p === '7d' ? 'Last 7 days' : p === '30d' ? 'Last 30 days' : 'Last 90 days'}
            </button>
          ))}
        </div>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile theme={theme} label="Tickets opened" value={data.ticketFlow.opened} note={`since ${sinceDate}`} />
        <StatTile theme={theme} label="Tickets resolved" value={data.ticketFlow.resolved} note={`since ${sinceDate}`} />
        <StatTile theme={theme} label="Refund requests" value={data.ticketFlow.refundRequests} note={`since ${sinceDate}`} />
        <StatTile theme={theme} label="Waiting on a person" value={totalHandoffs} note="open handoffs now" />
      </div>

      {/* Callers who could not be connected.
          Given a row of its own rather than a fifth tile: it is the only figure
          here that counts people the service failed to reach at all, and it is
          the number that decides whether to buy more capacity. A non-zero value
          takes the critical status color WITH the icon and the sentence beside
          it — never color alone. */}
      <div className={`${card} p-5 flex items-center gap-4`}>
        {data.callsNotConnected > 0
          ? <AlertTriangle className="w-6 h-6 shrink-0" style={{ color: T.status.critical }} />
          : <CheckCircle2 className="w-6 h-6 shrink-0" style={{ color: T.status.good }} />}
        <div className="flex-1">
          <p className="text-xs font-medium uppercase tracking-wider" style={{ color: T.muted }}>
            Callers who could not get through
          </p>
          <p className="text-3xl font-bold mt-0.5" style={{ color: data.callsNotConnected > 0 ? T.status.critical : T.ink }}>
            {data.callsNotConnected}
          </p>
          <p className="text-xs mt-0.5" style={{ color: T.inkSecondary }}>
            {data.callsNotConnected > 0
              ? `Since ${sinceDate}. The line was busy or the call could not be answered — usually every concurrent call slot being in use.`
              : `Since ${sinceDate}. Every call that reached the line was answered.`}
          </p>
        </div>
      </div>

      {/* Volume trend */}
      <ChartCard theme={theme} title="Daily volume" desc="Customer messages, AI replies and calls, day by day."
        table={{
          columns: ['Date', 'Customer messages', 'AI replies', 'Calls', 'Bookings'],
          rows: trendRows.map((d) => [d.date, d.customerMessages, d.aiMessages, d.calls, d.bookings]),
        }}>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={trendRows} margin={{ top: 8, right: 16, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={T.grid} vertical={false} />
            <XAxis dataKey="label" {...axisProps} interval="preserveStartEnd" />
            <YAxis {...axisProps} allowDecimals={false} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: T.inkSecondary }} />
            <Legend wrapperStyle={{ fontSize: 12, color: T.inkSecondary }} />
            <Line type="monotone" dataKey="customerMessages" name="Customer messages" stroke={T.s1} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            <Line type="monotone" dataKey="aiMessages" name="AI replies" stroke={T.s2} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            <Line type="monotone" dataKey="calls" name="Calls" stroke={T.s3} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Intent distribution — ranked magnitude, one hue */}
        <ChartCard theme={theme} title="What customers ask for"
          desc={`From the intent recorded on every AI reply since ${sinceDate}.`}
          empty={data.intentDistribution.length === 0
            ? 'No labelled traffic in this period yet — intents are recorded on every AI reply from this release onward.' : undefined}
          table={{
            columns: ['Intent', 'Count'],
            rows: data.intentDistribution.map((i) => [HUMAN_INTENTS[i.intent] ?? i.intent, i.count]),
          }}>
          <RankedBars theme={theme} color={T.s1}
            rows={data.intentDistribution.map((i) => ({ name: HUMAN_INTENTS[i.intent] ?? i.intent, count: i.count }))} />
        </ChartCard>

        {/* Handoff reasons */}
        <ChartCard theme={theme} title="Why threads reach your team"
          desc="Open handoffs right now, by recorded reason."
          empty={data.handoffReasons.length === 0 ? 'No conversations are waiting on a person right now.' : undefined}
          table={{
            columns: ['Reason', 'Open threads'],
            rows: data.handoffReasons.map((r) => [HUMAN_REASONS[r.reason] ?? r.reason, r.count]),
          }}>
          <RankedBars theme={theme} color={T.s2}
            rows={data.handoffReasons.map((r) => ({ name: HUMAN_REASONS[r.reason] ?? r.reason, count: r.count }))} />
        </ChartCard>
      </div>

      {/* Hourly demand */}
      <ChartCard theme={theme} title="When demand arrives" desc="Messages and calls by hour of day (West Africa Time) — staff to the curve."
        table={{
          columns: ['Hour', 'Messages', 'Calls'],
          rows: data.hourlyDemand.map((h) => [`${String(h.hour).padStart(2, '0')}:00`, h.messages, h.calls]),
        }}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data.hourlyDemand} margin={{ top: 8, right: 16, bottom: 0, left: -18 }} barGap={2}>
            <CartesianGrid stroke={T.grid} vertical={false} />
            <XAxis dataKey="hour" {...axisProps} tickFormatter={(h: number) => `${h}h`} interval={2} />
            <YAxis {...axisProps} allowDecimals={false} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(h) => `${String(h).padStart(2, '0')}:00 WAT`} labelStyle={{ color: T.inkSecondary }} />
            <Legend wrapperStyle={{ fontSize: 12, color: T.inkSecondary }} />
            <Bar dataKey="messages" name="Messages" fill={T.s1} radius={[4, 4, 0, 0]} maxBarSize={14} />
            <Bar dataKey="calls" name="Calls" fill={T.s2} radius={[4, 4, 0, 0]} maxBarSize={14} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Booking week ahead */}
        <ChartCard theme={theme} title="Appointments this week" desc="Confirmed bookings for the next seven days."
          table={{ columns: ['Date', 'Bookings'], rows: data.bookingFunnel.upcomingWeek.map((d) => [d.date, d.count]) }}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data.bookingFunnel.upcomingWeek.map((d) => ({ ...d, label: d.date.slice(5) }))}
              margin={{ top: 18, right: 16, bottom: 0, left: -18 }}>
              <CartesianGrid stroke={T.grid} vertical={false} />
              <XAxis dataKey="label" {...axisProps} />
              <YAxis {...axisProps} allowDecimals={false} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: T.inkSecondary }} />
              <Bar dataKey="count" name="Bookings" fill={T.s1} radius={[4, 4, 0, 0]} maxBarSize={26}>
                <LabelList dataKey="count" position="top" style={{ fill: T.inkSecondary, fontSize: 11 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Top services */}
        <ChartCard theme={theme} title="Most-booked services" desc={`Bookings by service since ${sinceDate}.`}
          empty={data.bookingFunnel.topServices.length === 0 ? 'No bookings in this period yet.' : undefined}
          table={{ columns: ['Service', 'Bookings'], rows: data.bookingFunnel.topServices.map((s) => [s.serviceName, s.count]) }}>
          <RankedBars theme={theme} color={T.s3}
            rows={data.bookingFunnel.topServices.map((s) => ({ name: s.serviceName, count: s.count }))} />
        </ChartCard>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Open tickets by priority — status colors, icon + label, never color alone */}
        <div className={`${card} p-5`}>
          <h3 className={`font-semibold ${heading}`}>Open tickets by priority</h3>
          <p className={`text-xs mt-0.5 mb-4 ${sub}`}>Everything currently waiting, most urgent first.</p>
          {data.ticketFlow.openByPriority.length === 0 ? (
            <p className={`text-sm py-6 text-center ${sub}`}>Nothing open. Clear queue.</p>
          ) : (
            <ul className="space-y-2.5">
              {data.ticketFlow.openByPriority.map((p) => {
                const style = {
                  URGENT: { color: T.status.critical, Icon: AlertTriangle, label: 'Urgent' },
                  HIGH: { color: T.status.serious, Icon: ArrowUp, label: 'High' },
                  MEDIUM: { color: T.status.warning, Icon: Minus, label: 'Medium' },
                  LOW: { color: T.status.good, Icon: CheckCircle2, label: 'Low' },
                }[p.priority] ?? { color: T.muted, Icon: Minus, label: p.priority };
                const max = Math.max(...data.ticketFlow.openByPriority.map((x) => x.count), 1);
                return (
                  <li key={p.priority} className="flex items-center gap-3">
                    <style.Icon className="w-4 h-4 shrink-0" style={{ color: style.color }} />
                    <span className={`w-16 text-sm ${heading}`}>{style.label}</span>
                    <div className="flex-1 h-4 rounded-[4px] overflow-hidden" style={{ background: T.grid }}>
                      <div className="h-full rounded-[4px]" style={{ width: `${(p.count / max) * 100}%`, background: style.color }} />
                    </div>
                    <span className={`w-8 text-right text-sm font-semibold tabular-nums ${heading}`}>{p.count}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Languages — identity. Color follows the ENTITY, never its rank: each
            language owns a fixed slot, so re-ordering between periods cannot
            repaint Hausa. "Not yet known" is an absence, not a language, and
            wears muted ink rather than a series hue. */}
        <ChartCard theme={theme} title="Languages your customers prefer"
          desc='Learned from their own messages. "Not yet known" is honest, never guessed.'
          empty={data.languages.length === 0 ? 'No contacts yet.' : undefined}
          table={{ columns: ['Language', 'Contacts'], rows: data.languages.map((l) => [LANGUAGE_NAMES[l.language] ?? l.language, l.count]) }}>
          <RankedBars theme={theme}
            colorOf={(row) => ({
              English: T.s1, 'Nigerian Pidgin': T.s2, Hausa: T.s3, Igbo: T.s4, Yoruba: T.s5,
            } as Record<string, string>)[row.name] ?? T.muted}
            rows={data.languages.map((l) => ({ name: LANGUAGE_NAMES[l.language] ?? l.language, count: l.count }))} />
        </ChartCard>
      </div>
    </div>
  );
}

function StatTile({ theme, label, value, note }: { theme: 'light' | 'dark'; label: string; value: number; note: string }) {
  const T = TOKENS[theme];
  return (
    <div className={`rounded-2xl border shadow-sm p-4 ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
      <p className="text-xs font-medium uppercase tracking-wider" style={{ color: T.muted }}>{label}</p>
      <p className="text-3xl font-bold mt-1" style={{ color: T.ink }}>{value}</p>
      <p className="text-xs mt-0.5" style={{ color: T.inkSecondary }}>{note}</p>
    </div>
  );
}

/**
 * One chart section: title, description, a chart↔table toggle (the relief the
 * light-mode contrast WARNs obligate), and an honest empty state.
 */
function ChartCard({ theme, title, desc, children, table, empty }: {
  theme: 'light' | 'dark'; title: string; desc: string; children: React.ReactNode;
  table: { columns: string[]; rows: Array<Array<string | number>> }; empty?: string;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const T = TOKENS[theme];
  const heading = theme === 'dark' ? 'text-white' : 'text-slate-900';
  const sub = theme === 'dark' ? 'text-slate-400' : 'text-slate-500';
  return (
    <div className={`rounded-2xl border shadow-sm p-5 ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className={`font-semibold ${heading}`}>{title}</h3>
          <p className={`text-xs mt-0.5 ${sub}`}>{desc}</p>
        </div>
        {!empty && (
          <button onClick={() => setView(view === 'chart' ? 'table' : 'chart')}
            aria-label={view === 'chart' ? 'Show as table' : 'Show as chart'}
            className={`p-1.5 rounded-lg border transition-all ${theme === 'dark' ? 'border-slate-700 text-slate-400 hover:text-white' : 'border-slate-200 text-slate-500 hover:text-slate-900'}`}>
            {view === 'chart' ? <Table2 className="w-4 h-4" /> : <LineChartIcon className="w-4 h-4" />}
          </button>
        )}
      </div>
      {empty ? (
        <p className={`text-sm py-8 text-center ${sub}`}>{empty}</p>
      ) : view === 'chart' ? children : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>{table.columns.map((c) => (
                <th key={c} className="text-left py-1.5 pr-4 text-xs font-semibold uppercase tracking-wider" style={{ color: T.muted }}>{c}</th>
              ))}</tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${T.grid}` }}>
                  {row.map((cell, j) => (
                    <td key={j} className={`py-1.5 pr-4 ${j > 0 ? 'tabular-nums' : ''}`} style={{ color: T.ink }}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Ranked horizontal bars for magnitude-across-categories: one hue unless the
 * job is identity (pass `colors` for fixed-order categorical assignment).
 * Values are always directly labelled — the relief rule, and just better.
 */
function RankedBars({ theme, rows, color, colorOf }: {
  theme: 'light' | 'dark';
  rows: Array<{ name: string; count: number }>;
  color?: string;
  /** Entity-fixed color assignment for identity encodings. */
  colorOf?: (row: { name: string; count: number }) => string;
}) {
  const T = TOKENS[theme];
  const height = Math.max(rows.length * 34 + 8, 60);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 36, bottom: 0, left: 8 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="name" width={168}
          tick={{ fill: T.inkSecondary, fontSize: 12 }} tickLine={false} axisLine={false} />
        <Tooltip cursor={{ fill: T.grid, opacity: 0.35 }}
          contentStyle={{ backgroundColor: T.surface, border: `1px solid ${T.grid}`, borderRadius: 8, color: T.ink, fontSize: 12 }} />
        <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={16}>
          {rows.map((row, i) => (
            <Cell key={i} fill={colorOf ? colorOf(row) : (color ?? T.s1)} />
          ))}
          <LabelList dataKey="count" position="right" style={{ fill: T.inkSecondary, fontSize: 11 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
