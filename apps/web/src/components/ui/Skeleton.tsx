"use client";

import React from 'react';

/**
 * Loading placeholders.
 *
 * These exist because the alternative was worse than nothing: several tables rendered
 * their "No items yet" empty state while the request was still in flight. Against a
 * database roughly a second away, a fresh sign-in showed "No contacts yet. Your first
 * customers will appear here" to an account that had thousands — the UI stated
 * something false and then quietly corrected itself.
 *
 * A skeleton says "loading" without claiming anything about the data.
 */

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-slate-200 dark:bg-slate-800 ${className}`} />;
}

/** Mirrors the shape of a data table so the layout does not jump when rows arrive. */
export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="w-full" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="flex gap-4 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className={`h-3 ${i === 0 ? 'w-40' : 'flex-1'}`} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-4 border-b border-slate-100 dark:border-slate-800/60">
          <div className="flex items-center gap-3 w-40">
            <Skeleton className="w-8 h-8 rounded-full shrink-0" />
            <Skeleton className="h-3 flex-1" />
          </div>
          {Array.from({ length: columns - 1 }).map((_, c) => (
            <Skeleton key={c} className="h-3 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardGridSkeleton({ cards = 4, height = 'h-28' }: { cards?: number; height?: string }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: cards }).map((_, i) => (
        <Skeleton key={i} className={`${height} rounded-2xl`} />
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 space-y-2">
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-2.5 w-2/3" />
        </div>
      ))}
    </div>
  );
}
