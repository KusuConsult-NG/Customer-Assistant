"use client";
import React, { useEffect, useState, useCallback } from 'react';
import { api, API_URL } from '@/lib/api';
import { copyToClipboard } from '@/lib/clipboard';
import {
  Settings, Building2, Bot, Phone, MessageSquare, Users, User,
  Save, CheckCircle2, AlertCircle, AlertTriangle, Eye, EyeOff, Copy, Plus,
  Globe, Zap, Shield, X, Loader2, ChevronDown, KeyRound
} from 'lucide-react';

type Tab = 'profile' | 'general' | 'whatsapp' | 'voice' | 'agent' | 'team';

const inputCls = "w-full px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all placeholder-gray-600";
const selectCls = `${inputCls} appearance-none cursor-pointer`;
const labelCls = "text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 block uppercase tracking-wider";

function Toast({ msg, type }: { msg: string; type: 'success' | 'error' }) {
  return (
    <div className={`fixed top-5 right-5 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border text-sm font-medium animate-fade-in-up ${
      type === 'success' ? 'bg-emerald-900/80 border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300' : 'bg-red-900/80 border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-300'
    }`}>
      {type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
      {msg}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
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
    { id: 'agent' as Tab, label: 'Hosted Agent', icon: <Bot className="w-4 h-4" /> },
    { id: 'team' as Tab, label: 'Team Members', icon: <Users className="w-4 h-4" /> },
  ];

  return (
    <div className="max-w-4xl space-y-6">
      {toast && <Toast msg={toast.msg} type={toast.type} />}

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Settings className="w-6 h-6 text-blue-600 dark:text-blue-400" /> Settings
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">Configure your AI platform, integrations, and team.</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm w-fit">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              tab === t.id ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-800/60'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-blue-600 dark:text-blue-400 animate-spin" /></div>
      ) : (
        <>
          {tab === 'profile' && <ProfileTab authHeaders={authHeaders} showToast={showToast} />}
          {tab === 'general' && <GeneralTab org={org} authHeaders={authHeaders} showToast={showToast} onSaved={fetchOrg} />}
          {tab === 'whatsapp' && <WhatsAppTab org={org} authHeaders={authHeaders} showToast={showToast} />}
          {tab === 'voice' && <VoiceTab org={org} authHeaders={authHeaders} showToast={showToast} />}
          {tab === 'agent' && <HostedAgentTab showToast={showToast} />}
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
            <button type="submit" disabled={saving} className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm disabled:opacity-50 transition-all shadow-lg shadow-blue-500/20">
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
  // Payment collection details. The AI assistant reads these out verbatim when a
  // customer asks how to pay; with them blank it says it will fetch a colleague
  // rather than guessing. (It used to recite a hardcoded account number instead.)
  const [payoutBankName, setPayoutBankName] = useState(org?.payoutBankName || '');
  const [payoutAccountName, setPayoutAccountName] = useState(org?.payoutAccountName || '');
  const [payoutAccountNumber, setPayoutAccountNumber] = useState(org?.payoutAccountNumber || '');
  const [payoutUssdCode, setPayoutUssdCode] = useState(org?.payoutUssdCode || '');
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/organizations/settings`, {
        method: 'PATCH', headers: authHeaders,
        body: JSON.stringify({
          name, aiPersonaPrompt, welcomeMessage,
          payoutBankName, payoutAccountName, payoutAccountNumber, payoutUssdCode,
        }),
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
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">This is the instruction your AI agent follows in every conversation. Be specific about tone, capabilities, and boundaries.</p>
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
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">First message sent to every new customer conversation.</p>
        </div>
      </Section>

      <Section
        title="Payment Collection Details"
        description="What the AI assistant tells customers when they ask how to pay. Leave blank and it will hand the conversation to a human instead of guessing."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Bank Name</label>
            <input type="text" value={payoutBankName} onChange={e => setPayoutBankName(e.target.value)} className={inputCls} placeholder="e.g. Zenith Bank" />
          </div>
          <div>
            <label className={labelCls}>Account Name</label>
            <input type="text" value={payoutAccountName} onChange={e => setPayoutAccountName(e.target.value)} className={inputCls} placeholder="e.g. Apex Care Services Ltd" />
          </div>
          <div>
            <label className={labelCls}>Account Number</label>
            <input type="text" inputMode="numeric" value={payoutAccountNumber} onChange={e => setPayoutAccountNumber(e.target.value)} className={inputCls} placeholder="10-digit NUBAN" />
          </div>
          <div>
            <label className={labelCls}>USSD Code (optional)</label>
            <input type="text" value={payoutUssdCode} onChange={e => setPayoutUssdCode(e.target.value)} className={inputCls} placeholder="e.g. *966*1234#" />
          </div>
        </div>
        <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5">
          Double-check these. They are read out to customers as payment instructions.
        </p>
      </Section>

      <div className="flex justify-end">
        <button type="submit" disabled={saving} className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm disabled:opacity-50 transition-all shadow-lg shadow-blue-500/20">
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
        <div className="p-4 rounded-xl bg-blue-500/[0.06] border border-blue-200 dark:border-blue-500/20">
          <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 mb-1">📌 Webhook URL — paste this in Meta Developer Portal</p>
          <div className="flex items-center gap-2 mt-2">
            <code className="flex-1 text-xs text-blue-200 font-mono bg-blue-50 dark:bg-blue-500/10 px-3 py-2 rounded-lg truncate">{webhookUrl}</code>
            <button type="button" onClick={async () => { const ok = await copyToClipboard(webhookUrl); if (ok) showToast('Copied to clipboard!'); else showToast('Failed to copy', 'error'); }}
              className="px-3 py-2 rounded-lg bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300 hover:bg-blue-500/30 transition-all font-semibold flex items-center gap-1.5">
              <Copy className="w-3.5 h-3.5" /> Copy
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
        <button type="submit" disabled={saving} className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm disabled:opacity-50 transition-all shadow-lg shadow-blue-500/20">
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
        <div className="p-4 rounded-xl bg-amber-500/[0.06] border border-amber-200 dark:border-amber-500/20 text-xs text-amber-700 dark:text-amber-300 flex items-center justify-between gap-3">
          <div>
            <strong>Inbound Voice Webhook URL:</strong>
            <code className="ml-2 font-mono">{API_URL}/api/telephony/inbound/{provider === 'TWILIO' ? 'twilio' : provider === 'AFRICA_TALKING' ? 'africa-talking' : 'nigeria-carrier'}</code>
          </div>
          <button
            type="button"
            onClick={async () => {
              const url = `${API_URL}/api/telephony/inbound/${provider === 'TWILIO' ? 'twilio' : provider === 'AFRICA_TALKING' ? 'africa-talking' : 'nigeria-carrier'}`;
              const ok = await copyToClipboard(url);
              if (ok) showToast('Telephony Webhook URL copied!');
            }}
            className="px-2.5 py-1 rounded bg-amber-100 dark:bg-amber-800/40 text-amber-800 dark:text-amber-200 hover:bg-amber-200 font-semibold text-[11px] flex items-center gap-1"
          >
            <Copy className="w-3 h-3" /> Copy
          </button>
        </div>
      </Section>
      <div className="flex justify-end">
        <button type="submit" disabled={saving} className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm disabled:opacity-50 transition-all shadow-lg shadow-blue-500/20">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving...' : 'Save Voice Config'}
        </button>
      </div>
    </form>
  );
}

// ─────────────────────── Hosted Agent Tab ───────────────────────
/**
 * The tenant's own ElevenLabs workspace.
 *
 * An ElevenLabs workspace has no tenancy of its own: the agents in it, the phone
 * numbers, the WhatsApp lines and every conversation transcript belong to
 * whoever holds the key. So each tenant needs its own, and until it has one the
 * API refuses every hosted-agent operation rather than quietly putting this
 * business's customers in a bucket with everyone else's.
 *
 * That refusal has been live with no way to clear it from the dashboard — the
 * key could only be written by hand in SQL, and a credential nobody can rotate
 * without a database console does not get rotated. This tab is that way.
 *
 * Three rules it follows, all of them the opposite of what the older tabs do:
 *
 *   NOTHING IS PRE-FILLED. The API returns fingerprints, never credentials, and
 *   there is no read-back endpoint at all. An empty box next to "••••abcd" is
 *   honest about that; a box pre-filled with a masked value invites someone to
 *   save the mask as the new secret.
 *
 *   THE SERVER'S WARNINGS ARE SHOWN VERBATIM. They name the exact gap and the
 *   exact URL to fix it. Re-wording them here means two descriptions of one
 *   state, and the friendlier one is always the one that drifts out of date.
 *
 *   A REFUSAL IS RENDERED, NOT SWALLOWED. Reading the agent status throws for a
 *   tenant with no key — and that exception text IS the instruction. Showing it
 *   beats a panel that sits empty for a reason the operator cannot see.
 */
function HostedAgentTab({ showToast }: any) {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [showSecrets, setShowSecrets] = useState(false);

  const [agent, setAgent] = useState<any>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentLoading, setAgentLoading] = useState(true);

  const role = (() => {
    try { return JSON.parse(localStorage.getItem('ace_user') || '{}').role; } catch { return undefined; }
  })();
  const canEdit = role === 'OWNER' || role === 'ADMIN';

  const load = useCallback(async () => {
    setLoading(true);
    try { setStatus(await api.agentProvisioning.getCredentials()); }
    catch (err: any) { showToast(err.message || 'Could not read workspace status', 'error'); }
    finally { setLoading(false); }
  }, []);

  const loadAgent = useCallback(async () => {
    setAgentLoading(true);
    setAgentError(null);
    try { setAgent(await api.agentProvisioning.getStatus()); }
    catch (err: any) {
      // Expected whenever no key is set — the message is the instruction.
      setAgent(null);
      setAgentError(err.message || 'Could not read the agent status');
    }
    finally { setAgentLoading(false); }
  }, []);

  useEffect(() => { load(); loadAgent(); }, [load, loadAgent]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim() && !webhookSecret.trim()) {
      showToast('Enter an API key, a webhook secret, or both', 'error');
      return;
    }
    setSaving(true);
    try {
      const next = await api.agentProvisioning.setCredentials({
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(webhookSecret.trim() ? { webhookSecret: webhookSecret.trim() } : {}),
      });
      // The POST already returns the full status, so there is nothing to re-fetch
      // and no window in which the screen shows the state from before the save.
      setStatus(next);
      setApiKey('');
      setWebhookSecret('');
      showToast('Workspace credentials saved');
      loadAgent();
    } catch (err: any) {
      showToast(err.message || 'Failed to save', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-blue-600 dark:text-blue-400 animate-spin" /></div>;
  }

  const dedicated = status?.mode === 'dedicated';

  return (
    <div className="space-y-5">
      <Section
        title="ElevenLabs Workspace"
        description="Everything inside an ElevenLabs workspace — agents, phone numbers, WhatsApp lines and every call transcript — belongs to whoever holds the key. This organization needs its own."
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className={`text-[11px] px-2.5 py-1 rounded-lg font-bold border ${
            dedicated
              ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20'
              : 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-500/20'
          }`}>
            {dedicated ? 'OWN WORKSPACE' : 'NO KEY OF ITS OWN'}
          </span>
          {status?.fingerprint && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              API key <code className="font-mono text-slate-700 dark:text-slate-300">{status.fingerprint}</code>
            </span>
          )}
          {dedicated && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Webhook secret {status?.webhookSecretConfigured
                ? <span className="text-emerald-600 dark:text-emerald-400 font-semibold">set</span>
                : <span className="text-amber-600 dark:text-amber-400 font-semibold">not set</span>}
            </span>
          )}
        </div>

        {/* Verbatim. The server names the exact gap and the exact URL. */}
        {(status?.warnings ?? []).map((w: string, i: number) => (
          <div key={i} className="flex gap-2.5 p-4 rounded-xl bg-amber-500/[0.06] border border-amber-200 dark:border-amber-500/20">
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed break-words">{w}</p>
          </div>
        ))}

        {status?.webhookUrl && (
          <div className="p-4 rounded-xl bg-blue-500/[0.06] border border-blue-200 dark:border-blue-500/20">
            <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 mb-1">
              📌 Post-call webhook URL — paste this into your ElevenLabs workspace webhook settings
            </p>
            <p className="text-[11px] text-blue-600 dark:text-blue-400/80 mb-2">
              This organization is in the path because the signature has to be checked before the body is read, so the delivery itself cannot say whose secret to use.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-200 px-3 py-2 rounded-lg truncate">{status.webhookUrl}</code>
              <button
                type="button"
                onClick={async () => {
                  const ok = await copyToClipboard(status.webhookUrl);
                  showToast(ok ? 'Copied to clipboard!' : 'Failed to copy', ok ? 'success' : 'error');
                }}
                className="px-3 py-2 rounded-lg bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300 hover:bg-blue-500/30 transition-all font-semibold flex items-center gap-1.5 text-xs"
              >
                <Copy className="w-3.5 h-3.5" /> Copy
              </button>
            </div>
          </div>
        )}
      </Section>

      <Section
        title="Workspace Credentials"
        description="Both halves are needed: the API key to act in the workspace, and its own signing secret to verify the transcripts it sends back. Set either now and the other later — the status above says what is still missing."
      >
        {!canEdit ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Only an OWNER or ADMIN can change workspace credentials. You are signed in as {role || 'a member'}.
          </p>
        ) : (
          <form onSubmit={save} className="space-y-4">
            <div>
              <label className={labelCls}>ElevenLabs API Key</label>
              <div className="relative">
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  className={`${inputCls} pr-12`}
                  placeholder={status?.fingerprint ? `Replace the current key (${status.fingerprint})` : 'sk_...'}
                  autoComplete="off"
                />
                <button type="button" onClick={() => setShowSecrets(!showSecrets)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300">
                  {showSecrets ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                From your own ElevenLabs workspace, under Profile → API Keys. Stored encrypted; it is never shown again after this.
              </p>
            </div>

            <div>
              <label className={labelCls}>Post-call Webhook Signing Secret</label>
              <div className="relative">
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={webhookSecret}
                  onChange={e => setWebhookSecret(e.target.value)}
                  className={`${inputCls} pr-12`}
                  placeholder={status?.webhookSecretConfigured ? 'Replace the current secret' : 'wsec_...'}
                  autoComplete="off"
                />
                <button type="button" onClick={() => setShowSecrets(!showSecrets)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300">
                  {showSecrets ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                From the same workspace's webhook settings. Without it, this organization's call transcripts arrive with a signature nothing can check — and an unverifiable delivery is rejected, so they are lost.
              </p>
            </div>

            <div className="flex justify-end pt-1">
              <button type="submit" disabled={saving} className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm disabled:opacity-50 transition-all shadow-lg shadow-blue-500/20">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                {saving ? 'Saving...' : 'Save Credentials'}
              </button>
            </div>
          </form>
        )}
      </Section>

      <Section
        title="Agent Status"
        description="What the agent your customers reach actually looks like, compared to this platform. Read-only — repairing drift silently would also destroy the evidence of how it happened."
      >
        {agentLoading ? (
          <div className="py-6 text-center text-slate-500 dark:text-slate-400 text-sm flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-blue-600 dark:text-blue-400" /> Checking the agent...
          </div>
        ) : agentError ? (
          <div className="flex gap-2.5 p-4 rounded-xl bg-amber-500/[0.06] border border-amber-200 dark:border-amber-500/20">
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed break-words">{agentError}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600 dark:text-slate-400">
              {agent?.agentId
                ? <>Agent <code className="font-mono text-slate-700 dark:text-slate-300">{agent.agentId}</code></>
                : <span>No agent has been provisioned yet.</span>}
              {agent?.configured && (
                <span>{agent.toolCount} of {agent.expectedToolCount} tools attached</span>
              )}
            </div>
            {(agent?.drift ?? []).length === 0 ? (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> The remote agent matches this platform.
              </p>
            ) : (
              agent.drift.map((d: string, i: number) => (
                <div key={i} className="flex gap-2.5 p-3 rounded-xl bg-amber-500/[0.06] border border-amber-200 dark:border-amber-500/20">
                  <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed break-words">{d}</p>
                </div>
              ))
            )}
            <p className="text-xs text-slate-500 dark:text-slate-400 pt-1">
              Provisioning the agent, importing a phone number and attaching a WhatsApp line are not on this screen yet — importing a number changes who answers your customers, so it needs its own confirmation rather than a button here. Use <code className="font-mono">POST /api/agent-provisioning/sync</code> for now.
            </p>
          </div>
        )}
      </Section>
    </div>
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
    OWNER: 'bg-purple-50 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-500/20',
    ADMIN: 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-500/20',
    AGENT: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20',
    VIEWER: 'bg-slate-100 dark:bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-500/20',
  };

  return (
    <div className="space-y-6">
      <Section title="Team Members & Role Access Control (RBAC)" description="Manage member access levels, roles, and granular platform permissions">
        {loadingMembers ? (
          <div className="py-8 text-center text-slate-500 dark:text-slate-400 text-sm flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-blue-600 dark:text-blue-400" /> Loading team members...
          </div>
        ) : members.length === 0 ? (
          <div className="py-8 text-center text-slate-500 dark:text-slate-400 text-sm">No team members yet. Invite your first agent below.</div>
        ) : (
          <div className="space-y-3">
            {members.map((m: any) => (
              <div key={m.id} className="flex flex-col md:flex-row md:items-center justify-between p-4 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-all gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-slate-900 dark:text-white font-bold text-sm flex items-center justify-center flex-shrink-0">
                    {(m.fullName || m.email || 'U')[0].toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{m.fullName || 'Team Member'}</p>
                      <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${m.isActive !== false ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' : 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'}`}>
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
                    className="px-3 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-white/[0.1] text-xs font-semibold text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
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
                        ? 'border-yellow-500/30 text-yellow-600 dark:text-yellow-400 hover:bg-yellow-50 dark:bg-yellow-500/10'
                        : 'border-emerald-200 dark:border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:bg-emerald-500/10'
                    }`}
                  >
                    {m.isActive !== false ? 'Suspend' : 'Reactivate'}
                  </button>

                  {/* Delete Button */}
                  <button
                    onClick={() => handleRemoveMember(m.id, m.fullName || m.email)}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-red-200 dark:border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-50 dark:bg-red-500/10 font-semibold transition-all"
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
              <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm disabled:opacity-50 transition-all flex items-center justify-center gap-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {saving ? 'Inviting...' : 'Send Invite'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200 text-sm transition-all">
                Cancel
              </button>
            </div>
          </form>
        </Section>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="w-full py-3 rounded-xl border border-dashed border-white/[0.10] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:text-slate-300 hover:border-slate-200 dark:border-slate-700 text-sm font-medium flex items-center justify-center gap-2 transition-all"
        >
          <Plus className="w-4 h-4" /> Invite New Team Member
        </button>
      )}

      {/* Role & Access Permission Matrix Grid Table */}
      <Section title="Role Access Permission Matrix" description="System access levels assigned per user role">
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-3">Platform Module</th>
                <th className="px-4 py-3 text-purple-600 dark:text-purple-400">OWNER</th>
                <th className="px-4 py-3 text-blue-600 dark:text-blue-400">ADMIN</th>
                <th className="px-4 py-3 text-emerald-600 dark:text-emerald-400">AGENT</th>
                <th className="px-4 py-3 text-slate-600 dark:text-slate-400">VIEWER</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04] text-slate-700 dark:text-slate-300">
              {matrix.map((row: any, i: number) => (
                <tr key={i} className="hover:bg-white dark:bg-slate-900/80 transition-colors">
                  <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{row.module}</td>
                  <td className="px-4 py-3 font-semibold text-purple-700 dark:text-purple-300">{row.OWNER}</td>
                  <td className="px-4 py-3 font-semibold text-blue-700 dark:text-blue-300">{row.ADMIN}</td>
                  <td className="px-4 py-3 font-semibold text-emerald-700 dark:text-emerald-300">{row.AGENT}</td>
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

