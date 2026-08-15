"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { API_URL } from '@/lib/api';
import { Camera, Copy, Check, X, Trash2, Eye, AlertTriangle } from 'lucide-react';
import { copyToClipboard } from '@/lib/clipboard';

/**
 * Onboarding selfie capture, for an agent working a live conversation or a contact
 * record.
 *
 * Two things this panel is careful about:
 *
 *  - It never says "verified". The platform captures a photo; it does not check
 *    liveness or match a face to an identity. Labelling a stored photo "verified"
 *    would put an operator in the position of trusting a check nobody performed.
 *  - It surfaces delivery failure. If WhatsApp is not configured or the send failed,
 *    the request still exists and the link is shown so the agent can send it another
 *    way — rather than the agent assuming the customer was messaged.
 */

interface SelfieRequest {
  id: string;
  contactId: string;
  channel: 'WHATSAPP' | 'VOICE' | 'WEB';
  status: 'PENDING' | 'RECEIVED' | 'EXPIRED' | 'CANCELLED';
  purpose: string | null;
  expiresAt: string;
  attempts: number;
  sizeBytes: number | null;
  receivedAt: string | null;
  receivedVia: string | null;
  rejectionReason: string | null;
  createdAt: string;
  contact?: { id: string; fullName: string; phoneNumber: string };
}

interface Props {
  contactId: string;
  contactName?: string;
  conversationId?: string;
  /** Where the request originates. VOICE always delivers a link instead of prompting in-thread. */
  channel?: 'WHATSAPP' | 'VOICE';
}

const STATUS_STYLE: Record<string, string> = {
  PENDING: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/20',
  RECEIVED: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20',
  EXPIRED: 'bg-slate-100 dark:bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-500/20',
  CANCELLED: 'bg-slate-100 dark:bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-500/20',
};

