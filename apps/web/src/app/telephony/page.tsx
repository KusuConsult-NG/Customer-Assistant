"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { api, API_URL } from '@/lib/api';
import {
  PhoneCall, Sparkles, Phone, CheckCircle, AlertCircle, Radio, ShieldCheck,
  Play, Pause, FileText, Clock, User, Volume2, RefreshCw, X, ArrowUpRight, ArrowDownLeft, PhoneOff
} from 'lucide-react';

interface CallLog {
  id: string;
  fromNumber: string;
  toNumber: string;
  direction?: 'INBOUND' | 'OUTBOUND';
  durationSeconds?: number;
  status: 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  recordingUrl?: string;
  transcript?: string;
  sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
  createdAt: string;
}

export default function TelephonyPage() {
  const [provider, setProvider] = useState('TWILIO');
  const [phoneNumber, setPhoneNumber] = useState('+234 1 700 8000');
  const [forwardingTarget, setForwardingTarget] = useState('+234 803 123 4567 (MTN Business Line)');
  const [demoMobileNumber, setDemoMobileNumber] = useState('');
  const [callLoading, setCallLoading] = useState(false);
  const [callStatus, setCallStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Call Logs state
  const [callLogs, setCallLogs] = useState<CallLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [selectedCall, setSelectedCall] = useState<CallLog | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const fetchCallLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const token = localStorage.getItem('ace_token');
      const headers = { Authorization: `Bearer ${token}` };
      const [logsRes, orgRes] = await Promise.allSettled([
        fetch(`${API_URL}/api/telephony/calls`, { headers }),
        fetch(`${API_URL}/api/organizations/me`, { headers }),
      ]);

      if (logsRes.status === 'fulfilled' && logsRes.value.ok) {
        const raw = await logsRes.value.json();
        const list = Array.isArray(raw) ? raw : (raw?.data || []);
        setCallLogs(list);
      }
      if (orgRes.status === 'fulfilled' && orgRes.value.ok) {
        const orgData = await orgRes.value.json();
        if (orgData?.telephonyConfigs?.[0]) {
          const cfg = orgData.telephonyConfigs[0];
          if (cfg.provider) setProvider(cfg.provider);
          if (cfg.phoneNumber) setPhoneNumber(cfg.phoneNumber);
        }
      }
    } catch {
      setCallLogs([]);
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCallLogs();
  }, [fetchCallLogs]);

  // Live Call Simulator State
  const [activeLiveCall, setActiveLiveCall] = useState<{
    callSid: string;
    toNumber: string;
    status: 'RINGING' | 'CONNECTED' | 'ENDED';
    transcript: Array<{ speaker: 'AI' | 'CUSTOMER'; text: string; time: string }>;
  } | null>(null);

  const handleTriggerDemoCall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!demoMobileNumber) return;

    setCallLoading(true);
    setCallStatus(null);

    const token = localStorage.getItem('ace_token');
    try {
      const res = await fetch(`${API_URL}/api/telephony/outbound`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          toNumber: demoMobileNumber,
          provider,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const callSid = data.callId || data.callSid || `CALL_${Date.now()}`;
        setCallStatus({
          type: 'success',
          text: `Call initiated! Call SID: ${callSid}. Launching interactive audio simulator session below.`,
        });
        
        // Launch live call simulation modal
        setActiveLiveCall({
          callSid,
          toNumber: demoMobileNumber,
          status: 'RINGING',
          transcript: [
            { speaker: 'AI', text: "Hello! Good day! Thank you for contacting customer service. My name is Alex. How can I assist you today?", time: '00:02' }
          ]
        });

        // Transition from RINGING to CONNECTED after 2s
        setTimeout(() => {
          setActiveLiveCall(prev => prev ? { ...prev, status: 'CONNECTED' } : null);
        }, 2000);

        fetchCallLogs();
      } else {
        const err = await res.json().catch(() => ({ message: 'Failed to place call' }));
        setCallStatus({
          type: 'error',
          text: err.message || 'Failed to place demo call. Check your telephony credentials.',
        });
      }
    } catch {
      setCallStatus({
        type: 'error',
        text: 'Network error. Make sure the API server is running.',
      });
    } finally {
      setCallLoading(false);
    }
  };

  const togglePlayAudio = (id: string) => {
    if (playingId === id) setPlayingId(null);
    else setPlayingId(id);
  };
  return (
    <div className="space-y-6 max-w-7xl pb-12">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 dark:text-slate-900 dark:text-white flex items-center gap-2">
            <PhoneCall className="w-6 h-6 text-indigo-600 dark:text-indigo-400" /> Voice AI Telephony & Call Intelligence
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">Manage carriers, trigger live AI calls, inspect recordings and transcripts.</p>
        </div>
      </div>

      {/* Web Voice Call (VoIP) Section */}
      <div className="rounded-2xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/60 dark:bg-emerald-500/10 p-6 space-y-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center font-bold shadow-sm">
              <Radio className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-slate-900 dark:text-slate-900 dark:text-white flex items-center gap-2">
                Voice Call Simulator (Demo Mode)
                <span className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 font-extrabold border border-emerald-300 dark:border-emerald-500/30">100% Free Web VoIP</span>
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-300 font-medium">Test your AI agent voice responses in demo mode. For real customer calls, connect a phone carrier in settings.</p>
            </div>
          </div>
          <button
            onClick={() => {
              setActiveLiveCall({
                callSid: `WEB_CALL_${Date.now()}`,
                toNumber: 'Kusu Consult Web Voice Support',
                status: 'RINGING',
                transcript: [
                  { speaker: 'AI', text: "Hello! Welcome to Kusu Consult Customer Care. My name is Alex. How can I assist you today?", time: '00:01' }
                ]
              });
              setTimeout(() => {
                setActiveLiveCall(prev => prev ? { ...prev, status: 'CONNECTED' } : null);
              }, 1500);
            }}
            className="px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm transition-all shadow-md shadow-emerald-500/25 flex items-center justify-center gap-2"
          >
            <Phone className="w-4 h-4" /> Start Demo Simulation
          </button>
        </div>
      </div>

      {/* Demo Outbound Call Widget Box */}
      <div className="rounded-2xl border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/60 dark:bg-indigo-500/10 p-6 space-y-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold shadow-sm">
            <Phone className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-extrabold text-slate-900 dark:text-slate-900 dark:text-white">Trigger Outbound Phone Call</h2>
            <p className="text-xs text-slate-600 dark:text-slate-300 font-medium">Enter a phone number to test Twilio / Africa's Talking voice call routing.</p>
          </div>
        </div>

        <form onSubmit={handleTriggerDemoCall} className="flex flex-col sm:flex-row gap-3 pt-2">
          <input
            type="text"
            value={demoMobileNumber}
            onChange={(e) => setDemoMobileNumber(e.target.value)}
            placeholder="Enter mobile number e.g. +2348031234567"
            className="flex-1 px-4 py-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:border-indigo-500 shadow-sm"
            required
          />
          <button
            type="submit"
            disabled={callLoading}
            className="px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm transition-all shadow-md shadow-indigo-500/25 flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <Sparkles className="w-4 h-4" /> {callLoading ? 'Initiating Call...' : 'Trigger Phone Call'}
          </button>
        </form>

        {callStatus && (
          <div className={`p-4 rounded-xl flex items-center gap-3 text-sm ${callStatus.type === 'success' ? 'bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-400' : 'bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-400'}`}>
            {callStatus.type === 'success' ? <CheckCircle className="w-5 h-5 flex-shrink-0" /> : <AlertCircle className="w-5 h-5 flex-shrink-0" />}
            <span className="font-bold">{callStatus.text}</span>
          </div>
        )}
      </div>

      {/* Call History Table */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 overflow-hidden space-y-3 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h3 className="font-extrabold text-slate-900 dark:text-slate-900 dark:text-white text-base flex items-center gap-2">
            <Volume2 className="w-5 h-5 text-purple-600 dark:text-purple-400" /> Live Call Logs & Audio Transcripts
          </h3>
          <button onClick={fetchCallLogs} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-900 dark:text-white transition-colors">
            <RefreshCw className={`w-4 h-4 ${logsLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {logsLoading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map(i => <div key={i} className="h-14 bg-slate-100 dark:bg-slate-800/40 rounded-xl animate-pulse" />)}
          </div>
        ) : callLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 flex items-center justify-center mb-4">
              <PhoneOff className="w-8 h-8 text-slate-400" />
            </div>
            <p className="text-slate-700 dark:text-slate-300 font-bold mb-1">No items yet</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 max-w-sm">No calls recorded yet. Configure your telephony provider in Settings to start receiving calls.</p>
          </div>
        ) : (
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-100 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 font-bold">
              <tr>
                <th className="px-5 py-3.5">Caller / Number</th>
                <th className="px-5 py-3.5">Direction</th>
                <th className="px-5 py-3.5">Duration</th>
                <th className="px-5 py-3.5">Status</th>
                <th className="px-5 py-3.5">Timestamp</th>
                <th className="px-5 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/40">
              {callLogs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                  <td className="px-5 py-4">
                    <p className="font-mono text-slate-900 dark:text-slate-100 font-bold">{log.fromNumber || log.toNumber || 'Unknown'}</p>
                  </td>
                  <td className="px-5 py-4">
                    <span className="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 font-semibold">
                      {log.direction === 'INBOUND' ? (
                        <ArrowDownLeft className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                      ) : (
                        <ArrowUpRight className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                      )}
                      {log.direction || 'OUTBOUND'}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-xs font-mono text-slate-400 dark:text-slate-500">
                    {Math.round((log.durationSeconds || 0) / 60)}m {(log.durationSeconds || 0) % 60}s
                  </td>
                  <td className="px-5 py-4">
                    <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${
                      log.status === 'COMPLETED' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20' :
                      log.status === 'IN_PROGRESS' ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-500/20 animate-pulse' :
                      'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-500/20'
                    }`}>
                      {log.status}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-xs text-slate-500 dark:text-slate-400">
                    {log.createdAt ? new Date(log.createdAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-5 py-4 text-right space-x-2">
                    {log.recordingUrl ? (
                      <button
                        onClick={() => window.open(log.recordingUrl, '_blank')}
                        className="px-3 py-1 rounded-lg bg-purple-50 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-200 dark:border-purple-500/20 hover:bg-purple-100 dark:bg-purple-500/20 text-xs font-semibold inline-flex items-center gap-1"
                      >
                        <Play className="w-3 h-3" /> Play Audio
                      </button>
                    ) : (
                      <span className="group relative inline-block">
                        <button disabled className="px-3 py-1 rounded-lg bg-slate-100 dark:bg-slate-500/10 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-500/20 text-xs font-semibold inline-flex items-center gap-1 cursor-not-allowed">
                          <Play className="w-3 h-3" /> Play Audio
                        </button>
                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-max px-2 py-1 text-[10px] text-slate-900 dark:text-white bg-gray-800 rounded opacity-0 group-hover:opacity-100 transition-opacity">No recording available</span>
                      </span>
                    )}
                    <button
                      onClick={() => setSelectedCall(log)}
                      className="px-3 py-1 rounded-lg bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20 hover:bg-blue-100 dark:bg-blue-500/20 text-xs font-semibold inline-flex items-center gap-1"
                    >
                      <FileText className="w-3 h-3" /> Transcript
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Provider Selection */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-2xl p-6 border border-slate-200 dark:border-slate-800 space-y-6" style={{ background: 'rgba(255,255,255,0.03)' }}>
          <h3 className="font-semibold text-xs text-slate-700 dark:text-slate-300 uppercase tracking-wider">Active Telephony Carrier Provider</h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <ProviderCard
              id="TWILIO"
              name="Twilio Voice AI"
              desc="Global SIP trunking & Real-time Media Streams API"
              active={provider === 'TWILIO'}
              onClick={() => setProvider('TWILIO')}
            />
            <ProviderCard
              id="MTN_ENTERPRISE_SIP"
              name="MTN Enterprise SIP"
              desc="Direct MTN Nigeria 01-landline & 0803 SBC SIP"
              active={provider === 'MTN_ENTERPRISE_SIP'}
              onClick={() => setProvider('MTN_ENTERPRISE_SIP')}
            />
            <ProviderCard
              id="AFRICAS_TALKING"
              name="Africa's Talking"
              desc="Pan-African Voice & Telecom IVR gateway"
              active={provider === 'AFRICAS_TALKING'}
              onClick={() => setProvider('AFRICAS_TALKING')}
            />
            <ProviderCard
              id="TELNYX"
              name="Telnyx / Plivo"
              desc="Low-latency enterprise voice SIP trunks"
              active={provider === 'TELNYX'}
              onClick={() => setProvider('TELNYX')}
            />
          </div>
        </div>

        {/* Carrier Config */}
        <div className="rounded-2xl p-6 border border-slate-200 dark:border-slate-800 space-y-4" style={{ background: 'rgba(255,255,255,0.03)' }}>
          <h3 className="font-semibold text-xs text-slate-700 dark:text-slate-300 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-blue-600 dark:text-blue-400" /> Carrier Forwarding
          </h3>
          <div>
            <label className="text-xs text-slate-600 dark:text-slate-400 block mb-1">Assigned Business Number</label>
            <input
              type="text"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              className="w-full bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-blue-600 dark:text-blue-400 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-xs text-slate-600 dark:text-slate-400 block mb-1">Carrier Forwarding Target</label>
            <input
              type="text"
              value={forwardingTarget}
              onChange={(e) => setForwardingTarget(e.target.value)}
              className="w-full bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-800 dark:text-slate-200 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Transcript Modal */}
      {selectedCall && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-slate-900 dark:text-white text-base">Call Audio Transcript</h3>
              <button onClick={() => setSelectedCall(null)} className="text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-3 text-xs text-slate-700 dark:text-slate-300 font-mono leading-relaxed max-h-80 overflow-y-auto">
              {selectedCall.transcript ? (
                <pre className="whitespace-pre-wrap">{selectedCall.transcript}</pre>
              ) : (
                <p className="text-slate-500 dark:text-slate-400 text-center py-4">No transcript available for this call.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Active Live Call Simulator Modal */}
      {activeLiveCall && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/80 backdrop-blur-md animate-fade-in">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-blue-500/40 rounded-3xl p-6 shadow-2xl shadow-blue-500/20 space-y-6">
            
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${activeLiveCall.status === 'RINGING' ? 'bg-amber-400 animate-ping' : 'bg-emerald-400 animate-pulse'}`} />
                <div>
                  <span className="text-[10px] font-mono text-blue-600 dark:text-blue-400 uppercase tracking-widest font-bold">Voice AI Live Session</span>
                  <h3 className="text-lg font-bold text-slate-900 dark:text-white mt-0.5">{activeLiveCall.toNumber}</h3>
                </div>
              </div>
              <span className={`px-3 py-1 rounded-full text-xs font-bold ${
                activeLiveCall.status === 'RINGING' ? 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-500/30' : 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/30'
              }`}>
                {activeLiveCall.status}
              </span>
            </div>

            {/* Audio Waveform Animation */}
            <div className="p-6 rounded-2xl bg-blue-500/[0.05] border border-blue-200 dark:border-blue-500/20 flex flex-col items-center justify-center space-y-4">
              <div className="flex items-center gap-1.5 h-12">
                {[40, 70, 30, 90, 60, 100, 50, 80, 40, 60, 90, 30, 70, 50, 80, 40].map((h, i) => (
                  <div
                    key={i}
                    className="w-1.5 bg-blue-400 rounded-full animate-pulse"
                    style={{ height: `${activeLiveCall.status === 'CONNECTED' ? h : 15}%`, animationDelay: `${i * 0.1}s` }}
                  />
                ))}
              </div>
              <p className="text-xs text-blue-700 dark:text-blue-300 font-mono">
                {activeLiveCall.status === 'RINGING' ? 'Dialing destination number...' : '250ms VAD Barge-In Active • Deepgram STT + ElevenLabs TTS'}
              </p>
            </div>

            {/* Live Streaming Audio Transcript */}
            <div className="space-y-3">
              <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">Live Streamed Transcript</h4>
              <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-3 text-xs max-h-48 overflow-y-auto">
                {activeLiveCall.transcript.map((t, idx) => (
                  <div key={idx} className="flex flex-col space-y-1">
                    <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400">
                      <span className={t.speaker === 'AI' ? 'text-blue-600 dark:text-blue-400 font-bold' : 'text-emerald-600 dark:text-emerald-400 font-bold'}>
                        {t.speaker === 'AI' ? 'AI Voice Agent (Alex)' : 'Customer'}
                      </span>
                      <span>{t.time}</span>
                    </div>
                    <p className="text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm p-2.5 rounded-xl border border-slate-200 dark:border-slate-800">{t.text}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Interactive User Input Simulator */}
            {activeLiveCall.status === 'CONNECTED' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.target as HTMLFormElement;
                  const input = form.elements.namedItem('userSpeech') as HTMLInputElement;
                  if (!input.value) return;

                  const userText = input.value;
                  input.value = '';

                  // Add customer speech line
                  setActiveLiveCall(prev => prev ? {
                    ...prev,
                    transcript: [
                      ...prev.transcript,
                      { speaker: 'CUSTOMER', text: userText, time: '00:14' }
                    ]
                  } : null);

                  // Simulate AI immediate response
                  setTimeout(() => {
                    setActiveLiveCall(prev => prev ? {
                      ...prev,
                      transcript: [
                        ...prev.transcript,
                        { speaker: 'AI', text: `I understand completely! I can certainly assist you with "${userText}". Let me record that for you right now.`, time: '00:16' }
                      ]
                    } : null);
                  }, 800);
                }}
                className="flex gap-2"
              >
                <input
                  name="userSpeech"
                  type="text"
                  placeholder="Speak or type a customer response..."
                  className="flex-1 px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-xs focus:outline-none focus:border-blue-500"
                />
                <button
                  type="submit"
                  className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-all shadow-lg shadow-blue-500/20"
                >
                  Speak
                </button>
              </form>
            )}

            {/* End Call Control */}
            <div className="pt-2 flex justify-end">
              <button
                onClick={() => setActiveLiveCall(null)}
                className="w-full py-3 rounded-xl bg-red-600/80 hover:bg-red-600 text-white font-semibold text-xs transition-all shadow-lg shadow-red-500/20 flex items-center justify-center gap-2"
              >
                <Phone className="w-4 h-4 rotate-[135deg]" /> Hang Up Call
              </button>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

function ProviderCard({ id, name, desc, active, onClick }: { id: string; name: string; desc: string; active: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className={`p-4 rounded-xl border cursor-pointer transition-all ${
        active ? 'bg-blue-50 dark:bg-blue-500/10 border-blue-500 shadow-lg shadow-blue-500/10' : 'bg-slate-100 dark:bg-slate-800/60 border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:bg-slate-800'
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="font-bold text-xs text-slate-800 dark:text-slate-200">{name}</span>
        {active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 font-bold">SELECTED</span>}
      </div>
      <p className="text-[11px] text-slate-600 dark:text-slate-400">{desc}</p>
    </div>
  );
}
