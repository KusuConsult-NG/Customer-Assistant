"use client";
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { API_URL } from '@/lib/api';
import SelfieRequestPanel from '@/components/SelfieRequestPanel';
import {
  MessageSquareText, Phone, User, Send, Bot,
  ToggleLeft, ToggleRight, Search, RefreshCw,
  Wifi, WifiOff, MessageCircle, Clock, Filter,
  ChevronDown, Circle, Zap, Tag, ShieldCheck, Mail, FileText
} from 'lucide-react';

interface Message {
  id?: string;
  sender: 'CUSTOMER' | 'AI' | 'HUMAN_AGENT' | 'SYSTEM' | string;
  content: string;
  sentAt?: string;
  createdAt?: string;
}

interface Conversation {
  id: string;
  contactName?: string;
  contact?: { id?: string; fullName?: string; phoneNumber?: string; email?: string };
  channel: string;
  status: string;
  updatedAt?: string;
  messages?: Message[];
}

/**
 * Canned replies an agent can insert with one click.
 *
 * Deliberately free of any payment details. One of these used to read
 * "Transfer to Providus Bank Acc: 9928374102" — an account no tenant on this platform
 * owns — one click away from being sent to a paying customer. Payment instructions
 * must come from the organization's own configured details
 * (Settings → payout account), which the AI payment-guidance tool reads.
 */
const QUICK_REPLIES = [
  "Hello! 👋 How can I assist you with your request today?",
  "Thank you for contacting us. Could you please confirm your location?",
  "Our operational hours are Mon - Fri: 8:00 AM - 6:00 PM.",
  "I have updated your request in our system. An agent will get in touch shortly.",
  "You can book an appointment directly through our scheduling portal.",
  "Let me check that for you — one moment please.",
];