export default function SelfieRequestPanel({ contactId, contactName, conversationId, channel = 'WHATSAPP' }: Props) {
  const [requests, setRequests] = useState<SelfieRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [purpose, setPurpose] = useState('account verification');
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [lastLink, setLastLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [viewing, setViewing] = useState<{ url: string; id: string } | null>(null);

  const headers = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('ace_token') : ''}`,
  });

  const load = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/onboarding/selfie-requests?contactId=${contactId}`, { headers: headers() });
      if (res.ok) setRequests(await res.json());
    } catch {
      /* the panel degrades to the request button */
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  useEffect(() => {
    void load();
    setLastLink(null);
  }, [load]);

  const request = async () => {
    setRequesting(true);
    setNotice(null);
    try {
      const res = await fetch(`${API_URL}/api/onboarding/selfie-requests`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ contactId, channel, purpose: purpose.trim() || undefined, conversationId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ type: 'error', text: body.message || 'Could not create the request.' });
        return;
      }
      // The link is returned once. Keep it in view so a failed send is recoverable.
      setLastLink(body.uploadUrl);
      setNotice({
        type: body.delivery?.delivered ? 'success' : 'error',
        text: body.delivery?.delivered
          ? `Asked ${contactName ?? 'the customer'} on WhatsApp. They can reply with a photo or use the link.`
          : body.delivery?.note ?? 'The request was created but not delivered. Send the link below yourself.',
      });
      await load();
    } catch {
      setNotice({ type: 'error', text: 'Could not reach the server.' });
    } finally {
      setRequesting(false);
    }
  };

  const view = async (id: string) => {
    try {
      const res = await fetch(`${API_URL}/api/onboarding/selfie-requests/${id}/image`, { headers: headers() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ type: 'error', text: body.message || 'Could not open the photo.' });
        return;
      }
      setViewing({ url: body.url, id });
    } catch {
      setNotice({ type: 'error', text: 'Could not open the photo.' });
    }
  };

  const cancel = async (id: string) => {
    await fetch(`${API_URL}/api/onboarding/selfie-requests/${id}/cancel`, { method: 'POST', headers: headers() });
    setLastLink(null);
    await load();
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this request and permanently erase the stored photo?')) return;
    const res = await fetch(`${API_URL}/api/onboarding/selfie-requests/${id}`, { method: 'DELETE', headers: headers() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setNotice({ type: 'error', text: body.message || 'Could not delete it. This needs an owner or admin.' });
      return;
    }
    setViewing(null);
    await load();
  };

  const copy = async () => {
    if (!lastLink) return;
    const ok = await copyToClipboard(lastLink);
    setCopied(ok);
    setTimeout(() => setCopied(false), 1800);
  };

  const pending = requests.find((r) => r.status === 'PENDING');

  return (
    <div className="rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
          <Camera className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /> Onboarding Selfie
        </h3>
        {requests.length > 0 && (
          <span className="text-[10px] text-slate-500 dark:text-slate-400">{requests.length} request(s)</span>
        )}
      </div>

      {notice && (
        <div
          className={`text-[11px] rounded-xl p-2.5 border flex items-start justify-between gap-2 ${
            notice.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-400'
              : 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20 text-amber-800 dark:text-amber-400'
          }`}
        >
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)}>
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {lastLink && (
        <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 p-2.5 space-y-1.5">
          <p className="text-[10px] text-slate-500 dark:text-slate-400">
            One-time upload link — shown only now, and it cannot be retrieved later.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[10px] text-slate-700 dark:text-slate-300 truncate">{lastLink}</code>
            <button
              onClick={copy}
              className="p-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
        </div>
      )}

      {!pending && (
        <div className="space-y-2">
          <input
            type="text"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="Reason shown to the customer"
            className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-xs outline-none"
          />
          <button
            onClick={request}
            disabled={requesting || !contactId}
            className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold disabled:opacity-50"
          >
            {requesting ? 'Requesting…' : channel === 'VOICE' ? 'Send upload link' : 'Ask for a selfie'}
          </button>
          {channel === 'VOICE' && (
            <p className="text-[10px] text-slate-500 dark:text-slate-400">
              A phone call cannot carry an image, so this sends the customer a secure link on WhatsApp.
            </p>
          )}
        </div>
      )}

      {loading ? (
        <div className="h-12 rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />
      ) : requests.length === 0 ? (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">No selfie has been requested for this contact.</p>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {requests.map((r) => (
            <div key={r.id} className="py-2 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${STATUS_STYLE[r.status]}`}>
                  {r.status}
                </span>
                <span className="text-[10px] text-slate-500 dark:text-slate-400 flex-1 truncate">
                  {r.purpose || 'No reason given'} · {new Date(r.createdAt).toLocaleDateString()}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  {r.status === 'RECEIVED' && (
                    <button onClick={() => view(r.id)} title="View photo" className="p-1 text-slate-400 hover:text-blue-600">
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {r.status === 'PENDING' && (
                    <button onClick={() => cancel(r.id)} title="Cancel" className="p-1 text-slate-400 hover:text-amber-600">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button onClick={() => remove(r.id)} title="Delete and erase photo" className="p-1 text-slate-400 hover:text-red-600">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {r.status === 'PENDING' && (
                <p className="text-[10px] text-slate-500 dark:text-slate-400">
                  Expires {new Date(r.expiresAt).toLocaleString()}
                  {r.attempts > 0 ? ` · ${r.attempts} failed attempt(s)` : ''}
                </p>
              )}
              {r.status === 'RECEIVED' && (
                <p className="text-[10px] text-slate-500 dark:text-slate-400">
                  Received {new Date(r.receivedAt!).toLocaleString()} via {r.receivedVia}
                  {r.sizeBytes ? ` · ${Math.round(r.sizeBytes / 1024)}KB` : ''}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Photo viewer */}
      {viewing && (
        <div
          className="fixed inset-0 z-[9999] bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setViewing(null)}
        >
          <div className="max-w-sm w-full space-y-3" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={viewing.url} alt="Customer selfie" className="w-full rounded-2xl shadow-2xl" />
            <div className="rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 p-3 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <p className="text-[10px] text-amber-800 dark:text-amber-300 leading-relaxed">
                This photo is captured, not verified. Nothing has checked that it is a live person or that it matches
                any identity document — treat it as evidence for a human to assess.
              </p>
            </div>
            <button
              onClick={() => setViewing(null)}
              className="w-full py-2 rounded-xl bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-semibold"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
