"use client";
import React, { useEffect, useState, useCallback } from 'react';
import { api, API_URL } from '@/lib/api';
import {
  Settings, Building2, Bot, Phone, MessageSquare, Users, User,
  Save, CheckCircle2, AlertCircle, Eye, EyeOff, Copy, Plus,
  Globe, Zap, Shield, X, Loader2, ChevronDown
} from 'lucide-react';

type Tab = 'profile' | 'general' | 'whatsapp' | 'voice' | 'team';

const inputCls = "w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all placeholder-gray-600";
const selectCls = `${inputCls} appearance-none cursor-pointer`;
const labelCls = "text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 block uppercase tracking-wider";

function Toast({ msg, type }: { msg: string; type: 'success' | 'error' }) {
  return (
    <div className={`fixed top-5 right-5 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border text-sm font-medium animate-fade-in-up ${
      type === 'success' ? 'bg-emerald-900/80 border-emerald-500/30 text-emerald-300' : 'bg-red-900/80 border-red-500/30 text-red-300'
    }`}>
      {type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
      {msg}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800">
        <h3 className="font-semibold text-slate-900 dark:text-white">{title}</h3>
        {description && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{description}</p>}
      </div>
      <div className="p-6 space-y-4">{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('profile');
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [org, setOrg] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const token = typeof window !== 'undefined' ? localStorage.getItem('ace_token') : '';
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const fetchOrg = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/organizations/me`, { headers: authHeaders });
      if (res.ok) setOrg(await res.json());
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchOrg(); }, [fetchOrg]);

  const tabs = [
    { id: 'profile' as Tab, label: 'Profile & Security', icon: <User className="w-4 h-4" /> },
    { id: 'general' as Tab, label: 'General', icon: <Building2 className="w-4 h-4" /> },
    { id: 'whatsapp' as Tab, label: 'WhatsApp', icon: <MessageSquare className="w-4 h-4" /> },
    { id: 'voice' as Tab, label: 'Voice / Telephony', icon: <Phone className="w-4 h-4" /> },
    { id: 'team' as Tab, label: 'Team Members', icon: <Users className="w-4 h-4" /> },
  ];

  return (
    <div className="max-w-4xl space-y-6">
      {toast && <Toast msg={toast.msg} type={toast.type} />}

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Settings className="w-6 h-6 text-blue-400" /> Settings
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">Configure your AI platform, integrations, and team.</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-slate-200 dark:border-slate-800 w-fit">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              tab === t.id ? 'bg-blue-600 text-slate-900 dark:text-white shadow-lg shadow-blue-500/20' : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200 hover:bg-white/5'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-blue-400 animate-spin" /></div>
      ) : (
        <>
          {tab === 'profile' && <ProfileTab authHeaders={authHeaders} showToast={showToast} />}
          {tab === 'general' && <GeneralTab org={org} authHeaders={authHeaders} showToast={showToast} onSaved={fetchOrg} />}
          {tab === 'whatsapp' && <WhatsAppTab org={org} authHeaders={authHeaders} showToast={showToast} />}
          {tab === 'voice' && <VoiceTab org={org} authHeaders={authHeaders} showToast={showToast} />}
          {tab === 'team' && <TeamTab org={org} authHeaders={authHeaders} showToast={showToast} onSaved={fetchOrg} />}
        </>
      )}
    </div>
  );
}

// ─────────────────────── Profile Tab ───────────────────────
function ProfileTab({ authHeaders, showToast }: any) {
  const [user, setUser] = useState<{ fullName?: string; email?: string; role?: string } | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('ace_user');
      if (stored) setUser(JSON.parse(stored));
    } catch {}
  }, []);

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      showToast('Passwords do not match', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/change-password`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Failed to change password');
      }
      showToast('Password updated successfully!');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Section title="User Profile" description="Your personal information">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Full Name</label>
            <input type="text" value={user?.fullName || ''} disabled className={`${inputCls} opacity-50 cursor-not-allowed`} />
          </div>
          <div>
            <label className={labelCls}>Email Address</label>
            <input type="email" value={user?.email || ''} disabled className={`${inputCls} opacity-50 cursor-not-allowed`} />
          </div>
          <div>
            <label className={labelCls}>Role</label>
            <input type="text" value={user?.role || ''} disabled className={`${inputCls} opacity-50 cursor-not-allowed`} />
          </div>
        </div>
      </Section>

      <Section title="Change Password" description="Update your security credentials">
        <form onSubmit={savePassword} className="space-y-4">
          <div>
            <label className={labelCls}>Current Password</label>
            <input type="password" required value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} className={inputCls} placeholder="••••••••" />
          </div>
          <div>
            <label className={labelCls}>New Password</label>
            <input type="password" required minLength={8} value={newPassword} onChange={e => setNewPassword(e.target.value)} className={inputCls} placeholder="Min 8 characters" />
          </div>
          <div>
            <label className={labelCls}>Confirm New Password</label>
            <input type="password" required minLength={8} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className={inputCls} placeholder="Confirm your new password" />
          </div>
          <div className="flex justify-end pt-2">
            <button type="submit" disabled={saving} className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-slate-900 dark:text-white font-semibold text-sm disabled:opacity-50 transition-all shadow-lg shadow-blue-500/20">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
              {saving ? 'Updating...' : 'Update Password'}
            </button>
          </div>
        </form>
      </Section>
    </div>
  );
}

