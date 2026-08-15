"use client";

import React from 'react';
import { LucideIcon } from 'lucide-react';

/**
 * The state a screen shows when there is genuinely nothing to show.
 *
 * Two rules this enforces by construction:
 *
 *  1. It is only rendered when loading has finished. Callers pass `loading` to their
 *     table and render a skeleton instead — an empty state shown mid-request is a
 *     false statement about the user's data.
 *
 *  2. It carries actions. "No contacts yet" is a dead end; "No contacts yet —
 *     [Connect WhatsApp] [Import CSV] [Add manually]" is the next step. Every empty
 *     surface in this product is reachable on day one, so it is the first thing a new
 *     operator sees, and it should tell them what to do rather than describe the void.
 */

export interface EmptyStateAction {
  label: string;
  onClick?: () => void;
  href?: string;
  /** The one action you would pick for them. Rendered filled; the rest are quiet. */
  primary?: boolean;
  icon?: LucideIcon;
}

interface Props {
  icon: LucideIcon;
  title: string;
  description?: string;
  actions?: EmptyStateAction[];
  /** Shown under the actions — for a caveat or a "why is this empty" explanation. */
  hint?: string;
  compact?: boolean;
}

export default function EmptyState({ icon: Icon, title, description, actions = [], hint, compact }: Props) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'py-10' : 'py-16'} px-6`}>
      <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 flex items-center justify-center mb-4">
        <Icon className="w-7 h-7 text-slate-400 dark:text-slate-500" />
      </div>

      <h3 className="text-slate-800 dark:text-slate-200 font-bold text-sm mb-1">{title}</h3>
      {description && (
        <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm leading-relaxed">{description}</p>
      )}

      {actions.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2 mt-5">
          {actions.map((a) => {
            const cls = a.primary
              ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm shadow-indigo-500/20'
              : 'bg-white dark:bg-slate-800/60 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800';
            const inner = (
              <>
                {a.icon && <a.icon className="w-3.5 h-3.5" />}
                {a.label}
              </>
            );
            return a.href ? (
              <a key={a.label} href={a.href} className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors ${cls}`}>
                {inner}
              </a>
            ) : (
              <button key={a.label} onClick={a.onClick} className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors ${cls}`}>
                {inner}
              </button>
            );
          })}
        </div>
      )}

      {hint && <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-4 max-w-xs leading-relaxed">{hint}</p>}
    </div>
  );
}
