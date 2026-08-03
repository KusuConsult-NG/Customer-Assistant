"use client";
import React, { useEffect, useState, useCallback } from 'react';
import { API_URL } from '@/lib/api';
import {
  Palette, Globe, Key, Webhook, Save, Copy, RefreshCw,
  Eye, EyeOff, CheckCircle2, Loader2, AlertCircle, Lock,
  Zap, Shield, ToggleLeft, ToggleRight
} from 'lucide-react';

const inputCls = "w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all placeholder-gray-600";
const labelCls = "text-xs font-semibold text-gray-400 mb-1.5 block uppercase tracking-wider";

const WEBHOOK_EVENTS = [
  { key: 'call.started', label: 'Call Started', desc: 'Fired when a voice call begins' },
  { key: 'call.ended', label: 'Call Ended', desc: 'Fired when a voice call concludes' },
  { key: 'message.received', label: 'Message Received', desc: 'New WhatsApp or webchat message' },
  { key: 'lead.captured', label: 'Lead Captured', desc: 'AI creates a new lead from a conversation' },
  { key: 'appointment.booked', label: 'Appointment Booked', desc: 'Customer books a slot via AI' },
  { key: 'ticket.created', label: 'Support Ticket Created', desc: 'Escalation ticket opened' },
  { key: 'handover.requested', label: 'Human Handover', desc: 'AI passes conversation to human agent' },
];

