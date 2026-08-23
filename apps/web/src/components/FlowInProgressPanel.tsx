"use client";
import React from 'react';
import { ClipboardList, Clock } from 'lucide-react';

/**
 * What the customer is part-way through filling in.
 *
 * Asking for a person always beats a flow — that is what stops a form being a
 * trap — but until now the state it interrupted never left the orchestrator.
 * Somebody six answers into PLASCHEMA enrollment who asked for help reached an
 * operator who could see the message thread and nothing else, and got asked
 * their name, age, address and LGA a second time.
 *
 * So this shows the answers already given, and the question the customer is
 * looking at right now. It is READ-ONLY on purpose: editing a live flow's state
 * from the dashboard is a second writer racing the engine over the same row,
 * and the operator already has the better tool for changing an answer — the
 * conversation. The flow accepts corrections from the customer by design.
 */
export interface FlowSnapshot {
  flow: string;
  title: string;
  answered: Array<{ name: string; label: string; value: string; declined: boolean }>;
  awaiting: { name: string; label: string } | null;
  confirming: boolean;
  startedAt: number;
  updatedAt: number;
  stale: boolean;
}

const sinceLabel = (ms: number) => {
  if (!ms) return '';
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
};

export default function FlowInProgressPanel({ flow }: { flow: FlowSnapshot | null }) {
  if (!flow) return null;

  return (
    <div
      className={`border-b px-6 py-3 flex-shrink-0 ${
        flow.stale
          ? 'bg-slate-50 border-slate-200 dark:bg-slate-800/40 dark:border-slate-700'
          : 'bg-sky-50 border-sky-200 dark:bg-sky-500/10 dark:border-sky-500/20'
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <ClipboardList
          className={`w-4 h-4 ${flow.stale ? 'text-slate-500 dark:text-slate-400' : 'text-sky-700 dark:text-sky-400'}`}
        />
        <span
          className={`text-xs font-bold ${flow.stale ? 'text-slate-600 dark:text-slate-300' : 'text-sky-800 dark:text-sky-300'}`}
        >
          {flow.title}
        </span>
        <span className="text-[10px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {sinceLabel(flow.updatedAt)}
        </span>
      </div>

      {flow.answered.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mb-2">
          {flow.answered.map((a) => (
            <React.Fragment key={a.name}>
              <dt className="text-[11px] text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">
                {a.label}
              </dt>
              <dd
                className={`text-[11px] font-semibold break-words ${
                  a.declined
                    ? 'text-slate-400 dark:text-slate-500 italic'
                    : 'text-slate-800 dark:text-slate-100'
                }`}
              >
                {/* An optional field the customer declined is an ANSWER — they
                    were asked and said no — not a field still to collect. */}
                {a.declined ? 'declined' : a.value || '—'}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      )}

      {flow.stale ? (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          This form has expired — the customer&apos;s next message starts a fresh conversation, not
          question&nbsp;{flow.answered.length + 1}.
        </p>
      ) : flow.confirming ? (
        <p className="text-[11px] text-sky-800 dark:text-sky-300 font-medium">
          Read back to the customer — waiting for them to confirm. Nothing has been saved yet.
        </p>
      ) : flow.awaiting ? (
        <p className="text-[11px] text-sky-800 dark:text-sky-300 font-medium">
          Waiting for: <span className="font-bold">{flow.awaiting.label}</span>
        </p>
      ) : null}
    </div>
  );
}
