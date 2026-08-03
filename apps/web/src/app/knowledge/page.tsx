"use client";

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { api, API_URL } from '@/lib/api';
import {
  BookOpen, Upload, Search, FileText, Loader2, AlertCircle,
  CheckCircle2, Clock, Globe, Sparkles, Trash2, RefreshCw,
  Plus, X, ExternalLink, Database, Zap, Brain, MessageSquare,
  ChevronRight, Layers
} from 'lucide-react';

interface KnowledgeDoc {
  id: string;
  title: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  status: 'PENDING' | 'PROCESSING' | 'INDEXED' | 'FAILED';
  chunkCount?: number;
  createdAt?: string;
  sourceUrl?: string;
}

interface SearchResult {
  content: string;
  similarity: number;
  documentTitle?: string;
  documentId?: string;
}

interface FaqPair {
  id: string;
  question: string;
  answer: string;
  category: string;
}

export default function KnowledgePage() {
  const [activeTab, setActiveTab] = useState<'documents' | 'faqs'>('documents');
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Selected document for chunk inspection
  const [selectedDoc, setSelectedDoc] = useState<KnowledgeDoc | null>(null);

  // FAQ Manager state
  const [faqs, setFaqs] = useState<FaqPair[]>([]);
  const [editingFaq, setEditingFaq] = useState<string | null>(null);
  const [editQuestion, setEditQuestion] = useState('');
  const [editAnswer, setEditAnswer] = useState('');
  const [showFaqModal, setShowFaqModal] = useState(false);
  const [faqQuestion, setFaqQuestion] = useState('');
  const [faqAnswer, setFaqAnswer] = useState('');
  const [faqCategory, setFaqCategory] = useState('General');

  // Website Crawler states
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [crawling, setCrawling] = useState(false);
  const [crawlStatus, setCrawlStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Text paste modal
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteContent, setPasteContent] = useState('');
  const [pasting, setPasting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchDocs = useCallback(async () => {
    try {
      const res = await api.knowledge.getDocuments();
      setDocs(res || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchFaqs = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/knowledge/faqs`, { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setFaqs(data || []);
      }
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    fetchDocs();
    fetchFaqs();
    const interval = setInterval(() => { fetchDocs(); fetchFaqs(); }, 8000);
    return () => clearInterval(interval);
  }, [fetchDocs, fetchFaqs]);

  const token = typeof window !== 'undefined' ? localStorage.getItem('ace_token') : '';
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const handleCrawlWebsite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!websiteUrl.trim()) return;
    setCrawling(true);
    setCrawlStatus(null);
    try {
      const res = await fetch(`${API_URL}/api/knowledge/crawl-website`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ url: websiteUrl }),
      });
      if (res.ok) {
        const data = await res.json();
        setCrawlStatus({ type: 'success', text: data.message || 'Website crawled and indexed successfully!' });
        setWebsiteUrl('');
        await fetchDocs();
      } else {
        const err = await res.json().catch(() => ({ message: 'Failed to crawl' }));
        setCrawlStatus({ type: 'error', text: err.message || 'Could not crawl website.' });
      }
    } catch {
      setCrawlStatus({ type: 'error', text: 'Network error. Check the URL and try again.' });
    } finally {
      setCrawling(false);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    setHasSearched(true);
    try {
      const res = await api.knowledge.search(searchQuery);
      setSearchResults(res || []);
    } catch (err) {
      console.error(err);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const toBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        let encoded = reader.result?.toString().replace(/^data:(.*,)?/, '') || '';
        if (encoded.length % 4 > 0) encoded += '='.repeat(4 - (encoded.length % 4));
        resolve(encoded);
      };
      reader.onerror = reject;
    });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadProgress(0);
    try {
      const progressInterval = setInterval(() => {
        setUploadProgress(p => Math.min(p + 20, 90));
      }, 150);

      const base64 = await toBase64(file);
      await api.knowledge.uploadDocument({
        title: file.name.replace(/\.[^/.]+$/, ''),
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        fileBufferBase64: base64,
      });

      clearInterval(progressInterval);
      setUploadProgress(100);
      await fetchDocs();
      setTimeout(() => setUploadProgress(0), 800);
    } catch (err) {
      console.error(err);
      setUploadProgress(0);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handlePasteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pasteTitle.trim() || !pasteContent.trim()) return;
    setPasting(true);
    try {
      const base64 = btoa(unescape(encodeURIComponent(pasteContent)));
      await api.knowledge.uploadDocument({
        title: pasteTitle,
        fileName: `${pasteTitle}.txt`,
        fileSize: pasteContent.length,
        mimeType: 'text/plain',
        fileBufferBase64: base64,
      });
      setShowPasteModal(false);
      setPasteTitle('');
      setPasteContent('');
      await fetchDocs();
    } catch (err) {
      console.error(err);
    } finally {
      setPasting(false);
    }
  };

  const handleAddFaq = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!faqQuestion.trim() || !faqAnswer.trim()) return;

    try {
      const res = await fetch(`${API_URL}/api/knowledge/faqs`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ question: faqQuestion, answer: faqAnswer, category: faqCategory })
      });
      if (res.ok) {
        fetchFaqs();
        setShowFaqModal(false);
        setFaqQuestion('');
        setFaqAnswer('');
      } else {
        alert('Failed to add FAQ');
      }
    } catch (err) {
      alert('Error adding FAQ');
    }
  };

  const handleEditFaq = async (id: string) => {
    if (!editQuestion.trim() || !editAnswer.trim()) return;
    try {
      const res = await fetch(`${API_URL}/api/knowledge/faqs/${id}`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ question: editQuestion, answer: editAnswer })
      });
      if (res.ok) {
        fetchFaqs();
        setEditingFaq(null);
      } else {
        alert('Failed to edit FAQ');
      }
    } catch (err) {
      alert('Error editing FAQ');
    }
  };

  const handleDeleteFaq = async (id: string) => {
    if (!confirm('Delete this FAQ rule?')) return;
    try {
      const res = await fetch(`${API_URL}/api/knowledge/faqs/${id}`, {
        method: 'DELETE',
        headers: authHeaders
      });
      if (res.ok) {
        fetchFaqs();
      } else {
        alert('Failed to delete FAQ');
      }
    } catch (err) {
      alert('Error deleting FAQ');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this document from the knowledge base?')) return;
    setDeletingId(id);
    try {
      await fetch(`${API_URL}/api/knowledge/documents/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      setDocs(prev => prev.filter(d => d.id !== id));
    } catch (err) {
      console.error(err);
    } finally {
      setDeletingId(null);
    }
  };

  const statusConfig: Record<string, { label: string; className: string; icon: React.ReactNode }> = {
    PENDING: { label: 'Pending', className: 'bg-amber-500/10 text-amber-400 border-amber-500/20', icon: <Clock className="w-3 h-3" /> },
    PROCESSING: { label: 'Processing', className: 'bg-blue-500/10 text-blue-400 border-blue-500/20', icon: <Loader2 className="w-3 h-3 animate-spin" /> },
    INDEXED: { label: 'Indexed', className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', icon: <CheckCircle2 className="w-3 h-3" /> },
    FAILED: { label: 'Failed', className: 'bg-red-500/10 text-red-400 border-red-500/20', icon: <AlertCircle className="w-3 h-3" /> },
  };

  const indexedCount = docs.filter(d => d.status === 'INDEXED').length;
  const totalChunks = docs.reduce((sum, d) => sum + (d.chunkCount || 0), 0);

  return (
    <div className="space-y-6 max-w-7xl pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Brain className="w-6 h-6 text-blue-400" /> AI Knowledge Base & RAG Engine
          </h1>
          <p className="text-sm text-gray-400 mt-1">Train your AI voice & chat assistant with documents, website links, and explicit Q&A rules.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowFaqModal(true)}
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/30 text-sm font-semibold transition-all"
          >
            <Plus className="w-4 h-4" /> Add FAQ Rule
          </button>
          <button
            onClick={() => setShowPasteModal(true)}
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-gray-300 hover:text-white text-sm font-semibold transition-all"
          >
            <Plus className="w-4 h-4" /> Paste Text
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept=".pdf,.txt,.md,.docx,.csv,.json"
            className="hidden"
          />
          <button
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-all text-sm shadow-lg shadow-blue-500/20 disabled:opacity-50"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Upload File
          </button>
        </div>
      </div>

      {/* Upload progress indicator */}
      {uploading && uploadProgress > 0 && (
        <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4">
          <div className="flex items-center justify-between mb-2 text-sm">
            <span className="text-gray-300 font-medium">Extracting & Vectorizing Document Chunks...</span>
            <span className="text-blue-400 font-mono font-bold">{uploadProgress}%</span>
          </div>
          <div className="w-full h-2 bg-white/[0.05] rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-600 to-blue-400 rounded-full transition-all duration-300"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* KPI Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 text-blue-400 flex items-center justify-center flex-shrink-0">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <p className="text-2xl font-bold text-white">{docs.length}</p>
            <p className="text-xs text-gray-500">Indexed Sources</p>
          </div>
        </div>
        <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center flex-shrink-0">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div>
            <p className="text-2xl font-bold text-white">{indexedCount}</p>
            <p className="text-xs text-gray-500">Active & Ready</p>
          </div>
        </div>
        <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-purple-500/10 text-purple-400 flex items-center justify-center flex-shrink-0">
            <Database className="w-5 h-5" />
          </div>
          <div>
            <p className="text-2xl font-bold text-white">{totalChunks}</p>
            <p className="text-xs text-gray-500">Vector Embeddings</p>
          </div>
        </div>
      </div>

      {/* Website Crawler Box */}
      <div className="rounded-2xl border border-blue-500/20 bg-blue-500/[0.04] p-5 space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-blue-600/20 flex items-center justify-center text-blue-400">
            <Globe className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">Import Knowledge From Any Website</h2>
            <p className="text-xs text-gray-400">Enter a website URL below. The AI crawler will scrape and index all text content automatically.</p>
          </div>
        </div>
        <form onSubmit={handleCrawlWebsite} className="flex gap-3">
          <input
            type="url"
            value={websiteUrl}
            onChange={e => setWebsiteUrl(e.target.value)}
            placeholder="https://yourcompany.com or https://apexcare.ng"
            className="flex-1 px-4 py-2.5 rounded-xl bg-black/30 border border-white/[0.08] text-white text-sm focus:outline-none focus:border-blue-500/60 placeholder-gray-600"
            required
          />
          <button
            type="submit"
            disabled={crawling}
            className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-all flex items-center gap-2 disabled:opacity-50 flex-shrink-0 shadow-lg shadow-blue-500/20"
          >
            {crawling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {crawling ? 'Crawling Website...' : 'Crawl & Index URL'}
          </button>
        </form>
        {crawlStatus && (
          <div className={`p-3 rounded-xl flex items-center gap-2 text-sm ${crawlStatus.type === 'success' ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/20 text-red-400'}`}>
            {crawlStatus.type === 'success' ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
            {crawlStatus.text}
          </div>
        )}
      </div>

      {/* Tabs Bar */}
      <div className="flex gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.06] w-fit">
        <button
          onClick={() => setActiveTab('documents')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            activeTab === 'documents' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          <FileText className="w-4 h-4" /> Documents & Websites ({docs.length})
        </button>
        <button
          onClick={() => setActiveTab('faqs')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            activeTab === 'faqs' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          <MessageSquare className="w-4 h-4" /> Custom FAQ Rules ({faqs.length})
        </button>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Left Column (Docs or FAQs list) */}
        <div className="lg:col-span-3 space-y-3">
          {activeTab === 'documents' ? (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">Indexed Knowledge Sources</h2>
                <button onClick={fetchDocs} className="text-gray-500 hover:text-gray-300 transition-colors">
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
              {loading ? (
                <div className="space-y-2">
                  {[1, 2, 3].map(i => <div key={i} className="h-16 bg-white/[0.03] rounded-xl border border-white/[0.06] animate-pulse" />)}
                </div>
              ) : docs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 border border-dashed border-white/[0.08] rounded-2xl text-gray-600">
                  <BookOpen className="w-12 h-12 mb-3 opacity-20" />
                  <p className="text-gray-400 font-medium mb-1">No knowledge sources indexed yet</p>
                  <p className="text-sm">Upload a PDF/TXT document or enter a website URL above.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {docs.map(doc => {
                    const cfg = statusConfig[doc.status] || statusConfig.PENDING;
                    return (
                      <div
                        key={doc.id}
                        onClick={() => setSelectedDoc(doc)}
                        className={`flex items-center gap-3 p-4 rounded-xl border transition-all cursor-pointer group ${
                          selectedDoc?.id === doc.id
                            ? 'bg-blue-500/10 border-blue-500/30'
                            : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.05]'
                        }`}
                      >
                        <div className={`w-9 h-9 rounded-xl flex-shrink-0 flex items-center justify-center ${
                          doc.mimeType === 'text/html' || doc.sourceUrl ? 'bg-blue-500/10 text-blue-400' : 'bg-purple-500/10 text-purple-400'
                        }`}>
                          {doc.mimeType === 'text/html' || doc.sourceUrl ? <Globe className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-gray-200 truncate">{doc.title || doc.fileName}</p>
                          <div className="flex items-center gap-3 mt-0.5">
                            {doc.fileSize && <span className="text-xs text-gray-600">{(doc.fileSize / 1024).toFixed(1)} KB</span>}
                            {doc.chunkCount && <span className="text-xs text-gray-600">{doc.chunkCount} vector chunks</span>}
                          </div>
                        </div>
                        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border flex-shrink-0 ${cfg.className}`}>
                          {cfg.icon} {cfg.label}
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(doc.id); }}
                          disabled={deletingId === doc.id}
                          className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-all p-1 flex-shrink-0"
                        >
                          {deletingId === doc.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">Explicit Question & Answer Rules</h2>
              </div>
              <div className="space-y-3">
                {faqs.map((faq) => (
                  <div key={faq.id} className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] space-y-3">
                    {editingFaq === faq.id ? (
                      <div className="space-y-3">
                        <input type="text" value={editQuestion} onChange={e => setEditQuestion(e.target.value)} className="w-full px-3 py-1.5 rounded bg-white/[0.05] border border-white/10 text-white text-sm" />
                        <textarea value={editAnswer} onChange={e => setEditAnswer(e.target.value)} className="w-full px-3 py-1.5 rounded bg-white/[0.05] border border-white/10 text-white text-sm" rows={2} />
                        <div className="flex gap-2">
                          <button onClick={() => handleEditFaq(faq.id)} className="px-3 py-1 bg-emerald-500/20 text-emerald-300 text-xs rounded hover:bg-emerald-500/30">Save</button>
                          <button onClick={() => setEditingFaq(null)} className="px-3 py-1 bg-gray-500/20 text-gray-300 text-xs rounded hover:bg-gray-500/30">Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-blue-400 uppercase tracking-wider">Q: {faq.question}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] px-2 py-0.5 rounded bg-white/[0.06] text-gray-400">{faq.category}</span>
                            <button onClick={() => { setEditingFaq(faq.id); setEditQuestion(faq.question); setEditAnswer(faq.answer); }} className="text-xs text-blue-400 hover:underline">Edit</button>
                            <button onClick={() => handleDeleteFaq(faq.id)} className="text-xs text-red-400 hover:underline">Delete</button>
                          </div>
                        </div>
                        <p className="text-xs text-gray-300 leading-relaxed">A: {faq.answer}</p>
                      </>
                    )}
                  </div>
                ))}
                {faqs.length === 0 && (
                  <div className="text-center py-10 text-gray-500">No FAQ rules defined.</div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Search Playground */}
        <div className="lg:col-span-2 space-y-3">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" /> RAG Search Playground
          </h2>
          <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
            <form onSubmit={handleSearch} className="p-4 border-b border-white/[0.06]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Ask anything your AI should know..."
                  className="w-full pl-10 pr-20 py-2.5 rounded-xl bg-black/30 border border-white/[0.08] text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500/50"
                />
                <button
                  type="submit"
                  disabled={searching}
                  className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg disabled:opacity-50 transition-all"
                >
                  {searching ? 'Searching...' : 'Search'}
                </button>
              </div>
            </form>
            <div className="p-4 space-y-3 max-h-96 overflow-y-auto">
              {searching ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
                </div>
              ) : searchResults.length > 0 ? (
                searchResults.map((r, i) => (
                  <div key={i} className="p-3.5 rounded-xl bg-black/20 border border-white/[0.05] space-y-2">
                    <p className="text-xs text-gray-300 leading-relaxed">{r.content}</p>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-gray-500">
                        {r.documentTitle && `Source: ${r.documentTitle}`}
                      </span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        r.similarity > 0.8 ? 'bg-emerald-500/10 text-emerald-400' :
                        r.similarity > 0.6 ? 'bg-amber-500/10 text-amber-400' :
                        'bg-gray-500/10 text-gray-500'
                      }`}>
                        {(r.similarity * 100).toFixed(0)}% match
                      </span>
                    </div>
                  </div>
                ))
              ) : hasSearched ? (
                <div className="text-center py-10 text-gray-600">
                  <Search className="w-8 h-8 mx-auto mb-2 opacity-20" />
                  <p className="text-sm">No vector matches found for your query.</p>
                </div>
              ) : (
                <div className="text-center py-10 text-gray-600">
                  <Brain className="w-8 h-8 mx-auto mb-2 opacity-20" />
                  <p className="text-sm">Search vector memory to test AI context.</p>
                  <p className="text-xs mt-1">Try: "What are your prices?" or "Working hours"</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Paste text modal */}
      {showPasteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-[#0d1225] border border-white/10 rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
              <h2 className="text-lg font-bold text-white">Paste Knowledge Text</h2>
              <button onClick={() => setShowPasteModal(false)} className="text-gray-500 hover:text-gray-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handlePasteSubmit} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-gray-400 mb-1.5 block">Document Title</label>
                <input
                  type="text"
                  required
                  value={pasteTitle}
                  onChange={e => setPasteTitle(e.target.value)}
                  placeholder="e.g. Return Policy, Product Details"
                  className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 placeholder-gray-600"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-400 mb-1.5 block">Content Body</label>
                <textarea
                  required
                  rows={8}
                  value={pasteContent}
                  onChange={e => setPasteContent(e.target.value)}
                  placeholder="Paste text content here..."
                  className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 resize-none placeholder-gray-600"
                />
              </div>
              <button
                type="submit"
                disabled={pasting}
                className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm disabled:opacity-50 transition-all flex items-center justify-center gap-2"
              >
                {pasting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {pasting ? 'Indexing...' : 'Index Content'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Add FAQ Modal */}
      {showFaqModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-[#0d1225] border border-white/10 rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
              <h2 className="text-lg font-bold text-white">Add FAQ Rule</h2>
              <button onClick={() => setShowFaqModal(false)} className="text-gray-500 hover:text-gray-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAddFaq} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-gray-400 mb-1.5 block">Customer Question</label>
                <input
                  type="text"
                  required
                  value={faqQuestion}
                  onChange={e => setFaqQuestion(e.target.value)}
                  placeholder="e.g. Do you offer nationwide delivery?"
                  className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 placeholder-gray-600"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-400 mb-1.5 block">Exact Answer for AI</label>
                <textarea
                  required
                  rows={4}
                  value={faqAnswer}
                  onChange={e => setFaqAnswer(e.target.value)}
                  placeholder="e.g. Yes, we deliver across all 36 states in Nigeria via Red Star Express..."
                  className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 resize-none placeholder-gray-600"
                />
              </div>
              <button
                type="submit"
                className="w-full py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold text-sm transition-all flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" /> Save FAQ Rule
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