export default function AgentConsolePage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [msgLoading, setMsgLoading] = useState(false);
  const [isHumanActive, setIsHumanActive] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState<string>('ALL');
  const [wsConnected, setWsConnected] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('ace_token') : '';
  const headers = { Authorization: `Bearer ${token}` };

  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/conversations`, { headers });
      if (res.ok) {
        const data = await res.json();
        setConversations(data || []);
      } else {
        setConversations([]);
      }
    } catch {
      setConversations([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchMessages = useCallback(async (convId: string) => {
    setMsgLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/conversations/${convId}/messages`, { headers });
      if (res.ok) {
        const data = await res.json();
        setMessages(data || []);
      } else {
        setMessages([]);
      }
    } catch {
      setMessages([]);
    } finally {
      setMsgLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConversations();
    const interval = setInterval(fetchConversations, 8000);
    return () => clearInterval(interval);
  }, [fetchConversations]);

  useEffect(() => {
    if (activeId) {
      fetchMessages(activeId);
    }
  }, [activeId, fetchMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Socket.IO real-time
  useEffect(() => {
    let socket: any = null;
    let cleanup = false;

    const connectSocket = async () => {
      try {
        const { io } = await import('socket.io-client');
        socket = io(API_URL + '/events', {
          transports: ['websocket', 'polling'],
          auth: { token },
        });

        socket.on('connect', () => { if (!cleanup) setWsConnected(true); });
        socket.on('disconnect', () => { if (!cleanup) setWsConnected(false); });

        socket.on('new_message_received', (data: any) => {
          if (!cleanup && data.conversationId === activeId) {
            setMessages(prev => [...prev, data.message]);
          }
          fetchConversations();
        });

        const storedUser = localStorage.getItem('ace_user');
        if (storedUser) {
          const u = JSON.parse(storedUser);
          socket.emit('join_organization', { organizationId: u.organizationId, userId: u.id || u.sub });
        }
      } catch {
        setWsConnected(false);
      }
    };

    connectSocket();

    return () => {
      cleanup = true;
      socket?.disconnect();
    };
  }, [activeId, fetchConversations, token]);

  const handleSend = async (e?: React.FormEvent, customText?: string) => {
    if (e) e.preventDefault();
    const text = customText || replyText;
    if (!text.trim() || !activeId || !isHumanActive) return;

    setSending(true);
    if (!customText) setReplyText('');

    const tempMsg: Message = {
      id: 'temp-' + Date.now(),
      sender: 'HUMAN_AGENT',
      content: text,
      sentAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, tempMsg]);

    try {
      // Use the WhatsApp-aware endpoint — this saves to DB AND delivers
      // the message to the customer's WhatsApp number via the Cloud API.
      // The generic /api/conversations/:id/messages only saves to DB.
      const activeConvChannel = conversations.find(c => c.id === activeId)?.channel;
      const endpoint = activeConvChannel === 'WHATSAPP'
        ? `${API_URL}/api/whatsapp/conversations/${activeId}/messages`
        : `${API_URL}/api/conversations/${activeId}/messages`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('Failed to send message:', err);
        // Remove optimistic message on failure
        setMessages(prev => prev.filter(m => m.id !== tempMsg.id));
        setReplyText(text);
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      setMessages(prev => prev.filter(m => m.id !== tempMsg.id));
      setReplyText(text);
    } finally {
      setSending(false);
    }
  };

  const activeConv = conversations.find(c => c.id === activeId);

  const filteredConvs = conversations.filter(c => {
    const name = (c.contact?.fullName || c.contactName || '').toLowerCase();
    const matchSearch = name.includes(search.toLowerCase());
    const matchChannel = channelFilter === 'ALL' || c.channel === channelFilter;
    return matchSearch && matchChannel;
  });

  const channelBadge = (channel: string) => {
    const map: Record<string, string> = {
      WHATSAPP: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20',
      VOICE: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-500/20',
      WEBCHAT: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-500/20',
    };
    return map[channel] || 'bg-gray-500/15 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-500/20';
  };

  const handleToggleHandoff = async () => {
    if (!activeId) return;
    const newStatus = !isHumanActive;
    setIsHumanActive(newStatus);
    try {
      // Use WhatsApp-specific endpoint — updates assignedUserId + handoff flag
      await fetch(`${API_URL}/api/whatsapp/conversations/${activeId}/handoff`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ isHumanHandoffActive: newStatus }),
      });
      fetchConversations();
    } catch (err) {
      console.error('Failed to toggle handoff:', err);
      setIsHumanActive(!newStatus);
    }
  };

  return (
    <div className="flex h-[calc(100vh-8.5rem)] gap-4">
      {/*
        Full-height split pane with no room for a visible title, but it still
        needs a page heading: without one the document's only h1 is the app
        shell's "ACE Platform", so every route announces identically to a
        screen reader.
      */}
      <h1 className="sr-only">Agent Console</h1>
      {/* Left: Conversation List */}
      <div className="w-80 flex-shrink-0 flex flex-col border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900/80 overflow-hidden">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-slate-900 dark:text-white text-sm flex items-center gap-2">
              <MessageSquareText className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              Live Inbox
              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 font-bold">
                {conversations.length}
              </span>
            </h2>
            <div className="flex items-center gap-2">
              {wsConnected
                ? <span className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 font-bold"><Wifi className="w-3 h-3" /> Live</span>
                : <span className="flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400"><WifiOff className="w-3 h-3" /> Offline</span>
              }
              <button onClick={fetchConversations} className="text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:text-slate-300 transition-colors">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
            <input
              type="text"
              placeholder="Search contacts..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-xs text-slate-900 dark:text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
            />
          </div>

          {/* Channel Filters */}
          <div className="flex gap-1">
            {['ALL', 'WHATSAPP', 'VOICE', 'WEBCHAT'].map(ch => (
              <button
                key={ch}
                onClick={() => setChannelFilter(ch)}
                className={`flex-1 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-colors ${
                  channelFilter === ch ? 'bg-blue-600 text-white' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:bg-slate-800/60'
                }`}
              >
                {ch === 'WHATSAPP' ? 'WA' : ch}
              </button>
            ))}
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loading ? (
            [1, 2, 3].map(i => <div key={i} className="h-16 bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm rounded-xl animate-pulse" />)
          ) : filteredConvs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-500 dark:text-slate-400 px-4 text-center">
              <MessageCircle className="w-8 h-8 mb-2 opacity-30" />
              <p className="text-sm text-slate-500 dark:text-slate-400">No conversations</p>
              <p className="text-xs mt-1">Incoming customer chats will appear here automatically.</p>
            </div>
          ) : (
            filteredConvs.map(conv => {
              const name = conv.contact?.fullName || conv.contactName || 'Unknown Contact';
              const isActive = activeId === conv.id;
              return (
                <button
                  key={conv.id}
                  onClick={() => setActiveId(conv.id)}
                  className={`w-full text-left p-3 rounded-xl transition-all ${
                    isActive ? 'bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60 border border-transparent'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold ${
                      isActive ? 'bg-blue-500/30 text-blue-700 dark:text-blue-300' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                    }`}>
                      {name[0]?.toUpperCase() || '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">{name}</span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold border ${channelBadge(conv.channel)}`}>
                          {conv.channel}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                        {conv.messages?.[0]?.content || 'Active conversation'}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Middle: Chat Window */}
      <div className="flex-1 flex flex-col border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900/80 overflow-hidden">
        {activeConv ? (
          <>
            {/* Header */}
            <div className="h-16 px-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center text-sm font-bold">
                  {(activeConv.contact?.fullName || activeConv.contactName || '?')[0].toUpperCase()}
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 dark:text-slate-100 text-sm">{activeConv.contact?.fullName || activeConv.contactName || 'Unknown Contact'}</h3>
                  <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold border ${channelBadge(activeConv.channel)}`}>
                      {activeConv.channel}
                    </span>
                    <span>{activeConv.contact?.phoneNumber || ''}</span>
                  </div>
                </div>
              </div>

              <button
                onClick={handleToggleHandoff}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  isHumanActive
                    ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30'
                    : 'bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-slate-200 dark:border-slate-700'
                }`}
              >
                {isHumanActive ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                {isHumanActive ? 'Human Takeover Active' : 'AI Assistant Handling'}
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {msgLoading ? (
                <div className="flex items-center justify-center py-20">
                  <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-500 dark:text-slate-400">
                  <MessageCircle className="w-10 h-10 mb-3 opacity-20" />
                  <p className="text-sm">No messages yet.</p>
                </div>
              ) : (
                messages.map((msg, i) => {
                  const isCustomer = msg.sender === 'CUSTOMER';
                  const isHumanMsg = msg.sender === 'HUMAN_AGENT';
                  return (
                    <div key={msg.id || i} className={`flex ${isCustomer ? 'justify-start' : 'justify-end'}`}>
                      {isCustomer && (
                        <div className="w-7 h-7 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mr-2 flex-shrink-0 mt-1">
                          <User className="w-3.5 h-3.5 text-slate-600 dark:text-slate-400" />
                        </div>
                      )}
                      <div className={`max-w-[65%] rounded-2xl px-4 py-2.5 text-sm ${
                        isCustomer
                          ? 'bg-white/[0.06] text-slate-800 dark:text-slate-200 rounded-tl-sm border border-slate-200 dark:border-slate-800'
                          : isHumanMsg
                            ? 'bg-emerald-600/80 text-white rounded-tr-sm'
                            : 'bg-blue-600/80 text-white rounded-tr-sm'
                      }`}>
                        {!isCustomer && (
                          <div className="flex items-center gap-1.5 mb-1 opacity-70">
                            {isHumanMsg ? <User className="w-3 h-3" /> : <Bot className="w-3 h-3" />}
                            <span className="text-[9px] uppercase font-bold tracking-wider">
                              {isHumanMsg ? 'Human Agent' : 'AI Assistant'}
                            </span>
                          </div>
                        )}
                        <p className="leading-relaxed">{msg.content}</p>
                        {(msg.sentAt || msg.createdAt) && (
                          <span className="text-[9px] opacity-50 mt-1 block text-right">
                            {new Date(msg.sentAt || msg.createdAt || '').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Quick replies bar */}
            {isHumanActive && (
              <div className="px-4 py-2 bg-slate-100 dark:bg-slate-800/60 border-t border-slate-200 dark:border-slate-800 flex items-center gap-2 overflow-x-auto">
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1 flex-shrink-0">
                  <Zap className="w-3 h-3 text-amber-600 dark:text-amber-400" /> Quick Snippets:
                </span>
                {QUICK_REPLIES.map((reply, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSend(undefined, reply)}
                    className="px-2.5 py-1 rounded-lg bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs truncate max-w-[200px] flex-shrink-0 border border-slate-200 dark:border-slate-800 transition-colors"
                  >
                    {reply}
                  </button>
                ))}
              </div>
            )}

            {/* Input box */}
            <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex-shrink-0">
              {!isHumanActive && (
                <div className="mb-2 px-3 py-1.5 rounded-lg bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 text-xs text-blue-700 dark:text-blue-300 flex items-center gap-2">
                  <Bot className="w-3.5 h-3.5" />
                  AI Agent is currently answering automatically. Click "Human Takeover" above to take control.
                </div>
              )}
              <form onSubmit={e => handleSend(e)} className="flex gap-2">
                <input
                  type="text"
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  placeholder={isHumanActive ? "Type your message to customer..." : "Enable Human Takeover to type"}
                  disabled={!isHumanActive || sending}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-40 text-sm"
                />
                <button
                  type="submit"
                  disabled={!isHumanActive || !replyText.trim() || sending}
                  className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center disabled:opacity-40 transition-all shadow-lg shadow-blue-500/20"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-500 dark:text-slate-400">
            <MessageSquareText className="w-14 h-14 mb-3 opacity-20" />
            <h3 className="text-slate-600 dark:text-slate-400 font-semibold text-sm">Select a Conversation</h3>
            <p className="text-xs text-center max-w-xs text-slate-500 dark:text-slate-400 mt-1">
              Choose a customer thread from the left panel to inspect message history and engage in real time.
            </p>
          </div>
        )}
      </div>

      {/* Right: Contact Context Panel */}
      {activeConv && (
        <div className="w-72 flex-shrink-0 border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900/80 p-4 space-y-4 overflow-y-auto hidden xl:block">
          <div className="text-center pb-4 border-b border-slate-200 dark:border-slate-800">
            <div className="w-14 h-14 rounded-full bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 font-bold text-lg flex items-center justify-center mx-auto mb-2">
              {(activeConv.contact?.fullName || activeConv.contactName || '?')[0].toUpperCase()}
            </div>
            <h4 className="font-bold text-slate-900 dark:text-white text-sm">{activeConv.contact?.fullName || activeConv.contactName || 'Unknown Customer'}</h4>
            <p className="text-xs font-mono text-blue-600 dark:text-blue-400 mt-0.5">{activeConv.contact?.phoneNumber || 'No phone'}</p>
          </div>

          <div className="space-y-3">
            <div>
              <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Email</p>
              <p className="text-xs text-slate-700 dark:text-slate-300 flex items-center gap-1.5"><Mail className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" /> {activeConv.contact?.email || 'Not specified'}</p>
            </div>

            <div>
              <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Channel Source</p>
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${channelBadge(activeConv.channel)}`}>
                {activeConv.channel}
              </span>
            </div>

            <div>
              <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Tags</p>
              <div className="flex gap-1 flex-wrap">
                <span className="px-2 py-0.5 rounded text-[10px] bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20">{activeConv.channel}</span>
                {isHumanActive
                  ? <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20">Human Takeover</span>
                  : <span className="px-2 py-0.5 rounded text-[10px] bg-purple-50 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-200 dark:border-purple-500/20">AI Handling</span>
                }
              </div>
            </div>

            {/* Onboarding selfie. Needs a real contact id — a conversation whose contact
                was never resolved has nothing to attach a photo to. */}
            {activeConv.contact?.id && (
              <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
                <SelfieRequestPanel
                  contactId={activeConv.contact.id}
                  contactName={activeConv.contact.fullName || activeConv.contactName}
                  conversationId={activeConv.id}
                  channel={activeConv.channel === 'VOICE' ? 'VOICE' : 'WHATSAPP'}
                />
              </div>
            )}

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
              <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Last Message</p>
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                {messages.length > 0
                  ? <>
                      <span className="text-[9px] uppercase font-bold text-slate-400 dark:text-slate-500 block mb-1">
                        {messages[messages.length - 1]?.sender === 'CUSTOMER' ? '👤 Customer' :
                         messages[messages.length - 1]?.sender === 'HUMAN_AGENT' ? '🧑‍💼 Agent' : '🤖 AI'}
                      </span>
                      {(messages[messages.length - 1]?.content || '').slice(0, 100)}
                      {(messages[messages.length - 1]?.content || '').length > 100 ? '…' : ''}
                    </>
                  : <span className="text-slate-400 dark:text-slate-500 italic">No messages yet</span>
                }
              </div>
              {messages.length > 0 && (
                <p className="text-[10px] text-slate-400 dark:text-slate-500">{messages.length} message{messages.length !== 1 ? 's' : ''} in thread</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
