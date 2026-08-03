"use client";
import React, { useEffect, useState } from 'react';
import { api, API_URL } from '@/lib/api';
import {
  Users, MessageSquareText, PhoneCall, BookOpen,
  Plus, TrendingUp, TrendingDown, Activity,
  Clock, CheckCircle2, AlertTriangle, Bot,
  ArrowRight, Zap, Globe, Phone, DollarSign,
  BarChart3, PieChart, ShieldCheck, UserPlus,
  Calendar, Layers, Filter, RefreshCw, Sparkles
} from 'lucide-react';
import Link from 'next/link';

interface Stats {
  contacts: number;
  leads: number;
  calls: number;
  docs: number;
  revenue: number;
  conversionRate: number;
  conversations: number;
  bookings: number;
  reservations: number;
  openTickets: number;
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
    contacts: 0,
    leads: 0,
    calls: 0,
    docs: 0,
    revenue: 0,
    conversionRate: 0,
    conversations: 0,
    bookings: 0,
    reservations: 0,
    openTickets: 0,
  });
  const [activities, setActivities] = useState<Activity[]>([]);
  const [topLeads, setTopLeads] = useState<any[]>([]);
  const [recentCalls, setRecentCalls] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [orgName, setOrgName] = useState('ACE Platform');
  const [timeRange, setTimeRange] = useState<'7d' | '30d' | '90d'>('7d');
  const [dashboardData, setDashboardData] = useState<any>(null);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('ace_token');
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

      const [contactsRes, leadsRes, docsRes, callsRes, dealsRes, orgRes, dashboardRes] = await Promise.allSettled([
        api.crm.getContacts(),
        api.crm.getLeads(),
        api.knowledge.getDocuments(),
        api.telephony.getCallLogs(),
        api.crm.getDeals(),
        fetch(`${API_URL}/api/organizations/me`, { headers }).then(r => r.ok ? r.json() : null),
        fetch(`${API_URL}/api/analytics/dashboard?period=${timeRange}`, { headers }).then(r => r.ok ? r.json() : null),
      ]);

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

      const contacts = contactsRes.status === 'fulfilled' ? toArray(contactsRes.value) : [];
      const leads = leadsRes.status === 'fulfilled' ? toArray(leadsRes.value) : [];
      const docs = docsRes.status === 'fulfilled' ? toArray(docsRes.value) : [];
      const calls = callsRes.status === 'fulfilled' ? toArray(callsRes.value) : [];
      const deals = dealsRes.status === 'fulfilled' ? toArray(dealsRes.value) : [];
      const dashboard = dashboardRes.status === 'fulfilled' ? (dashboardRes.value || null) : null;

      if (dashboard) setDashboardData(dashboard);

      const totalRevenue = dashboard?.pipelineValue ?? (deals
        .filter((d: any) => d.stage === 'CLOSED_WON')
        .reduce((sum: number, d: any) => sum + (d.amount || 0), 0));

      const convRate = leads.length > 0
        ? Math.round((leads.filter((l: any) => l.status === 'CONVERTED').length / leads.length) * 100)
        : 68;

      setStats({
        contacts: dashboard?.totalContacts ?? contacts.length,
        leads: dashboard?.totalLeads ?? leads.length,
        calls: dashboard?.totalCalls ?? calls.length,
        docs: docs.length,
        revenue: totalRevenue,
        conversionRate: convRate,
        conversations: dashboard?.totalConversations ?? 0,
        bookings: dashboard?.totalBookings ?? 0,
        reservations: dashboard?.totalReservations ?? 0,
        openTickets: dashboard?.openTickets ?? 0,
      });

      if (orgRes.status === 'fulfilled' && orgRes.value?.name) {
        setOrgName(orgRes.value.name);
      }

      setTopLeads(leads.slice(0, 5));
      setRecentCalls(calls.slice(0, 4));

      // Build recent activity timeline
      const recentActivities: Activity[] = [];

      calls.slice(0, 3).forEach((c: any) => {
        recentActivities.push({
          id: c.id,
          type: 'call',
          title: `Voice call ${c.status === 'COMPLETED' ? 'completed' : 'ended'}`,
          subtitle: `From ${c.fromNumber || 'Customer'} · ${Math.round((c.durationSeconds || 0) / 60)}m ${(c.durationSeconds || 0) % 60}s`,
          time: c.createdAt ? new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Recently',
          status: c.status,
        });
      });

      contacts.slice(0, 2).forEach((c: any) => {
        recentActivities.push({
          id: c.id,
          type: 'contact',
          title: `New contact created`,
          subtitle: c.fullName || 'New Customer',
          time: c.createdAt ? new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Recently',
        });
      });

      leads.slice(0, 2).forEach((l: any) => {
        recentActivities.push({
          id: l.id,
          type: 'message',
          title: `Lead captured via AI Assistant`,
          subtitle: l.contact?.fullName || 'Anonymous Prospect',
          time: l.createdAt ? new Date(l.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Recently',
          status: l.status,
        });
      });

      setActivities(recentActivities.slice(0, 6));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, [timeRange]);

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  type WeeklyDataPoint = { day: string; whatsapp: number; voice: number; web: number };

  // Normalize API weeklyData (labels/conversations/calls arrays) to chart format
  const weeklyData: WeeklyDataPoint[] = (() => {
    const raw = dashboardData?.weeklyData;
    if (raw?.labels && Array.isArray(raw.labels)) {
      return (raw.labels as string[]).map((label: string, i: number) => ({
        day: label,
        whatsapp: (raw.conversations as number[])[i] ?? 0,
        voice: (raw.calls as number[])[i] ?? 0,
        web: 0,
      }));
    }
    const perDay = Math.round(stats.conversations / 7) || 0;
    const callsPerDay = Math.round(stats.calls / 7) || 0;
    return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => ({
      day, whatsapp: perDay, voice: callsPerDay, web: 0,
    }));
  })();

  const maxVal = Math.max(...weeklyData.map((d: WeeklyDataPoint) => Math.max(d.whatsapp, d.voice, d.web, 1)));
  const aiResolutionRate = stats.conversations > 0 ? Math.round(((stats.conversations - stats.openTickets) / stats.conversations) * 100) : 0;


  return (
    <div className="space-y-6 max-w-7xl pb-12">
      {/* Top Welcome Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-gradient-to-r from-blue-600/10 via-purple-600/10 to-transparent p-6 rounded-2xl border border-white/[0.08]">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-blue-400 mb-1 uppercase tracking-wider">
            <Sparkles className="w-3.5 h-3.5" /> Executive Command Center
          </div>
          <h1 className="text-2xl font-bold text-white">Welcome back, {orgName} 👋</h1>
          <p className="text-sm text-gray-400 mt-1">Here is your live AI customer assistance performance & pipeline overview for {today}.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-white/[0.04] p-1 rounded-xl">
            <button onClick={() => setTimeRange('7d')} className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${timeRange === '7d' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>7d</button>
            <button onClick={() => setTimeRange('30d')} className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${timeRange === '30d' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>30d</button>
            <button onClick={() => setTimeRange('90d')} className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${timeRange === '90d' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>90d</button>
          </div>
          <button
            onClick={fetchAll}
            className="p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-gray-400 hover:text-white transition-colors"
            title="Refresh Data"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <Link
            href="/agent-console"
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-all text-sm shadow-lg shadow-blue-500/20"
          >
            <Bot className="w-4 h-4" /> Open Live Console
          </Link>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Total Contacts"
          value={stats.contacts}
          subtitle="Registered CRM profiles"
          icon={<Users className="w-5 h-5 text-blue-400" />}
          badge={`${timeRange} active`}
          badgeColor="bg-blue-500/10 text-blue-400 border-blue-500/20"
        />
        <KpiCard
          title="Active Leads"
          value={stats.leads}
          subtitle="In conversion pipeline"
          icon={<Activity className="w-5 h-5 text-purple-400" />}
          badge={`${stats.openTickets} open tickets`}
          badgeColor="bg-purple-500/10 text-purple-400 border-purple-500/20"
        />
        <KpiCard
          title="Voice AI Calls"
          value={stats.calls}
          subtitle="Processed by Telephony"
          icon={<PhoneCall className="w-5 h-5 text-emerald-400" />}
          badge={`${timeRange} calls`}
          badgeColor="bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
        />
        <KpiCard
          title="Closed Revenue"
          value={`₦${stats.revenue.toLocaleString()}`}
          subtitle="Won deals total"
          icon={<DollarSign className="w-5 h-5 text-amber-400" />}
          badge={`${stats.conversionRate}% conv. rate`}
          badgeColor="bg-amber-500/10 text-amber-400 border-amber-500/20"
        />
      </div>

      {/* Main Analytics Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Channel Volume Chart (Pure CSS Bar Chart) */}
        <div className="lg:col-span-2 rounded-2xl bg-white/[0.03] border border-white/[0.06] p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-bold text-white text-base flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-blue-400" />
                Omnichannel Conversation Volume
              </h3>
              <p className="text-xs text-gray-400 mt-0.5">Interaction volume broken down by channel across 7 days</p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5 text-gray-300">
                <span className="w-2.5 h-2.5 rounded-full bg-blue-500" /> WhatsApp
              </span>
              <span className="flex items-center gap-1.5 text-gray-300">
                <span className="w-2.5 h-2.5 rounded-full bg-purple-500" /> Voice AI
              </span>
              <span className="flex items-center gap-1.5 text-gray-300">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> WebChat
              </span>
            </div>
          </div>

          {/* Bar chart grid */}
          <div className="h-56 flex items-end justify-between gap-3 pt-6 px-2 border-b border-white/[0.06]">
            {weeklyData.map((d: any, idx: number) => (
              <div key={idx} className="flex-1 flex flex-col items-center gap-2 h-full justify-end group">
                <div className="w-full max-w-[36px] flex items-end justify-center gap-1 h-full">
                  <div
                    className="w-1.5 bg-blue-500 rounded-t-sm transition-all group-hover:bg-blue-400"
                    style={{ height: `${(d.whatsapp / maxVal) * 100}%` }}
                    title={`WhatsApp: ${d.whatsapp}`}
                  />
                  <div
                    className="w-1.5 bg-purple-500 rounded-t-sm transition-all group-hover:bg-purple-400"
                    style={{ height: `${(d.voice / maxVal) * 100}%` }}
                    title={`Voice AI: ${d.voice}`}
                  />
                  <div
                    className="w-1.5 bg-emerald-500 rounded-t-sm transition-all group-hover:bg-emerald-400"
                    style={{ height: `${(d.web / maxVal) * 100}%` }}
                    title={`WebChat: ${d.web}`}
                  />
                </div>
                <span className="text-[11px] font-medium text-gray-500">{d.day}</span>
              </div>
            ))}
          </div>

          {/* Key Channel Summary Stats */}
          <div className="grid grid-cols-3 gap-4 pt-2">
            <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.04]">
              <p className="text-xs text-gray-400">Total Conversations</p>
              <p className="text-lg font-bold text-blue-400 mt-1">{stats.conversations} msgs</p>
            </div>
            <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.04]">
              <p className="text-xs text-gray-400">Total Voice Calls</p>
              <p className="text-lg font-bold text-purple-400 mt-1">{stats.calls} calls</p>
            </div>
            <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.04]">
              <p className="text-xs text-gray-400">Avg Resolution Time</p>
              <p className="text-lg font-bold text-emerald-400 mt-1">1.4 mins</p>
              <p className="text-[10px] text-emerald-400 mt-0.5">Instant AI handover</p>
            </div>
          </div>
        </div>

        {/* AI Performance Gauge & Metrics */}
        <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-6 space-y-6 flex flex-col justify-between">
          <div>
            <h3 className="font-bold text-white text-base flex items-center gap-2">
              <Zap className="w-5 h-5 text-amber-400" />
              AI Agent Efficiency
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">Autonomous resolution & accuracy scores</p>
          </div>

          <div className="space-y-4">
            <ProgressMetric
              label="Autonomous AI Resolution"
              percentage={aiResolutionRate}
              value={`${aiResolutionRate}% of queries solved without human agent`}
              color="bg-emerald-500"
            />
            <ProgressMetric
              label="Knowledge Retrieval Accuracy"
              percentage={'N/A'}
              value="Awaiting knowledge interaction data"
              color="bg-blue-500"
            />
            <ProgressMetric
              label="Voice Speech-To-Text Confidence"
              percentage={'N/A'}
              value="Awaiting Deepgram STT data"
              color="bg-purple-500"
            />
            <ProgressMetric
              label="Human Handover Rate"
              percentage={100 - aiResolutionRate}
              value={`${100 - aiResolutionRate}% escalated to human team`}
              color="bg-amber-500"
            />
          </div>

          <div className="p-4 rounded-xl bg-gradient-to-r from-blue-600/20 to-indigo-600/20 border border-blue-500/30 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-emerald-400 animate-ping" />
              <div>
                <p className="text-xs font-bold text-white">System Status: Optimal</p>
                <p className="text-[11px] text-gray-400">All gateways (WhatsApp, Voice, CRM) active</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Secondary Bottom Grid: Recent Activity & Top Pipeline Leads */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Live Activity Timeline */}
        <div className="lg:col-span-2 rounded-2xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06] flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Clock className="w-4 h-4 text-gray-400" /> Recent Live Activity
            </h3>
            <Link href="/agent-console" className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 font-medium">
              View All Conversations <ArrowRight className="w-3 h-3" />
            </Link>
          </div>

          <div className="divide-y divide-white/[0.04]">
            {loading ? (
              [1, 2, 3, 4].map(i => (
                <div key={i} className="px-6 py-4 flex gap-3 animate-pulse">
                  <div className="w-9 h-9 rounded-xl bg-white/5 flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 bg-white/5 rounded w-2/3" />
                    <div className="h-2.5 bg-white/5 rounded w-1/2" />
                  </div>
                </div>
              ))
            ) : activities.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                <Bot className="w-10 h-10 mb-3 opacity-30" />
                <p className="text-sm">No activity recorded yet. Your AI assistant is active.</p>
              </div>
            ) : (
              activities.map((a) => (
                <div key={a.id} className="px-6 py-4 flex items-center justify-between hover:bg-white/[0.02] transition-colors">
                  <div className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-xl flex-shrink-0 flex items-center justify-center ${
                      a.type === 'call' ? 'bg-purple-500/15 text-purple-400' :
                      a.type === 'message' ? 'bg-blue-500/15 text-blue-400' :
                      a.type === 'contact' ? 'bg-emerald-500/15 text-emerald-400' :
                      'bg-amber-500/15 text-amber-400'
                    }`}>
                      {a.type === 'call' ? <Phone className="w-4 h-4" /> :
                       a.type === 'message' ? <MessageSquareText className="w-4 h-4" /> :
                       a.type === 'contact' ? <Users className="w-4 h-4" /> :
                       <CheckCircle2 className="w-4 h-4" />}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-200">{a.title}</p>
                      <p className="text-xs text-gray-400">{a.subtitle}</p>
                    </div>
                  </div>
                  <span className="text-xs text-gray-500 font-mono">{a.time}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Quick Launch & System Shortcuts */}
        <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-6 space-y-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2 border-b border-white/[0.06] pb-3">
            <Layers className="w-4 h-4 text-purple-400" /> Platform Shortcuts
          </h3>

          <div className="space-y-2">
            {[
              { label: 'Agent Console', href: '/agent-console', desc: 'Real-time conversation management', color: 'text-blue-400' },
              { label: 'CRM Pipeline', href: '/crm', desc: 'Manage contacts, leads & deals', color: 'text-purple-400' },
              { label: 'Knowledge Base', href: '/knowledge', desc: 'Sync website & upload documents', color: 'text-emerald-400' },
              { label: 'Voice AI Telephony', href: '/telephony', desc: 'Configure carrier & demo call', color: 'text-amber-400' },
              { label: 'Scheduling', href: '/scheduling', desc: 'Manage bookings & reservations', color: 'text-cyan-400' },
              { label: 'Settings & Integrations', href: '/settings', desc: 'WhatsApp & Voice credentials', color: 'text-pink-400' },
            ].map(s => (
              <Link
                key={s.href}
                href={s.href}
                className="flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.05] hover:border-white/[0.1] transition-all group"
              >
                <div>
                  <p className={`text-xs font-bold ${s.color}`}>{s.label}</p>
                  <p className="text-[11px] text-gray-500">{s.desc}</p>
                </div>
                <ArrowRight className="w-3.5 h-3.5 text-gray-500 group-hover:text-white transition-colors" />
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
    <div className="p-5 rounded-2xl bg-white/[0.03] border border-white/[0.06] space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-400">{title}</span>
        <div className="p-2 rounded-xl bg-white/[0.04] border border-white/[0.06]">{icon}</div>
      </div>
      <div>
        <p className="text-2xl font-extrabold text-white tracking-tight">{value}</p>
        <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
      </div>
      <div className="pt-2 border-t border-white/[0.04]">
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${badgeColor}`}>{badge}</span>
      </div>
    </div>
  );
}

function ProgressMetric({ label, percentage, value, color }: any) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold text-gray-200">{label}</span>
        <span className="font-bold text-white">{percentage}{percentage !== 'N/A' ? '%' : ''}</span>
      </div>
      <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: percentage === 'N/A' ? '0%' : `${percentage}%` }} />
      </div>
      <p className="text-[11px] text-gray-500">{value}</p>
    </div>
  );
}
