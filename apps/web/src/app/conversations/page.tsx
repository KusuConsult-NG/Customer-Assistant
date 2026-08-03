"use client";
import React, { useState, useEffect, useRef } from 'react';
import { Search, Send, MessageCircle, Phone as WhatsAppIcon, User, Bot, AlertTriangle } from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

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
        setConversations(toArray(data));
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
      id: Date.now().toString(),
      content,
      senderType: 'AGENT',
      createdAt: new Date().toISOString()
    };
    setMessages(prev => [...prev, tempMsg]);

    try {
      const token = localStorage.getItem('ace_token');
      const res = await fetch(`${API_URL}/api/conversations/${selectedId}/messages`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}` 
        },
        body: JSON.stringify({ content, senderType: 'AGENT' })
      });
      if (!res.ok) {
        // Handle failure (e.g. remove optimistic message)
      }
    } catch (err) {
      console.error('Failed to send message', err);
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
      <div className="flex flex-col items-center justify-center py-20 text-center h-full">
        <div className="w-16 h-16 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-4">
          <MessageCircle className="w-8 h-8 text-gray-600" />
        </div>
        <p className="text-gray-400 font-medium mb-1">No conversations yet</p>
        <p className="text-sm text-gray-600 max-w-sm">Connect your WhatsApp Business number in Settings to start receiving messages.</p>
      </div>
    );
  }

  const selectedConversation = conversations.find(c => c.id === selectedId);

  return (
    <div className="flex h-[calc(100vh-80px)] -m-6 border border-white/[0.06] rounded-xl overflow-hidden bg-[#080c18]">
      {/* Left Panel - Conversation List */}
      <div className={`w-full md:w-80 flex-shrink-0 flex flex-col border-r border-white/[0.06] bg-[#0d1225] ${selectedId ? 'hidden md:flex' : 'flex'}`}>
        <div className="p-4 border-b border-white/[0.06]">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-500" />
            <input
              type="text"
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500/50"
            />
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto">
          {filteredConversations.map(conv => (
            <div 
              key={conv.id}
              onClick={() => setSelectedId(conv.id)}
              className={`p-4 border-b border-white/[0.04] cursor-pointer hover:bg-white/[0.02] transition-colors flex items-center gap-3 ${selectedId === conv.id ? 'bg-white/[0.04]' : ''}`}
            >
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500/20 to-indigo-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 font-medium flex-shrink-0">
                {conv.contactName?.slice(0, 2).toUpperCase() || 'U'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <h4 className="text-sm font-semibold text-gray-200 truncate">{conv.contactName || conv.contactPhone}</h4>
                  <span className="text-[10px] text-gray-500 whitespace-nowrap ml-2">
                    {new Date(conv.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-500 truncate mr-2">{conv.lastMessagePreview || 'New conversation'}</p>
                  {!!conv.unreadCount && conv.unreadCount > 0 && (
                    <span className="w-4 h-4 rounded-full bg-blue-500 text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">
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
      <div className={`flex-1 flex flex-col min-w-0 bg-[#080c18] relative ${!selectedId ? 'hidden md:flex' : 'flex'}`}>
        {selectedId ? (
          <>
            {/* Chat Header */}
            <div className="h-16 px-6 border-b border-white/[0.06] flex items-center justify-between bg-[#080c18] z-10 shadow-sm flex-shrink-0">
              <div className="flex items-center gap-3">
                <button 
                  className="md:hidden text-gray-400 hover:text-white"
                  onClick={() => setSelectedId(null)}
                >
                  ←
                </button>
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500/20 to-indigo-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 font-medium">
                  {selectedConversation?.contactName?.slice(0, 2).toUpperCase() || 'U'}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">{selectedConversation?.contactName || selectedConversation?.contactPhone}</h3>
                  <p className="text-xs text-gray-500">{selectedConversation?.contactPhone}</p>
                </div>
              </div>
            </div>

            {/* Handoff Banner */}
            {selectedConversation?.isHumanHandoffActive && (
              <div className="bg-orange-500/10 border-b border-orange-500/20 px-6 py-2 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-2 text-orange-400 text-xs font-medium">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Human Handoff Active</span>
                </div>
                <button 
                  onClick={handleReturnToAI}
                  className="text-xs px-3 py-1 bg-white/5 hover:bg-white/10 rounded-lg text-white border border-white/10 transition-colors"
                >
                  Return to AI
                </button>
              </div>
            )}

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {messages.map((msg, i) => {
                const isCustomer = msg.senderType === 'USER';
                const isAI = msg.senderType === 'AI' || msg.senderType === 'SYSTEM';
                
                return (
                  <div key={msg.id || i} className={`flex ${isCustomer ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                      isCustomer 
                        ? 'bg-blue-600 text-white rounded-tr-sm' 
                        : isAI 
                          ? 'bg-[#1a233a] text-gray-200 rounded-tl-sm border border-white/[0.06]' 
                          : 'bg-emerald-600 text-white rounded-tl-sm' // Human agent
                    }`}>
                      {!isCustomer && (
                        <div className="flex items-center gap-1.5 mb-1 text-[10px] opacity-70 font-medium">
                          {isAI ? <Bot className="w-3 h-3" /> : <User className="w-3 h-3" />}
                          {isAI ? 'AI Agent' : 'Human Agent'}
                        </div>
                      )}
                      <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                      <div className={`text-[10px] mt-1 text-right ${isCustomer ? 'text-blue-200' : 'text-gray-500'}`}>
                        {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-4 border-t border-white/[0.06] bg-[#0d1225] flex-shrink-0">
              <form onSubmit={handleSendMessage} className="flex gap-2">
                <input
                  type="text"
                  value={newMessage}
                  onChange={e => setNewMessage(e.target.value)}
                  placeholder="Type a message..."
                  className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500/50"
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
          <div className="flex-1 flex items-center justify-center flex-col text-gray-500">
            <MessageCircle className="w-12 h-12 mb-4 opacity-20" />
            <p>Select a conversation to start messaging</p>
          </div>
        )}
      </div>
    </div>
  );
}
