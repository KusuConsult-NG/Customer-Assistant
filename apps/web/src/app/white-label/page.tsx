"use client";
import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { API_URL, apiFetch } from '@/lib/api';
// The ONE list, shared with the dispatcher that sends these.
//
// This screen used to carry its own copy, and it had drifted: it offered
// `call.ended` while the API dispatched `call.completed`, so a tenant ticked
// Call Ended, saw it saved, and never received one. It offered
// `appointment.booked` and `handover.requested`, which nothing dispatches at
// all, and it did not offer `contact.created`, which is dispatched — leaving
// that one receivable only by a tenant holding `'*'`, which this screen cannot
// set.
import { WEBHOOK_EVENTS, canonicalWebhookEvent, isWebhookEventEnabled } from '@ace/shared-types';
import { copyToClipboard } from '@/lib/clipboard';
import { RoleNotice, useScreenAccess } from '@/components/RoleNotice';
import {
  Palette, Globe, Key, Webhook, Save, Copy, RefreshCw,
  Eye, EyeOff, CheckCircle2, Loader2, AlertCircle, Lock,
  Zap, Shield, ToggleLeft, ToggleRight
} from 'lucide-react';

const inputCls = "w-full px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all placeholder-gray-600";
const labelCls = "text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 block uppercase tracking-wider";

/**
 * Whether a brand colour can carry text, and a note saying so when it cannot.
 *
 * The preview below renders the tenant's chosen colour faithfully, including
 * when that colour is unreadable — a preview that quietly corrected it would
 * be showing them something they are not about to get. But rendering it and
 * saying nothing leaves them to discover it from a citizen. So the preview
 * stays honest and this says what the measurement is.
 */
function contrastWithWhite(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return null;
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const l = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return (1.05) / (l + 0.05);
}

function ContrastNote({ color, label }: { color: string; label: string }) {
  const ratio = contrastWithWhite(color);
  if (ratio === null) return null;
  // 4.5:1 is what AA asks of body text; 3:1 is the floor for large text,
  // icons and borders.
  if (ratio >= 4.5) return null;
  const onlyLarge = ratio >= 3;
  return (
    <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-400 leading-snug">
      {onlyLarge
        ? `White text on this ${label.toLowerCase()} measures ${ratio.toFixed(2)}:1 — readable at large sizes, but under the 4.5:1 that body text needs.`
        : `White text on this ${label.toLowerCase()} measures ${ratio.toFixed(2)}:1, under the 4.5:1 WCAG AA asks for. Citizens on a bright screen may not be able to read it.`}
    </p>
  );
}

