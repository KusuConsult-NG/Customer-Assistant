"use client";

import Link from 'next/link';
import React, { useState, useEffect, useCallback } from 'react';
import { api, API_URL, apiFetch } from '@/lib/api';
import { RoleNotice } from '@/components/RoleNotice';
import {
  PhoneCall, Sparkles, Phone, CheckCircle, AlertCircle, Radio, ShieldCheck,
  Play, Pause, FileText, Clock, User, Volume2, RefreshCw, X, ArrowUpRight, ArrowDownLeft, PhoneOff
} from 'lucide-react';

/** One of the agency's voice lines, as `GET /api/organizations/me` returns it. */
interface CarrierLine {
  id: string;
  provider: string;
  phoneNumber: string;
  forwardingNumber?: string | null;
  isDefault?: boolean;
}

/** `GET /api/telephony/voice-readiness` — see VoiceReadinessService. */
interface VoiceReadiness {
  state: 'ready' | 'degraded' | 'blocked';
  summary: string;
  /** Platform operators only. */
  note?: string;
  /**
   * True when this deployment holds a complete Twilio line in its environment
   * and this agency has none. The endpoint re-checks every condition itself,
   * so this only decides whether to OFFER the button.
   */
  canAdoptDeploymentLine?: boolean;
  twilio: {
    voiceWebhook: { method: string; url: string };
    statusCallback: { method: string; url: string };
    /** Platform operators only: an agency never enters it. */
    mediaStream?: string;
  };
  checks: Array<{
    id: string;
    label: string;
    state: 'ready' | 'degraded' | 'blocked';
    detail: string;
    consequence: string;
    remedy: string;
  }>;
}

/** `GET /api/diagnostics/providers` — see ProviderHealthService. */
interface ProviderHealth {
  checkedAt: string;
  summary: string;
  providers: Array<{
    id: string;
    label: string;
    state: 'ok' | 'failed' | 'not_configured';
    detail: string;
    consequence: string;
  }>;
}

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

/**
 * The providers this platform actually supports, in the operator's words.
 * Mirrors `TELEPHONY_PROVIDERS` in the settings service, which is what the
 * API validates against.
 */
const PROVIDER_LABELS: Record<string, string> = {
  TWILIO: 'Twilio',
  PLIVO: 'Plivo',
  TELNYX: 'Telnyx',
  AFRICAS_TALKING: "Africa's Talking",
  NIGERIA_CARRIER_FORWARD: 'Nigerian carrier forwarding',
  SIP_TRUNK: 'SIP trunk (your own carrier)',
  // Not a carrier anyone configures here — it is what a CallLog carries
  // when the call came in over WhatsApp, with no carrier involved. Listed
  // so the call history names it instead of printing the raw enum value.
  WHATSAPP_CLOUD: 'WhatsApp call (no carrier)',
};