// ─────────────────────── General Tab ───────────────────────
function GeneralTab({ org, authHeaders, showToast, onSaved }: any) {
  const [name, setName] = useState(org?.name || '');
  const [aiPersonaPrompt, setAiPersonaPrompt] = useState(org?.aiPersonaPrompt || '');
  const [welcomeMessage, setWelcomeMessage] = useState(org?.welcomeMessage || '');
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/organizations/settings`, {
        method: 'PATCH', headers: authHeaders,
        body: JSON.stringify({ name, aiPersonaPrompt, welcomeMessage }),
      });
      if (!res.ok) throw new Error('Failed');
      showToast('Settings saved!');
      onSaved();
    } catch { showToast('Failed to save settings', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <Section title="Organization Profile" description="Basic info about your business">
        <div>
          <label className={labelCls}>Organization Name</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="e.g. Apex Care Services" />
        </div>
        <div>
          <label className={labelCls}>Industry</label>
          <input type="text" value={org?.industry || ''} disabled className={`${inputCls} opacity-50 cursor-not-allowed`} />
        </div>
      </Section>

      <Section title="AI Agent Personality" description="Control how your AI assistant speaks to customers">
        <div>
          <label className={labelCls}>AI Persona Prompt</label>
          <textarea
            rows={5}
            value={aiPersonaPrompt}
            onChange={e => setAiPersonaPrompt(e.target.value)}
            className={inputCls}
            placeholder="You are a helpful, professional customer service agent for [Company Name]. You answer questions about our products and services in a friendly, concise manner. You can book appointments, check availability, and handle common support queries..."
          />
          <p className="text-xs text-gray-600 mt-1.5">This is the instruction your AI agent follows in every conversation. Be specific about tone, capabilities, and boundaries.</p>
        </div>
        <div>
          <label className={labelCls}>Welcome Message</label>
          <textarea
            rows={2}
            value={welcomeMessage}
            onChange={e => setWelcomeMessage(e.target.value)}
            className={inputCls}
            placeholder="Hello! 👋 Welcome to [Company]. I'm your AI assistant. How can I help you today?"
          />
          <p className="text-xs text-gray-600 mt-1.5">First message sent to every new customer conversation.</p>
        </div>
      </Section>

      <div className="flex justify-end">
        <button type="submit" disabled={saving} className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-slate-900 dark:text-white font-semibold text-sm disabled:opacity-50 transition-all shadow-lg shadow-blue-500/20">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </form>
  );
}

// ─────────────────────── WhatsApp Tab ───────────────────────
function WhatsAppTab({ org, authHeaders, showToast }: any) {
  const wa = org?.whatsappConfigs?.[0] || {};
  const [phoneNumberId, setPhoneNumberId] = useState(wa.phoneNumberId || '');
  const [whatsappBusinessId, setWhatsappBusinessId] = useState(wa.whatsappBusinessId || '');
  const [accessToken, setAccessToken] = useState(wa.accessToken || '');
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);

  const webhookUrl = `${API_URL}/api/whatsapp/webhook`;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/organizations/whatsapp-config`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ phoneNumberId, whatsappBusinessId, accessToken }),
      });
      if (!res.ok) throw new Error();
      showToast('WhatsApp config saved!');
    } catch { showToast('Failed to save', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <Section title="WhatsApp Cloud API" description="Connect your Meta Business WhatsApp number">
        <div className="p-4 rounded-xl bg-blue-500/[0.06] border border-blue-500/20">
          <p className="text-xs font-semibold text-blue-300 mb-1">📌 Webhook URL — paste this in Meta Developer Portal</p>
          <div className="flex items-center gap-2 mt-2">
            <code className="flex-1 text-xs text-blue-200 font-mono bg-blue-500/10 px-3 py-2 rounded-lg truncate">{webhookUrl}</code>
            <button type="button" onClick={() => { navigator.clipboard.writeText(webhookUrl); showToast('Copied!'); }}
              className="px-3 py-2 rounded-lg bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 transition-all">
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <div>
          <label className={labelCls}>Phone Number ID</label>
          <input type="text" value={phoneNumberId} onChange={e => setPhoneNumberId(e.target.value)} className={inputCls} placeholder="From Meta → WhatsApp → Phone Numbers" />
        </div>
        <div>
          <label className={labelCls}>WhatsApp Business Account ID</label>
          <input type="text" value={whatsappBusinessId} onChange={e => setWhatsappBusinessId(e.target.value)} className={inputCls} placeholder="Your WABA ID" />
        </div>
        <div>
          <label className={labelCls}>Permanent Access Token</label>
          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              value={accessToken}
              onChange={e => setAccessToken(e.target.value)}
              className={`${inputCls} pr-12`}
              placeholder="EAA..."
            />
            <button type="button" onClick={() => setShowToken(!showToken)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:text-slate-300">
              {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </Section>
      <div className="flex justify-end">
        <button type="submit" disabled={saving} className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-slate-900 dark:text-white font-semibold text-sm disabled:opacity-50 transition-all shadow-lg shadow-blue-500/20">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving...' : 'Save WhatsApp Config'}
        </button>
      </div>
    </form>
  );
}

// ─────────────────────── Voice Tab ───────────────────────
function VoiceTab({ org, authHeaders, showToast }: any) {
  const tc = org?.telephonyConfigs?.[0] || {};
  const [provider, setProvider] = useState(tc.provider || 'TWILIO');
  const [phoneNumber, setPhoneNumber] = useState(tc.phoneNumber || '');
  const [accountSid, setAccountSid] = useState(tc.accountSid || '');
  const [authToken, setAuthToken] = useState(tc.authToken || '');
  const [apiKey, setApiKey] = useState(tc.apiKey || '');
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);

  const providers = ['TWILIO', 'AFRICA_TALKING', 'NIGERIAN_CARRIER', 'PLIVO', 'TELNYX'];

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/organizations/telephony-config`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ provider, phoneNumber, accountSid, authToken, apiKey }),
      });
      if (!res.ok) throw new Error();
      showToast('Voice config saved!');
    } catch { showToast('Failed to save', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <Section title="Voice AI Telephony" description="Configure your phone provider for AI voice calls">
        <div>
          <label className={labelCls}>Provider</label>
          <select value={provider} onChange={e => setProvider(e.target.value)} className={selectCls}>
            {providers.map(p => <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Phone Number</label>
          <input type="tel" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} className={inputCls} placeholder="+12025551234 or +2341234567890" />
        </div>
        {(provider === 'TWILIO' || provider === 'PLIVO') && (
          <>
            <div>
              <label className={labelCls}>{provider === 'TWILIO' ? 'Account SID' : 'Auth ID'}</label>
              <input type="text" value={accountSid} onChange={e => setAccountSid(e.target.value)} className={inputCls} placeholder="AC..." />
            </div>
            <div>
              <label className={labelCls}>Auth Token</label>
              <div className="relative">
                <input type={showSecret ? 'text' : 'password'} value={authToken} onChange={e => setAuthToken(e.target.value)} className={`${inputCls} pr-12`} placeholder="••••••••" />
                <button type="button" onClick={() => setShowSecret(!showSecret)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:text-slate-300">
                  {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </>
        )}
        {(provider === 'AFRICA_TALKING' || provider === 'NIGERIAN_CARRIER' || provider === 'TELNYX') && (
          <div>
            <label className={labelCls}>API Key</label>
            <div className="relative">
              <input type={showSecret ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value)} className={`${inputCls} pr-12`} placeholder="Your API key" />
              <button type="button" onClick={() => setShowSecret(!showSecret)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:text-slate-300">
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        )}
        <div className="p-4 rounded-xl bg-amber-500/[0.06] border border-amber-500/20 text-xs text-amber-300">
          <strong>Inbound Voice Webhook URL:</strong>
          <code className="ml-2 font-mono">{API_URL}/api/telephony/inbound/{provider === 'TWILIO' ? 'twilio' : provider === 'AFRICA_TALKING' ? 'africa-talking' : 'nigeria-carrier'}</code>
        </div>
      </Section>
      <div className="flex justify-end">
        <button type="submit" disabled={saving} className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-slate-900 dark:text-white font-semibold text-sm disabled:opacity-50 transition-all shadow-lg shadow-blue-500/20">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving...' : 'Save Voice Config'}
        </button>
      </div>
    </form>
  );
}

// ─────────────────────── Team & RBAC Tab ───────────────────────
function TeamTab({ org, authHeaders, showToast, onSaved }: any) {
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('AGENT');
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<any[]>(org?.users || []);
  const [matrix, setMatrix] = useState<any[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);

  const fetchTeamAndMatrix = useCallback(async () => {
    setLoadingMembers(true);
    try {
      const [mRes, pRes] = await Promise.all([
        api.organizations.getTeamMembers(),
        api.organizations.getPermissionsMatrix(),
      ]);
      if (mRes) setMembers(mRes);
      if (pRes) setMatrix(pRes);
    } catch {}
    finally { setLoadingMembers(false); }
  }, []);

  useEffect(() => {
    fetchTeamAndMatrix();
  }, [fetchTeamAndMatrix]);

  const addMember = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.organizations.addTeamMember({ email, fullName, role });
      showToast('Team member invited successfully!');
      setShowForm(false); setEmail(''); setFullName('');
      fetchTeamAndMatrix();
    } catch (err: any) { showToast(err.message || 'Failed to invite', 'error'); }
    finally { setSaving(false); }
  };

  const handleRoleChange = async (userId: string, newRole: string) => {
    try {
      await api.organizations.updateMemberRole(userId, newRole);
      showToast(`User role updated to ${newRole}`);
      fetchTeamAndMatrix();
    } catch (err: any) {
      showToast(err.message || 'Failed to update role', 'error');
    }
  };

  const handleStatusToggle = async (userId: string, currentStatus: boolean) => {
    try {
      await api.organizations.updateMemberStatus(userId, !currentStatus);
      showToast(`User ${!currentStatus ? 'reactivated' : 'suspended'}`);
      fetchTeamAndMatrix();
    } catch (err: any) {
      showToast(err.message || 'Failed to update status', 'error');
    }
  };

  const handleRemoveMember = async (userId: string, memberName: string) => {
    if (!window.confirm(`Are you sure you want to remove ${memberName} from this organization?`)) return;
    try {
      await api.organizations.removeTeamMember(userId);
      showToast('Team member removed');
      fetchTeamAndMatrix();
    } catch (err: any) {
      showToast(err.message || 'Failed to remove member', 'error');
    }
  };

  const roleColors: Record<string, string> = {
    OWNER: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    ADMIN: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    AGENT: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    VIEWER: 'bg-gray-500/10 text-slate-600 dark:text-slate-400 border-gray-500/20',
  };

  return (
    <div className="space-y-6">
      <Section title="Team Members & Role Access Control (RBAC)" description="Manage member access levels, roles, and granular platform permissions">
        {loadingMembers ? (
          <div className="py-8 text-center text-slate-500 dark:text-slate-400 text-sm flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-blue-400" /> Loading team members...
          </div>
        ) : members.length === 0 ? (
          <div className="py-8 text-center text-slate-500 dark:text-slate-400 text-sm">No team members yet. Invite your first agent below.</div>
        ) : (
          <div className="space-y-3">
            {members.map((m: any) => (
              <div key={m.id} className="flex flex-col md:flex-row md:items-center justify-between p-4 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-slate-200 dark:border-slate-800 hover:bg-white/[0.05] transition-all gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-slate-900 dark:text-white font-bold text-sm flex items-center justify-center flex-shrink-0">
                    {(m.fullName || m.email || 'U')[0].toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{m.fullName || 'Team Member'}</p>
                      <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${m.isActive !== false ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                        {m.isActive !== false ? 'ACTIVE' : 'SUSPENDED'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{m.email}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {/* Role Selector */}
                  <select
                    value={m.role}
                    onChange={e => handleRoleChange(m.id, e.target.value)}
                    className="px-3 py-1.5 rounded-lg bg-black/40 border border-white/[0.1] text-xs font-semibold text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
                  >
                    <option value="OWNER">OWNER</option>
                    <option value="ADMIN">ADMIN</option>
                    <option value="AGENT">AGENT</option>
                    <option value="VIEWER">VIEWER</option>
                  </select>

                  {/* Status Toggle */}
                  <button
                    onClick={() => handleStatusToggle(m.id, m.isActive !== false)}
                    className={`text-xs px-2.5 py-1.5 rounded-lg border font-semibold transition-all ${
                      m.isActive !== false
                        ? 'border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10'
                        : 'border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10'
                    }`}
                  >
                    {m.isActive !== false ? 'Suspend' : 'Reactivate'}
                  </button>

                  {/* Delete Button */}
                  <button
                    onClick={() => handleRemoveMember(m.id, m.fullName || m.email)}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 font-semibold transition-all"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Invite Member Form */}
      {showForm ? (
        <Section title="Invite Team Member">
          <form onSubmit={addMember} className="space-y-4">
            <div>
              <label className={labelCls}>Full Name</label>
              <input required type="text" value={fullName} onChange={e => setFullName(e.target.value)} className={inputCls} placeholder="e.g. Chidi Okeke" />
            </div>
            <div>
              <label className={labelCls}>Email Address</label>
              <input required type="email" value={email} onChange={e => setEmail(e.target.value)} className={inputCls} placeholder="agent@yourcompany.com" />
            </div>
            <div>
              <label className={labelCls}>Role</label>
              <select value={role} onChange={e => setRole(e.target.value)} className={selectCls}>
                {['ADMIN', 'AGENT', 'VIEWER'].map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="flex gap-3">
              <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-slate-900 dark:text-white font-semibold text-sm disabled:opacity-50 transition-all flex items-center justify-center gap-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {saving ? 'Inviting...' : 'Send Invite'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200 text-sm transition-all">
                Cancel
              </button>
            </div>
          </form>
        </Section>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="w-full py-3 rounded-xl border border-dashed border-white/[0.10] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:text-slate-300 hover:border-white/20 text-sm font-medium flex items-center justify-center gap-2 transition-all"
        >
          <Plus className="w-4 h-4" /> Invite New Team Member
        </button>
      )}

      {/* Role & Access Permission Matrix Grid Table */}
      <Section title="Role Access Permission Matrix" description="System access levels assigned per user role">
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-white/[0.04] text-slate-600 dark:text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-3">Platform Module</th>
                <th className="px-4 py-3 text-purple-400">OWNER</th>
                <th className="px-4 py-3 text-blue-400">ADMIN</th>
                <th className="px-4 py-3 text-emerald-400">AGENT</th>
                <th className="px-4 py-3 text-slate-600 dark:text-slate-400">VIEWER</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04] text-slate-700 dark:text-slate-300">
              {matrix.map((row: any, i: number) => (
                <tr key={i} className="hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{row.module}</td>
                  <td className="px-4 py-3 font-semibold text-purple-300">{row.OWNER}</td>
                  <td className="px-4 py-3 font-semibold text-blue-300">{row.ADMIN}</td>
                  <td className="px-4 py-3 font-semibold text-emerald-300">{row.AGENT}</td>
                  <td className="px-4 py-3 font-semibold text-slate-600 dark:text-slate-400">{row.VIEWER}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

