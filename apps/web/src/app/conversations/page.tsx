"use client";
import React, { useState, useEffect, useRef } from 'react';
import { Search, Send, MessageCircle, Phone as WhatsAppIcon, User, Bot, AlertTriangle } from 'lucide-react';

import { API_URL } from '@/lib/api';
import SharedEmptyState from '@/components/ui/EmptyState';

interface Conversation {
  id: string;
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
  createdAt: string;
}

export default function ConversationsPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [filteredConversations, setFilteredConversations] = useState<Conversation[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  
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
    const list = Array.isArray(conversations) ? conversations : [];
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
  }, [searchQuery, conversations]);

  useEffect(() => {
    if (selectedId) {
      fetchMessages(selectedId);
    }
  }, [selectedId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const fetchConversations = async () => {
    try {
      const token = localStorage.getItem('ace_token');
      const res = await fetch(`${API_URL}/api/whatsapp/conversations`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const rawList = toArray(data);
        const mapped = rawList.map((c: any) => ({
          ...c,
          contactName: c.contactName || c.contact?.fullName || 'Customer',
          contactPhone: c.contactPhone || c.contact?.phoneNumber || '',
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
      const res = await fetch(`${API_URL}/api/conversations/${id}/messages`, {
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
      createdAt: new Date().toISOString()
    };
    setMessages(prev => [...prev, tempMsg]);

    try {
      const token = localStorage.getItem('ace_token');
      const res = await fetch(`${API_URL}/api/whatsapp/conversations/${selectedId}/messages`, {
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

  const handleReturnToAI = async () => {
    if (!selectedId) return;
    try {
      const token = localStorage.getItem('ace_token');
      await fetch(`${API_URL}/api/whatsapp/conversations/${selectedId}/handoff`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}` 
        },
        body: JSON.stringify({ isHumanHandoffActive: false })
      });
      setConversations(prev => prev.map(c => c.id === selectedId ? { ...c, isHumanHandoffActive: false } : c));
    } catch (err) {
      console.error('Failed to return to AI', err);
    }
  };

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
        description="Messages land here from WhatsApp, the web chat widget, and phone calls. Connect a channel and the first one will appear automatically."
        actions={[
          { label: 'Connect WhatsApp', primary: true, href: '/settings' },
          { label: 'Install the chat widget', href: '/widget' },
          { label: 'Set up a phone number', href: '/telephony' },
        ]}
      />
      </>
    );
  }

  const selectedConversation = conversations.find(c => c.id === selectedId);

  return (
    <div className="flex h-[calc(100vh-80px)] -m-6 rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm">
      {/*
        This screen is a full-bleed split pane, so it has no room for a visible
        page title — but it still needs one. Without it the only h1 in the
        document is the app shell's "Customer Care Agent", so a screen reader announces
        every route identically and landmark navigation has nothing to jump to.
      */}
      <h1 className="sr-only">Live Conversations</h1>
      {/* Left Panel - Conversation List */}
      <div className={`w-full md:w-80 flex-shrink-0 flex flex-col border-r border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-white dark:bg-slate-900 ${selectedId ? 'hidden md:flex' : 'flex'}`}>
        <div className="p-4 border-b border-slate-200 dark:border-slate-800">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-white dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 rounded-xl text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-indigo-500/50 shadow-sm"
            />
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto">
          {filteredConversations.map(conv => (
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
                <div className="flex items-center justify-between">
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate mr-2 font-medium">{conv.lastMessagePreview || 'New conversation'}</p>
                  {!!conv.unreadCount && conv.unreadCount > 0 && (
                    <span className="w-4 h-4 rounded-full bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">
                      {conv.unreadCount}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right Panel - Chat Area */}
      <div className={`flex-1 flex flex-col min-w-0 bg-white dark:bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-sm relative ${!selectedId ? 'hidden md:flex' : 'flex'}`}>
        {selectedId ? (
          <>
            {/* Chat Header */}
            <div className="h-16 px-6 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-white dark:bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-sm z-10 shadow-sm flex-shrink-0">
              <div className="flex items-center gap-3">
                <button 
                  className="md:hidden text-slate-400 hover:text-slate-600 dark:hover:text-slate-900 dark:hover:text-white"
                  onClick={() => setSelectedId(null)}
                >
                  ←
                </button>
                <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-500/20 border border-indigo-200 dark:border-indigo-500/30 flex items-center justify-center text-indigo-700 dark:text-indigo-400 font-bold">
                  {selectedConversation?.contactName?.slice(0, 2).toUpperCase() || 'U'}
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white">{selectedConversation?.contactName || selectedConversation?.contactPhone}</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{selectedConversation?.contactPhone}</p>
                </div>
              </div>
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
                        ? 'bg-indigo-600 text-white rounded-tr-sm shadow-sm font-medium' 
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
                        {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex-shrink-0">
              <form onSubmit={handleSendMessage} className="flex gap-2">
                <input
                  type="text"
                  value={newMessage}
                  onChange={e => setNewMessage(e.target.value)}
                  placeholder="Type a message..."
                  className="flex-1 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-900 dark:text-white placeholder-gray-500 focus:outline-none focus:border-blue-500/50"
                />
                <button
                  type="submit"
                  disabled={!newMessage.trim()}
                  className="px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl flex items-center justify-center transition-colors"
                >
                  <Send className="w-5 h-5" />
                </button>
              </form>
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
