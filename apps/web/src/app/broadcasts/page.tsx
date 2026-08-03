"use client";

import React, { useEffect, useState, useCallback } from 'react';
import { API_URL } from '@/lib/api';
import {
  Send,
  Plus,
  Trash2,
  Users,
  CheckCircle2,
  XCircle,
  Clock,
  MessageSquare,
  FileText,
  Sparkles,
  Search,
  Layers,
  ArrowRight,
  ChevronRight,
  X,
  AlertCircle
} from 'lucide-react';

interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  headerType?: string;
  headerContent?: string;
  bodyText: string;
  footerText?: string;
  status: string;
  createdAt: string;
}

interface BroadcastCampaign {
  id: string;
  name: string;
  recipients: string[];
  totalCount: number;
  sentCount: number;
  failedCount: number;
  status: string;
  sentAt?: string;
  createdAt: string;
  template?: WhatsAppTemplate;
}

export default function BroadcastsPage() {
  const [activeTab, setActiveTab] = useState<'campaigns' | 'templates'>('campaigns');
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [broadcasts, setBroadcasts] = useState<BroadcastCampaign[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Modals
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showBroadcastModal, setShowBroadcastModal] = useState(false);

  // Template Form
  const [tplName, setTplName] = useState('');
  const [tplCategory, setTplCategory] = useState('MARKETING');
  const [tplLanguage, setTplLanguage] = useState('en_US');
  const [tplBody, setTplBody] = useState('Hello {{1}}, thank you for choosing ACE Customer Care! We have an exclusive offer for you.');
  const [tplFooter, setTplFooter] = useState('ACE Platform • Reply STOP to unsubscribe');
  const [creatingTemplate, setCreatingTemplate] = useState(false);

  // Broadcast Form
  const [campaignName, setCampaignName] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [recipientsText, setRecipientsText] = useState('');
  const [useAllContacts, setUseAllContacts] = useState(false);
  const [varValue1, setVarValue1] = useState('Valued Customer');
  const [sendingBroadcast, setSendingBroadcast] = useState(false);
  const [statusNotice, setStatusNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const getHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('ace_token') : ''}`,
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const headers = getHeaders();
      const [tplRes, bcRes, cRes] = await Promise.allSettled([
        fetch(`${API_URL}/api/whatsapp/templates`, { headers }),
        fetch(`${API_URL}/api/whatsapp/broadcasts`, { headers }),
        fetch(`${API_URL}/api/crm/contacts`, { headers }),
      ]);

      if (tplRes.status === 'fulfilled' && tplRes.value.ok) {
        setTemplates(await tplRes.value.json() || []);
      }
      if (bcRes.status === 'fulfilled' && bcRes.value.ok) {
        setBroadcasts(await bcRes.value.json() || []);
      }
      if (cRes.status === 'fulfilled' && cRes.value.ok) {
        const cData = await cRes.value.json();
        setContacts(Array.isArray(cData) ? cData : cData?.data || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCreateTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tplName.trim() || !tplBody.trim()) return;
    setCreatingTemplate(true);
    try {
      const res = await fetch(`${API_URL}/api/whatsapp/templates`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          name: tplName,
          category: tplCategory,
          language: tplLanguage,
          bodyText: tplBody,
          footerText: tplFooter,
        }),
      });

      if (res.ok) {
        setStatusNotice({ type: 'success', text: 'WhatsApp template created successfully!' });
        setShowTemplateModal(false);
        setTplName('');
        setTplBody('');
        fetchData();
      } else {
        const err = await res.json().catch(() => ({ message: 'Failed to create template' }));
        setStatusNotice({ type: 'error', text: err.message || 'Could not save template.' });
      }
    } catch {
      setStatusNotice({ type: 'error', text: 'Network error creating template.' });
    } finally {
      setCreatingTemplate(false);
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    if (!confirm('Are you sure you want to delete this WhatsApp template?')) return;
    try {
      const res = await fetch(`${API_URL}/api/whatsapp/templates/${id}`, {
        method: 'DELETE',
        headers: getHeaders(),
      });
      if (res.ok) {
        setTemplates(prev => prev.filter(t => t.id !== id));
      }
    } catch {
      alert('Failed to delete template.');
    }
  };

  const handleSendBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!campaignName.trim() || !selectedTemplateId) {
      alert('Please fill campaign name and choose a template.');
      return;
    }

    let recipientList: string[] = [];
    if (useAllContacts) {
      recipientList = contacts.map(c => c.phoneNumber).filter(Boolean);
    } else {
      recipientList = recipientsText
        .split(/[\n,;]+/)
        .map(p => p.trim())
        .filter(p => p.length >= 7);
    }

    if (recipientList.length === 0) {
      alert('Please specify at least one recipient phone number.');
      return;
    }

    setSendingBroadcast(true);
    setStatusNotice(null);

    try {
      const res = await fetch(`${API_URL}/api/whatsapp/broadcasts/send`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          name: campaignName,
          templateId: selectedTemplateId,
          recipients: recipientList,
          variables: { '1': varValue1 },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setStatusNotice({
          type: 'success',
          text: `Broadcast "${data.name}" dispatched successfully to ${data.sentCount} recipients!`,
        });
        setShowBroadcastModal(false);
        setCampaignName('');
        setRecipientsText('');
        fetchData();
      } else {
        const err = await res.json().catch(() => ({ message: 'Failed to send broadcast' }));
        setStatusNotice({ type: 'error', text: err.message || 'Error dispatching broadcast.' });
      }
    } catch {
      setStatusNotice({ type: 'error', text: 'Network error sending broadcast campaign.' });
    } finally {
      setSendingBroadcast(false);
    }
  };

  return (
    <div className="space-y-6 max-w-7xl pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Send className="w-6 h-6 text-blue-400" /> WhatsApp Template Broadcasts & Campaigns
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Send approved Meta WhatsApp template messages in bulk to multi-recipient target customer segments.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowTemplateModal(true)}
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:text-white text-sm font-semibold transition-all"
          >
            <Plus className="w-4 h-4" /> Create Template
          </button>
          <button
            onClick={() => setShowBroadcastModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-slate-900 dark:text-white font-semibold transition-all text-sm shadow-lg shadow-blue-500/20"
          >
            <Send className="w-4 h-4" /> New Broadcast Campaign
          </button>
        </div>
      </div>

      {statusNotice && (
        <div className={`p-4 rounded-xl text-sm border flex items-center justify-between ${
          statusNotice.type === 'success'
            ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
            : 'bg-red-500/10 border-red-500/20 text-red-400'
        }`}>
          <span>{statusNotice.text}</span>
          <button onClick={() => setStatusNotice(null)}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 gap-8">
        <button
          onClick={() => setActiveTab('campaigns')}
          className={`pb-3 text-sm font-semibold flex items-center gap-2 border-b-2 transition-all ${
            activeTab === 'campaigns'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200'
          }`}
        >
          <Send className="w-4 h-4" /> Broadcast History ({broadcasts.length})
        </button>
        <button
          onClick={() => setActiveTab('templates')}
          className={`pb-3 text-sm font-semibold flex items-center gap-2 border-b-2 transition-all ${
            activeTab === 'templates'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200'
          }`}
        >
          <FileText className="w-4 h-4" /> WhatsApp Templates ({templates.length})
        </button>
      </div>

      {/* Tab 1: Broadcast Campaigns History */}
      {activeTab === 'campaigns' && (
        <div className="rounded-2xl bg-white/[0.02] border border-slate-200 dark:border-slate-800 overflow-hidden">
          {loading ? (
            <div className="p-8 space-y-3">
              {[1, 2, 3].map(i => <div key={i} className="h-16 bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm rounded-xl animate-pulse" />)}
            </div>
          ) : broadcasts.length === 0 ? (
            <div className="p-12 text-center flex flex-col items-center justify-center">
              <div className="w-12 h-12 rounded-full bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-slate-600 dark:text-slate-400 mb-3">
                <Send className="w-6 h-6 text-blue-400" />
              </div>
              <p className="text-slate-700 dark:text-slate-300 font-medium mb-1">No Broadcast Campaigns Sent Yet</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mb-4">
                Launch a multi-recipient WhatsApp template campaign to reach your CRM contacts instantly.
              </p>
              <button
                onClick={() => setShowBroadcastModal(true)}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-slate-900 dark:text-white font-semibold text-xs shadow-lg shadow-blue-500/20"
              >
                Send First Campaign
              </button>
            </div>
          ) : (
            <table className="w-full text-sm text-left">
              <thead className="bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-3.5">Campaign Name</th>
                  <th className="px-5 py-3.5">Template</th>
                  <th className="px-5 py-3.5">Recipients</th>
                  <th className="px-5 py-3.5">Sent / Failed</th>
                  <th className="px-5 py-3.5">Status</th>
                  <th className="px-5 py-3.5">Sent Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {broadcasts.map((b) => (
                  <tr key={b.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-5 py-4 font-bold text-slate-900 dark:text-white">{b.name}</td>
                    <td className="px-5 py-4 font-mono text-xs text-purple-400">
                      {b.template?.name || 'Standard Template'}
                    </td>
                    <td className="px-5 py-4 font-medium text-slate-700 dark:text-slate-300">
                      {b.totalCount} contacts
                    </td>
                    <td className="px-5 py-4 text-xs font-mono">
                      <span className="text-emerald-400 font-bold">{b.sentCount} sent</span>
                      {b.failedCount > 0 && <span className="text-red-400 ml-2">({b.failedCount} failed)</span>}
                    </td>
                    <td className="px-5 py-4">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${
                        b.status === 'COMPLETED'
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          : b.status === 'SENDING'
                          ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                          : 'bg-red-500/10 text-red-400 border-red-500/20'
                      }`}>
                        {b.status}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-xs text-slate-500 dark:text-slate-400">
                      {b.sentAt ? new Date(b.sentAt).toLocaleString() : new Date(b.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Tab 2: WhatsApp Templates Library */}
      {activeTab === 'templates' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.length === 0 ? (
            <div className="col-span-full p-12 text-center rounded-2xl bg-white/[0.02] border border-slate-200 dark:border-slate-800">
              <FileText className="w-10 h-10 text-purple-400 mx-auto mb-2" />
              <p className="text-slate-700 dark:text-slate-300 font-medium">No Templates Created</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto mb-4">
                Meta requires pre-approved templates for outgoing broadcast messages outside 24-hour customer windows.
              </p>
              <button
                onClick={() => setShowTemplateModal(true)}
                className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-slate-900 dark:text-white font-semibold text-xs"
              >
                Create Template
              </button>
            </div>
          ) : (
            templates.map((tpl) => (
              <div key={tpl.id} className="p-5 rounded-2xl bg-white/[0.02] border border-slate-200 dark:border-slate-800 space-y-4 hover:border-purple-500/30 transition-all flex flex-col justify-between">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-900 dark:text-white text-base">{tpl.name}</span>
                    <span className="px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20 text-[10px] font-mono uppercase font-bold">
                      {tpl.category}
                    </span>
                  </div>

                  <div className="p-3 rounded-xl bg-black/40 border border-white/[0.04] text-xs text-slate-700 dark:text-slate-300 font-sans space-y-2">
                    <p className="whitespace-pre-wrap">{tpl.bodyText}</p>
                    {tpl.footerText && (
                      <p className="text-[10px] text-slate-500 dark:text-slate-400 border-t border-slate-200 dark:border-slate-800 pt-1.5">{tpl.footerText}</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-800 pt-3 text-xs">
                  <span className="text-slate-500 dark:text-slate-400 font-mono">{tpl.language}</span>
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-bold">
                      APPROVED
                    </span>
                    <button
                      onClick={() => handleDeleteTemplate(tpl.id)}
                      className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Modal 1: Create Template */}
      {showTemplateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-900 border border-white/10 p-6 space-y-5 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <FileText className="w-5 h-5 text-purple-400" /> Create WhatsApp Template
              </h2>
              <button onClick={() => setShowTemplateModal(false)} className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateTemplate} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Template Name (Unique)</label>
                <input
                  required
                  type="text"
                  value={tplName}
                  onChange={(e) => setTplName(e.target.value)}
                  placeholder="e.g. promo_discount_offer"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-white/[0.08] text-slate-900 dark:text-white focus:border-purple-500 outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Category</label>
                  <select
                    value={tplCategory}
                    onChange={(e) => setTplCategory(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-[#080c18] border border-white/[0.08] text-slate-900 dark:text-white outline-none"
                  >
                    <option value="MARKETING">MARKETING</option>
                    <option value="UTILITY">UTILITY</option>
                    <option value="AUTHENTICATION">AUTHENTICATION</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Language</label>
                  <select
                    value={tplLanguage}
                    onChange={(e) => setTplLanguage(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-[#080c18] border border-white/[0.08] text-slate-900 dark:text-white outline-none"
                  >
                    <option value="en_US">English (en_US)</option>
                    <option value="es">Spanish (es)</option>
                    <option value="fr">French (fr)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Body Text (Use {"{{1}}"} for variable parameters)</label>
                <textarea
                  required
                  rows={4}
                  value={tplBody}
                  onChange={(e) => setTplBody(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-white/[0.08] text-slate-900 dark:text-white focus:border-purple-500 outline-none font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Footer Text (Optional)</label>
                <input
                  type="text"
                  value={tplFooter}
                  onChange={(e) => setTplFooter(e.target.value)}
                  placeholder="e.g. Reply STOP to unsubscribe"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-white/[0.08] text-slate-900 dark:text-white outline-none"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowTemplateModal(false)}
                  className="px-4 py-2.5 rounded-xl bg-white/[0.04] text-slate-700 dark:text-slate-300 font-semibold"
                >
                  Cancel
                </button>
                <button
                  disabled={creatingTemplate}
                  type="submit"
                  className="px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-slate-900 dark:text-white font-semibold shadow-lg shadow-purple-500/20 disabled:opacity-50"
                >
                  {creatingTemplate ? 'Saving...' : 'Save & Register Template'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal 2: Send Broadcast Campaign */}
      {showBroadcastModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-900 border border-white/10 p-6 space-y-5 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Send className="w-5 h-5 text-blue-400" /> Send Multi-Recipient WhatsApp Broadcast
              </h2>
              <button onClick={() => setShowBroadcastModal(false)} className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSendBroadcast} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Campaign Title</label>
                <input
                  required
                  type="text"
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder="e.g. August Customer Special Offer"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-white/[0.08] text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Select Approved Template</label>
                <select
                  required
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#080c18] border border-white/[0.08] text-slate-900 dark:text-white outline-none"
                >
                  <option value="">-- Choose WhatsApp Template --</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.category})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Variable {"{{1}}"} Substitution</label>
                <input
                  type="text"
                  value={varValue1}
                  onChange={(e) => setVarValue1(e.target.value)}
                  placeholder="e.g. Valued Customer"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-white/[0.08] text-slate-900 dark:text-white outline-none"
                />
              </div>

              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2 text-slate-700 dark:text-slate-300 font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useAllContacts}
                    onChange={(e) => setUseAllContacts(e.target.checked)}
                    className="rounded bg-white/10 border-white/20 text-blue-600 focus:ring-0"
                  />
                  <span>Send to all {contacts.length} CRM registered contacts</span>
                </label>

                {!useAllContacts && (
                  <div>
                    <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">
                      Recipient Phone Numbers (one per line or comma-separated)
                    </label>
                    <textarea
                      rows={3}
                      value={recipientsText}
                      onChange={(e) => setRecipientsText(e.target.value)}
                      placeholder="+2348030000000, +2348120000000"
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-white/[0.08] text-slate-900 dark:text-white font-mono outline-none"
                    />
                  </div>
                )}
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowBroadcastModal(false)}
                  className="px-4 py-2.5 rounded-xl bg-white/[0.04] text-slate-700 dark:text-slate-300 font-semibold"
                >
                  Cancel
                </button>
                <button
                  disabled={sendingBroadcast}
                  type="submit"
                  className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-slate-900 dark:text-white font-semibold shadow-lg shadow-blue-500/20 disabled:opacity-50 flex items-center gap-2"
                >
                  {sendingBroadcast ? 'Sending...' : <><Send className="w-4 h-4" /> Launch Broadcast</>}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
