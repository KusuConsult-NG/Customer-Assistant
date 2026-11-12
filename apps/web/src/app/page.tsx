"use client";
import React, { useEffect, useState } from 'react';
import { api, API_URL } from '@/lib/api';
import {
  Users, MessageSquareText, PhoneCall, BookOpen,
  TrendingUp, Activity, Clock, CheckCircle2, Bot,
  ArrowRight, Zap, DollarSign, BarChart3, RefreshCw, Sparkles, Layers, Phone,
  ArrowUpRight, AlertTriangle
} from 'lucide-react';
import Link from 'next/link';

/**
 * `null` means NOT KNOWN, and it is not interchangeable with 0.
 *
 * Every figure here used to be a plain number that defaulted to 0, and every
 * request behind it ends in `.catch(() => null)` with an 8s abort. So an API
 * that was down, a bad token, or a slow cold start rendered "0 citizens, 0
 * calls, 0 open tickets" to an officer as the state of their agency — the
 * same class of fabrication as the scheduling screen's empty state on a
 * failed load. Unknown figures render as "—" and the page says why.
 */
interface Stats {
  contacts: number | null;
  leads: number | null;
  calls: number | null;
  docs: number | null;
  pipelineValue: number | null;
  conversionRate: number | null;
  conversations: number | null;
  bookings: number | null;
  reservations: number | null;
  openTickets: number | null;
}

