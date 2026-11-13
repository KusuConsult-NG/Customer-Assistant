'use client';

import { useEffect, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { API_URL, apiFetch } from '@/lib/api';

/**
 * Plays a call's recording.
 *
 * The audio is not a link the browser can open: it is held by the agency's
 * ElevenLabs workspace and fetched with the agency's key, which never reaches
 * the browser. So this asks GET /api/calls/:id/recording with the officer's
 * own session and plays the bytes it gets back. When there is nothing to play,
 * it shows the API's own reason (erased, past retention, a confidential report)
 * rather than a generic failure.
 */
export function CallRecordingPlayer({ callId, playable }: { callId: string; playable?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => () => {
    if (src) URL.revokeObjectURL(src);
  }, [src]);

  if (!playable) {
    return (
      <span className="group relative inline-block">
        <button disabled className="px-3 py-1 rounded-lg bg-slate-100 dark:bg-slate-500/10 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-500/20 text-xs font-semibold inline-flex items-center gap-1 cursor-not-allowed">
          <Play className="w-3 h-3" /> Play Audio
        </button>
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-max px-2 py-1 text-[10px] text-white bg-gray-800 rounded opacity-0 group-hover:opacity-100 transition-opacity">No recording available</span>
      </span>
    );
  }

  if (src) return <audio controls autoPlay src={src} className="h-8 max-w-[16rem] inline-block align-middle" aria-label="Call recording" />;

  const load = async () => {
    setLoading(true);
    setProblem(null);
    try {
      const res = await apiFetch(`${API_URL}/api/calls/${callId}/recording`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setProblem((body && (body.message as string)) || `The recording could not be loaded (HTTP ${res.status}).`);
        return;
      }
      setSrc(URL.createObjectURL(await res.blob()));
    } catch {
      setProblem('The recording could not be loaded. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        onClick={load}
        disabled={loading}
        className="px-3 py-1 rounded-lg bg-purple-50 dark:bg-purple-500/10 text-purple-700 dark:text-purple-400 border border-purple-200 dark:border-purple-500/20 hover:bg-purple-100 dark:hover:bg-purple-500/20 text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-60"
      >
        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Play Audio
      </button>
      {problem && <span role="alert" className="text-[11px] text-amber-700 dark:text-amber-400 max-w-[18rem] text-right">{problem}</span>}
    </span>
  );
}
