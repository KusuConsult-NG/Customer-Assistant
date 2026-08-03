"use client";

import React, { useEffect, useState, useCallback } from 'react';
import { api, API_URL } from '@/lib/api';
import {
  Search, Plus, Users, X, ChevronDown, Phone, Mail,
  Tag, Briefcase, TicketCheck, TrendingUp, Filter,
  MoreHorizontal, Edit2, Trash2, CheckCircle2, Clock,
  AlertCircle, XCircle, ArrowUpRight, LayoutGrid, List,
  Download, ArrowRight, FileText, ExternalLink, ShieldCheck
} from 'lucide-react';

type Tab = 'contacts' | 'leads' | 'deals' | 'tickets';
type ViewMode = 'table' | 'kanban';

const DEAL_STAGES = ['LEAD', 'PROSPECT', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'];
const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST'];
const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${color}`}>
      {text}
    </span>
  );
}

function statusColor(status: string) {
  const map: Record<string, string> = {
    NEW: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
    CONTACTED: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
    QUALIFIED: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
    CONVERTED: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
    LOST: 'bg-red-500/15 text-red-400 border-red-500/20',
    OPEN: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
    IN_PROGRESS: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
    RESOLVED: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
    CLOSED: 'bg-gray-500/15 text-gray-400 border-gray-500/20',
    LEAD: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
    PROSPECT: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/20',
    PROPOSAL: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
    NEGOTIATION: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
    CLOSED_WON: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
    CLOSED_LOST: 'bg-red-500/15 text-red-400 border-red-500/20',
  };
  return map[status] || 'bg-gray-500/15 text-gray-400 border-gray-500/20';
}

export default function CrmPage() {
  const [tab, setTab] = useState<Tab>('contacts');
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [contacts, setContacts] = useState<any[]>([]);
  const [leads, setLeads] = useState<any[]>([]);
  const [deals, setDeals] = useState<any[]>([]);
  const [tickets, setTickets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Modals & Drawers
  const [modalType, setModalType] = useState<'contact' | 'lead' | 'deal' | 'ticket' | null>(null);
  const [selectedContact, setSelectedContact] = useState<any | null>(null);
  const [quoteModal, setQuoteModal] = useState<{title: string; amount: number} | null>(null);

  const handleDelete = async (type: string, id: string) => {
    if (!confirm('Are you sure you want to delete this record?')) return;
    try {
      const res = await fetch(`${API_URL}/api/crm/${type}/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${localStorage.getItem('ace_token')}` }
      });
      if (res.ok) {
        fetchAll();
      } else {
        alert('Failed to delete');
      }
    } catch (err) {
      alert('Error deleting');
    }
  };

  const token = typeof window !== 'undefined' ? localStorage.getItem('ace_token') : '';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [c, l, d, t] = await Promise.allSettled([
        api.crm.getContacts(),
        api.crm.getLeads(),
        fetch(`${API_URL}/api/crm/deals`, { headers }).then(r => r.ok ? r.json() : []),
        fetch(`${API_URL}/api/crm/tickets`, { headers }).then(r => r.ok ? r.json() : []),
      ]);
      setContacts(c.status === 'fulfilled' ? (c.value || []) : []);
      setLeads(l.status === 'fulfilled' ? (l.value || []) : []);
      setDeals(d.status === 'fulfilled' ? (d.value || []) : []);
      setTickets(t.status === 'fulfilled' ? (t.value || []) : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const filtered = <T extends Record<string, any>>(items: T[]) =>
    items.filter(i =>
      (i.fullName || i.title || i.subject || i.contact?.fullName || '').toLowerCase().includes(search.toLowerCase()) ||
      (i.phoneNumber || i.email || i.contact?.phoneNumber || '').toLowerCase().includes(search.toLowerCase())
    );

  const exportContactsCsv = () => {
    if (contacts.length === 0) return;
    const csvRows = [
      ['Full Name', 'Phone Number', 'Email', 'Tags', 'Created At'],
      ...contacts.map(c => [
        `"${c.fullName || ''}"`,
        `"${c.phoneNumber || ''}"`,
        `"${c.email || ''}"`,
        `"${(c.tags || []).join(';')}"`,
        `"${c.createdAt || ''}"`
      ])
    ];
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ACE_Contacts_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  const tabs = [
    { id: 'contacts' as Tab, label: 'Contacts', count: contacts.length, icon: <Users className="w-4 h-4" /> },
    { id: 'leads' as Tab, label: 'Leads', count: leads.length, icon: <TrendingUp className="w-4 h-4" /> },
    { id: 'deals' as Tab, label: 'Deals & Pipeline', count: deals.length, icon: <Briefcase className="w-4 h-4" /> },
    { id: 'tickets' as Tab, label: 'Support Tickets', count: tickets.length, icon: <TicketCheck className="w-4 h-4" /> },
  ];

  return (
    <div className="space-y-6 max-w-7xl pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Users className="w-6 h-6 text-blue-400" /> Customer Relationship Management
          </h1>
          <p className="text-sm text-gray-400 mt-1">Manage contacts, sales pipelines, lead conversions, and customer support tickets.</p>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'contacts' && (
            <button
              onClick={exportContactsCsv}
              className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-gray-300 hover:text-white text-sm font-semibold transition-all"
            >
              <Download className="w-4 h-4" /> Export CSV
            </button>
          )}
          <button
            onClick={() => setModalType(tab === 'contacts' ? 'contact' : tab === 'leads' ? 'lead' : tab === 'deals' ? 'deal' : 'ticket')}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-all text-sm shadow-lg shadow-blue-500/20"
          >
            <Plus className="w-4 h-4" />
            Add {tab === 'contacts' ? 'Contact' : tab === 'leads' ? 'Lead' : tab === 'deals' ? 'Deal' : 'Ticket'}
          </button>
        </div>
      </div>

      {/* Tabs & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/[0.06] pb-4">
        <div className="flex gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.06] w-fit">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); setSearch(''); }}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                tab === t.id
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
              }`}
            >
              {t.icon}
              {t.label}
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                tab === t.id ? 'bg-white/20 text-white' : 'bg-white/5 text-gray-500'
              }`}>{t.count}</span>
            </button>
          ))}
        </div>

        {tab === 'deals' && (
          <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.06]">
            <button
              onClick={() => setViewMode('table')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                viewMode === 'table' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              <List className="w-3.5 h-3.5" /> Table
            </button>
            <button
              onClick={() => setViewMode('kanban')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                viewMode === 'kanban' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" /> Kanban Board
            </button>
          </div>
        )}
      </div>

      {/* Search Bar */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          type="text"
          placeholder={`Search ${tab}...`}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 text-sm"
        />
      </div>

      {/* Content Area */}
      <div className="rounded-2xl border border-white/[0.06] overflow-hidden bg-white/[0.02]">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-14 bg-white/[0.03] rounded-xl animate-pulse" />
            ))}
          </div>
        ) : tab === 'contacts' ? (
          <ContactsTable
            data={filtered(contacts)}
            onAdd={() => setModalType('contact')}
            onSelectContact={(c) => setSelectedContact(c)}
            onDelete={(id) => handleDelete('contacts', id)}
          />
        ) : tab === 'leads' ? (
          <LeadsTable
            data={filtered(leads)}
            onAdd={() => setModalType('lead')}
            onRefresh={fetchAll}
            onDelete={(id) => handleDelete('leads', id)}
          />
        ) : tab === 'deals' ? (
          viewMode === 'kanban' ? (
            <DealsKanban data={filtered(deals)} onAdd={() => setModalType('deal')} onRefresh={fetchAll} onDelete={(id) => handleDelete('deals', id)} onQuote={(title, amount) => setQuoteModal({title, amount})} />
          ) : (
            <DealsTable data={filtered(deals)} onAdd={() => setModalType('deal')} onDelete={(id) => handleDelete('deals', id)} onQuote={(title, amount) => setQuoteModal({title, amount})} />
          )
        ) : (
          <TicketsTable data={filtered(tickets)} onAdd={() => setModalType('ticket')} onRefresh={fetchAll} onDelete={(id) => handleDelete('tickets', id)} />
        )}
      </div>

      {/* Modals */}
      {modalType === 'contact' && (
        <AddContactModal onClose={() => setModalType(null)} onAdded={() => { setModalType(null); fetchAll(); }} />
      )}
      {modalType === 'lead' && (
        <AddLeadModal onClose={() => setModalType(null)} onAdded={() => { setModalType(null); fetchAll(); }} />
      )}
      {modalType === 'deal' && (
        <AddDealModal onClose={() => setModalType(null)} onAdded={() => { setModalType(null); fetchAll(); }} />
      )}
      {modalType === 'ticket' && (
        <AddTicketModal onClose={() => setModalType(null)} onAdded={() => { setModalType(null); fetchAll(); }} />
      )}

      {/* Contact Details Drawer */}
      {selectedContact && (
        <ContactDetailModal contact={selectedContact} onClose={() => setSelectedContact(null)} />
      )}
      
      {/* Quotation Preview Modal */}
      {quoteModal && (
        <ModalWrapper title="Quotation Generated" onClose={() => setQuoteModal(null)}>
          <div className="text-center py-6 space-y-4">
            <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto" />
            <p className="text-sm text-gray-300">Quotation preview generated for <strong>{quoteModal.title}</strong> - ₦{quoteModal.amount.toLocaleString()}</p>
            <button onClick={() => setQuoteModal(null)} className="px-4 py-2 bg-emerald-600/20 text-emerald-400 rounded-lg font-semibold">Done</button>
          </div>
        </ModalWrapper>
      )}
    </div>
  );
}

// ─────────────────────────── Contacts Table ────────────────────────────
function ContactsTable({ data, onAdd, onSelectContact, onDelete }: { data: any[]; onAdd: () => void; onSelectContact: (c: any) => void; onDelete: (id: string) => void }) {
  if (data.length === 0) return <EmptyState icon={<Users className="w-12 h-12" />} text="No contacts found" action="Add Contact" onAction={onAdd} />;
  return (
    <table className="w-full text-sm text-left">
      <thead className="bg-white/[0.03] border-b border-white/[0.06] text-gray-400">
        <tr>
          <th className="px-5 py-3.5 font-medium">Name</th>
          <th className="px-5 py-3.5 font-medium">Phone Number</th>
          <th className="px-5 py-3.5 font-medium">Email</th>
          <th className="px-5 py-3.5 font-medium">Tags</th>
          <th className="px-5 py-3.5 font-medium">Created</th>
          <th className="px-5 py-3.5 font-medium text-right">Actions</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-white/[0.04]">
        {data.map((c) => (
          <tr key={c.id} className="hover:bg-white/[0.02] transition-colors group cursor-pointer" onClick={() => onSelectContact(c)}>
            <td className="px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-blue-500/15 text-blue-400 font-bold text-xs flex items-center justify-center flex-shrink-0">
                  {(c.fullName || 'U')[0].toUpperCase()}
                </div>
                <span className="font-semibold text-gray-200 group-hover:text-blue-400 transition-colors">{c.fullName}</span>
              </div>
            </td>
            <td className="px-5 py-4 text-gray-400 font-mono text-xs">{c.phoneNumber || '—'}</td>
            <td className="px-5 py-4 text-gray-400 text-xs">{c.email || '—'}</td>
            <td className="px-5 py-4">
              <div className="flex gap-1 flex-wrap">
                {(c.tags || ['customer']).map((t: string) => (
                  <Badge key={t} text={t} color="bg-blue-500/10 text-blue-400 border-blue-500/20" />
                ))}
              </div>
            </td>
            <td className="px-5 py-4 text-gray-500 text-xs">{c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—'}</td>
            <td className="px-5 py-4 text-right space-x-2">
              <button
                onClick={(e) => { e.stopPropagation(); onSelectContact(c); }}
                className="px-3 py-1 rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 text-xs font-semibold transition-all"
              >
                View Profile
              </button>
              <button onClick={(e) => { e.stopPropagation(); onDelete(c.id); }} className="p-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all">
                <Trash2 className="w-4 h-4" />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─────────────────────────── Leads Table ────────────────────────────
function LeadsTable({ data, onAdd, onRefresh, onDelete }: { data: any[]; onAdd: () => void; onRefresh: () => void; onDelete: (id: string) => void }) {
  const updateStatus = async (id: string, status: string) => {
    const token = localStorage.getItem('ace_token');
    await fetch(`${API_URL}/api/crm/leads/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status }),
    });
    onRefresh();
  };

  if (data.length === 0) return <EmptyState icon={<TrendingUp className="w-12 h-12" />} text="No leads found" action="Add Lead" onAction={onAdd} />;
  return (
    <table className="w-full text-sm text-left">
      <thead className="bg-white/[0.03] border-b border-white/[0.06] text-gray-400">
        <tr>
          <th className="px-5 py-3.5 font-medium">Lead Name</th>
          <th className="px-5 py-3.5 font-medium">Phone Number</th>
          <th className="px-5 py-3.5 font-medium">Notes / Context</th>
          <th className="px-5 py-3.5 font-medium">Status</th>
          <th className="px-5 py-3.5 font-medium">Created</th>
          <th className="px-5 py-3.5 font-medium text-right">Actions</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-white/[0.04]">
        {data.map((l) => (
          <tr key={l.id} className="hover:bg-white/[0.02] transition-colors">
            <td className="px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-purple-500/15 text-purple-400 font-bold text-xs flex items-center justify-center flex-shrink-0">
                  {(l.contact?.fullName || 'U')[0].toUpperCase()}
                </div>
                <div>
                  <p className="font-semibold text-gray-200">{l.contact?.fullName || 'Anonymous Prospect'}</p>
                  <p className="text-xs text-gray-500">{l.contact?.email || ''}</p>
                </div>
              </div>
            </td>
            <td className="px-5 py-4 text-gray-400 font-mono text-xs">{l.contact?.phoneNumber || '—'}</td>
            <td className="px-5 py-4 text-xs text-gray-400 truncate max-w-xs">{l.notes || 'Captured via AI conversation'}</td>
            <td className="px-5 py-4">
              <select
                value={l.status}
                onChange={e => updateStatus(l.id, e.target.value)}
                className={`text-xs font-bold rounded-full px-3 py-1 border cursor-pointer outline-none bg-black/40 ${statusColor(l.status)}`}
              >
                {LEAD_STATUSES.map(s => (
                  <option key={s} value={s} className="bg-[#0a0f1e] text-white">{s}</option>
                ))}
              </select>
            </td>
            <td className="px-5 py-4 text-gray-500 text-xs">{l.createdAt ? new Date(l.createdAt).toLocaleDateString() : '—'}</td>
            <td className="px-5 py-4 text-right">
              <button onClick={() => onDelete(l.id)} className="p-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all">
                <Trash2 className="w-4 h-4" />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─────────────────────────── Deals Table ────────────────────────────
function DealsTable({ data, onAdd, onDelete, onQuote }: { data: any[]; onAdd: () => void; onDelete: (id: string) => void; onQuote: (title: string, amount: number) => void }) {
  if (data.length === 0) return <EmptyState icon={<Briefcase className="w-12 h-12" />} text="No deals in pipeline" action="Add Deal" onAction={onAdd} />;

  const totalValue = data.reduce((sum, d) => sum + (d.amount || 0), 0);
  const wonValue = data.filter(d => d.stage === 'CLOSED_WON').reduce((sum, d) => sum + (d.amount || 0), 0);

  return (
    <div>
      <div className="grid grid-cols-3 gap-4 p-5 border-b border-white/[0.06] bg-white/[0.01]">
        <div className="text-center">
          <p className="text-2xl font-extrabold text-white">₦{totalValue.toLocaleString()}</p>
          <p className="text-xs text-gray-500">Pipeline Total Value</p>
        </div>
        <div className="text-center">
          <p className="text-2xl font-extrabold text-emerald-400">₦{wonValue.toLocaleString()}</p>
          <p className="text-xs text-gray-500">Closed Won Revenue</p>
        </div>
        <div className="text-center">
          <p className="text-2xl font-extrabold text-white">{data.length}</p>
          <p className="text-xs text-gray-500">Active Deals</p>
        </div>
      </div>
      <table className="w-full text-sm text-left">
        <thead className="bg-white/[0.03] border-b border-white/[0.06] text-gray-400">
          <tr>
            <th className="px-5 py-3.5 font-medium">Deal Title</th>
            <th className="px-5 py-3.5 font-medium">Contact</th>
            <th className="px-5 py-3.5 font-medium">Amount</th>
            <th className="px-5 py-3.5 font-medium">Stage</th>
            <th className="px-5 py-3.5 font-medium">Created</th>
            <th className="px-5 py-3.5 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04]">
          {data.map((d) => (
            <tr key={d.id} className="hover:bg-white/[0.02] transition-colors">
              <td className="px-5 py-4 font-semibold text-gray-200">{d.title || 'Untitled Deal'}</td>
              <td className="px-5 py-4 text-gray-400 text-xs">{d.contact?.fullName || '—'}</td>
              <td className="px-5 py-4 font-bold text-emerald-400">₦{(d.amount || 0).toLocaleString()}</td>
              <td className="px-5 py-4"><Badge text={d.stage || 'LEAD'} color={statusColor(d.stage)} /></td>
              <td className="px-5 py-4 text-gray-500 text-xs">{d.createdAt ? new Date(d.createdAt).toLocaleDateString() : '—'}</td>
              <td className="px-5 py-4 text-right space-x-2">
                <button onClick={() => onQuote(d.title, d.amount || 0)} className="px-2 py-1.5 rounded-lg bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 text-xs font-semibold transition-all">Generate Quotation</button>
                <button onClick={() => onDelete(d.id)} className="p-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all"><Trash2 className="w-4 h-4" /></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────── Deals Kanban Board ────────────────────────────
function DealsKanban({ data, onAdd, onRefresh, onDelete, onQuote }: { data: any[]; onAdd: () => void; onRefresh: () => void; onDelete: (id: string) => void; onQuote: (title: string, amount: number) => void }) {
  const updateStage = async (id: string, stage: string) => {
    const token = localStorage.getItem('ace_token');
    await fetch(`${API_URL}/api/crm/deals/${id}/stage`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ stage }),
    });
    onRefresh();
  };

  return (
    <div className="p-5 overflow-x-auto">
      <div className="flex gap-4 min-w-[1100px]">
        {DEAL_STAGES.map((stage) => {
          const stageDeals = data.filter(d => d.stage === stage);
          const stageTotal = stageDeals.reduce((sum, d) => sum + (d.amount || 0), 0);
          return (
            <div key={stage} className="w-72 flex-shrink-0 bg-white/[0.02] border border-white/[0.06] rounded-2xl p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between border-b border-white/[0.06] pb-2">
                <span className="font-bold text-xs text-gray-200 uppercase tracking-wider">{stage.replace('_', ' ')}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-white/[0.06] text-gray-400 font-bold">{stageDeals.length}</span>
              </div>
              <p className="text-xs font-bold text-emerald-400">₦{stageTotal.toLocaleString()}</p>
              <div className="space-y-2.5 flex-1 min-h-[300px]">
                {stageDeals.map((deal) => (
                  <div key={deal.id} className="p-3.5 rounded-xl bg-white/[0.04] border border-white/[0.08] space-y-2 hover:border-blue-500/30 transition-all">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-sm text-white">{deal.title}</p>
                      <button onClick={() => onDelete(deal.id)} className="text-gray-500 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                    <p className="text-xs text-gray-400">{deal.contact?.fullName || 'No contact'}</p>
                    <p className="text-sm font-bold text-emerald-400">₦{(deal.amount || 0).toLocaleString()}</p>
                    <button onClick={() => onQuote(deal.title, deal.amount || 0)} className="w-full mt-1 py-1 text-[10px] rounded bg-purple-500/10 text-purple-400 font-bold border border-purple-500/20 hover:bg-purple-500/20">Generate Quotation</button>
                    <div className="pt-2 border-t border-white/[0.04] flex items-center justify-between">
                      <span className="text-[10px] text-gray-500">{new Date(deal.createdAt).toLocaleDateString()}</span>
                      <select
                        value={deal.stage}
                        onChange={e => updateStage(deal.id, e.target.value)}
                        className="bg-black/60 text-[10px] text-gray-300 rounded px-1.5 py-0.5 border border-white/10 outline-none"
                      >
                        {DEAL_STAGES.map(s => (
                          <option key={s} value={s}>{s.replace('_', ' ')}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────── Tickets Table ────────────────────────────
function TicketsTable({ data, onAdd, onRefresh, onDelete }: { data: any[]; onAdd: () => void; onRefresh: () => void; onDelete: (id: string) => void }) {
  const updateStatus = async (id: string, status: string) => {
    const token = localStorage.getItem('ace_token');
    await fetch(`${API_URL}/api/crm/tickets/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status }),
    });
    onRefresh();
  };

  const priorityColor: Record<string, string> = {
    LOW: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
    MEDIUM: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    HIGH: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
    URGENT: 'bg-red-500/10 text-red-400 border-red-500/20',
  };

  if (data.length === 0) return <EmptyState icon={<TicketCheck className="w-12 h-12" />} text="No tickets found" action="Add Ticket" onAction={onAdd} />;
  return (
    <table className="w-full text-sm text-left">
      <thead className="bg-white/[0.03] border-b border-white/[0.06] text-gray-400">
        <tr>
          <th className="px-5 py-3.5 font-medium">Subject</th>
          <th className="px-5 py-3.5 font-medium">Contact</th>
          <th className="px-5 py-3.5 font-medium">Priority</th>
          <th className="px-5 py-3.5 font-medium">Status</th>
          <th className="px-5 py-3.5 font-medium">Created</th>
          <th className="px-5 py-3.5 font-medium text-right">Actions</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-white/[0.04]">
        {data.map((t) => (
          <tr key={t.id} className="hover:bg-white/[0.02] transition-colors">
            <td className="px-5 py-4">
              <p className="font-semibold text-gray-200 truncate max-w-[250px]">{t.subject || 'No subject'}</p>
              <p className="text-xs text-gray-500 truncate">{t.description?.slice(0, 60)}...</p>
            </td>
            <td className="px-5 py-4 text-gray-400 text-xs">{t.contact?.fullName || '—'}</td>
            <td className="px-5 py-4"><Badge text={t.priority || 'MEDIUM'} color={priorityColor[t.priority] || priorityColor.MEDIUM} /></td>
            <td className="px-5 py-4">
              <select
                value={t.status}
                onChange={e => updateStatus(t.id, e.target.value)}
                className={`text-xs font-bold rounded-full px-3 py-1 border cursor-pointer outline-none bg-black/40 ${statusColor(t.status)}`}
              >
                {TICKET_STATUSES.map(s => <option key={s} value={s} className="bg-[#0a0f1e] text-white">{s}</option>)}
              </select>
            </td>
            <td className="px-5 py-4 text-gray-500 text-xs">{t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '—'}</td>
            <td className="px-5 py-4 text-right">
              <button onClick={() => onDelete(t.id)} className="p-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all"><Trash2 className="w-4 h-4" /></button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EmptyState({ icon, text, action, onAction }: { icon: React.ReactNode; text: string; action: string; onAction: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-gray-600">
      <div className="opacity-20 mb-4">{icon}</div>
      <p className="text-gray-400 font-medium mb-4">{text}</p>
      <button onClick={onAction} className="px-4 py-2 rounded-xl bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 text-sm font-semibold transition-all border border-blue-500/20">
        <Plus className="w-4 h-4 inline mr-1" /> {action}
      </button>
    </div>
  );
}

function ModalWrapper({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md bg-[#0d1225] border border-white/10 rounded-2xl p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
          <h2 className="text-lg font-bold text-white">{title}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-semibold text-gray-400 mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}

const inputCls = "w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition-all placeholder-gray-600";
const selectCls = `${inputCls} appearance-none cursor-pointer bg-[#0d1225]`;

function AddContactModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [fullName, setFullName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api.crm.addContact({ fullName, phoneNumber, email, tags: ['customer'] });
      onAdded();
    } catch (err: any) {
      setError(err.message || 'Failed to add contact');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalWrapper title="Add New Contact" onClose={onClose}>
      {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Full Name"><input required type="text" value={fullName} onChange={e => setFullName(e.target.value)} className={inputCls} placeholder="e.g. Emeka Okafor" /></Field>
        <Field label="Phone Number"><input required type="tel" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} className={inputCls} placeholder="+2348031234567" /></Field>
        <Field label="Email (optional)"><input type="email" value={email} onChange={e => setEmail(e.target.value)} className={inputCls} placeholder="emeka@example.com" /></Field>
        <button disabled={loading} type="submit" className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold disabled:opacity-50 transition-all">
          {loading ? 'Saving...' : 'Save Contact'}
        </button>
      </form>
    </ModalWrapper>
  );
}

function AddLeadModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [fullName, setFullName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const token = localStorage.getItem('ace_token');
      const contactRes = await fetch(`${API_URL}/api/crm/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fullName, phoneNumber, tags: ['lead'] }),
      });
      if (!contactRes.ok) throw new Error('Failed to create contact for lead');
      const contact = await contactRes.json();
      const leadRes = await fetch(`${API_URL}/api/crm/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ contactId: contact.id, notes }),
      });
      if (!leadRes.ok) throw new Error('Failed to create lead');
      onAdded();
    } catch (err: any) {
      setError(err.message || 'Failed to add lead');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalWrapper title="Add New Lead" onClose={onClose}>
      {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Full Name"><input required type="text" value={fullName} onChange={e => setFullName(e.target.value)} className={inputCls} placeholder="e.g. Amaka Osei" /></Field>
        <Field label="Phone Number"><input required type="tel" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} className={inputCls} placeholder="+2348031234567" /></Field>
        <Field label="Notes / Context"><textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} placeholder="How did they find you? What service are they inquiring about?" /></Field>
        <button disabled={loading} type="submit" className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold disabled:opacity-50 transition-all">
          {loading ? 'Saving...' : 'Save Lead'}
        </button>
      </form>
    </ModalWrapper>
  );
}

function AddDealModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [contactFullName, setContactFullName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [stage, setStage] = useState('LEAD');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const token = localStorage.getItem('ace_token');
      const contactRes = await fetch(`${API_URL}/api/crm/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fullName: contactFullName, phoneNumber: contactPhone, tags: ['deal'] }),
      });
      if (!contactRes.ok) throw new Error('Failed to create contact for deal');
      const contact = await contactRes.json();
      const res = await fetch(`${API_URL}/api/crm/deals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title, amount: parseFloat(amount) || 0, stage, contactId: contact.id }),
      });
      if (!res.ok) throw new Error('Failed to create deal');
      onAdded();
    } catch (err: any) {
      setError(err.message || 'Failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalWrapper title="Add New Deal" onClose={onClose}>
      {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Deal Title"><input required type="text" value={title} onChange={e => setTitle(e.target.value)} className={inputCls} placeholder="e.g. Premium Service Contract" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact Name"><input required type="text" value={contactFullName} onChange={e => setContactFullName(e.target.value)} className={inputCls} placeholder="Full name" /></Field>
          <Field label="Contact Phone"><input required type="tel" value={contactPhone} onChange={e => setContactPhone(e.target.value)} className={inputCls} placeholder="+234..." /></Field>
        </div>
        <Field label="Deal Amount (₦)"><input type="number" value={amount} onChange={e => setAmount(e.target.value)} className={inputCls} placeholder="e.g. 150000" /></Field>
        <Field label="Stage">
          <select value={stage} onChange={e => setStage(e.target.value)} className={selectCls}>
            {DEAL_STAGES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
        <button disabled={loading} type="submit" className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold disabled:opacity-50 transition-all">
          {loading ? 'Saving...' : 'Create Deal'}
        </button>
      </form>
    </ModalWrapper>
  );
}

function AddTicketModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('MEDIUM');
  const [contactFullName, setContactFullName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const token = localStorage.getItem('ace_token');
      const contactRes = await fetch(`${API_URL}/api/crm/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fullName: contactFullName, phoneNumber: contactPhone, tags: ['support'] }),
      });
      if (!contactRes.ok) throw new Error('Failed to create contact');
      const contact = await contactRes.json();
      const res = await fetch(`${API_URL}/api/crm/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ contactId: contact.id, subject, description, priority }),
      });
      if (!res.ok) throw new Error('Failed to create ticket');
      onAdded();
    } catch (err: any) {
      setError(err.message || 'Failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalWrapper title="New Support Ticket" onClose={onClose}>
      {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Customer Name"><input required type="text" value={contactFullName} onChange={e => setContactFullName(e.target.value)} className={inputCls} placeholder="Full name" /></Field>
          <Field label="Phone"><input required type="tel" value={contactPhone} onChange={e => setContactPhone(e.target.value)} className={inputCls} placeholder="+234..." /></Field>
        </div>
        <Field label="Subject"><input required type="text" value={subject} onChange={e => setSubject(e.target.value)} className={inputCls} placeholder="Brief issue summary" /></Field>
        <Field label="Description">
          <textarea rows={3} value={description} onChange={e => setDescription(e.target.value)} className={inputCls} placeholder="Describe the issue in detail..." />
        </Field>
        <Field label="Priority">
          <select value={priority} onChange={e => setPriority(e.target.value)} className={selectCls}>
            {['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <button disabled={loading} type="submit" className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold disabled:opacity-50 transition-all">
          {loading ? 'Saving...' : 'Create Ticket'}
        </button>
      </form>
    </ModalWrapper>
  );
}

function ContactDetailModal({ contact, onClose }: { contact: any; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md h-full bg-[#0d1225] border-l border-white/10 p-6 overflow-y-auto space-y-6 animate-slide-left">
        <div className="flex items-center justify-between border-b border-white/[0.06] pb-4">
          <h2 className="text-lg font-bold text-white">Contact Profile</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-blue-500/20 text-blue-400 font-bold text-xl flex items-center justify-center">
            {(contact.fullName || 'U')[0].toUpperCase()}
          </div>
          <div>
            <h3 className="font-bold text-white text-lg">{contact.fullName}</h3>
            <p className="text-xs font-mono text-blue-400">{contact.phoneNumber || 'No phone'}</p>
            <p className="text-xs text-gray-400">{contact.email || 'No email registered'}</p>
          </div>
        </div>

        <div className="space-y-3 pt-2">
          <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] space-y-2">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Contact Metadata</p>
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">ID</span>
              <span className="font-mono text-gray-300">{contact.id?.slice(0, 12)}...</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">Registered Date</span>
              <span className="text-gray-300">{contact.createdAt ? new Date(contact.createdAt).toLocaleDateString() : '—'}</span>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] space-y-2">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Associated Tags</p>
            <div className="flex gap-1.5 flex-wrap">
              {(contact.tags || ['customer']).map((t: string) => (
                <Badge key={t} text={t} color="bg-blue-500/10 text-blue-400 border-blue-500/20" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