export default function WhiteLabelPage() {
  const [org, setOrg] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  // Branding state
  const [companyName, setCompanyName] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#3b82f6');
  const [secondaryColor, setSecondaryColor] = useState('#8b5cf6');
  const [logoPreview, setLogoPreview] = useState<string | null>(null);

  // Webhook state
  const [webhookUrl, setWebhookUrl] = useState('');
  const [enabledEvents, setEnabledEvents] = useState<string[]>([]);

  const token = typeof window !== 'undefined' ? localStorage.getItem('ace_token') : '';
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchOrg = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_URL}/api/organizations/me`, { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setOrg(data);
        setCompanyName(data.name || '');
        setPrimaryColor(data.primaryColor || '#3b82f6');
        setSecondaryColor(data.secondaryColor || '#8b5cf6');
        setWebhookUrl(data.webhookUrl || '');
        setEnabledEvents(data.enabledWebhookEvents || []);
        if (data.logoUrl) setLogoPreview(data.logoUrl);
      } else {
        // Silence here was worse than an error: the form fell back to the
        // placeholder blue and purple, which look exactly like a deliberate
        // choice — so an operator could save the defaults over the agency's
        // real branding without ever being told the load had failed.
        setToast({ msg: 'Could not load this agency’s branding. Reload before saving, or you may overwrite it with defaults.', type: 'error' });
      }
    } catch {
      setToast({ msg: 'Could not reach the server to load branding. Reload before saving.', type: 'error' });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchOrg(); }, [fetchOrg]);

  const saveBranding = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiFetch(`${API_URL}/api/organizations/settings`, {
        method: 'PATCH', headers: authHeaders,
        body: JSON.stringify({ name: companyName, primaryColor, secondaryColor }),
      });
      // Read the reason. `throw new Error()` discarded the body, so a refusal
      // the API explained in full — an agency name that is a placeholder, for
      // instance — reached the operator as "Failed to save" and left them to
      // guess which of four fields was wrong.
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `Failed to save (${res.status})`);
      }
      showToast('Branding saved!');
    } catch (err: any) { showToast(err?.message || 'Failed to save', 'error'); }
    finally { setSaving(false); }
  };

  const saveWebhooks = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiFetch(`${API_URL}/api/organizations/settings`, {
        method: 'PATCH', headers: authHeaders,
        body: JSON.stringify({ webhookUrl, enabledWebhookEvents: enabledEvents }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `Failed to save (${res.status})`);
      }
      showToast('Webhook settings saved!');
    } catch (err: any) { showToast(err?.message || 'Failed to save', 'error'); }
    finally { setSaving(false); }
  };

  /**
   * Toggling writes the CANONICAL key and drops every alias of it.
   *
   * A row can already hold `call.completed` from before the two lists were
   * reconciled. Without the filter, un-ticking Call Ended would remove
   * `call.ended` and leave `call.completed` behind — still a live subscription,
   * on a switch the operator had just turned off.
   *
   * A row holding `'*'` is converted to the explicit set on the first toggle.
   * `'*'` cannot express "everything except this one", so without the
   * conversion the switch would read as on, filter nothing, leave `'*'` in
   * place and do nothing at all — a control that moves and changes no
   * subscription. `'*'` is not something this screen can set, so the
   * conversion only ever narrows what was already agreed.
   */
  const toggleEvent = (key: string) => {
    setEnabledEvents(prev => {
      const explicit = prev.includes('*')
        ? WEBHOOK_EVENTS.filter(e => e.delivered).map(e => e.key)
        : prev;
      const others = explicit.filter(e => canonicalWebhookEvent(e) !== canonicalWebhookEvent(key));
      return isWebhookEventEnabled(explicit, key) ? others : [...others, key];
    });
  };

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setLogoPreview(reader.result as string);
    reader.readAsDataURL(file);
  };


  // This screen exists to CHANGE things, so a member who cannot change
  // anything here is told so instead of being shown the controls and
  // left to discover it by pressing one. Cosmetic either way: the API
  // re-checks the role on every request.
  const access = useScreenAccess('/white-label');
  if (access === 'denied') return <div className="p-6"><RoleNotice path="/white-label" /></div>;

  return (
    <div className="max-w-6xl space-y-6">
      <RoleNotice path="/white-label" />
      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 right-5 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border text-sm font-medium ${
          toast.type === 'success' ? 'bg-emerald-900/80 border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300' : 'bg-red-900/80 border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-300'
        }`}>
          {toast.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Palette className="w-6 h-6 text-purple-700 dark:text-purple-400" /> White-Label & API
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">Customize your brand identity and configure developer integrations.</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-blue-700 dark:text-blue-400 animate-spin" /></div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
          {/* Left column: Config */}
          <div className="xl:col-span-3 space-y-5">
            {/* Branding */}
            <div className="rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
                <Palette className="w-4 h-4 text-purple-700 dark:text-purple-400" />
                <h3 className="font-semibold text-slate-900 dark:text-white">Brand Identity</h3>
              </div>
              <form onSubmit={saveBranding} className="p-6 space-y-4">
                <div className="flex items-center gap-4">
                  <div
                    className="w-16 h-16 rounded-2xl border-2 border-dashed border-white/[0.12] flex items-center justify-center overflow-hidden cursor-pointer relative flex-shrink-0 hover:border-blue-500/40 transition-all"
                    onClick={() => document.getElementById('logo-upload')?.click()}
                  >
                    {logoPreview
                      ? <img src={logoPreview} alt="logo" className="w-full h-full object-cover" />
                      : <div className="text-2xl font-black text-slate-500 dark:text-slate-400">{(companyName || 'A')[0]}</div>
                    }
                    <input id="logo-upload" type="file" accept="image/*" onChange={handleLogoChange} className="hidden" />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Company Name</label>
                    <input type="text" value={companyName} onChange={e => setCompanyName(e.target.value)} className={inputCls} placeholder="Your Company Ltd" />
                  </div>
                </div>


                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>Primary Color</label>
                    <div className="flex items-center gap-2">
                      <input type="color" value={primaryColor} onChange={e => setPrimaryColor(e.target.value)}
                        className="w-12 h-10 rounded-xl border border-slate-200 dark:border-slate-800 cursor-pointer bg-transparent" />
                      <input type="text" value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} className={inputCls} placeholder="#3b82f6" />
                    </div>
                    <ContrastNote color={primaryColor} label="Primary Color" />
                  </div>
                  <div>
                    <label className={labelCls}>Secondary Color</label>
                    <div className="flex items-center gap-2">
                      <input type="color" value={secondaryColor} onChange={e => setSecondaryColor(e.target.value)}
                        className="w-12 h-10 rounded-xl border border-slate-200 dark:border-slate-800 cursor-pointer bg-transparent" />
                      <input type="text" value={secondaryColor} onChange={e => setSecondaryColor(e.target.value)} className={inputCls} placeholder="#8b5cf6" />
                    </div>
                    <ContrastNote color={secondaryColor} label="Secondary Color" />
                  </div>
                </div>

                <button type="submit" disabled={saving} className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-sm disabled:opacity-50 transition-all shadow-lg shadow-brand-600/20">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save Branding
                </button>
              </form>
            </div>

            {/* API key: issued at Settings, where it is real.
                This card showed "sk-ace-••••" with Show and Copy buttons. The
                organization has no apiKey field, so it was ALWAYS that
                placeholder: Copy put a fake key on the clipboard, and had a
                real key ever been returned it would have been shown in full,
                because the mask only matched the fake prefix. Keys are
                generated, and shown once, at Settings → API Key. */}
            <div className="rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm p-6 flex items-start gap-3">
              <Key className="w-4 h-4 mt-0.5 text-amber-700 dark:text-amber-400 shrink-0" />
              <div className="text-sm text-slate-700 dark:text-slate-300 space-y-1">
                <p className="font-semibold text-slate-900 dark:text-white">API Access</p>
                <p>
                  API keys are issued at{' '}
                  <Link href="/settings" className="font-semibold text-brand-700 dark:text-brand-300 underline">System Settings → API Key</Link>.
                  A key is shown once, when it is generated, and stored only in a form that cannot be read back.
                </p>
              </div>
            </div>

            {/* Webhooks */}
            <div className="rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
                <Webhook className="w-4 h-4 text-blue-700 dark:text-blue-400" />
                <h3 className="font-semibold text-slate-900 dark:text-white">Webhook Subscriptions</h3>
              </div>
              <form onSubmit={saveWebhooks} className="p-6 space-y-5">
                <div>
                  <label className={labelCls}>Webhook Endpoint URL</label>
                  <input type="url" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} className={inputCls} placeholder="https://yourserver.com/webhook/ace" />
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">We'll POST JSON events to this URL with <code className="text-blue-700 dark:text-blue-400">X-ACE-Signature</code> header for HMAC verification.</p>
                </div>

                <div>
                  <label className={labelCls}>Event Subscriptions</label>
                  {enabledEvents.includes('*') && (
                    // Otherwise every switch simply reads as on, and an
                    // operator cannot tell a wildcard subscription from having
                    // ticked each box.
                    <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
                      This agency is subscribed to <code>*</code> — every event, including ones added later.
                      Changing any switch below replaces that with the explicit list.
                    </p>
                  )}
                  <div className="space-y-2">
                    {WEBHOOK_EVENTS.map(ev => (
                      <div key={ev.key} className={`flex items-center justify-between p-3 rounded-xl border transition-all ${ev.delivered ? 'bg-white dark:bg-slate-900/80 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60' : 'bg-slate-50 dark:bg-slate-900/40 border-dashed border-slate-300 dark:border-slate-700'}`}>
                        <div>
                          <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{ev.label}</p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">{ev.description}</p>
                          <code className="text-[11px] text-slate-500 dark:text-slate-400">{ev.key}</code>
                          {!ev.delivered && (
                            // An event nobody sends must not be offered as a
                            // subscription: ticked, it waits forever, and an
                            // operator cannot tell "never happened" from
                            // "never implemented".
                            <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                              Not sent yet — the platform does not emit this event, so there is nothing to subscribe to.
                            </p>
                          )}
                        </div>
                        {ev.delivered ? (
                          <button type="button" onClick={() => toggleEvent(ev.key)} className="flex-shrink-0">
                            {isWebhookEventEnabled(enabledEvents, ev.key)
                              ? <ToggleRight className="w-8 h-8 text-blue-700 dark:text-blue-400" />
                              : <ToggleLeft className="w-8 h-8 text-slate-500 dark:text-slate-400" />
                            }
                          </button>
                        ) : (
                          <Lock className="w-5 h-5 flex-shrink-0 text-slate-400 dark:text-slate-500" />
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <button type="submit" disabled={saving} className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-sm disabled:opacity-50 transition-all shadow-lg shadow-brand-600/20">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save Webhooks
                </button>
              </form>
            </div>
          </div>

          {/* Right column: Live preview */}
          <div className="xl:col-span-2">
            <div className="sticky top-4 space-y-4">
              <div className="rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
                  <h3 className="font-semibold text-slate-900 dark:text-white text-sm flex items-center gap-2">
                    <Eye className="w-4 h-4 text-slate-600 dark:text-slate-400" /> Live Brand Preview
                  </h3>
                </div>
                <div className="p-5">
                  {/* Mini platform preview.
                      Marked so the contrast suite can tell it apart: everything
                      inside renders the TENANT'S chosen colours, which they are
                      free to set to something unreadable. Correcting them here
                      would show them a page they are not about to publish, so
                      the warning under the picker says it instead. */}
                  <div
                    data-brand-preview
                    className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/90"
                  >
                    {/* Fake topbar */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800"
                      style={{ background: `linear-gradient(135deg, ${primaryColor}20, ${secondaryColor}10)` }}>
                      <div className="flex items-center gap-2">
                        {logoPreview
                          ? <img src={logoPreview} alt="" className="w-6 h-6 rounded-lg object-cover" />
                          : <div className="w-6 h-6 rounded-lg flex items-center justify-center text-xs font-black" style={{ background: primaryColor }}>{(companyName || 'A')[0]}</div>
                        }
                        <span className="text-xs font-bold text-slate-900 dark:text-white">{companyName || 'Your Company'}</span>
                      </div>
                      <div className="w-5 h-5 rounded-full" style={{ background: primaryColor }} />
                    </div>
                    {/* Fake sidebar + content */}
                    <div className="flex" style={{ height: '200px' }}>
                      <div className="w-1/3 border-r border-slate-200 dark:border-slate-800 p-3 space-y-2">
                        {['Dashboard', 'CRM', 'Agent Console', 'Knowledge'].map((item, i) => (
                          // The ACTIVE item deliberately renders the tenant's own
                          // colour on a tint of itself: this is a preview, and a
                          // preview that silently corrected their colour would be
                          // lying about what they are about to publish. The
                          // inactive items are OUR chrome, so they follow the
                          // dashboard's own muted step instead of a hardcoded grey
                          // that measured 3.7:1 on the dark card.
                          <div
                            key={item}
                            className={`px-2 py-1.5 rounded-lg text-[10px] font-medium ${
                              i === 0 ? '' : 'text-slate-500 dark:text-slate-400'
                            }`}
                            style={{
                              background: i === 0 ? `${primaryColor}30` : 'transparent',
                              ...(i === 0 ? { color: primaryColor } : {}),
                            }}
                          >{item}</div>
                        ))}
                      </div>
                      <div className="flex-1 p-3 space-y-2">
                        <div className="h-3 rounded-full w-3/4" style={{ background: `${primaryColor}30` }} />
                        <div className="grid grid-cols-2 gap-2">
                          <div className="h-14 rounded-xl border border-slate-200 dark:border-slate-800" style={{ background: `${primaryColor}10` }} />
                          <div className="h-14 rounded-xl border border-slate-200 dark:border-slate-800" style={{ background: `${secondaryColor}10` }} />
                        </div>
                        <div className="h-3 rounded-full w-1/2" style={{ background: 'rgba(255,255,255,0.05)' }} />
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 space-y-2 text-xs">
                    <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
                      <span>Primary Color</span>
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 rounded-full border border-slate-200 dark:border-slate-700" style={{ background: primaryColor }} />
                        <code className="text-slate-600 dark:text-slate-400">{primaryColor}</code>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
                      <span>Secondary Color</span>
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 rounded-full border border-slate-200 dark:border-slate-700" style={{ background: secondaryColor }} />
                        <code className="text-slate-600 dark:text-slate-400">{secondaryColor}</code>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}