interface Activity {
  id: string;
  type: 'call' | 'message' | 'contact' | 'booking';
  title: string;
  subtitle: string;
  time: string;
  status?: string;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats>({
    contacts: null,
    leads: null,
    calls: null,
    docs: null,
    pipelineValue: null,
    conversionRate: null,
    conversations: null,
    bookings: null,
    reservations: null,
    openTickets: null,
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [callsUnavailable, setCallsUnavailable] = useState(false);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  // Starts true: with it false the stat cards rendered real-looking zeros before any
  // request had returned, so a populated account briefly read as an empty one.
  const [loading, setLoading] = useState(true);
  const [orgName, setOrgName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [timeRange, setTimeRange] = useState<'7d' | '30d' | '90d'>('7d');
  const [dashboardData, setDashboardData] = useState<any>(null);

  const fetchAll = async (attempt = 0) => {
    const token = localStorage.getItem('ace_token');
    if (!token) { setLoading(false); return; }
    setLoading(true);

    // 45 seconds, not 8. The API runs on a host that puts it to sleep when
    // idle, and waking it takes longer than eight seconds — so the FIRST visit
    // after a quiet spell aborted every request and the page reported "figures
    // unavailable" for an API that was healthy and simply starting.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    let dashboardStatus: number | 'unreachable' | null = null;

    const safeFetch = (url: string, opts: RequestInit = {}) =>
      fetch(url, { ...opts, signal: controller.signal })
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);
    const dashboardFetch = (url: string, opts: RequestInit = {}) =>
      fetch(url, { ...opts, signal: controller.signal })
        .then(r => { dashboardStatus = r.status; return r.ok ? r.json() : null; })
        .catch(() => { dashboardStatus = 'unreachable'; return null; });

    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };

      // The contacts and deals lists used to be fetched here too, purely as
      // fallbacks for `m.totalContacts` and the money card. Both were wrong —
      // a list endpoint returns one page, not an agency total — so both the
      // fallbacks and the two round trips behind them are gone.
      const [leadsRes, docsRes, callsRes, orgRes, dashboardRes] = await Promise.allSettled([
        api.crm.getLeads().catch(() => null),
        api.knowledge.getDocuments().catch(() => null),
        api.telephony.getCallLogs().catch(() => null),
        safeFetch(`${API_URL}/api/organizations/me`, { headers }),
        dashboardFetch(`${API_URL}/api/analytics/dashboard?period=${timeRange}`, { headers }),
      ]);

      clearTimeout(timeout);

      const toArray = (val: any) => {
        if (!val) return [];
        if (Array.isArray(val)) return val;
        if (Array.isArray(val.contacts)) return val.contacts;
        if (Array.isArray(val.leads)) return val.leads;
        if (Array.isArray(val.deals)) return val.deals;
        if (Array.isArray(val.tickets)) return val.tickets;
        if (Array.isArray(val.documents)) return val.documents;
        if (Array.isArray(val.calls)) return val.calls;
        if (Array.isArray(val.data)) return val.data;
        return [];
      };

      const leads = leadsRes.status === 'fulfilled' ? toArray(leadsRes.value) : [];
      const docs = docsRes.status === 'fulfilled' ? toArray(docsRes.value) : [];
      const calls = callsRes.status === 'fulfilled' ? toArray(callsRes.value) : [];
      const dashboard = dashboardRes.status === 'fulfilled' ? (dashboardRes.value || null) : null;

      if (dashboard) setDashboardData(dashboard);

      // The analytics endpoint nests its numbers under `metrics`.
      //
      // Every read here used to be `dashboard?.totalContacts` etc. against the
      // top-level object, which is always undefined — so conversations, bookings,
      // reservations and openTickets fell back to a hardcoded 0 and the rest silently
      // reverted to counting whatever the CRM list endpoints happened to return
      // (capped at one page). The whole dashboard displayed wrong figures.
      const m = dashboard?.metrics ?? {};

      // The dashboard call is the only source that counts the whole agency; the
      // CRM list calls are capped at one page. If it did not answer, nothing on
      // this page is known, and the page says so rather than showing zeros.
      if (!dashboard) {
        // Say WHY. An expired session, a server still waking and a real fault
        // each need a different response from the officer looking at this.
        if (dashboardStatus === 401) {
          setLoadError('Your session has expired. Sign in again to see the current figures.');
        } else if (dashboardStatus === 'unreachable' && attempt === 0) {
          // Most often the server waking up: try once more before reporting.
          setLoadError('The server is starting up. Trying again…');
          setTimeout(() => void fetchAll(1), 3_000);
          return;
        } else {
          setLoadError(
            dashboardStatus === 'unreachable'
              ? 'The server did not answer, so none of the numbers below are current.'
              : `The dashboard figures could not be loaded (error ${dashboardStatus}), so none of the numbers below are current.`
          );
        }
      } else {
        setLoadError(null);
      }
      setUnavailable(Array.isArray(dashboard?.unavailable) ? dashboard.unavailable : []);

      // A count is only reportable if the API returned one. `?? contacts.length`
      // would substitute one page of a list for an agency-wide total.
      const count = (v: unknown): number | null => (typeof v === 'number' ? v : null);

      // No invented default. This used to fall back to a hardcoded 68%, so a brand
      // new account with no leads at all was shown a 68% conversion rate. It is
      // null, not 0, when the leads list itself did not load.
      const convRate =
        leadsRes.status !== 'fulfilled' || leadsRes.value === null
          ? null
          : leads.length > 0
            ? Math.round((leads.filter((l: any) => l.status === 'CONVERTED').length / leads.length) * 100)
            : 0;

      setStats({
        contacts: count(m.totalContacts),
        leads: count(m.totalLeads),
        calls: count(m.totalCalls),
        docs: docsRes.status === 'fulfilled' && docsRes.value !== null ? docs.length : null,
        pipelineValue: count(m.pipelineValue),
        conversionRate: convRate,
        conversations: count(m.totalConversations),
        bookings: count(m.totalBookings),
        reservations: count(m.totalReservations),
        openTickets: count(m.openTickets),
      });

      if (orgRes.status === 'fulfilled' && orgRes.value?.name) {
        setOrgName(orgRes.value.name);
      }

      // The signed-in user's own name, from the session the login flow stored.
      try {
        const u = JSON.parse(localStorage.getItem('ace_user') || 'null');
        if (u?.fullName) setFirstName(String(u.fullName).split(' ')[0]);
      } catch { /* a malformed session is not worth failing the dashboard over */ }

      const recentActivities: Activity[] = [];
      calls.slice(0, 4).forEach((c: any) => {
        recentActivities.push({
          id: c.id,
          type: 'call',
          title: `Voice call ${c.status === 'COMPLETED' ? 'completed' : 'ended'}`,
          // A call log with no number is a WITHHELD caller, which is a fact
          // worth showing. "From Customer" said nothing and read like a name.
          subtitle: `From ${c.fromNumber || 'a withheld number'} · ${Math.round((c.durationSeconds || 0) / 60)}m ${(c.durationSeconds || 0) % 60}s`,
          // CallLog has startedAt, not createdAt — reading createdAt made every row
          // display the literal string "Recently".
          time: c.startedAt ? new Date(c.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Recently',
          status: c.status,
        });
      });
      setCallsUnavailable(callsRes.status !== 'fulfilled' || callsRes.value === null);
      setActivities(recentActivities);
    } catch (err: any) {
      console.error('Failed to load dashboard stats', err);
      setLoadError(err?.message || 'The dashboard could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, [timeRange]);

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  /** An unknown figure is a dash. It is never a zero. */
  const num = (v: number | null) => (v === null ? '—' : v.toLocaleString());

  type WeeklyDataPoint = { day: string; whatsapp: number; voice: number; web: number };

  /**
   * The per-day series, each from the channel it claims to be.
   *
   * The chart draws three legends — WhatsApp, Voice AI, WebChat — and used to
   * plot the API's single undifferentiated conversation count under the
   * WhatsApp one, with WebChat hardcoded to `web: 0`. So a WEBCHAT thread
   * appeared as a WhatsApp message and the legend asserted a split the
   * payload never carried. The API now returns the three series separately.
   */
  const raw = dashboardData?.weeklyData;
  // null (not an empty array) is the API saying it could not read the week.
  const trendUnavailable = !!raw && raw.conversations === null && raw.calls === null;
  const weeklyData: WeeklyDataPoint[] = (() => {
    if (!raw?.labels || !Array.isArray(raw.labels) || trendUnavailable) return [];
    return (raw.labels as string[]).map((label: string, i: number) => ({
      day: label,
      whatsapp: (raw.whatsapp as number[] | null)?.[i] ?? 0,
      voice: (raw.calls as number[] | null)?.[i] ?? 0,
      web: (raw.webchat as number[] | null)?.[i] ?? 0,
    }));
    // The old fallback spread all-time totals evenly across seven days and
    // drew it as history, so an account with 70 conversations was shown a
    // flat "10 per day" week that never happened.
  })();

  // Math.max(...[]) is -Infinity, which turns every bar height into -0.
  const maxVal = weeklyData.length
    ? Math.max(...weeklyData.map((d: WeeklyDataPoint) => Math.max(d.whatsapp, d.voice, 1)))
    : 1;
  // A week of real-but-all-zero days is still nothing to look at. The API
  // returns seven labelled days from the moment an account exists, so the
  // "no activity" message never appeared — a new operator saw an axis with
  // seven invisible bars and no explanation of why the chart looked broken.
  const hasChartActivity = weeklyData.some(
    (d: WeeklyDataPoint) => d.whatsapp > 0 || d.voice > 0
  );
  // Use the value the API computes (resolved tickets / total tickets) rather than
  // deriving one from conversations minus open tickets — two unrelated populations,
  // which could produce a negative percentage when tickets outnumbered conversations.
  const aiResolutionRate: number | null = dashboardData?.aiMetrics?.resolutionRate ?? null;
  const aiReplyRate: number | null = dashboardData?.aiMetrics?.aiReplyRate ?? null;
  // Handover rate is measured independently by the API; it is NOT 100 minus the
  // resolution rate — those are different populations (conversations vs tickets),
  // and subtracting one from the other produced a meaningless, sometimes negative,
  // percentage.
  const handoverRate: number | null = dashboardData?.aiMetrics?.handoverRate ?? null;

  if (loading) {
    return (
      <div className="space-y-6 max-w-7xl pb-12 animate-pulse">
        <div className="h-28 rounded-2xl bg-slate-200 dark:bg-slate-800" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <div key={i} className="h-32 rounded-2xl bg-slate-200 dark:bg-slate-800" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-64 rounded-2xl bg-slate-200 dark:bg-slate-800" />
          <div className="h-64 rounded-2xl bg-slate-200 dark:bg-slate-800" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl pb-12">
      {/* Nothing loaded, or part of it did not. Either way the page says so
          instead of presenting its defaults as the agency's figures. */}
      {(loadError || unavailable.length > 0) && (
        <div className="flex items-start gap-3 p-4 rounded-2xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10">
          <AlertTriangle className="w-5 h-5 shrink-0 text-amber-700 dark:text-amber-400 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-amber-900 dark:text-amber-200">
              {loadError ? 'Dashboard figures unavailable' : 'Some figures could not be read'}
            </p>
            <p className="text-xs text-amber-800 dark:text-amber-300/90 mt-0.5">
              {loadError ?? `Shown as "—": ${unavailable.join(', ')}. Everything else on this page is current.`}
            </p>
            <button
              onClick={() => void fetchAll()}
              className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-amber-400 dark:border-amber-500/50 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-500/15"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        </div>
      )}

      {/* Top Welcome Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6 rounded-2xl bg-gradient-to-r from-brand-500/10 via-brand-600/10 to-brand-500/5 border border-brand-500/30 dark:border-brand-500/20 shadow-sm">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold text-brand-700 dark:text-brand-300 mb-1 uppercase tracking-wider">
            <Sparkles className="w-3.5 h-3.5" /> Service Dashboard
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900 dark:text-white tracking-tight">
            {firstName ? `Welcome back, ${firstName}` : 'Welcome back'} 👋
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            {orgName ? `${orgName} \u2014 ` : ''}Plateau State Government &bull; {today}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-slate-200/70 dark:bg-slate-800/60 p-1 rounded-xl">
            <button onClick={() => setTimeRange('7d')} className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${timeRange === '7d' ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'}`}>7d</button>
            <button onClick={() => setTimeRange('30d')} className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${timeRange === '30d' ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'}`}>30d</button>
            <button onClick={() => setTimeRange('90d')} className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${timeRange === '90d' ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'}`}>90d</button>
          </div>
          <button
            onClick={() => void fetchAll()}
            className="p-2.5 rounded-xl bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/60 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors shadow-sm"
            title="Refresh Data"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <Link
            href="/agent-console"
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-white font-semibold transition-all text-sm shadow-md"
            style={{ background: 'linear-gradient(135deg, #3b6102, #4d7d02)' }}
          >
            <Bot className="w-4 h-4 text-white" /> Open Live Console
          </Link>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Total Citizens"
          value={num(stats.contacts)}
          subtitle="Citizens who have contacted the agency"
          icon={<Users className="w-5 h-5 text-brand-700 dark:text-brand-300" />}
          badge={`${timeRange} active`}
          badgeColor="bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20"
        />
        <KpiCard
          title="Open Cases"
          value={num(stats.openTickets)}
          subtitle="Complaints and requests awaiting resolution"
          icon={<Activity className="w-5 h-5 text-purple-700 dark:text-purple-400" />}
          badge="Needs action"
          badgeColor="bg-purple-50 dark:bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-200 dark:border-purple-500/20"
        />
        <KpiCard
          title="Calls"
          value={num(stats.calls)}
          subtitle="Handled by the voice assistant"
          icon={<PhoneCall className="w-5 h-5 text-brand-700 dark:text-brand-300" />}
          badge={`${timeRange} calls`}
          badgeColor="bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20"
        />
        {/* This slot held "Open Pipeline" — the naira value of sales deals —
            and a "conversion rate", both inherited from the commercial CRM
            this platform was built from. A citizen information centre has no
            deals to close; the slot shows the WhatsApp conversations it does
            have. */}
        <KpiCard
          title="Conversations"
          value={num(stats.conversations)}
          subtitle="WhatsApp threads with citizens"
          icon={<MessageSquareText className="w-5 h-5 text-amber-700 dark:text-amber-400" />}
          badge={`${timeRange} threads`}
          badgeColor="bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/20"
        />
      </div>

      {/* Main Analytics Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Channel Volume Chart */}
        <div className="lg:col-span-2 rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800/80 shadow-sm p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-bold text-slate-900 dark:text-white text-base flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-indigo-700 dark:text-indigo-400" />
                Conversation Volume
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">WhatsApp and phone, by day, across 7 days</p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300 font-medium">
                <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" /> WhatsApp
              </span>
              <span className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300 font-medium">
                <span className="w-2.5 h-2.5 rounded-full bg-purple-500" /> Voice AI
              </span>
            </div>
          </div>

          {/* Bar chart grid */}
          <div className="h-56 flex items-end justify-between gap-3 pt-6 px-2 border-b border-slate-200 dark:border-slate-800/60">
            {!hasChartActivity && (
              <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-center">
                <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                  {trendUnavailable || loadError
                    ? 'This week could not be loaded'
                    : 'No conversations in this period yet'}
                </p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 max-w-xs">
                  {trendUnavailable || loadError
                    ? 'The figures for these days are unknown, not zero.'
                    : 'Volume appears here once customers reach you on WhatsApp or by phone.'}
                </p>
              </div>
            )}
            {hasChartActivity && weeklyData.map((d: any, idx: number) => (
              <div key={idx} className="flex-1 flex flex-col items-center gap-2 h-full justify-end group">
                <div className="w-full max-w-[36px] flex items-end justify-center gap-1 h-full">
                  <div
                    className="w-1.5 bg-indigo-500 rounded-t-sm transition-all group-hover:bg-indigo-400"
                    style={{ height: `${(d.whatsapp / maxVal) * 100}%` }}
                    title={`WhatsApp: ${d.whatsapp}`}
                  />
                  <div
                    className="w-1.5 bg-purple-500 rounded-t-sm transition-all group-hover:bg-purple-400"
                    style={{ height: `${(d.voice / maxVal) * 100}%` }}
                    title={`Voice AI: ${d.voice}`}
                  />
                </div>
                <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">{d.day}</span>
              </div>
            ))}
          </div>

          {/* Key Channel Summary Stats */}
          <div className="grid grid-cols-3 gap-4 pt-2">
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-800">
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">Total Conversations</p>
              <p className="text-lg font-bold text-indigo-700 dark:text-indigo-400 mt-1">{num(stats.conversations)} threads</p>
            </div>
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-800">
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">Total Voice Calls</p>
              <p className="text-lg font-bold text-purple-700 dark:text-purple-400 mt-1">{num(stats.calls)} calls</p>
            </div>
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-800">
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">Open Tickets</p>
              <p className="text-lg font-bold text-amber-700 dark:text-amber-400 mt-1">{num(stats.openTickets)}</p>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">Awaiting resolution</p>
            </div>
          </div>
        </div>

        {/* AI Performance Gauge & Metrics */}
        <div className="rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800/80 shadow-sm p-6 space-y-6 flex flex-col justify-between">
          <div>
            <h3 className="font-bold text-slate-900 dark:text-white text-base flex items-center gap-2">
              <Zap className="w-5 h-5 text-amber-500" />
              AI Agent Efficiency
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Autonomous resolution & accuracy scores</p>
          </div>

          <div className="space-y-4">
            <ProgressMetric
              label="Ticket Resolution Rate"
              percentage={aiResolutionRate ?? 'N/A'}
              value={aiResolutionRate === null
                ? 'No tickets recorded yet'
                : `${aiResolutionRate}% of support tickets resolved`}
              color="bg-brand-600 dark:bg-brand-500"
            />
            <ProgressMetric
              label="AI Reply Share"
              percentage={aiReplyRate ?? 'N/A'}
              value={aiReplyRate === null
                ? 'No messages recorded yet'
                : `${aiReplyRate}% of all replies handled by the AI assistant`}
              color="bg-brand-600"
            />
            <ProgressMetric
              label="Human Desk Handover Rate"
              percentage={handoverRate ?? 'N/A'}
              value={handoverRate === null
                ? 'No conversations recorded yet'
                : `${handoverRate}% of conversations escalated to a desk officer`}
              color="bg-amber-500"
            />
          </div>

          <div className="p-4 rounded-xl bg-gradient-to-r from-brand-500/10 to-brand-600/10 border border-brand-500/30 dark:border-brand-500/20 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${dashboardData ? 'bg-brand-600 dark:bg-brand-500 animate-ping' : 'bg-amber-500'}`} />
              <div>
                {/* Reflects whether analytics actually loaded. */}
                <p className="text-xs font-bold text-slate-900 dark:text-white">
                  {dashboardData ? 'Analytics: Connected' : 'Analytics: Unavailable'}
                </p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {dashboardData
                    ? `Figures below cover the last ${timeRange === '7d' ? '7 days' : timeRange === '30d' ? '30 days' : '90 days'}.`
                    : 'Could not load analytics — the figures below may be incomplete.'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Secondary Bottom Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Live Activity Timeline */}
        <div className="lg:col-span-2 rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800/80 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800/80 flex items-center justify-between bg-slate-50/50 dark:bg-slate-900/40">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Clock className="w-4 h-4 text-slate-500 dark:text-slate-400" /> Recent Live Activity
            </h3>
            <Link href="/agent-console" className="text-xs text-indigo-700 dark:text-indigo-400 hover:underline flex items-center gap-1 font-semibold">
              View All Conversations <ArrowRight className="w-3 h-3" />
            </Link>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
            {loading ? (
              [1, 2, 3, 4].map(i => (
                <div key={i} className="px-6 py-4 flex gap-3 animate-pulse">
                  <div className="w-9 h-9 rounded-xl bg-slate-200 dark:bg-slate-800 flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 bg-slate-200 dark:bg-slate-800 rounded w-2/3" />
                    <div className="h-2.5 bg-slate-200 dark:bg-slate-800 rounded w-1/2" />
                  </div>
                </div>
              ))
            ) : callsUnavailable ? (
              // A call list that did not load is not an account with no
              // activity. Saying "No activity yet" here, and then offering a
              // setup checklist, tells an officer their agency is empty on the
              // strength of a failed request.
              <div className="px-6 py-10 text-center">
                <AlertTriangle className="w-6 h-6 mx-auto text-amber-600 dark:text-amber-400" />
                <p className="text-sm font-bold text-slate-700 dark:text-slate-300 mt-2">Recent activity unavailable</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  The call and message history could not be loaded. This is not a quiet day — it is unknown.
                </p>
                <button onClick={() => void fetchAll()} className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300">
                  <RefreshCw className="w-3.5 h-3.5" /> Try again
                </button>
              </div>
            ) : activities.length === 0 ? (
              // Previously: "No activity recorded yet. Your AI assistant is active."
              // On an account with no channel connected the assistant is NOT active and
              // never will be, so that sentence was both a dead end and untrue. This
              // shows what is actually missing and links straight to it.
              <div className="px-6 py-10">
                <div className="flex flex-col items-center text-center mb-5">
                  <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 flex items-center justify-center mb-3">
                    <Bot className="w-6 h-6 text-slate-500 dark:text-slate-400" />
                  </div>
                  <p className="text-sm font-bold text-slate-700 dark:text-slate-300">No activity yet</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm">
                    Conversations, calls and bookings appear here as they happen. Finish the steps below and your
                    assistant starts handling them.
                  </p>
                </div>

                <ul className="space-y-2 max-w-md mx-auto">
                  {[
                    { done: (stats.conversations ?? 0) > 0, label: 'Connect WhatsApp so customers can message you', href: '/settings' },
                    { done: (stats.calls ?? 0) > 0, label: 'Point a phone number at the Voice AI', href: '/telephony' },
                    { done: (stats.docs ?? 0) > 0, label: 'Add knowledge so the AI can answer questions', href: '/knowledge' },
                    { done: (stats.contacts ?? 0) > 0, label: 'Import or add your first contacts', href: '/crm' },
                  ].map((step) => (
                    <li key={step.label}>
                      <a
                        href={step.href}
                        className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors ${
                          step.done
                            ? 'border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/60 dark:bg-emerald-500/10'
                            : 'border-slate-200 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-500/40 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                        }`}
                      >
                        <span
                          className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                            step.done
                              ? 'bg-emerald-500 text-white'
                              : 'border border-slate-300 dark:border-slate-600 text-transparent'
                          }`}
                        >
                          ✓
                        </span>
                        <span className={`text-xs flex-1 ${step.done ? 'text-slate-500 dark:text-slate-400 line-through' : 'text-slate-700 dark:text-slate-300 font-medium'}`}>
                          {step.label}
                        </span>
                        {!step.done && <ArrowUpRight className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              activities.map((a) => (
                <div key={a.id} className="px-6 py-4 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-xl flex-shrink-0 flex items-center justify-center ${
                      a.type === 'call' ? 'bg-purple-100 dark:bg-purple-500/15 text-purple-700 dark:text-purple-400' :
                      a.type === 'message' ? 'bg-indigo-100 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-400' :
                      a.type === 'contact' ? 'bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' :
                      'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400'
                    }`}>
                      {a.type === 'call' ? <Phone className="w-4 h-4" /> :
                       a.type === 'message' ? <MessageSquareText className="w-4 h-4" /> :
                       a.type === 'contact' ? <Users className="w-4 h-4" /> :
                       <CheckCircle2 className="w-4 h-4" />}
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-900 dark:text-slate-100">{a.title}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">{a.subtitle}</p>
                    </div>
                  </div>
                  <span className="text-xs text-slate-500 dark:text-slate-400 font-mono font-medium">{a.time}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Quick Launch & System Shortcuts */}
        <div className="rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800/80 shadow-sm p-6 space-y-4">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2 border-b border-slate-200 dark:border-slate-800/80 pb-3">
            <Layers className="w-4 h-4 text-brand-700 dark:text-brand-300" /> Shortcuts
          </h3>

          <div className="space-y-2">
            {[
              { label: 'Agent Console', href: '/agent-console', desc: 'Real-time conversation management', color: 'text-brand-700 dark:text-brand-300' },
              { label: 'Citizen Register', href: '/crm', desc: 'Manage beneficiaries & contacts', color: 'text-brand-700 dark:text-brand-300' },
              { label: 'Knowledge Base', href: '/knowledge', desc: 'Published answers & documents', color: 'text-brand-700 dark:text-brand-300' },
              { label: 'Telephone Service', href: '/telephony', desc: 'Carrier setup & test call', color: 'text-amber-700 dark:text-amber-400' },
              { label: 'Appointments', href: '/scheduling', desc: 'Citizen appointments', color: 'text-brand-700 dark:text-brand-300' },
              { label: 'System Settings', href: '/settings', desc: 'Agency credentials & prompt', color: 'text-slate-600 dark:text-slate-400' },
            ].map(s => (
              <Link
                key={s.href}
                href={s.href}
                className="flex items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all group"
              >
                <div>
                  <p className={`text-xs font-bold ${s.color}`}>{s.label}</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">{s.desc}</p>
                </div>
                <ArrowRight className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 group-hover:text-brand-700 dark:text-brand-300 dark:group-hover:text-white transition-colors" />
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ title, value, subtitle, icon, badge, badgeColor }: any) {
  return (
    <div className="p-5 rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800/80 shadow-sm hover:shadow-md transition-all space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">{title}</span>
        <div className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/50">{icon}</div>
      </div>
      <div>
        <p className="text-2xl font-extrabold text-slate-900 dark:text-white tracking-tight">{value}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-medium">{subtitle}</p>
      </div>
      <div className="pt-2 border-t border-slate-100 dark:border-slate-800/60">
        <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-extrabold border ${badgeColor}`}>{badge}</span>
      </div>
    </div>
  );
}

function ProgressMetric({ label, percentage, value, color }: any) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-bold text-slate-900 dark:text-slate-200">{label}</span>
        <span className="font-extrabold text-slate-900 dark:text-white">{percentage}{percentage !== 'N/A' ? '%' : ''}</span>
      </div>
      <div className="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: percentage === 'N/A' ? '0%' : `${percentage}%` }} />
      </div>
      <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">{value}</p>
    </div>
  );
}