export default function TelephonyPage() {
  // Read for display only — see the note by the carrier panel.
  const [provider, setProvider] = useState('');
  // No invented defaults. These were '+234 1 700 8000' and '+234 803 123 4567
  // (MTN Business Line)' — and `forwardingTarget` was never assigned from the
  // API at all, so this screen displayed a phone number and an MTN forwarding
  // line that belonged to nobody, as the agency's configuration, on the screen
  // an operator uses to check whether their line works.
  const [lines, setLines] = useState<CarrierLine[] | null>(null);
  const [readiness, setReadiness] = useState<VoiceReadiness | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [adoptResult, setAdoptResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [providers, setProviders] = useState<ProviderHealth | null>(null);
  const [pointing, setPointing] = useState(false);
  const [pointResult, setPointResult] = useState<{ ok: boolean; message: string } | null>(null);
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
      const [logsRes, orgRes, readyRes, providerRes] = await Promise.allSettled([
        apiFetch(`${API_URL}/api/telephony/calls`, { headers }),
        apiFetch(`${API_URL}/api/organizations/me`, { headers }),
        apiFetch(`${API_URL}/api/telephony/voice-readiness`, { headers }),
        apiFetch(`${API_URL}/api/diagnostics/providers`, { headers }),
      ]);

      if (logsRes.status === 'fulfilled' && logsRes.value.ok) {
        const raw = await logsRes.value.json();
        const list = Array.isArray(raw) ? raw : (raw?.data || []);
        setCallLogs(list);
      }
      if (orgRes.status === 'fulfilled' && orgRes.value.ok) {
        const orgData = await orgRes.value.json();
        const configs: CarrierLine[] = Array.isArray(orgData?.telephonyConfigs)
          ? orgData.telephonyConfigs
          : [];
        setLines(configs);
        if (configs[0]?.provider) setProvider(configs[0].provider);
      }

      // Readiness is OWNER/ADMIN. A 403 is not a fault — an AGENT simply does
      // not get this panel — so it is reported as what it is rather than as a
      // broken line.
      if (readyRes.status === 'fulfilled') {
        if (readyRes.value.ok) {
          setReadiness(await readyRes.value.json());
          setReadinessError(null);
        } else if (readyRes.value.status === 403) {
          setReadinessError('Call readiness is visible to owners and administrators.');
        } else {
          setReadinessError('Call readiness could not be checked.');
        }
      } else {
        setReadinessError('Call readiness could not be checked.');
      }

      // Silent on refusal: it is OWNER/ADMIN like the readiness panel, and the
      // panel above already says so. A second identical notice is noise.
      if (providerRes.status === 'fulfilled' && providerRes.value.ok) {
        setProviders(await providerRes.value.json());
      } else {
        setProviders(null);
      }
    } catch {
      setCallLogs([]);
    } finally {
      setLogsLoading(false);
    }
  }, []);

  /**
   * The server's own sentence is shown, success or failure.
   *
   * Its refusals are the useful part — "this agency already has 2 lines",
   * "this deployment serves 3 agencies" — and replacing them with "Could not
   * adopt line" is how an operator ends up with no idea which guard stopped
   * them. The panel is re-read afterwards rather than assuming the outcome.
   */
  const adoptDeploymentLine = async () => {
    setAdopting(true);
    setAdoptResult(null);
    try {
      const token = localStorage.getItem('ace_token');
      const res = await apiFetch(`${API_URL}/api/telephony/adopt-deployment-line`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmAdoptsDeploymentNumber: true }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          (Array.isArray(payload?.message) ? payload.message.join(' ') : payload?.message) ||
            'The line could not be adopted.'
        );
      }
      setAdoptResult({
        ok: true,
        message: `${payload?.line?.phoneNumber} now answers as this agency. ${payload?.nextStep ?? ''}`,
      });
      await fetchCallLogs();
    } catch (err: any) {
      setAdoptResult({ ok: false, message: err?.message || 'The line could not be adopted.' });
    } finally {
      setAdopting(false);
    }
  };

  /**
   * What TWILIO said, not what we asked for.
   *
   * The server reads the new webhook back out of Twilio's own response and
   * reports `pointedHere` from that. This renders that answer rather than
   * "done!", for the same reason a voice handoff announces the transfer only
   * after the carrier accepts it: a confirmation nobody verified is the bug
   * the first invariant exists for.
   */
  const pointNumberAtPlatform = async () => {
    setPointing(true);
    setPointResult(null);
    try {
      const token = localStorage.getItem('ace_token');
      const res = await apiFetch(`${API_URL}/api/telephony/point-number-at-platform`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmRepointsCarrierWebhook: true }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          (Array.isArray(payload?.message) ? payload.message.join(' ') : payload?.message) ||
            'Twilio did not accept the change.'
        );
      }
      setPointResult(
        payload?.pointedHere
          ? {
              ok: true,
              message: `Twilio now sends ${payload.phoneNumber} to ${payload.voiceUrl}${
                payload.previousVoiceUrl ? ` (was ${payload.previousVoiceUrl})` : ''
              }.`,
            }
          : {
              // Twilio answered, but not with the URL we asked for. Saying
              // "done" here is exactly the fabrication to avoid.
              ok: false,
              message: `Twilio accepted the request but reports the Voice webhook as ${
                payload?.voiceUrl ?? 'something else'
              }. The number is NOT pointed here.`,
            }
      );
      await fetchCallLogs();
    } catch (err: any) {
      setPointResult({ ok: false, message: err?.message || 'Twilio did not accept the change.' });
    } finally {
      setPointing(false);
    }
  };

  useEffect(() => {
    fetchCallLogs();
  }, [fetchCallLogs]);

  // Live Call Simulator State
  /**
   * The call this screen actually placed.
   *
   * It used to be a SIMULATED session: a fabricated AI greeting, a RINGING →
   * CONNECTED flip on a two-second timer regardless of what the carrier did,
   * a waveform, and a box where an officer typed a "customer response" and got
   * an invented AI reply. None of it came from the call. An operator testing a
   * real number watched a conversation that never happened and concluded the
   * line worked.
   *
   * What is kept is what the API returned about the call it really placed.
   */
  const [placedCall, setPlacedCall] = useState<{
    callSid: string;
    toNumber: string;
    status: string;
    provider?: string;
  } | null>(null);

  const handleTriggerDemoCall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!demoMobileNumber) return;

    setCallLoading(true);
    setCallStatus(null);

    const token = localStorage.getItem('ace_token');
    try {
      const res = await apiFetch(`${API_URL}/api/telephony/outbound`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        // The provider is NOT sent. The server uses the carrier this agency
        // has configured; sending one from the browser is how a test call
        // could be attempted through a carrier the agency does not have.
        body: JSON.stringify({ toNumber: demoMobileNumber }),
      });

      if (res.ok) {
        const data = await res.json();
        const callSid = data.callId || data.callSid;
        if (!callSid) {
          // The endpoint reports what the carrier did. No id means no call to
          // point at, whatever the status code said.
          setCallStatus({
            type: 'error',
            text: 'The call was accepted but no call id came back, so there is nothing to follow. Check the call log below.',
          });
        } else {
          setCallStatus({
            type: 'success',
            text: `Dialling ${demoMobileNumber}. Call id ${callSid}. What happens next appears in the call log below, and the transcript arrives when the call ends.`,
          });
          setPlacedCall({
            callSid,
            toNumber: demoMobileNumber,
            status: data.status || 'QUEUED',
            provider: data.provider,
          });
        }

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
      <RoleNotice path="/telephony" />
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 dark:text-white flex items-center gap-2">
            <PhoneCall className="w-6 h-6 text-brand-700 dark:text-brand-300" /> Telephone Service &amp; Voice AI
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">Manage telephony carriers, place test calls, and inspect call logs and transcripts.</p>
        </div>
      </div>

      {/* No simulator.
          This was a "Voice Call Simulator (Demo Mode)" button that opened a
          fabricated conversation: an AI greeting nobody said, a RINGING →
          CONNECTED flip on a timer, a waveform, "250ms VAD Barge-In Active",
          and a box where an officer typed a line and received an invented AI
          reply. It demonstrated nothing about this deployment, and on the one
          screen an operator uses to test a real number it is indistinguishable
          from a call that worked. There is no honest version of it that does
          not place a call, so it places one or it says nothing. */}

      {/* Demo Outbound Call Widget Box */}
      <div className="rounded-2xl border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/60 dark:bg-indigo-500/10 p-6 space-y-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-600 text-white flex items-center justify-center font-bold shadow-sm">
            <Phone className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-extrabold text-slate-900 dark:text-white">Trigger Outbound Phone Call</h2>
            <p className="text-xs text-slate-600 dark:text-slate-300 font-medium">Enter a phone number to test Twilio / Africa's Talking voice call routing.</p>
          </div>
        </div>

        <form onSubmit={handleTriggerDemoCall} className="flex flex-col sm:flex-row gap-3 pt-2">
          <input
            type="text"
            value={demoMobileNumber}
            onChange={(e) => setDemoMobileNumber(e.target.value)}
            placeholder="Enter mobile number e.g. +2348031234567"
            className="flex-1 px-4 py-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:border-brand-600 shadow-sm"
            required
          />
          <button
            type="submit"
            disabled={callLoading}
            className="px-6 py-3 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-sm transition-all shadow-md shadow-brand-600/25 flex items-center justify-center gap-2 disabled:opacity-50"
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
          <h3 className="font-extrabold text-slate-900 dark:text-white text-base flex items-center gap-2">
            <Volume2 className="w-5 h-5 text-purple-700 dark:text-purple-400" /> Live Call Logs & Audio Transcripts
          </h3>
          <button onClick={fetchCallLogs} className="text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-900 dark:hover:text-white transition-colors">
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
              <PhoneOff className="w-8 h-8 text-slate-500 dark:text-slate-400" />
            </div>
            <p className="text-slate-700 dark:text-slate-300 font-bold mb-1">No calls yet</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 max-w-sm">Calls appear here once a phone number is pointed at this platform. Add your carrier credentials and webhook URL below to start receiving them.</p>
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
                        <ArrowDownLeft className="w-3.5 h-3.5 text-indigo-700 dark:text-indigo-400" />
                      ) : (
                        <ArrowUpRight className="w-3.5 h-3.5 text-purple-700 dark:text-purple-400" />
                      )}
                      {log.direction || 'OUTBOUND'}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-xs font-mono text-slate-500 dark:text-slate-400">
                    {Math.round((log.durationSeconds || 0) / 60)}m {(log.durationSeconds || 0) % 60}s
                  </td>
                  <td className="px-5 py-4">
                    <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${
                      log.status === 'COMPLETED' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20' :
                      log.status === 'IN_PROGRESS' ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-500/20 animate-pulse' :
                      'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/20'
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
                        className="px-3 py-1 rounded-lg bg-purple-50 dark:bg-purple-500/10 text-purple-700 dark:text-purple-400 border border-purple-200 dark:border-purple-500/20 hover:bg-purple-100 dark:bg-purple-500/20 text-xs font-semibold inline-flex items-center gap-1"
                      >
                        <Play className="w-3 h-3" /> Play Audio
                      </button>
                    ) : (
                      <span className="group relative inline-block">
                        <button disabled className="px-3 py-1 rounded-lg bg-slate-100 dark:bg-slate-500/10 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-500/20 text-xs font-semibold inline-flex items-center gap-1 cursor-not-allowed">
                          <Play className="w-3 h-3" /> Play Audio
                        </button>
                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-max px-2 py-1 text-[10px] text-slate-900 dark:text-white bg-gray-800 rounded opacity-0 group-hover:opacity-100 transition-opacity">No recording available</span>
                      </span>
                    )}
                    <button
                      onClick={() => setSelectedCall(log)}
                      className="px-3 py-1 rounded-lg bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20 hover:bg-blue-100 dark:bg-blue-500/20 text-xs font-semibold inline-flex items-center gap-1"
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

          {/* READ-ONLY, and it reads from the saved configuration.
              This was a second provider picker. It offered "MTN Enterprise SIP"
              — a value the API rejects outright, because it is not one of the
              providers this platform supports — and it offered neither
              SIP_TRUNK nor NIGERIA_CARRIER_FORWARD, which are the two an
              agency bringing its own toll-free number actually needs. Worse,
              whatever was picked here was sent as the provider for the real
              outbound test call, so a test could be attempted "via" a carrier
              that does not exist.

              Settings → Voice has the complete form, with the SIP fields and
              the validation. One place to configure it; this one reports it. */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 bg-white dark:bg-slate-900/60">
            <p className="text-xs text-slate-600 dark:text-slate-400">Configured carrier</p>
            <p className="text-lg font-extrabold text-slate-900 dark:text-white mt-1">
              {provider ? PROVIDER_LABELS[provider] ?? provider : 'Not configured'}
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-2">
              {provider
                ? 'Change it, and its credentials, at Settings → Voice & Telephony.'
                : 'No carrier is configured for this agency yet. Set one at Settings → Voice & Telephony before placing or receiving calls.'}
            </p>
            <Link
              href="/settings"
              className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold"
            >
              <ShieldCheck className="w-3.5 h-3.5" /> Open voice settings
            </Link>
          </div>
        </div>

        {/* The agency's real lines, read-only.
            This was two editable inputs with no save path: an officer could
            type a forwarding number into "Carrier Forwarding Target" and
            nothing was sent anywhere. Both also started as invented values —
            and the forwarding one was never assigned from the API at all — so
            an unconfigured agency was shown a phone number and an MTN
            business line it did not have. Editing happens at Settings → Voice
            & Telephony, which is the one place that writes these. */}
        <div className="rounded-2xl p-6 border border-slate-200 dark:border-slate-800 space-y-4" style={{ background: 'rgba(255,255,255,0.03)' }}>
          <h3 className="font-semibold text-xs text-slate-700 dark:text-slate-300 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-blue-700 dark:text-blue-400" /> Lines on this agency
          </h3>

          {lines === null ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">Loading…</p>
          ) : lines.length === 0 ? (
            <p className="text-xs text-slate-600 dark:text-slate-300">
              No line is configured, so no call can reach this agency. Add one at Settings → Voice &amp; Telephony.
            </p>
          ) : (
            <ul className="space-y-3">
              {lines.map((l) => (
                <li key={l.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-blue-700 dark:text-blue-400">{l.phoneNumber}</span>
                    {l.isDefault && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                        outbound default
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-slate-400">
                    {PROVIDER_LABELS[l.provider] ?? l.provider}
                  </p>
                  <p className="text-[11px] text-slate-600 dark:text-slate-400">
                    Handoff goes to{' '}
                    {l.forwardingNumber
                      ? <span className="font-mono">{l.forwardingNumber}</span>
                      : <span className="text-amber-700 dark:text-amber-400">nobody — the AI files a ticket instead of transferring</span>}
                  </p>
                </li>
              ))}
            </ul>
          )}

          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs font-bold"
          >
            <ShieldCheck className="w-3.5 h-3.5" /> Edit at Settings → Voice
          </Link>
        </div>
      </div>

      {/* ── Can a call actually complete right now ──────────────────────────
          Four separate things each produce a call that connects and goes
          nowhere — no TTS key means the caller hears pure silence, because the
          inbound TwiML is <Connect><Stream/> with no <Say> in it; no STT key
          means they are never transcribed; a wrong API_BASE_URL means every
          call is refused as unauthenticated. None of that was visible
          anywhere, so a failed test call looked the same as a broken number. */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 p-6 space-y-4" style={{ background: 'rgba(255,255,255,0.03)' }}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-2">
            <Radio className="w-4 h-4 text-brand-600 dark:text-brand-400" /> Can a call complete right now?
          </h3>
          <button
            onClick={fetchCallLogs}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs font-bold"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Re-check
          </button>
        </div>

        {/* Whether each provider ANSWERS, not whether a variable is set.
            Every readiness surface here reported a provider as working
            because its key was non-empty — a revoked, mistyped or
            out-of-credit key looks identical, and the first thing that
            finds out is a citizen on the phone. */}
        {providers && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-bold text-slate-900 dark:text-white">
                Do the providers answer?
              </p>
              <span className="text-[10px] text-slate-500 dark:text-slate-400">
                asked {new Date(providers.checkedAt).toLocaleTimeString()}
              </span>
            </div>
            <p className="text-[11px] text-slate-600 dark:text-slate-400">{providers.summary}</p>
            <ul className="space-y-1.5">
              {providers.providers.map((p) => (
                <li key={p.id} className="flex items-start gap-2">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 mt-1 ${
                      p.state === 'ok' ? 'bg-emerald-500' : p.state === 'failed' ? 'bg-red-500' : 'bg-slate-400'
                    }`}
                  />
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-slate-900 dark:text-white">
                      {p.label}{' '}
                      <span className="uppercase tracking-wider text-slate-500 dark:text-slate-400">
                        {p.state === 'not_configured' ? 'not configured' : p.state}
                      </span>
                    </p>
                    <p className="text-[11px] text-slate-600 dark:text-slate-400 break-words">{p.detail}</p>
                    {p.state !== 'ok' && (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 italic">{p.consequence}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {readinessError && (
          <p className="text-xs text-slate-600 dark:text-slate-400">{readinessError}</p>
        )}

        {readiness && (
          <>
            <div className={`flex items-start gap-3 rounded-xl p-3 border ${
              readiness.state === 'ready'
                ? 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10'
                : readiness.state === 'degraded'
                  ? 'border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10'
                  : 'border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10'
            }`}>
              {readiness.state === 'ready'
                ? <CheckCircle className="w-5 h-5 shrink-0 text-emerald-700 dark:text-emerald-400 mt-0.5" />
                : <AlertCircle className={`w-5 h-5 shrink-0 mt-0.5 ${readiness.state === 'degraded' ? 'text-amber-700 dark:text-amber-400' : 'text-red-700 dark:text-red-400'}`} />}
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-900 dark:text-white">{readiness.summary}</p>
                {readiness.note && (
                  <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">{readiness.note}</p>
                )}
              </div>
            </div>

            {/* Offered only when the deployment holds a complete line and this
                agency has none. It states what it will do BEFORE doing it —
                which number will answer as this agency, and that the
                credentials are the deployment's own — because this decides who
                answers the State's phone number. */}
            {readiness.canAdoptDeploymentLine && (
              <div className="rounded-xl border border-brand-500/40 bg-brand-50 dark:bg-brand-500/10 p-3 space-y-2">
                <p className="text-xs font-bold text-slate-900 dark:text-white">
                  This deployment already holds a Twilio line
                </p>
                <p className="text-[11px] text-slate-700 dark:text-slate-300">
                  Its account SID, auth token and phone number are set in the server environment,
                  but no agency claims them — so every caller is told the number is not configured.
                  Adopting them makes that number answer as this agency. You will still need to point
                  the number&apos;s Voice webhook at the URL below in the Twilio console.
                </p>
                {adoptResult && (
                  <p className={`text-[11px] font-semibold ${adoptResult.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>
                    {adoptResult.message}
                  </p>
                )}
                <button
                  onClick={adoptDeploymentLine}
                  disabled={adopting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-xs font-bold"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  {adopting ? 'Adopting…' : 'Adopt this line for this agency'}
                </button>
              </div>
            )}

            <div className="space-y-2">
              {readiness.checks.map((c) => (
                <div key={c.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${
                      c.state === 'ready' ? 'bg-emerald-500' : c.state === 'degraded' ? 'bg-amber-500' : 'bg-red-500'
                    }`} />
                    <span className="text-xs font-bold text-slate-900 dark:text-white">{c.label}</span>
                    {/* The state is written out as well as coloured — a dot
                        alone is unreadable to anyone who cannot distinguish
                        the colours. */}
                    <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400">
                      {c.state}
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-slate-700 dark:text-slate-300 mt-1 break-all">{c.detail}</p>
                  {c.consequence && (
                    <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">{c.consequence}</p>
                  )}
                  {c.state !== 'ready' && c.remedy && (
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 italic">{c.remedy}</p>
                  )}
                </div>
              ))}
            </div>

            {/* The carrier is the one thing readiness cannot see: every check
                above can be green while the number still rings to whatever its
                Voice webhook pointed at. We hold the credentials, so this asks
                Twilio directly rather than printing a URL to retype. */}
            {lines && lines.length > 0 && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
                <p className="text-xs font-bold text-slate-900 dark:text-white">
                  Does Twilio send this number&apos;s calls here?
                </p>
                <p className="text-[11px] text-slate-600 dark:text-slate-400">
                  Everything above can be ready while the number still rings somewhere else — a new
                  Twilio number points at a demo TwiML bin. This sets its Voice webhook and status
                  callback to the URLs below. Whatever it points at now stops receiving calls.
                </p>
                {pointResult && (
                  <p className={`text-[11px] font-semibold ${pointResult.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>
                    {pointResult.message}
                  </p>
                )}
                <button
                  onClick={pointNumberAtPlatform}
                  disabled={pointing}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-brand-500 text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-500/10 disabled:opacity-60 text-xs font-bold"
                >
                  <Radio className="w-3.5 h-3.5" />
                  {pointing ? 'Asking Twilio…' : 'Point the number at this platform'}
                </button>
              </div>
            )}

            {/* Generated from the same API_BASE_URL the signature check uses,
                so what is shown here is what will be verified against. */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
              <p className="text-xs font-bold text-slate-900 dark:text-white">Paste into the Twilio console for this number</p>
              <div className="space-y-1 text-[11px] font-mono break-all">
                <p className="text-slate-700 dark:text-slate-300">
                  <span className="text-slate-500 dark:text-slate-400">A call comes in ({readiness.twilio.voiceWebhook.method}): </span>
                  {readiness.twilio.voiceWebhook.url}
                </p>
                <p className="text-slate-700 dark:text-slate-300">
                  <span className="text-slate-500 dark:text-slate-400">Call status changes ({readiness.twilio.statusCallback.method}): </span>
                  {readiness.twilio.statusCallback.url}
                </p>
                {readiness.twilio.mediaStream && (
                  <p className="text-slate-700 dark:text-slate-300">
                    <span className="text-slate-500 dark:text-slate-400">Media stream (set by us, not in the console): </span>
                    {readiness.twilio.mediaStream}
                  </p>
                )}
              </div>
            </div>
          </>
        )}
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

      {/* What the call this screen placed actually did. */}
      {placedCall && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/80 backdrop-blur-md animate-fade-in">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
              <div>
                <span className="text-[10px] font-mono text-brand-700 dark:text-brand-300 uppercase tracking-widest font-bold">Call placed</span>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white mt-0.5">{placedCall.toNumber}</h3>
              </div>
              <span className="px-3 py-1 rounded-full text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                {placedCall.status}
              </span>
            </div>

            <div className="space-y-2 text-sm text-slate-700 dark:text-slate-300">
              <p>
                The carrier accepted the request. <strong>That is not the same as the
                citizen answering</strong> — what happened to the call appears in the call
                log below as the carrier reports it.
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Call id <span className="font-mono">{placedCall.callSid}</span>
                {placedCall.provider ? ` · via ${placedCall.provider}` : ''}
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                There is no live transcript on this screen: nothing streams a call in
                progress to a dashboard. The transcript is written when the call ends, and
                a call in progress can be watched on the Agent Console.
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setPlacedCall(null); fetchCallLogs(); }}
                className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold"
              >
                Refresh the call log
              </button>
              <button
                onClick={() => setPlacedCall(null)}
                className="px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-sm font-bold"
              >
                Close
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
        {active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400 font-bold">SELECTED</span>}
      </div>
      <p className="text-[11px] text-slate-600 dark:text-slate-400">{desc}</p>
    </div>
  );
}
