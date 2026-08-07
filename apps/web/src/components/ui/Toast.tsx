"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react';

/**
 * Non-blocking feedback.
 *
 * This replaces 19 `alert()` calls. `alert()` is a poor fit here for reasons beyond
 * taste: it blocks the event loop, it cannot be styled or dismissed programmatically,
 * it cannot show two things at once, and — the practical problem — it halts every
 * subsequent browser interaction until a human clicks OK, which makes automated
 * testing of any flow that touches it impossible.
 *
 * Errors default to staying until dismissed. A message explaining why something
 * failed is exactly the message a user needs time to read.
 */

type ToastKind = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Optional single action, e.g. "Retry". */
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  success: (message: string, opts?: Partial<Omit<Toast, 'id' | 'kind' | 'message'>>) => void;
  error: (message: string, opts?: Partial<Omit<Toast, 'id' | 'kind' | 'message'>>) => void;
  info: (message: string, opts?: Partial<Omit<Toast, 'id' | 'kind' | 'message'>>) => void;
  warning: (message: string, opts?: Partial<Omit<Toast, 'id' | 'kind' | 'message'>>) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Auto-dismiss delays. Errors are sticky — see the note above. */
const DURATION: Record<ToastKind, number> = {
  success: 4000,
  info: 5000,
  warning: 7000,
  error: 0,
};

const STYLE: Record<ToastKind, { icon: typeof CheckCircle2; wrap: string; iconCls: string }> = {
  success: {
    icon: CheckCircle2,
    wrap: 'bg-white dark:bg-slate-900 border-emerald-200 dark:border-emerald-500/30',
    iconCls: 'text-emerald-600 dark:text-emerald-400',
  },
  error: {
    icon: XCircle,
    wrap: 'bg-white dark:bg-slate-900 border-red-200 dark:border-red-500/30',
    iconCls: 'text-red-600 dark:text-red-400',
  },
  warning: {
    icon: AlertTriangle,
    wrap: 'bg-white dark:bg-slate-900 border-amber-200 dark:border-amber-500/30',
    iconCls: 'text-amber-600 dark:text-amber-400',
  },
  info: {
    icon: Info,
    wrap: 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700',
    iconCls: 'text-blue-600 dark:text-blue-400',
  },
};

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, message: string, opts?: Partial<Toast>) => {
    const id = nextId++;
    setToasts((t) => [...t.slice(-3), { id, kind, message, ...opts }]);
    const ms = DURATION[kind];
    if (ms > 0) setTimeout(() => dismiss(id), ms);
  }, [dismiss]);

  const api = useMemo<ToastApi>(() => ({
    success: (m, o) => push('success', m, o),
    error: (m, o) => push('error', m, o),
    info: (m, o) => push('info', m, o),
    warning: (m, o) => push('warning', m, o),
    dismiss,
  }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {mounted &&
        createPortal(
          // Rendered at the document root so no page's stacking context can bury it —
          // several modals in this app sit at z-50 and would otherwise cover it.
          <div className="fixed top-4 right-4 z-[99999] flex flex-col gap-2 w-[min(24rem,calc(100vw-2rem))] pointer-events-none">
            {toasts.map((t) => {
              const s = STYLE[t.kind];
              return (
                <div
                  key={t.id}
                  role={t.kind === 'error' ? 'alert' : 'status'}
                  className={`pointer-events-auto flex items-start gap-2.5 p-3.5 rounded-2xl border shadow-lg ${s.wrap} animate-in slide-in-from-top-2 fade-in`}
                >
                  <s.icon className={`w-4 h-4 shrink-0 mt-0.5 ${s.iconCls}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed break-words">{t.message}</p>
                    {t.action && (
                      <button
                        onClick={() => { t.action!.onClick(); dismiss(t.id); }}
                        className="mt-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                      >
                        {t.action.label}
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => dismiss(t.id)}
                    aria-label="Dismiss"
                    className="p-0.5 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </ToastContext.Provider>
  );
}

/**
 * Falls back to a no-op-free console path rather than throwing when a component is
 * rendered outside the provider — a missing provider should not take a page down.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx;
  const log = (kind: string) => (m: string) => console.warn(`[toast:${kind}] ${m}`);
  return {
    success: log('success'), error: log('error'), info: log('info'), warning: log('warning'),
    dismiss: () => {},
  };
}
