"use client";
import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, API_URL, apiFetch } from '@/lib/api';
import { copyToClipboard } from '@/lib/clipboard';
import {
  Settings, Building2, Bot, Phone, MessageSquare, Users, User,
  Save, CheckCircle2, AlertCircle, AlertTriangle, Eye, EyeOff, Copy, Plus,
  Globe, Zap, Shield, X, Loader2, ChevronDown, KeyRound, ScrollText, Landmark
} from 'lucide-react';

type Tab = 'profile' | 'general' | 'whatsapp' | 'voice' | 'agent' | 'team' | 'activity' | 'apikeys';

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
      const res = await apiFetch(`${API_URL}/api/organizations/me`, { headers: authHeaders });
      if (res.ok) {
        setOrg(await res.json());
        return;
      }
      // An expired token is handled by apiFetch, which refreshes or signs the
      // operator out. Anything else reaching here leaves every field on this
      // screen blank — and a blank settings form will happily save itself
      // over the agency's real configuration. Say so rather than look loaded.
      showToast('Could not load this agency’s settings. Reload before saving, or you may overwrite them.', 'error');
    } catch {
      showToast('Could not reach the server to load settings. Reload before saving.', 'error');
    }
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
    { id: 'apikeys' as Tab, label: 'API Key', icon: <KeyRound className="w-4 h-4" /> },
    { id: 'activity' as Tab, label: 'Activity Log', icon: <ScrollText className="w-4 h-4" /> },
  ];

  return (
    <div className="max-w-4xl space-y-6">
      {toast && <Toast msg={toast.msg} type={toast.type} />}

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Settings className="w-6 h-6 text-[#558A02] dark:text-[#74BA03]" /> Agency Settings
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">Configure this agency’s identity, serving hours, telephony credentials and voice assistant.</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm w-fit">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              tab === t.id ? 'bg-[#558A02] text-white shadow-md' : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-800/60'
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
          {tab === 'apikeys' && <ApiKeyTab authHeaders={authHeaders} showToast={showToast} />}
          {tab === 'activity' && <ActivityLogTab showToast={showToast} />}
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
      const res = await apiFetch(`${API_URL}/api/auth/change-password`, {
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
  // What the AI opens conversations in until the customer's own language is
  // detected — once they write in a supported language, the AI follows them.
  const [defaultLanguage, setDefaultLanguage] = useState(org?.defaultLanguage || 'en');
  // When this agency serves citizens. Appointment search offers nothing outside
  // these, so they are the difference between a diary that looks full and one
  // that is. 0 = Sunday … 6 = Saturday.
  const [openingHour, setOpeningHour] = useState<number>(org?.openingHour ?? 8);
  const [closingHour, setClosingHour] = useState<number>(org?.closingHour ?? 18);
  const [serviceDays, setServiceDays] = useState<number[]>(org?.serviceDays ?? [1, 2, 3, 4, 5]);
  const [saving, setSaving] = useState(false);

  const toggleDay = (d: number) =>
    setServiceDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiFetch(`${API_URL}/api/organizations/settings`, {
        method: 'PATCH', headers: authHeaders,
        body: JSON.stringify({
          name, aiPersonaPrompt, welcomeMessage, defaultLanguage,
          payoutBankName, payoutAccountName, payoutAccountNumber, payoutUssdCode,
          openingHour, closingHour, serviceDays,
        }),
      });
      // The API rejects hours that cannot produce an appointment and says why.
      // Showing its reason beats a generic failure for a form whose mistakes
      // are easy to make and invisible until a citizen is told nothing is free.
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || 'Failed');
      }
      showToast('Settings saved!');
      onSaved();
    } catch { showToast('Failed to save settings', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <Section title="Organization Profile" description="Basic info about your business">
        <div>
          <label className={labelCls} htmlFor="org-name">Organization Name</label>
          <input id="org-name" aria-label="Organization Name" type="text" value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="e.g. Apex Care Services" />
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
        <div>
          <label className={labelCls}>Default Language</label>
          <select
            aria-label="Default Language"
            value={defaultLanguage}
            onChange={e => setDefaultLanguage(e.target.value)}
            className={inputCls}
          >
            <option value="en">English</option>
            <option value="pcm">Nigerian Pidgin</option>
            <option value="ha">Hausa</option>
            <option value="ig">Igbo</option>
            <option value="yo">Yoruba</option>
          </select>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
            The language the AI uses until a customer&apos;s own language is known. Once someone writes in
            English, Pidgin, Hausa, Igbo or Yoruba, the AI follows their language automatically.
          </p>
        </div>
      </Section>

      <Section
        title="Serving Hours"
        description="When this agency can see citizens. Appointment search offers times inside these hours only — nothing outside them is ever proposed."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Opens at</label>
            <select aria-label="Opens at" value={openingHour} onChange={e => setOpeningHour(Number(e.target.value))} className={inputCls}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Closes at</label>
            <select aria-label="Closes at" value={closingHour} onChange={e => setClosingHour(Number(e.target.value))} className={inputCls}>
              {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className={labelCls}>Days open</label>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, d) => {
              const on = serviceDays.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleDay(d)}
                  aria-pressed={on}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors ${
                    on
                      ? 'bg-[#558A02] text-white border-[#558A02]'
                      : 'bg-transparent text-slate-500 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
            All times are West Africa Time. A 24-hour service sets 00:00 to 24:00 and selects every day.
          </p>
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
  // Fix: the API returns `whatsAppConfigs` (capital A), not `whatsappConfigs`
  const wa = org?.whatsAppConfigs?.[0] || {};
  const [phoneNumberId, setPhoneNumberId] = useState(wa.phoneNumberId || '');
  const [whatsappBusinessId, setWhatsappBusinessId] = useState(wa.whatsappBusinessId || '');
  const [accessToken, setAccessToken] = useState(''); // never pre-fill — always masked on server
  const [displayPhoneNumber, setDisplayPhoneNumber] = useState(wa.displayPhoneNumber || '');
  const [webhookVerifyToken, setWebhookVerifyToken] = useState(''); // never pre-fill — always masked on server
  const [showToken, setShowToken] = useState(false);
  const [showVerifyToken, setShowVerifyToken] = useState(false);
  const [saving, setSaving] = useState(false);

  const webhookUrl = `${API_URL}/api/whatsapp/webhook`;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneNumberId.trim() || !accessToken.trim() || !webhookVerifyToken.trim()) {
      showToast('Phone Number ID, Access Token, and Webhook Verify Token are required', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch(`${API_URL}/api/organizations/whatsapp-config`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({
          phoneNumberId: phoneNumberId.trim(),
          whatsappBusinessId: whatsappBusinessId.trim(),
          accessToken: accessToken.trim(),
          webhookVerifyToken: webhookVerifyToken.trim(),
          displayPhoneNumber: displayPhoneNumber.trim() || phoneNumberId.trim(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.message || 'Save failed');
      }
      showToast('WhatsApp config saved!');
    } catch (err: any) { showToast(err?.message || 'Failed to save', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <Section title="WhatsApp Cloud API" description="Connect your Meta Business WhatsApp number">
        <div className="p-4 rounded-xl bg-blue-500/[0.06] border border-blue-200 dark:border-blue-500/20">
          <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 mb-1">📌 Webhook URL — paste this in Meta Developer Portal → WhatsApp → Configuration</p>
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
          <label className={labelCls}>WhatsApp Business Account ID (WABA ID)</label>
          <input type="text" value={whatsappBusinessId} onChange={e => setWhatsappBusinessId(e.target.value)} className={inputCls} placeholder="From Meta Business Manager → Accounts → WhatsApp Accounts" />
        </div>
        <div>
          <label className={labelCls}>Display Phone Number (e.g. +1 555 671-9884)</label>
          <input type="text" value={displayPhoneNumber} onChange={e => setDisplayPhoneNumber(e.target.value)} className={inputCls} placeholder="+1 555 671-9884" />
        </div>
        <div>
          <label className={labelCls}>Permanent Access Token <span className="text-slate-400 font-normal normal-case">(EAA…)</span></label>
          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              value={accessToken}
              onChange={e => setAccessToken(e.target.value)}
              className={`${inputCls} pr-12`}
              placeholder={wa.accessToken ? `Current: ${wa.accessToken} — enter new to replace` : 'EAA...'}
            />
            <button type="button" onClick={() => setShowToken(!showToken)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:text-slate-300">
              {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div>
          <label className={labelCls}>Webhook Verify Token <span className="text-slate-400 font-normal normal-case">(you choose — must match Meta Dashboard)</span></label>
          <div className="relative">
            <input
              type={showVerifyToken ? 'text' : 'password'}
              value={webhookVerifyToken}
              onChange={e => setWebhookVerifyToken(e.target.value)}
              className={`${inputCls} pr-12`}
              placeholder={wa.webhookVerifyToken ? `Current: ${wa.webhookVerifyToken} — enter new to replace` : 'e.g. my_verify_token_123'}
            />
            <button type="button" onClick={() => setShowVerifyToken(!showVerifyToken)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:text-slate-300">
              {showVerifyToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
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
/**
 * How the agency's phone line is connected.
 *
 * Four things here were wrong, and each of them was invisible from the
 * dashboard — the form saved, or appeared to, and the damage showed up on a
 * phone line instead.
 *
 * **Two of the five providers could never be saved.** The list read
 * `AFRICA_TALKING` and `NIGERIAN_CARRIER`; the enum says `AFRICAS_TALKING` and
 * `NIGERIA_CARRIER_FORWARD`. Both reached Prisma and came back as a bare 500,
 * so choosing either showed "Failed to save" with no reason, every time. The
 * API now answers 400 with the valid list, and this list is the valid list.
 *
 * **Secrets were pre-filled from their own masks.** `GET /me` returns
 * `••••1234`, this form put that in the input, and saving wrote the mask as the
 * credential — encrypted, stored, and rejected by Twilio as a bad auth token on
 * the next call. Nothing is pre-filled now: what is configured is shown as
 * text, the box starts empty, and an untouched box sends nothing.
 *
 * **A SIP trunk could not be configured at all**, so
 * `/api/agent-provisioning/numbers/import-sip` could only ever answer "No SIP
 * trunk is configured" — the one path that removes the Twilio dependency, with
 * no way to fill in its fields.
 *
 * **`forwardingNumber` had no field.** Both voice handoff paths refuse with
 * "Set one under Settings → Telephony and try again", which was a pointer to
 * somewhere that did not exist.
 */

/** Providers, with the enum value the API expects and a label a human reads. */
const VOICE_PROVIDERS: Array<{ value: string; label: string; note?: string }> = [
  { value: 'TWILIO', label: 'Twilio' },
  { value: 'SIP_TRUNK', label: 'SIP trunk (local carrier)', note: 'Answered by the hosted agent — no Twilio' },
  { value: 'AFRICAS_TALKING', label: "Africa's Talking" },
  { value: 'NIGERIA_CARRIER_FORWARD', label: 'Nigerian carrier forwarding' },
  { value: 'MTN_ENTERPRISE_SIP', label: 'MTN Business SIP (inbound only)' },
  { value: 'AIRTEL_BUSINESS_SIP', label: 'Airtel Business SIP (inbound only)' },
  { value: 'PLIVO', label: 'Plivo' },
  { value: 'TELNYX', label: 'Telnyx' },
];

/** Which inbound webhook a provider delivers to, or null when it sends us none. */
function inboundWebhookPath(provider: string): string | null {
  switch (provider) {
    case 'TWILIO':
    case 'MTN_ENTERPRISE_SIP':
    case 'AIRTEL_BUSINESS_SIP':
      // The carrier-SIP arrangements route into a Twilio SIP domain, so the
      // call arrives on the Twilio webhook.
      return 'twilio';
    case 'AFRICAS_TALKING':
      // The route is 'africa-talking' (singular) while the provider enum is
      // AFRICAS_TALKING. Spelling it from the enum hands the operator a URL
      // that 404s, and they would point their carrier at it.
      return 'africa-talking';
    case 'NIGERIA_CARRIER_FORWARD':
      return 'nigeria-carrier';
    case 'TELNYX':
      return 'telnyx';
    // A SIP trunk goes to ElevenLabs, which answers it. Showing a webhook URL
    // for it would invite an operator to point the trunk back here and undo the
    // cutover. Plivo has no inbound route in this API.
    default:
      return null;
  }
}

/**
 * A labelled control.
 *
 * The labels on this form were bare `<label>` elements with no `htmlFor`, so
 * nothing tied them to their inputs: a screen reader announced an unlabelled
 * text box, and clicking the label did not focus it. On a government platform
 * that is a defect in its own right, and it is also why these fields were
 * unreachable by name from a test.
 */
function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className={labelCls}>{label}</label>
      {children}
      {hint && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">{hint}</p>}
    </div>
  );
}

/** What is stored, shown as text — never as the contents of an input. */
function Configured({ value }: { value?: string | null }) {
  if (!value) return <span className="text-slate-400 dark:text-slate-500">not set</span>;
  return <span className="font-mono text-slate-600 dark:text-slate-300">{value}</span>;
}

function VoiceTab({ org, authHeaders, showToast }: any) {
  const tc = org?.telephonyConfigs?.[0] || {};
  const [provider, setProvider] = useState(tc.provider || 'TWILIO');
  const [phoneNumber, setPhoneNumber] = useState(tc.phoneNumber || '');
  const [forwardingNumber, setForwardingNumber] = useState(tc.forwardingNumber || '');

  // Credentials start EMPTY and are sent only when typed. See the note above:
  // pre-filling these from the masked read wrote the mask as the secret.
  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [apiKey, setApiKey] = useState('');

  const [sipAddress, setSipAddress] = useState(tc.sipAddress || '');
  const [sipTransport, setSipTransport] = useState(tc.sipTransport || 'udp');
  const [sipUsername, setSipUsername] = useState(tc.sipUsername || '');
  const [sipPassword, setSipPassword] = useState('');

  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSip = provider === 'SIP_TRUNK';
  const usesAccount = provider === 'TWILIO' || provider === 'PLIVO';
  const usesApiKey = provider === 'AFRICAS_TALKING' || provider === 'NIGERIA_CARRIER_FORWARD' || provider === 'TELNYX';
  const webhookPath = inboundWebhookPath(provider);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { provider, phoneNumber, forwardingNumber };
      if (usesAccount) {
        if (accountSid) body.accountSid = accountSid;
        if (authToken) body.authToken = authToken;
      }
      if (usesApiKey && apiKey) body.apiKey = apiKey;
      if (isSip) {
        body.sipAddress = sipAddress;
        body.sipTransport = sipTransport;
        body.sipUsername = sipUsername;
        if (sipPassword) body.sipPassword = sipPassword;
      }

      const res = await apiFetch(`${API_URL}/api/organizations/telephony-config`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        // The API's message names the field and the valid values. Replacing it
        // with "Failed to save" is what left an operator with two unsaveable
        // providers and nothing to go on.
        throw new Error(
          Array.isArray(payload?.message) ? payload.message.join(' ') : payload?.message || 'Could not save the voice configuration.'
        );
      }
      // Cleared so a saved credential is never sitting in the DOM, and so the
      // next save does not re-send one the operator did not retype.
      setAuthToken(''); setApiKey(''); setSipPassword(''); setAccountSid('');
      showToast('Voice config saved!');
    } catch (err: any) {
      setError(err?.message || 'Could not save the voice configuration.');
      showToast('Failed to save', 'error');
    }
    finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <Section title="Voice AI Telephony" description="How citizens' calls reach this agency">
        <Field
          id="voice-provider"
          label="Provider"
          hint={VOICE_PROVIDERS.find(p => p.value === provider)?.note}
        >
          <select id="voice-provider" value={provider} onChange={e => setProvider(e.target.value)} className={selectCls}>
            {VOICE_PROVIDERS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </Field>
        <Field id="voice-number" label="Phone Number">
          <input id="voice-number" type="tel" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} className={inputCls} placeholder="+2348012345678" />
        </Field>
        <Field
          id="voice-forwarding"
          label="Forwarding Number"
          hint={
            <>
              Where a call goes when the AI hands over to a person. With none set, a handover files a
              high-priority ticket instead and the caller is told so — the AI never claims a transfer it
              cannot make.
            </>
          }
        >
          <input id="voice-forwarding" type="tel" value={forwardingNumber} onChange={e => setForwardingNumber(e.target.value)} className={inputCls} placeholder="+2348090000000" />
        </Field>

        {usesAccount && (
          <>
            <Field
              id="voice-account-sid"
              label={provider === 'TWILIO' ? 'Account SID' : 'Auth ID'}
              hint={<>Saved: <Configured value={tc.accountSid} /></>}
            >
              <input id="voice-account-sid" type="text" value={accountSid} onChange={e => setAccountSid(e.target.value)} className={inputCls} placeholder="Leave blank to keep the saved value" />
            </Field>
            <Field
              id="voice-auth-token"
              label="Auth Token"
              hint={<>Saved: <Configured value={tc.authToken} /></>}
            >
              <div className="relative">
                <input id="voice-auth-token" type={showSecret ? 'text' : 'password'} value={authToken} onChange={e => setAuthToken(e.target.value)} className={`${inputCls} pr-12`} placeholder="Leave blank to keep the saved value" />
                <button type="button" onClick={() => setShowSecret(!showSecret)} aria-label={showSecret ? 'Hide secret' : 'Show secret'} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-700">
                  {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </Field>
          </>
        )}

        {usesApiKey && (
          <Field
            id="voice-api-key"
            label="API Key"
            hint={<>Saved: <Configured value={tc.apiKey} /></>}
          >
            <div className="relative">
              <input id="voice-api-key" type={showSecret ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value)} className={`${inputCls} pr-12`} placeholder="Leave blank to keep the saved value" />
              <button type="button" onClick={() => setShowSecret(!showSecret)} aria-label={showSecret ? 'Hide secret' : 'Show secret'} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-700">
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </Field>
        )}
      </Section>

      {isSip && (
        <Section
          title="SIP trunk"
          description="The trunk the hosted agent answers. Your carrier supplies these."
        >
          <Field id="sip-address" label="SIP Host Address">
            <input id="sip-address" type="text" value={sipAddress} onChange={e => setSipAddress(e.target.value)} className={inputCls} placeholder="sip.carrier.ng" />
          </Field>
          <Field id="sip-transport" label="Transport">
            <select id="sip-transport" value={sipTransport} onChange={e => setSipTransport(e.target.value)} className={selectCls}>
              {['udp', 'tcp', 'tls', 'auto'].map(t => (
                <option key={t} value={t}>{t.toUpperCase()}</option>
              ))}
            </select>
          </Field>
          <Field id="sip-username" label="SIP Username">
            <input id="sip-username" type="text" value={sipUsername} onChange={e => setSipUsername(e.target.value)} className={inputCls} placeholder="Leave blank for an IP-authenticated trunk" />
          </Field>
          <Field
            id="sip-password"
            label="SIP Password"
            hint={
              <>
                Saved: <Configured value={tc.sipPassword} /> — digest authentication needs a username and a
                password together, or neither if your carrier authenticates the trunk by IP address.
              </>
            }
          >
            <div className="relative">
              <input id="sip-password" type={showSecret ? 'text' : 'password'} value={sipPassword} onChange={e => setSipPassword(e.target.value)} className={`${inputCls} pr-12`} placeholder="Leave blank to keep the saved value" />
              <button type="button" onClick={() => setShowSecret(!showSecret)} aria-label={showSecret ? 'Hide secret' : 'Show secret'} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-700">
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </Field>
          <div className="p-4 rounded-xl bg-blue-500/[0.06] border border-blue-200 dark:border-blue-500/20 text-xs text-blue-700 dark:text-blue-300">
            Saving the trunk here does not move any calls. Hand it to the agent from{' '}
            <Link href="/agent-provisioning" className="underline font-semibold">Agent provisioning</Link>, which
            states what the cutover changes before it happens.
          </div>
        </Section>
      )}

      <Section title="Inbound webhook" description="Where the carrier delivers a call">
        {webhookPath ? (
          <div className="p-4 rounded-xl bg-amber-500/[0.06] border border-amber-200 dark:border-amber-500/20 text-xs text-amber-700 dark:text-amber-300 flex items-center justify-between gap-3">
            <div>
              <strong>Inbound Voice Webhook URL:</strong>
              <code className="ml-2 font-mono break-all">{API_URL}/api/telephony/inbound/{webhookPath}</code>
            </div>
            <button
              type="button"
              onClick={async () => {
                const ok = await copyToClipboard(`${API_URL}/api/telephony/inbound/${webhookPath}`);
                if (ok) showToast('Telephony Webhook URL copied!');
              }}
              className="px-2.5 py-1 rounded bg-amber-100 dark:bg-amber-800/40 text-amber-800 dark:text-amber-200 hover:bg-amber-200 font-semibold text-[11px] flex items-center gap-1 shrink-0"
            >
              <Copy className="w-3 h-3" /> Copy
            </button>
          </div>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {isSip
              ? 'A SIP trunk is answered by the hosted agent, so no call is delivered to this platform. Point the trunk at ElevenLabs, not here.'
              : 'This provider has no inbound route in this platform. Calls to it do not reach the AI.'}
          </p>
        )}
      </Section>

      {error && (
        <div className="p-4 rounded-xl bg-red-500/[0.06] border border-red-200 dark:border-red-500/20 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex justify-end">
        <button type="submit" disabled={saving} className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm disabled:opacity-50 transition-all shadow-lg shadow-blue-500/20">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving...' : 'Save Voice Config'}
        </button>
      </div>
    </form>
  );
}

// ─────────────────────── API Key Tab ───────────────────────
/**
 * The agency's integration key.
 *
 * `POST /api/organizations/api-keys/regenerate` has existed, audited, with no
 * screen — so the only way to rotate the key an agency's own integrations
 * authenticate with was a curl command, and a credential nobody can rotate
 * without a terminal does not get rotated.
 *
 * Three things this screen has to get right, because the endpoint returns a
 * LIVE credential exactly once:
 *
 *   IT IS SHOWN ONCE. Only a SHA-256 hash is stored, so nothing can show it
 *   again — the panel says that before the operator navigates away, and copying
 *   it is one click rather than a careful selection.
 *
 *   ROTATING IS NOT FREE. A new key does not disable the old one here (it adds
 *   a key), but anything still using an old key should be moved over, so the
 *   confirmation says what the operator needs to go and do.
 *
 *   A REFUSAL IS RENDERED. This is OWNER/ADMIN; a member reaching the tab sees
 *   the server's 403 rather than a button that silently fails.
 */
function ApiKeyTab({ authHeaders, showToast }: any) {
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const rotate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_URL}/api/organizations/api-keys/regenerate`, {
        method: 'POST',
        headers: authHeaders,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.apiKey) {
        throw new Error(
          (Array.isArray(body?.message) ? body.message.join(' ') : body?.message) ||
          'Could not issue a new key.'
        );
      }
      setIssued(body.apiKey);
      setConfirming(false);
      showToast('A new API key has been issued.');
    } catch (err: any) {
      setError(err?.message || 'Could not issue a new key.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <Section
        title="Integration API key"
        description="What this agency's own systems use to call the platform"
      >
        {issued ? (
          <div className="space-y-3">
            <div className="p-4 rounded-xl bg-emerald-500/[0.07] border border-emerald-200 dark:border-emerald-500/20">
              <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-200 mb-2">
                Copy this now — it cannot be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 font-mono text-xs break-all text-slate-900 dark:text-white bg-white dark:bg-slate-900 rounded-lg px-3 py-2 border border-emerald-200 dark:border-emerald-500/30">
                  {issued}
                </code>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await copyToClipboard(issued);
                    if (ok) showToast('API key copied.');
                  }}
                  className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 shrink-0"
                >
                  <Copy className="w-3.5 h-3.5" /> Copy
                </button>
              </div>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Only a hash of it is stored, which is why this is the one time it is readable. Move any
              integration still using an older key over to this one.
            </p>
            <button
              type="button"
              onClick={() => setIssued(null)}
              className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
            >
              I have copied it
            </button>
          </div>
        ) : confirming ? (
          <div className="space-y-3">
            <div className="p-4 rounded-xl bg-amber-500/[0.08] border border-amber-200 dark:border-amber-500/20 text-xs text-amber-800 dark:text-amber-200">
              A new key is issued and shown once. Existing keys keep working until they are removed,
              so nothing breaks the moment you click — but anything still using an old key should be
              moved over.
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={rotate}
                disabled={busy}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-semibold text-sm disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                {busy ? 'Issuing…' : 'Issue a new key'}
              </button>
              <button
                type="button"
                onClick={() => { setConfirming(false); setError(null); }}
                className="px-5 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-200 font-semibold text-sm"
              >
                Not now
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              The key itself is never readable after it is issued — only a hash is kept. If it has
              been shared or exposed, issue a new one.
            </p>
            <button
              type="button"
              onClick={() => { setConfirming(true); setError(null); }}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm"
            >
              <KeyRound className="w-4 h-4" /> Issue a new API key
            </button>
          </div>
        )}

        {error && (
          <div className="p-3 rounded-xl bg-red-500/[0.06] border border-red-200 dark:border-red-500/20 text-xs text-red-700 dark:text-red-300">
            {error}
          </div>
        )}
      </Section>
    </div>
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
              Provisioning the agent, importing a phone number and attaching a WhatsApp line live on{' '}
              <Link href="/agent-provisioning" className="text-blue-600 dark:text-blue-400 font-semibold hover:underline">
                Agent Provisioning
              </Link>
              , not here — importing a number changes who answers your citizens, so it needs its own
              confirmation rather than a button on a settings screen.
            </p>
          </div>
        )}
      </Section>
    </div>
  );
}

// ─────────────────────── Activity Log Tab ───────────────────────

/**
 * Who changed what, in this agency.
 *
 * Until this existed the only reader of the audit table was the ministry's own
 * console, so an agency could not find out who had promoted somebody, who had
 * minted an API key, or — the part that matters most — what the ministry had
 * done to the agency and why. A record that only the party with the most reach
 * can read is not accountability.
 *
 * Two things the screen states rather than leaves to be inferred:
 *
 *   - WHETHER WE DID IT OR IT WAS DONE TO US. The server marks each entry
 *     `agency` or `platform`. An operator scanning for "why were we suspended"
 *     should not have to decode an action prefix to find it.
 *   - THAT AN OUTSIDE ACTOR IS NOT NAMED. The ministry's officials are staff of
 *     another tenancy, so the trail describes the role instead. Saying so is
 *     better than letting somebody conclude the record is simply vague.
 */
function ActivityLogTab({ showToast }: any) {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [origin, setOrigin] = useState<'all' | 'agency' | 'platform'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setForbidden(false);
    try {
      const res = await api.organizations.getAudit({ limit: 200 });
      setEntries(res.entries ?? []);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      // A 403 is a legitimate answer for an AGENT or VIEWER, not a fault.
      if (/permission|forbidden|403/i.test(msg)) setForbidden(true);
      else showToast(msg || 'Could not read the activity log', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (forbidden) {
    return (
      <Section
        title="Activity Log"
        description="Who changed what in this agency, and what was done to it."
      >
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Only an OWNER or ADMIN can read the activity log. It names which colleague changed
          somebody&rsquo;s role or deactivated an account, which is administrative information
          rather than something needed to handle citizens.
        </p>
      </Section>
    );
  }

  const shown = entries.filter(e => origin === 'all' || e.origin === origin);
  const platformCount = entries.filter(e => e.origin === 'platform').length;

  return (
    <div className="space-y-5">
      <Section
        title="Activity Log"
        description="Append-only. Nothing here can be edited or removed, including by this agency."
      >
        <div className="flex flex-wrap items-center gap-2">
          {([
            ['all', `Everything (${entries.length})`],
            ['agency', `By this agency (${entries.length - platformCount})`],
            ['platform', `By the ministry (${platformCount})`],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setOrigin(id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                origin === id
                  ? 'bg-[#558A02] text-white border-[#558A02]'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              {label}
            </button>
          ))}
          <button
            onClick={load}
            disabled={loading}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            Refresh
          </button>
        </div>

        {platformCount > 0 && (
          <div className="flex gap-2.5 p-4 rounded-xl bg-blue-500/[0.06] border border-blue-200 dark:border-blue-500/20">
            <Landmark className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
              {platformCount === 1 ? 'One entry was' : `${platformCount} entries were`} recorded by the
              operating ministry rather than by this agency. Their officials are staff of another
              organisation, so the log names the role and not the person — which official it was is a
              question for the ministry.
            </p>
          </div>
        )}

        {loading && entries.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-500 dark:text-slate-400 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-blue-600 dark:text-blue-400" /> Reading the log...
          </div>
        ) : shown.length === 0 ? (
          <p className="py-10 text-center text-xs text-slate-500 dark:text-slate-400">
            {entries.length === 0
              ? 'Nothing has been recorded yet. Changes to team roles, account access and API keys appear here as they happen.'
              : 'Nothing recorded in this category.'}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
            {shown.map(e => (
              <li key={e.id} className="px-4 py-3 space-y-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`text-[10px] px-2 py-0.5 rounded-lg font-bold border flex-shrink-0 ${
                      e.origin === 'platform'
                        ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-500/20'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                    }`}>
                      {e.origin === 'platform' ? 'MINISTRY' : 'THIS AGENCY'}
                    </span>
                    <code className="text-xs font-mono font-semibold text-slate-900 dark:text-white truncate">
                      {e.action}
                    </code>
                  </div>
                  <span className="text-[10px] text-slate-400 flex-shrink-0">
                    {new Date(e.createdAt).toLocaleString('en-NG')}
                  </span>
                </div>

                <p className="text-[11px] text-slate-600 dark:text-slate-400">
                  by <span className={e.actorIsOwnStaff ? 'font-semibold text-slate-800 dark:text-slate-200' : 'italic'}>{e.actor}</span>
                  {' · '}{e.targetType}
                </p>

                {/* The shape of the change, both sides where there are two.
                    A role change is unreadable without the value it replaced. */}
                <ChangeSummary previous={e.previousValue} next={e.newValue} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/**
 * Renders a change as the fields that moved.
 *
 * Deliberately not a JSON dump: these values are written by code, not by a
 * person, so a reader wants "role: AGENT → ADMIN", not a brace-delimited blob
 * they have to parse by eye.
 */
function ChangeSummary({ previous, next }: { previous: any; next: any }) {
  const prev = previous && typeof previous === 'object' ? previous : null;
  const now = next && typeof next === 'object' ? next : null;
  if (!prev && !now) return null;

  const keys = Array.from(new Set([...Object.keys(prev ?? {}), ...Object.keys(now ?? {})]));
  if (keys.length === 0) return null;

  const show = (v: any) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
      {keys.map(k => {
        const before = prev?.[k];
        const after = now?.[k];
        const changed = prev && now && show(before) !== show(after);
        return (
          <div key={k} className="text-[11px]">
            <dt className="inline text-slate-400">{k}: </dt>
            <dd className="inline text-slate-700 dark:text-slate-300 font-mono">
              {changed ? <>{show(before)} <span className="text-slate-400">&rarr;</span> {show(after)}</> : show(after ?? before)}
            </dd>
          </div>
        );
      })}
    </dl>
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
    } catch (err: any) {
      // An empty team list reads as "this agency has one member", which is a
      // different and much less alarming statement than "we could not ask".
      showToast(err?.message || 'Could not load the team list.', 'error');
    }
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