export default function WhiteLabelPage() {
  const [org, setOrg] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  // Branding state
  const [companyName, setCompanyName] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#3b82f6');
  const [secondaryColor, setSecondaryColor] = useState('#8b5cf6');
  const [customDomain, setCustomDomain] = useState('');
  const [logoPreview, setLogoPreview] = useState<string | null>(null);

  // Webhook state
  const [webhookUrl, setWebhookUrl] = useState('');
  const [enabledEvents, setEnabledEvents] = useState<string[]>([]);
  const [showApiKey, setShowApiKey] = useState(false);
  const [generatingKey, setGeneratingKey] = useState(false);

  const token = typeof window !== 'undefined' ? localStorage.getItem('ace_token') : '';
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchOrg = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/organizations/me`, { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setOrg(data);
        setCompanyName(data.name || '');
        setPrimaryColor(data.primaryColor || '#3b82f6');
        setSecondaryColor(data.secondaryColor || '#8b5cf6');
        setCustomDomain(data.customDomain || '');
        setWebhookUrl(data.webhookUrl || '');
        setEnabledEvents(data.enabledWebhookEvents || []);
        if (data.logoUrl) setLogoPreview(data.logoUrl);
      }
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchOrg(); }, [fetchOrg]);

  const saveBranding = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/organizations/settings`, {
        method: 'PATCH', headers: authHeaders,
        body: JSON.stringify({ name: companyName, primaryColor, secondaryColor, customDomain }),
      });
      if (!res.ok) throw new Error();
      showToast('Branding saved!');
    } catch { showToast('Failed to save', 'error'); }
    finally { setSaving(false); }
  };

  const saveWebhooks = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/organizations/settings`, {
        method: 'PATCH', headers: authHeaders,
        body: JSON.stringify({ webhookUrl, enabledWebhookEvents: enabledEvents }),
      });
      if (!res.ok) throw new Error();
      showToast('Webhook settings saved!');
    } catch { showToast('Failed to save', 'error'); }
    finally { setSaving(false); }
  };

  const toggleEvent = (key: string) => {
    setEnabledEvents(prev =>
      prev.includes(key) ? prev.filter(e => e !== key) : [...prev, key]
    );
  };

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setLogoPreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  const apiKey = org?.apiKey || 'sk-ace-••••••••••••••••••••••••••••••';
  const maskedKey = showApiKey ? apiKey : apiKey.replace(/sk-ace-.{20,}/, (m: string) => 'sk-ace-' + '•'.repeat(m.length - 7));

  return (
    <div className="max-w-6xl space-y-6">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 right-5 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border text-sm font-medium ${
          toast.type === 'success' ? 'bg-emerald-900/80 border-emerald-500/30 text-emerald-300' : 'bg-red-900/80 border-red-500/30 text-red-300'
        }`}>
          {toast.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Palette className="w-6 h-6 text-purple-400" /> White-Label & API
        </h1>
        <p className="text-sm text-gray-400 mt-1">Customize your brand identity and configure developer integrations.</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-blue-400 animate-spin" /></div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
          {/* Left column: Config */}
          <div className="xl:col-span-3 space-y-5">
            {/* Branding */}
            <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
              <div className="px-6 py-4 border-b border-white/[0.06] flex items-center gap-2">
                <Palette className="w-4 h-4 text-purple-400" />
                <h3 className="font-semibold text-white">Brand Identity</h3>
              </div>
              <form onSubmit={saveBranding} className="p-6 space-y-4">
                <div className="flex items-center gap-4">
                  <div
                    className="w-16 h-16 rounded-2xl border-2 border-dashed border-white/[0.12] flex items-center justify-center overflow-hidden cursor-pointer relative flex-shrink-0 hover:border-blue-500/40 transition-all"
                    onClick={() => document.getElementById('logo-upload')?.click()}
                  >
                    {logoPreview
                      ? <img src={logoPreview} alt="logo" className="w-full h-full object-cover" />
                      : <div className="text-2xl font-black text-gray-600">{(companyName || 'A')[0]}</div>
                    }
                    <input id="logo-upload" type="file" accept="image/*" onChange={handleLogoChange} className="hidden" />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Company Name</label>
                    <input type="text" value={companyName} onChange={e => setCompanyName(e.target.value)} className={inputCls} placeholder="Your Company Ltd" />
                  </div>
                </div>

                <div>
                  <label className={labelCls}>Custom Domain</label>
                  <div className="relative">
                    <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                    <input type="text" value={customDomain} onChange={e => setCustomDomain(e.target.value)} className={`${inputCls} pl-10`} placeholder="app.yourcompany.com" />
                  </div>
                  <p className="text-xs text-gray-600 mt-1.5">Point your domain's CNAME to <code className="text-blue-400">platform.ace-ai.io</code> then enter it here.</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>Primary Color</label>
                    <div className="flex items-center gap-2">
                      <input type="color" value={primaryColor} onChange={e => setPrimaryColor(e.target.value)}
                        className="w-12 h-10 rounded-xl border border-white/10 cursor-pointer bg-transparent" />
                      <input type="text" value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} className={inputCls} placeholder="#3b82f6" />
                    </div>
                  </div>
                  <div>
                    <label className={labelCls}>Secondary Color</label>
                    <div className="flex items-center gap-2">
                      <input type="color" value={secondaryColor} onChange={e => setSecondaryColor(e.target.value)}
                        className="w-12 h-10 rounded-xl border border-white/10 cursor-pointer bg-transparent" />
                      <input type="text" value={secondaryColor} onChange={e => setSecondaryColor(e.target.value)} className={inputCls} placeholder="#8b5cf6" />
                    </div>
                  </div>
                </div>

                <button type="submit" disabled={saving} className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm disabled:opacity-50 transition-all shadow-lg shadow-blue-500/20">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save Branding
                </button>
              </form>
            </div>

            {/* API Key */}
            <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
              <div className="px-6 py-4 border-b border-white/[0.06] flex items-center gap-2">
                <Key className="w-4 h-4 text-amber-400" />
                <h3 className="font-semibold text-white">API Access</h3>
              </div>
              <div className="p-6 space-y-4">
                <div className="p-4 rounded-xl bg-amber-500/[0.06] border border-amber-500/20 text-xs text-amber-300 flex items-start gap-2">
                  <Shield className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  Keep your API key secret. Never expose it in client-side code.
                </div>
                <div>
                  <label className={labelCls}>Your API Key</label>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 px-4 py-2.5 rounded-xl bg-black/30 border border-white/[0.08] font-mono text-sm text-gray-300 overflow-hidden">
                      {maskedKey}
                    </div>
                    <button
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-gray-400 hover:text-gray-200 transition-all"
                    >
                      {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => { navigator.clipboard.writeText(apiKey); showToast('API key copied!'); }}
                      className="p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-gray-400 hover:text-gray-200 transition-all"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-gray-600">
                  Use this key in the <code className="text-blue-400">Authorization: Bearer sk-ace-...</code> header to call the ACE Platform REST API.
                </p>
              </div>
            </div>

            {/* Webhooks */}
            <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
              <div className="px-6 py-4 border-b border-white/[0.06] flex items-center gap-2">
                <Webhook className="w-4 h-4 text-blue-400" />
                <h3 className="font-semibold text-white">Webhook Subscriptions</h3>
              </div>
              <form onSubmit={saveWebhooks} className="p-6 space-y-5">
                <div>
                  <label className={labelCls}>Webhook Endpoint URL</label>
                  <input type="url" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} className={inputCls} placeholder="https://yourserver.com/webhook/ace" />
                  <p className="text-xs text-gray-600 mt-1.5">We'll POST JSON events to this URL with <code className="text-blue-400">X-ACE-Signature</code> header for HMAC verification.</p>
                </div>

                <div>
                  <label className={labelCls}>Event Subscriptions</label>
                  <div className="space-y-2">
                    {WEBHOOK_EVENTS.map(ev => (
                      <div key={ev.key} className="flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.04] transition-all">
                        <div>
                          <p className="text-sm font-medium text-gray-200">{ev.label}</p>
                          <p className="text-xs text-gray-500">{ev.desc}</p>
                        </div>
                        <button type="button" onClick={() => toggleEvent(ev.key)} className="flex-shrink-0">
                          {enabledEvents.includes(ev.key)
                            ? <ToggleRight className="w-8 h-8 text-blue-400" />
                            : <ToggleLeft className="w-8 h-8 text-gray-600" />
                          }
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <button type="submit" disabled={saving} className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm disabled:opacity-50 transition-all shadow-lg shadow-blue-500/20">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save Webhooks
                </button>
              </form>
            </div>
          </div>

          {/* Right column: Live preview */}
          <div className="xl:col-span-2">
            <div className="sticky top-4 space-y-4">
              <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
                <div className="px-5 py-4 border-b border-white/[0.06]">
                  <h3 className="font-semibold text-white text-sm flex items-center gap-2">
                    <Eye className="w-4 h-4 text-gray-400" /> Live Brand Preview
                  </h3>
                </div>
                <div className="p-5">
                  {/* Mini platform preview */}
                  <div className="rounded-xl overflow-hidden border border-white/[0.08]" style={{ background: '#0a0f1e' }}>
                    {/* Fake topbar */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]"
                      style={{ background: `linear-gradient(135deg, ${primaryColor}20, ${secondaryColor}10)` }}>
                      <div className="flex items-center gap-2">
                        {logoPreview
                          ? <img src={logoPreview} alt="" className="w-6 h-6 rounded-lg object-cover" />
                          : <div className="w-6 h-6 rounded-lg flex items-center justify-center text-xs font-black" style={{ background: primaryColor }}>{(companyName || 'A')[0]}</div>
                        }
                        <span className="text-xs font-bold text-white">{companyName || 'Your Company'}</span>
                      </div>
                      <div className="w-5 h-5 rounded-full" style={{ background: primaryColor }} />
                    </div>
                    {/* Fake sidebar + content */}
                    <div className="flex" style={{ height: '200px' }}>
                      <div className="w-1/3 border-r border-white/[0.06] p-3 space-y-2">
                        {['Dashboard', 'CRM', 'Agent Console', 'Knowledge'].map((item, i) => (
                          <div key={item} className="px-2 py-1.5 rounded-lg text-[10px] font-medium" style={{
                            background: i === 0 ? `${primaryColor}30` : 'transparent',
                            color: i === 0 ? primaryColor : '#6b7280'
                          }}>{item}</div>
                        ))}
                      </div>
                      <div className="flex-1 p-3 space-y-2">
                        <div className="h-3 rounded-full w-3/4" style={{ background: `${primaryColor}30` }} />
                        <div className="grid grid-cols-2 gap-2">
                          <div className="h-14 rounded-xl border border-white/[0.06]" style={{ background: `${primaryColor}10` }} />
                          <div className="h-14 rounded-xl border border-white/[0.06]" style={{ background: `${secondaryColor}10` }} />
                        </div>
                        <div className="h-3 rounded-full w-1/2" style={{ background: 'rgba(255,255,255,0.05)' }} />
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 space-y-2 text-xs">
                    <div className="flex items-center justify-between text-gray-500">
                      <span>Primary Color</span>
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 rounded-full border border-white/20" style={{ background: primaryColor }} />
                        <code className="text-gray-400">{primaryColor}</code>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-gray-500">
                      <span>Secondary Color</span>
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 rounded-full border border-white/20" style={{ background: secondaryColor }} />
                        <code className="text-gray-400">{secondaryColor}</code>
                      </div>
                    </div>
                    {customDomain && (
                      <div className="flex items-center justify-between text-gray-500">
                        <span>Custom Domain</span>
                        <code className="text-blue-400">{customDomain}</code>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* API docs link */}
              <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Zap className="w-4 h-4 text-amber-400" />
                  <h4 className="text-sm font-semibold text-white">Developer Docs</h4>
                </div>
                <p className="text-xs text-gray-500 mb-3">Full REST API reference with request/response examples.</p>
                <a
                  href={`${API_URL}/api`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.05] border border-white/[0.08] text-sm text-gray-300 hover:text-white hover:bg-white/[0.08] transition-all"
                >
                  <Key className="w-3.5 h-3.5" /> View API Reference
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
