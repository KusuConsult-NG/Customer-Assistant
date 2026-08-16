"use client";

import React, { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { useToast } from '@/components/ui/Toast';
import { copyToClipboard } from "@/lib/clipboard";
import { Code, Save, Copy, Check, Palette, MessageSquare, ToggleLeft, Monitor } from "lucide-react";

export default function WidgetPage() {
  const toast = useToast();
  const [config, setConfig] = useState({
    welcomeMessage: "Hi there! How can I help you today?",
    primaryColor: "#3b82f6",
    secondaryColor: "#1e40af",
    position: "bottom-right",
    enableChat: true,
    companyName: "Kusu Consult",
  });

  const [copied, setCopied] = useState(false);
  // Null until a key is generated. The previous default was the literal string
  // "ace_live_demo_key_123", and /api/organizations/me never returns an `apiKey`
  // field (keys are only ever shown once, at generation), so the snippet on this
  // page always displayed that fake key — every widget copied from here was broken.
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function loadData() {
      try {
        const org: any = await api.organizations.getMe();
        // Load what is actually stored, so the panel shows the live widget's
        // configuration rather than defaults that mask it.
        setConfig(prev => ({
          ...prev,
          ...(org?.name && { companyName: org.name }),
          ...(org?.welcomeMessage && { welcomeMessage: org.welcomeMessage }),
          ...(org?.widgetPrimaryColor && { primaryColor: org.widgetPrimaryColor }),
          ...(org?.widgetSecondaryColor && { secondaryColor: org.widgetSecondaryColor }),
          ...(org?.widgetPosition && { position: org.widgetPosition }),
        }));
      } catch (e) {
        console.error(e);
      }
    }
    loadData();
  }, []);

  /**
   * Generates a live API key. The plaintext key is returned exactly once — the server
   * stores only its SHA-256 hash — so it is held in component state for copying and
   * is not retrievable afterwards.
   */
  const handleGenerateKey = async () => {
    setGenerating(true);
    try {
      const res: any = await api.organizations.regenerateApiKey();
      if (res?.apiKey) setApiKey(res.apiKey);
    } catch (e: any) {
      toast.error(e?.message || "Could not generate an API key.");
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Every control on this panel is sent. Previously only welcomeMessage
      // was, while the toast still said "Widget settings saved" — an operator
      // could set their brand colour and position, be told it saved, and see
      // the default blue bottom-right widget on their site forever.
      await api.organizations.updateSettings({
        welcomeMessage: config.welcomeMessage,
        widgetPrimaryColor: config.primaryColor,
        widgetSecondaryColor: config.secondaryColor,
        widgetPosition: config.position,
      });
      toast.success("Widget settings saved.");
    } catch (e) {
      console.error(e);
      toast.error("Could not save the widget settings. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  // widget.js is served by the WEB app (apps/web/public/widget.js), not the API, so
  // the src must be this origin. It pointed at NEXT_PUBLIC_API_URL, where no such
  // file exists, so every embed 404'd on the script itself. data-api-url tells the
  // widget where to reach the API.
  const webOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const apiOrigin = process.env.NEXT_PUBLIC_API_URL || "";
  const codeSnippet = apiKey
    ? `<script src="${webOrigin}/widget.js" data-api-key="${apiKey}" data-api-url="${apiOrigin}"></script>`
    : "";

  const copyCode = async () => {
    if (!codeSnippet) return;
    const ok = await copyToClipboard(codeSnippet);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-screen overflow-hidden bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 backdrop-blur-md">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Code className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            Widget Generator
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">Customize and embed the web chat & voice widget.</p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 transition text-white font-medium rounded-lg text-sm disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
        {/* Left config */}
        <div className="w-full lg:w-1/3 p-6 overflow-y-auto border-r border-slate-200 dark:border-slate-800 space-y-8">
          
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2 uppercase tracking-widest opacity-80">
              <Palette className="w-4 h-4" /> Theme
            </h3>
            
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Primary Color</label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={config.primaryColor}
                  onChange={e => setConfig({...config, primaryColor: e.target.value})}
                  className="w-10 h-10 rounded border-0 bg-transparent cursor-pointer"
                />
                <span className="text-sm font-mono text-slate-700 dark:text-slate-300">{config.primaryColor}</span>
              </div>
            </div>
            
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Widget Position</label>
              <select
                value={config.position}
                onChange={e => setConfig({...config, position: e.target.value})}
                className="w-full bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition"
              >
                <option value="bottom-right">Bottom Right</option>
                <option value="bottom-left">Bottom Left</option>
              </select>
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2 uppercase tracking-widest opacity-80">
              <MessageSquare className="w-4 h-4" /> Content
            </h3>
            
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Greeting / Welcome Message</label>
              <textarea
                value={config.welcomeMessage}
                onChange={e => setConfig({...config, welcomeMessage: e.target.value})}
                className="w-full bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 rounded-lg p-3 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition h-24 resize-none"
              />
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2 uppercase tracking-widest opacity-80">
              <ToggleLeft className="w-4 h-4" /> Features
            </h3>
            
            <label className="flex items-center justify-between cursor-pointer p-3 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:bg-slate-800/60 transition">
              <span className="text-sm font-medium">Enable Web Chat</span>
              <input
                type="checkbox"
                checked={config.enableChat}
                onChange={e => setConfig({...config, enableChat: e.target.checked})}
                className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-gray-800"
              />
            </label>

            {/*
              No "Enable Voice Calling" toggle. There is no click-to-call or
              WebRTC path behind the embedded widget, and the API deliberately
              reports enableVoiceCall: false. A switch that cannot turn anything
              on is a promise to the operator that their visitors can ring them
              from the website — they cannot.
            */}
          </div>

          <div className="space-y-4 pt-4 border-t border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2 uppercase tracking-widest opacity-80">
              <Code className="w-4 h-4" /> Embed Code
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400">Copy this code and paste it before the closing &lt;/body&gt; tag of your website.</p>

            {!apiKey ? (
              <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-3">
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  Generate an API key to get your embed snippet. The key is shown once —
                  copy it somewhere safe.
                </p>
                <button
                  onClick={handleGenerateKey}
                  disabled={generating}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition disabled:opacity-50"
                >
                  {generating ? 'Generating…' : 'Generate widget API key'}
                </button>
              </div>
            ) : (
              <div className="relative group">
                <pre className="bg-white dark:bg-slate-900 p-4 rounded-lg overflow-x-auto text-[11px] font-mono text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800">
                  {codeSnippet}
                </pre>
                <button
                  onClick={copyCode}
                  className="absolute top-2 right-2 p-1.5 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-white transition opacity-0 group-hover:opacity-100"
                  title="Copy code"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right preview */}
        <div className="flex-1 bg-slate-100 dark:bg-slate-800/60 relative p-6 lg:p-12 overflow-hidden flex flex-col">
          <div className="absolute top-6 left-6 text-sm font-semibold text-white/40 flex items-center gap-2 uppercase tracking-widest">
            <Monitor className="w-4 h-4" /> Live Preview
          </div>
          
          <div className="flex-1 bg-white rounded-xl overflow-hidden shadow-2xl border border-slate-200 dark:border-slate-700 flex flex-col relative w-full h-full">
            <div className="h-14 bg-gray-100 border-b border-gray-200 flex items-center px-4 gap-4">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-red-400" />
                <div className="w-3 h-3 rounded-full bg-amber-400" />
                <div className="w-3 h-3 rounded-full bg-green-400" />
              </div>
              <div className="flex-1 bg-white h-8 rounded border border-gray-200 flex items-center px-3 text-xs text-slate-600 dark:text-slate-400 font-mono">
                customer-website.com
              </div>
            </div>
            
            <div className="flex-1 bg-slate-50 p-8 relative">
              <div className="max-w-xl space-y-6">
                <div className="w-64 h-8 bg-gray-200 rounded-md" />
                <div className="w-full h-32 bg-gray-200 rounded-md" />
                <div className="w-4/5 h-24 bg-gray-200 rounded-md" />
              </div>

              {/* Injected Widget Mock */}
              <div
                className="absolute"
                style={{
                  bottom: "20px",
                  left: config.position === "bottom-left" ? "20px" : "auto",
                  right: config.position === "bottom-right" ? "20px" : "auto",
                  width: "380px",
                  height: "520px",
                  background: "rgba(255, 255, 255, 0.95)",
                  backdropFilter: "blur(16px)",
                  border: "1px solid rgba(0,0,0,0.1)",
                  borderRadius: "16px",
                  boxShadow: "0 12px 40px rgba(0,0,0,0.15)",
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                  fontFamily: "system-ui, sans-serif"
                }}
              >
                <div style={{ background: config.primaryColor, padding: "16px", display: "flex", alignItems: "center", justifyContent: "space-between", color: "#fff" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <div style={{ width: "32px", height: "32px", borderRadius: "50%", background: "#fff" }} />
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "15px" }}>{config.companyName}</div>
                      <div style={{ fontSize: "11px", opacity: 0.8 }}>AI Assistant Online</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <span style={{ cursor: "pointer", padding: "4px" }}>✖</span>
                  </div>
                </div>

                <div style={{ flex: 1, padding: "16px", display: "flex", flexDirection: "column", gap: "12px", background: "#f8fafc" }}>
                  <div style={{ background: "#e2e8f0", color: "#1e293b", padding: "10px 14px", borderRadius: "16px", borderBottomLeftRadius: "4px", fontSize: "14px", alignSelf: "flex-start", maxWidth: "80%" }}>
                    {config.welcomeMessage}
                  </div>
                </div>

                {config.enableChat && (
                  <div style={{ padding: "12px", background: "#fff", borderTop: "1px solid #f1f5f9", display: "flex", gap: "8px" }}>
                    <div style={{ flex: 1, border: "1px solid #e2e8f0", borderRadius: "20px", padding: "8px 16px", fontSize: "14px", color: "#94a3b8" }}>
                      Type a message...
                    </div>
                    <div style={{ width: "38px", height: "38px", borderRadius: "50%", background: config.primaryColor, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                    </div>
                  </div>
                )}
              </div>

            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
