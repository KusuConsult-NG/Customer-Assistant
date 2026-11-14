"use client";
import React, { useState, useEffect, useRef } from 'react';
import { Search, Send, MessageCircle, Phone as WhatsAppIcon, User, Bot, AlertTriangle } from 'lucide-react';

import { API_URL, apiFetch } from '@/lib/api';
import SharedEmptyState from '@/components/ui/EmptyState';
import FlowInProgressPanel, { type FlowSnapshot } from '@/components/FlowInProgressPanel';
import { RoleNotice } from '@/components/RoleNotice';

interface Conversation {
  id: string;
  channel?: string;
  contactName: string;
  contactPhone: string;
  isHumanHandoffActive: boolean;
  lastMessagePreview?: string;
  updatedAt: string;
  unreadCount?: number;
}

interface Message {
  id: string;
  content: string;
  senderType: 'USER' | 'AGENT' | 'SYSTEM' | 'AI';
  sentAt: string;
  createdAt?: string;
}

export default function ConversationsPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [filteredConversations, setFilteredConversations] = useState<Conversation[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [channelFilter, setChannelFilter] = useState<'ALL' | 'VOICE' | 'WHATSAPP'>('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [flow, setFlow] = useState<FlowSnapshot | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchConversations();
  }, []);

  const toArray = (val: any) => {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    if (Array.isArray(val.conversations)) return val.conversations;
    if (Array.isArray(val.messages)) return val.messages;
    if (Array.isArray(val.data)) return val.data;
    return [];
  };

  useEffect(() => {
    let list = Array.isArray(conversations) ? conversations : [];
    if (channelFilter !== 'ALL') {
      list = list.filter(c => (c.channel || 'WHATSAPP') === channelFilter);
    }
    if (searchQuery.trim()) {
      setFilteredConversations(
        list.filter(c => 
          c.contactName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.contactPhone?.includes(searchQuery)
        )
      );
    } else {
      setFilteredConversations(list);
    }
  }, [searchQuery, channelFilter, conversations]);

  useEffect(() => {
    if (selectedId) {
      fetchMessages(selectedId);
      fetchFlow(selectedId);
    } else {
      setFlow(null);
    }
  }, [selectedId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const fetchConversations = async () => {
    try {
      const token = localStorage.getItem('ace_token');
      const res = await apiFetch(`${API_URL}/api/whatsapp/conversations`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const rawList = toArray(data);
        const mapped = rawList.map((c: any) => ({
          ...c,
          // "Customer" read as the person's name, in the same place a real
          // name goes. Contacts always carry one now — `Caller (···1234)` when
          // nobody has given theirs — so a blank here means the thread has no
          // contact at all, and a dash says that honestly.
          contactName: c.contactName || c.contact?.fullName || '—',
          contactPhone: c.contactPhone || c.contact?.phoneNumber || '',
          // Derived from the thread the list already carries. There is no
          // `lastMessagePreview` field on the payload, so every row in the
          // inbox said "New conversation" — including threads with fifty
          // messages in them, which made the list impossible to scan.
          lastMessagePreview:
            c.lastMessagePreview || c.messages?.[c.messages.length - 1]?.content || '',
          updatedAt: c.lastMessageAt || c.updatedAt,
        }));
        setConversations(mapped);
      }
    } catch (err) {
      console.error('Failed to fetch conversations', err);
      setConversations([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchMessages = async (id: string) => {
    try {
      const token = localStorage.getItem('ace_token');
      const res = await apiFetch(`${API_URL}/api/conversations/${id}/messages`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setMessages(toArray(data));
      }
    } catch (err) {
      console.error('Failed to fetch messages', err);
      setMessages([]);
    }
  };

  /**
   * What the customer is part-way through, so an operator taking over does not
   * ask for six answers they have already given.
   *
   * Failure is silent by design: this is context beside the thread, and an
   * error banner over a conversation because a side panel could not load would
   * be louder than the thing it is reporting.
   */
  const fetchFlow = async (id: string) => {
    try {
      const token = localStorage.getItem('ace_token');
      const res = await apiFetch(`${API_URL}/api/conversations/${id}/flow`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setFlow(res.ok ? await res.json() : null);
    } catch {
      setFlow(null);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !selectedId) return;

    const content = newMessage.trim();
    setNewMessage('');
    
    // Optimistic UI update
    const tempMsg: Message = {
      id: 'temp-' + Date.now().toString(),
      content,
      senderType: 'AGENT',
      sentAt: new Date().toISOString()
    };
    setMessages(prev => [...prev, tempMsg]);

    try {
      const token = localStorage.getItem('ace_token');
      const res = await apiFetch(`${API_URL}/api/conversations/${selectedId}/messages`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}` 
        },
        body: JSON.stringify({ content })
      });
      if (!res.ok) {
        setMessages(prev => prev.filter(m => m.id !== tempMsg.id));
        setNewMessage(content);
      }
    } catch (err) {
      console.error('Failed to send message', err);
      setMessages(prev => prev.filter(m => m.id !== tempMsg.id));
      setNewMessage(content);
    }
  };

  const handleSetHandoff = async (handoff: boolean) => {
    if (!selectedId) return;
    setHandoffError(null);
    try {
      const token = localStorage.getItem('ace_token');
      const res = await apiFetch(`${API_URL}/api/conversations/${selectedId}/handoff`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ handoff })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          (Array.isArray(body?.message) ? body.message.join(' ') : body?.message) ||
          (handoff ? 'Could not take over this conversation.' : 'Could not return this conversation to the AI.')
        );
      }
      setConversations(prev => prev.map(c => c.id === selectedId ? { ...c, isHumanHandoffActive: handoff } : c));
    } catch (err: any) {
      console.error('Failed to toggle handoff', err);
      setHandoffError(err?.message || 'Could not update conversation handoff status.');
    }
  };

  const handleReturnToAI = () => handleSetHandoff(false);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <>
      <h1 className="sr-only">Live Conversations</h1>
      <SharedEmptyState
        icon={MessageCircle}
        title="No conversations yet"
        description="Messages land here from WhatsApp and phone calls. Connect a channel and the first one will appear automatically."
        actions={[
          { label: 'Connect WhatsApp', primary: true, href: '/settings' },
          { label: 'Set up a phone number', href: '/telephony' },
        ]}
      />
      </>
    );
  }

  const selectedConversation = conversations.find(c => c.id === selectedId);

  return (
    <div className="flex h-[calc(100vh-80px)] -m-6 rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm">
      <RoleNotice path="/conversations" />
      {/*
        This screen is a full-bleed split pane, so it has no room for a visible
        page title — but it still needs one. Without it the only h1 in the
        document is the app shell's "Customer Care Agent", so a screen reader announces
        every route identically and landmark navigation has nothing to jump to.
      */}
      <h1 className="sr-only">Live Conversations</h1>
      {/* Left Panel - Conversation List */}
      <div className={`w-full md:w-80 flex-shrink-0 flex flex-col border-r border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 ${selectedId ? 'hidden md:flex' : 'flex'}`}>
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-2.5">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-500 dark:text-slate-400" />
            <input
              type="text"
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-white dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 rounded-xl text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-indigo-500/50 shadow-sm"
            />
          </div>
          <div className="flex items-center gap-1.5">
            {([
              { id: 'ALL', label: 'All' },
              { id: 'VOICE', label: 'Voice Calls' },
              { id: 'WHATSAPP', label: 'WhatsApp' },
            ] as const).map(f => (
              <button
                key={f.id}
                type="button"
                onClick={() => setChannelFilter(f.id)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                  channelFilter === f.id
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto">
          {filteredConversations.map(conv => {
            const isVoice = conv.channel === 'VOICE';
            return (
              <div 
                key={conv.id}
                onClick={() => setSelectedId(conv.id)}
                className={`p-4 border-b border-slate-100 dark:border-slate-800/60 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/40 transition-colors flex items-center gap-3 ${selectedId === conv.id ? 'bg-indigo-50 dark:bg-slate-800/60' : ''}`}
              >
                <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-500/20 border border-indigo-200 dark:border-indigo-500/30 flex items-center justify-center text-indigo-700 dark:text-indigo-400 font-bold flex-shrink-0">
                  {conv.contactName?.slice(0, 2).toUpperCase() || 'U'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{conv.contactName || conv.contactPhone}</h4>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 whitespace-nowrap ml-2">
                      {new Date(conv.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate font-medium">{conv.lastMessagePreview || 'New conversation'}</p>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${
                        isVoice
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300'
                          : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
                      }`}>
                        {isVoice ? 'Voice' : 'WhatsApp'}
                      </span>
                      {!!conv.unreadCount && conv.unreadCount > 0 && (
                        <span className="w-4 h-4 rounded-full bg-brand-600 text-white text-[10px] font-bold flex items-center justify-center">
                          {conv.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right Panel - Chat Area */}
      <div className={`flex-1 flex flex-col min-w-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-sm relative ${!selectedId ? 'hidden md:flex' : 'flex'}`}>
        {selectedId ? (
          <>
            {/* Chat Header */}
            <div className="h-16 px-6 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-sm z-10 shadow-sm flex-shrink-0">
              <div className="flex items-center gap-3">
                <button 
                  className="md:hidden text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-900 dark:hover:text-white"
                  onClick={() => setSelectedId(null)}
                >
                  ←
                </button>
                <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-500/20 border border-indigo-200 dark:border-indigo-500/30 flex items-center justify-center text-indigo-700 dark:text-indigo-400 font-bold">
                  {selectedConversation?.contactName?.slice(0, 2).toUpperCase() || 'U'}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white">{selectedConversation?.contactName || selectedConversation?.contactPhone}</h3>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                      selectedConversation?.channel === 'VOICE'
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300'
                        : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
                    }`}>
                      {selectedConversation?.channel === 'VOICE' ? 'Voice Call' : 'WhatsApp'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{selectedConversation?.contactPhone}</p>
                </div>
              </div>
              {selectedConversation?.channel !== 'VOICE' && !selectedConversation?.isHumanHandoffActive && (
                <button
                  type="button"
                  onClick={() => handleSetHandoff(true)}
                  className="text-xs px-3 py-1.5 rounded-lg font-bold transition-colors bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-500/15 dark:hover:bg-amber-500/25 dark:text-amber-300 dark:border-amber-500/30"
                >
                  Take Over Thread
                </button>
              )}
            </div>

            {/* Handoff Banner */}
            {selectedConversation?.isHumanHandoffActive && (
              <div className="bg-amber-50 dark:bg-orange-500/10 border-b border-amber-200 dark:border-orange-500/20 px-6 py-2 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-2 text-amber-700 dark:text-orange-400 text-xs font-bold">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Human Handoff Active</span>
                </div>
                <button 
                  onClick={handleReturnToAI}
                  className="text-xs px-3 py-1 rounded-lg font-bold transition-colors bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300 dark:bg-amber-500/15 dark:hover:bg-amber-500/25 dark:text-amber-300 dark:border-amber-500/30"
                >
                  Return to AI
                </button>
              </div>
            )}

            {handoffError && (
              <div className="bg-red-50 dark:bg-red-500/10 border-b border-red-200 dark:border-red-500/20 px-6 py-2 flex items-center justify-between flex-shrink-0 gap-3">
                <span className="text-xs text-red-700 dark:text-red-300">{handoffError}</span>
                <button
                  onClick={() => setHandoffError(null)}
                  aria-label="Dismiss"
                  className="text-xs font-bold text-red-700 dark:text-red-300 hover:underline shrink-0"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* What the customer is half-way through filling in, if anything. */}
            <FlowInProgressPanel flow={flow} />

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {messages.map((msg: any, i) => {
                const s = (msg.sender || msg.senderType || '').toUpperCase();
                const isCustomer = s === 'CUSTOMER' || s === 'USER';
                const isAI = s === 'AI' || s === 'SYSTEM';
                
                return (
                  <div key={msg.id || i} className={`flex ${isCustomer ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                      isCustomer 
                        ? 'bg-brand-600 text-white rounded-tr-sm shadow-sm font-medium' 
                        : isAI 
                          ? 'bg-slate-100 dark:bg-slate-100 dark:bg-slate-800/80 text-slate-900 dark:text-slate-800 dark:text-slate-200 rounded-tl-sm border border-slate-200 dark:border-slate-200 dark:border-slate-800 font-medium' 
                          : 'bg-emerald-600 text-white rounded-tl-sm font-medium' // Human agent
                    }`}>
                      {!isCustomer && (
                        <div className="flex items-center gap-1.5 mb-1 text-[10px] opacity-70 font-medium">
                          {isAI ? <Bot className="w-3 h-3" /> : <User className="w-3 h-3" />}
                          {isAI ? 'AI Agent' : 'Human Agent'}
                        </div>
                      )}
                      <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                      <div className={`text-[10px] mt-1 text-right ${isCustomer ? 'text-blue-200' : 'text-slate-500 dark:text-slate-400'}`}>
                        {/* `sentAt` is the column — Message has no `createdAt`, so this
                            rendered "Invalid Date" on every message in the thread. The
                            optimistic bubble below sets `sentAt` too; `createdAt` is kept
                            as a fallback for any caller still sending it. */}
                        {new Date(msg.sentAt ?? msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex-shrink-0">
              {selectedConversation?.channel === 'VOICE' ? (
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-xl">
                  <div className="text-xs text-slate-600 dark:text-slate-300">
                    <span className="font-bold text-slate-900 dark:text-white">Voice Call Transcript</span> — This is a completed phone call record. Use Voice / Telephony to call the citizen back or Cases to follow up.
                  </div>
                  <div className="flex items-center gap-2">
                    <a
                      href="/telephony"
                      className="px-3 py-1.5 rounded-lg text-xs font-bold bg-brand-600 hover:bg-blue-700 text-white transition-colors"
                    >
                      Call Logs & Dialer
                    </a>
                    <a
                      href="/cases"
                      className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 transition-colors"
                    >
                      View Cases
                    </a>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleSendMessage} className="flex gap-2">
                  <input
                    type="text"
                    value={newMessage}
                    onChange={e => setNewMessage(e.target.value)}
                    placeholder="Type a WhatsApp reply..."
                    className="flex-1 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-900 dark:text-white placeholder-gray-500 focus:outline-none focus:border-blue-500/50"
                  />
                  <button
                    type="submit"
                    disabled={!newMessage.trim()}
                    className="px-4 py-3 bg-brand-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl flex items-center justify-center transition-colors"
                  >
                    <Send className="w-5 h-5" />
                  </button>
                </form>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center flex-col text-slate-500 dark:text-slate-400">
            <MessageCircle className="w-12 h-12 mb-4 opacity-20" />
            <p>Select a conversation to start messaging</p>
          </div>
        )}
      </div>
    </div>
  );
}
