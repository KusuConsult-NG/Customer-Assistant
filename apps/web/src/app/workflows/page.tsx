"use client";

import React, { useEffect, useState, useCallback } from 'react';
import { API_URL } from '@/lib/api';
import {
  GitFork,
  Plus,
  Trash2,
  Play,
  AlertTriangle,
  ArrowRight,
  X,
  History,
  Save,
  Pencil,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Clock,
} from 'lucide-react';

/**
 * Workflow builder.
 *
 * Nodes are machine-readable: an ACTION node carries an `action` identifier and a
 * typed `config`, not a free-text label. The action catalogue and each action's
 * fields come from GET /api/workflows/capabilities, so the editor can never offer a
 * step the executor cannot run — the mismatch that made the old builder produce
 * graphs that matched triggers and then did nothing.
 */

type NodeKind = 'TRIGGER' | 'CONDITION' | 'ACTION' | 'DELAY' | 'UNCONFIGURED';

interface WorkflowNode {
  id: string;
  kind: NodeKind;
  label?: string;
  detail?: string;
  color?: string;
  action?: string;
  config?: Record<string, any>;
  field?: string;
  operator?: string;
  value?: any;
  delaySeconds?: number;
  unconfiguredReason?: string;
}

interface WorkflowEdge {
  from: string;
  to: string;
  branch?: 'true' | 'false';
}

interface RunStep {
  id: string;
  nodeId: string;
  kind: string;
  action?: string | null;
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  output?: any;
  error?: string | null;
}

interface WorkflowRun {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD_LETTER';
  triggerType: string;
  queuedAt: string;
  finishedAt?: string | null;
  error?: string | null;
  ranInline?: boolean;
  steps?: RunStep[];
}

interface Workflow {
  id: string;
  name: string;
  description?: string;
  triggerType: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** Server-computed. Empty means the graph is executable. */
  problems?: string[];
  runnable?: boolean;
  runCount?: number;
  lastRun?: WorkflowRun | null;
  /** Present on the detail response — legacy nodes resolved to executable form. */
  normalizedNodes?: WorkflowNode[];
}

interface ActionSpec {
  action: string;
  label: string;
  fields: Array<{ key: string; label: string; required: boolean; hint?: string }>;
}

interface Capabilities {
  triggers: string[];
  actions: ActionSpec[];
  operators: string[];
}

const TRIGGER_LABELS: Record<string, string> = {
  MESSAGE_RECEIVED: 'Message received (WhatsApp or web chat)',
  LEAD_CREATED: 'Lead created',
  TICKET_CREATED: 'Ticket created',
  BOOKING_CONFIRMED: 'Booking confirmed',
  DEAL_STAGE_CHANGED: 'Deal stage changed',
  CALL_ENDED: 'Call ended',
  CONTACT_CREATED: 'Contact created',
};

const KIND_COLOR: Record<string, string> = {
  TRIGGER: 'from-blue-500 to-indigo-600',
  CONDITION: 'from-amber-500 to-orange-600',
  ACTION: 'from-emerald-500 to-teal-600',
  DELAY: 'from-slate-400 to-slate-600',
};

/** Nodes the editor produces are always executable; this only guards legacy graphs. */
function nodeIsConfigured(node: WorkflowNode, capabilities: Capabilities | null): boolean {
  if (node.kind === 'TRIGGER') return true;
  if (node.kind === 'DELAY') return Number.isFinite(Number(node.delaySeconds));
  if (node.kind === 'CONDITION') return Boolean(node.field && node.operator);
  if (node.kind === 'ACTION') {
    if (!node.action) return false;
    if (!capabilities) return true;
    const spec = capabilities.actions.find((a) => a.action === node.action);
    if (!spec) return false;
    return spec.fields.filter((f) => f.required).every((f) => {
      const v = node.config?.[f.key];
      return v !== undefined && v !== null && String(v).trim() !== '';
    });
  }
  return false;
}

function summarizeNode(node: WorkflowNode, capabilities: Capabilities | null): string {
  if (node.kind === 'TRIGGER') return TRIGGER_LABELS[node.label ?? ''] ?? 'Starts the workflow';
  if (node.kind === 'DELAY') {
    const s = Number(node.delaySeconds ?? 0);
    if (s >= 3600) return `Wait ${Math.round((s / 3600) * 10) / 10} hour(s)`;
    if (s >= 60) return `Wait ${Math.round(s / 60)} minute(s)`;
    return `Wait ${s} second(s)`;
  }
  if (node.kind === 'CONDITION') {
    return `${node.field ?? '?'} ${node.operator ?? '?'}${
      node.operator === 'IS_SET' || node.operator === 'IS_EMPTY' ? '' : ` "${node.value ?? ''}"`
    }`;
  }
  const spec = capabilities?.actions.find((a) => a.action === node.action);
  const cfg = Object.entries(node.config ?? {})
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `${k}: ${String(v).slice(0, 48)}`)
    .join(' · ');
  return cfg ? `${spec?.label ?? node.action} — ${cfg}` : spec?.label ?? node.action ?? 'Unconfigured';
}

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [activeWorkflow, setActiveWorkflow] = useState<Workflow | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState(false);
  const [statusNotice, setStatusNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [lastTest, setLastTest] = useState<any>(null);

  // New Workflow Modal
  const [showNewModal, setShowNewModal] = useState(false);
  const [wfName, setWfName] = useState('');
  const [wfDescription, setWfDescription] = useState('');
  const [wfTrigger, setWfTrigger] = useState('MESSAGE_RECEIVED');

  // Node editor modal — one modal for add and edit.
  const [showNodeModal, setShowNodeModal] = useState(false);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [nodeKind, setNodeKind] = useState<NodeKind>('ACTION');
  const [nodeAction, setNodeAction] = useState<string>('SEND_WHATSAPP');
  const [nodeConfig, setNodeConfig] = useState<Record<string, string>>({});
  const [condField, setCondField] = useState('message');
  const [condOperator, setCondOperator] = useState('CONTAINS');
  const [condValue, setCondValue] = useState('');
  const [delayMinutes, setDelayMinutes] = useState('5');

  const getHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('ace_token') : ''}`,
  });

  const fetchCapabilities = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/workflows/capabilities`, { headers: getHeaders() });
      if (res.ok) setCapabilities(await res.json());
    } catch {
      /* the editor still works with free-form config if this fails */
    }
  }, []);

  const fetchWorkflows = useCallback(async (selectId?: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/workflows`, { headers: getHeaders() });
      if (res.ok) {
        const data: Workflow[] = await res.json();
        setWorkflows(data || []);
        const target = selectId ? data.find((w) => w.id === selectId) : data[0];
        if (target) void openWorkflow(target.id);
        else setActiveWorkflow(null);
      }
    } catch (e) {
      console.error('Failed to fetch workflows:', e);
    } finally {
      setLoading(false);
    }
    // openWorkflow is stable enough for this usage; excluded to avoid a fetch loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Loads the full record — normalized nodes, problems, and run history. */
  const openWorkflow = async (id: string) => {
    try {
      const res = await fetch(`${API_URL}/api/workflows/${id}`, { headers: getHeaders() });
      if (!res.ok) return;
      const wf: Workflow = await res.json();
      // Prefer the server's normalized view so legacy graphs show what will actually run.
      setActiveWorkflow({ ...wf, nodes: wf.normalizedNodes ?? wf.nodes ?? [], edges: wf.edges ?? [] });
      setRuns((wf as any).runs ?? []);
      setDirty(false);
      setLastTest(null);
    } catch {
      /* ignore */
    }
  };

  const refreshRuns = async (id: string) => {
    try {
      const res = await fetch(`${API_URL}/api/workflows/${id}/runs?limit=25`, { headers: getHeaders() });
      if (res.ok) setRuns(await res.json());
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    fetchCapabilities();
    fetchWorkflows();
  }, [fetchCapabilities, fetchWorkflows]);

  /** Rebuilds the linear edge chain from node order. */
  const chainEdges = (nodes: WorkflowNode[]): WorkflowEdge[] =>
    nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1].id }));

  const handleCreateWorkflow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wfName.trim()) return;

    // Only the trigger node. Actions are added deliberately, with real configuration —
    // the old builder pre-seeded a "Send AI Automated Response" node that nothing
    // could execute.
    const initialNodes: WorkflowNode[] = [
      {
        id: 'node-1',
        kind: 'TRIGGER',
        label: wfTrigger,
        detail: TRIGGER_LABELS[wfTrigger] ?? wfTrigger,
        color: KIND_COLOR.TRIGGER,
      },
    ];

    try {
      const res = await fetch(`${API_URL}/api/workflows`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          name: wfName,
          description: wfDescription,
          triggerType: wfTrigger,
          nodes: initialNodes,
          edges: [],
          isActive: false,
        }),
      });

      if (res.ok) {
        const created = await res.json();
        setStatusNotice({
          type: 'success',
          text: `"${created.name}" created as a draft. Add at least one action, then activate it.`,
        });
        setShowNewModal(false);
        setWfName('');
        setWfDescription('');
        await fetchWorkflows(created.id);
      } else {
        const err = await res.json().catch(() => ({}));
        setStatusNotice({ type: 'error', text: err.message || 'Error creating workflow.' });
      }
    } catch {
      setStatusNotice({ type: 'error', text: 'Error creating workflow.' });
    }
  };

  const handleSaveWorkflow = async () => {
    if (!activeWorkflow) return;
    try {
      const res = await fetch(`${API_URL}/api/workflows/${activeWorkflow.id}`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({
          name: activeWorkflow.name,
          nodes: activeWorkflow.nodes,
          edges: chainEdges(activeWorkflow.nodes),
          isActive: activeWorkflow.isActive,
        }),
      });

      if (res.ok) {
        setStatusNotice({ type: 'success', text: 'Workflow saved.' });
        setDirty(false);
        await openWorkflow(activeWorkflow.id);
        await fetchWorkflowList();
      } else {
        const err = await res.json().catch(() => ({}));
        setStatusNotice({ type: 'error', text: err.message || 'Failed to save workflow.' });
      }
    } catch {
      setStatusNotice({ type: 'error', text: 'Failed to save workflow.' });
    }
  };

  /** Refreshes only the sidebar list, leaving the open editor untouched. */
  const fetchWorkflowList = async () => {
    try {
      const res = await fetch(`${API_URL}/api/workflows`, { headers: getHeaders() });
      if (res.ok) setWorkflows(await res.json());
    } catch {
      /* ignore */
    }
  };

  const handleToggleActive = async () => {
    if (!activeWorkflow) return;
    const next = !activeWorkflow.isActive;

    if (next && dirty) {
      setStatusNotice({ type: 'error', text: 'Save your changes before activating.' });
      return;
    }

    try {
      const res = await fetch(`${API_URL}/api/workflows/${activeWorkflow.id}`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({ isActive: next }),
      });
      if (res.ok) {
        setActiveWorkflow({ ...activeWorkflow, isActive: next });
        setStatusNotice({
          type: 'success',
          text: next ? 'Workflow is live — it will run on every matching event.' : 'Workflow paused.',
        });
        await fetchWorkflowList();
      } else {
        // The API refuses to activate a graph it cannot execute and says why.
        const err = await res.json().catch(() => ({}));
        setStatusNotice({ type: 'error', text: err.message || 'Failed to update workflow status.' });
      }
    } catch {
      setStatusNotice({ type: 'error', text: 'Failed to update workflow status.' });
    }
  };

  const handleDeleteWorkflow = async (id: string) => {
    if (!confirm('Delete this workflow and its run history?')) return;
    try {
      const res = await fetch(`${API_URL}/api/workflows/${id}`, { method: 'DELETE', headers: getHeaders() });
      if (res.ok) {
        setWorkflows((prev) => prev.filter((w) => w.id !== id));
        if (activeWorkflow?.id === id) {
          setActiveWorkflow(null);
          setRuns([]);
        }
      }
    } catch {
      setStatusNotice({ type: 'error', text: 'Failed to delete workflow.' });
    }
  };

  // ── Node editor ───────────────────────────────────────────────────────────

  const openNodeEditor = (node?: WorkflowNode) => {
    if (node) {
      setEditingNodeId(node.id);
      setNodeKind(node.kind === 'TRIGGER' ? 'ACTION' : node.kind);
      setNodeAction(node.action ?? capabilities?.actions[0]?.action ?? 'SEND_WHATSAPP');
      setNodeConfig(
        Object.fromEntries(Object.entries(node.config ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]))
      );
      setCondField(node.field ?? 'message');
      setCondOperator(node.operator ?? 'CONTAINS');
      setCondValue(node.value != null ? String(node.value) : '');
      setDelayMinutes(String(Math.max(1, Math.round((node.delaySeconds ?? 300) / 60))));
    } else {
      setEditingNodeId(null);
      setNodeKind('ACTION');
      setNodeAction(capabilities?.actions[0]?.action ?? 'SEND_WHATSAPP');
      setNodeConfig({});
      setCondField('message');
      setCondOperator('CONTAINS');
      setCondValue('');
      setDelayMinutes('5');
    }
    setShowNodeModal(true);
  };

  const buildNodeFromForm = (id: string): WorkflowNode | { error: string } => {
    if (nodeKind === 'ACTION') {
      const spec = capabilities?.actions.find((a) => a.action === nodeAction);
      const missing = (spec?.fields ?? [])
        .filter((f) => f.required && !String(nodeConfig[f.key] ?? '').trim())
        .map((f) => f.label);
      if (missing.length) return { error: `${spec?.label ?? nodeAction} needs: ${missing.join(', ')}.` };

      const config: Record<string, any> = {};
      for (const [k, v] of Object.entries(nodeConfig)) {
        if (String(v).trim() === '') continue;
        // TAG_CONTACT takes a list; every other field is a scalar.
        config[k] = nodeAction === 'TAG_CONTACT' && k === 'tags'
          ? String(v).split(',').map((t) => t.trim()).filter(Boolean)
          : v;
      }
      return {
        id,
        kind: 'ACTION',
        action: nodeAction,
        config,
        label: spec?.label ?? nodeAction,
        color: KIND_COLOR.ACTION,
      };
    }

    if (nodeKind === 'CONDITION') {
      if (!condField.trim()) return { error: 'A condition needs a field to test.' };
      const needsValue = condOperator !== 'IS_SET' && condOperator !== 'IS_EMPTY';
      if (needsValue && !condValue.trim()) return { error: 'A condition needs a value to compare against.' };
      return {
        id,
        kind: 'CONDITION',
        field: condField.trim(),
        operator: condOperator,
        value: needsValue ? condValue : undefined,
        label: 'Condition',
        color: KIND_COLOR.CONDITION,
      };
    }

    const minutes = Number(delayMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return { error: 'Delay must be a positive number of minutes.' };
    return { id, kind: 'DELAY', delaySeconds: Math.round(minutes * 60), label: 'Wait', color: KIND_COLOR.DELAY };
  };

  const handleSaveNode = () => {
    if (!activeWorkflow) return;
    const id = editingNodeId ?? `node-${Date.now()}`;
    const built = buildNodeFromForm(id);
    if ('error' in built) {
      setStatusNotice({ type: 'error', text: built.error });
      return;
    }

    const nodes = editingNodeId
      ? activeWorkflow.nodes.map((n) => (n.id === editingNodeId ? built : n))
      : [...(activeWorkflow.nodes ?? []), built];

    setActiveWorkflow({ ...activeWorkflow, nodes, edges: chainEdges(nodes) });
    setDirty(true);
    setShowNodeModal(false);
  };

  const handleDeleteNode = (id: string) => {
    if (!activeWorkflow) return;
    const nodes = activeWorkflow.nodes.filter((n) => n.id !== id);
    setActiveWorkflow({ ...activeWorkflow, nodes, edges: chainEdges(nodes) });
    setDirty(true);
  };

  const moveNode = (index: number, direction: -1 | 1) => {
    if (!activeWorkflow) return;
    const nodes = [...activeWorkflow.nodes];
    const target = index + direction;
    if (target < 1 || target >= nodes.length) return; // the trigger stays first
    [nodes[index], nodes[target]] = [nodes[target], nodes[index]];
    setActiveWorkflow({ ...activeWorkflow, nodes, edges: chainEdges(nodes) });
    setDirty(true);
  };

  // ── Test run ──────────────────────────────────────────────────────────────

  const handleTestExecute = async () => {
    if (!activeWorkflow) return;
    if (dirty) {
      setStatusNotice({ type: 'error', text: 'Save your changes before running a test.' });
      return;
    }
    if (
      !confirm(
        'This runs the workflow for real: messages are sent, tickets are created and webhooks are called. Continue?'
      )
    ) {
      return;
    }

    setTesting(true);
    setLastTest(null);
    try {
      const res = await fetch(`${API_URL}/api/workflows/${activeWorkflow.id}/execute`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ payload: { source: 'manual-test' } }),
      });
      const result = await res.json().catch(() => ({}));

      if (!res.ok) {
        setStatusNotice({ type: 'error', text: result.message || 'Workflow could not be run.' });
        return;
      }

      setLastTest(result);
      setStatusNotice({
        type: result.status === 'SUCCEEDED' || result.status === 'PAUSED' ? 'success' : 'error',
        text:
          result.status === 'SUCCEEDED'
            ? `Ran ${result.stepsExecuted} step(s) successfully.`
            : result.status === 'PAUSED'
            ? `Ran ${result.stepsExecuted} step(s); paused until ${new Date(result.resumesAt).toLocaleString()}.`
            : `Run failed after ${result.stepsExecuted} step(s): ${result.error ?? 'unknown error'}`,
      });
      await refreshRuns(activeWorkflow.id);
    } catch {
      setStatusNotice({ type: 'error', text: 'Could not reach the workflow engine.' });
    } finally {
      setTesting(false);
    }
  };

  const handleReplay = async (runId: string) => {
    if (!activeWorkflow) return;
    try {
      const res = await fetch(`${API_URL}/api/workflows/runs/${runId}/replay`, {
        method: 'POST',
        headers: getHeaders(),
      });
      const result = await res.json().catch(() => ({}));
      setStatusNotice(
        res.ok
          ? { type: 'success', text: result.queued ? 'Run re-queued.' : `Replayed inline — ${result.status}.` }
          : { type: 'error', text: result.message || 'Replay failed.' }
      );
      await refreshRuns(activeWorkflow.id);
    } catch {
      setStatusNotice({ type: 'error', text: 'Replay failed.' });
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const actionSpec = capabilities?.actions.find((a) => a.action === nodeAction);
  const problems = activeWorkflow?.problems ?? [];
  const unconfigured = (activeWorkflow?.nodes ?? []).filter((n) => !nodeIsConfigured(n, capabilities));

  return (
    <div className="space-y-6 max-w-7xl pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <GitFork className="w-6 h-6 text-blue-600 dark:text-blue-400" /> Workflow Automation
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Run real actions — send messages, open tickets, update the pipeline, call webhooks — whenever a business
            event happens.
          </p>
        </div>
        <button
          onClick={() => setShowNewModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-all text-sm shadow-lg shadow-blue-500/20"
        >
          <Plus className="w-4 h-4" /> New Workflow
        </button>
      </div>

      {statusNotice && (
        <div
          className={`p-4 rounded-xl text-sm border flex items-start justify-between gap-4 ${
            statusNotice.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-400'
              : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/20 text-red-700 dark:text-red-400'
          }`}
        >
          <span>{statusNotice.text}</span>
          <button onClick={() => setStatusNotice(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left column: workflow list */}
        <div className="lg:col-span-1 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400">
            Workflows ({workflows.length})
          </h3>

          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-16 bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm rounded-xl animate-pulse"
                />
              ))}
            </div>
          ) : workflows.length === 0 ? (
            <div className="p-6 rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 text-center text-xs text-slate-600 dark:text-slate-400">
              No workflows yet. Create one to automate a response to a business event.
            </div>
          ) : (
            workflows.map((wf) => (
              <div
                key={wf.id}
                onClick={() => openWorkflow(wf.id)}
                className={`p-4 rounded-2xl border transition-all cursor-pointer space-y-2 ${
                  activeWorkflow?.id === wf.id
                    ? 'bg-blue-50 dark:bg-blue-500/10 border-blue-500/40 shadow-lg'
                    : 'bg-white dark:bg-slate-900/80 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-sm text-slate-900 dark:text-white truncate">{wf.name}</span>
                  <span
                    title={wf.isActive ? 'Active' : 'Paused'}
                    className={`w-2 h-2 rounded-full shrink-0 ${wf.isActive ? 'bg-emerald-500' : 'bg-slate-400'}`}
                  />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                  {TRIGGER_LABELS[wf.triggerType] ?? wf.triggerType}
                </p>
                <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 pt-1">
                  <span>{wf.runCount ?? 0} run(s)</span>
                  {wf.problems && wf.problems.length > 0 ? (
                    <span className="text-amber-600 dark:text-amber-400 font-semibold">Needs setup</span>
                  ) : (
                    <span>{wf.nodes?.length || 0} nodes</span>
                  )}
                </div>
                {wf.lastRun && (
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">
                    Last: <span className={runStatusClass(wf.lastRun.status)}>{wf.lastRun.status}</span>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Right column: editor */}
        <div className="lg:col-span-3 space-y-6">
          {activeWorkflow ? (
            <>
              <div className="rounded-2xl bg-slate-50 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 shadow-sm p-6 space-y-6">
                {/* Toolbar */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
                  <div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <h2 className="text-lg font-bold text-slate-900 dark:text-white">{activeWorkflow.name}</h2>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                          activeWorkflow.isActive
                            ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20'
                            : 'bg-slate-100 dark:bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-500/20'
                        }`}
                      >
                        {activeWorkflow.isActive ? 'ACTIVE' : 'PAUSED'}
                      </span>
                      {dirty && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold border bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/20">
                          UNSAVED
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                      Runs on: <span className="font-medium">{TRIGGER_LABELS[activeWorkflow.triggerType] ?? activeWorkflow.triggerType}</span>
                    </p>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={handleToggleActive}
                      className="px-3 py-1.5 rounded-xl bg-white dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-300 font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      {activeWorkflow.isActive ? 'Pause' : 'Activate'}
                    </button>
                    <button
                      onClick={handleTestExecute}
                      disabled={testing}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600/15 border border-emerald-300 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-600/25 text-xs font-semibold disabled:opacity-50"
                    >
                      <Play className="w-3.5 h-3.5" /> {testing ? 'Running…' : 'Run Now'}
                    </button>
                    <button
                      onClick={handleSaveWorkflow}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-lg shadow-blue-500/20"
                    >
                      <Save className="w-3.5 h-3.5" /> Save
                    </button>
                    <button
                      onClick={() => handleDeleteWorkflow(activeWorkflow.id)}
                      className="p-2 rounded-xl text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Blockers — the reason a workflow will not run, stated plainly. */}
                {(problems.length > 0 || unconfigured.length > 0) && (
                  <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 text-xs text-amber-800 dark:text-amber-300 space-y-1">
                    <div className="flex items-center gap-2 font-bold">
                      <AlertTriangle className="w-4 h-4" /> This workflow cannot run yet
                    </div>
                    <ul className="list-disc ml-5 space-y-0.5">
                      {problems.map((p, i) => (
                        <li key={`p-${i}`}>{p}</li>
                      ))}
                      {unconfigured.map((n) => (
                        <li key={n.id}>{n.unconfiguredReason ?? `"${n.label ?? n.id}" is missing required configuration.`}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Node chain */}
                <div className="py-4 flex flex-col items-center space-y-4">
                  {(activeWorkflow.nodes ?? []).map((node, index) => {
                    const ok = nodeIsConfigured(node, capabilities);
                    return (
                      <React.Fragment key={node.id}>
                        <div
                          className={`w-full max-w-xl p-5 rounded-2xl bg-white dark:bg-slate-900/80 border shadow-sm transition-all group ${
                            ok
                              ? 'border-slate-200 dark:border-slate-700 hover:border-blue-500/40'
                              : 'border-amber-300 dark:border-amber-500/40'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className={`w-3 h-3 rounded-full bg-gradient-to-r ${node.color || KIND_COLOR[node.kind] || KIND_COLOR.ACTION}`} />
                              <span className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400">
                                {node.kind}
                              </span>
                              {node.action && (
                                <code className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                                  {node.action}
                                </code>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] font-mono text-slate-400 mr-1">#{index + 1}</span>
                              {node.kind !== 'TRIGGER' && (
                                <>
                                  <button
                                    onClick={() => moveNode(index, -1)}
                                    title="Move up"
                                    className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                                  >
                                    ↑
                                  </button>
                                  <button
                                    onClick={() => moveNode(index, 1)}
                                    title="Move down"
                                    className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                                  >
                                    ↓
                                  </button>
                                  <button
                                    onClick={() => openNodeEditor(node)}
                                    title="Edit step"
                                    className="p-1 rounded text-slate-400 hover:text-blue-600"
                                  >
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => handleDeleteNode(node.id)}
                                    title="Remove step"
                                    className="p-1 rounded text-slate-400 hover:text-red-600"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                          <h4 className="font-bold text-slate-900 dark:text-white text-sm mb-1">
                            {node.kind === 'TRIGGER'
                              ? TRIGGER_LABELS[activeWorkflow.triggerType] ?? activeWorkflow.triggerType
                              : node.label ?? node.action ?? node.kind}
                          </h4>
                          <p className={`text-xs ${ok ? 'text-slate-600 dark:text-slate-400' : 'text-amber-700 dark:text-amber-400'}`}>
                            {ok ? summarizeNode(node, capabilities) : node.unconfiguredReason ?? 'Missing required configuration.'}
                          </p>
                        </div>

                        {index < activeWorkflow.nodes.length - 1 && (
                          <div className="flex flex-col items-center">
                            <div className="w-0.5 h-4 bg-slate-300 dark:bg-slate-700" />
                            <ArrowRight className="w-4 h-4 rotate-90 text-slate-400" />
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}

                  <button
                    onClick={() => openNodeEditor()}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-white dark:bg-slate-800/60 border border-dashed border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-blue-400 hover:text-slate-900 dark:hover:text-white transition-all text-xs font-semibold mt-2"
                  >
                    <Plus className="w-4 h-4" /> Add step
                  </button>
                </div>
              </div>

              {/* Last test result — step by step, from the server. */}
              {lastTest && (
                <div className="rounded-2xl bg-white dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 shadow-sm p-6 space-y-3">
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                    Last run — {lastTest.status} ({lastTest.stepsExecuted} step(s))
                  </h3>
                  {(lastTest.steps ?? []).length === 0 ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400">No steps were executed.</p>
                  ) : (
                    <ol className="space-y-2">
                      {lastTest.steps.map((s: RunStep, i: number) => (
                        <li key={i} className="flex items-start gap-2 text-xs">
                          <StepIcon status={s.status} />
                          <div className="min-w-0">
                            <span className="font-semibold text-slate-800 dark:text-slate-200">
                              {s.action ?? s.kind}
                            </span>
                            {s.error && <span className="text-red-600 dark:text-red-400"> — {s.error}</span>}
                            {s.output != null && (
                              <pre className="mt-1 p-2 rounded-lg bg-slate-50 dark:bg-slate-800/60 text-[10px] text-slate-600 dark:text-slate-300 overflow-x-auto">
                                {JSON.stringify(s.output, null, 2)}
                              </pre>
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}

              {/* Run history */}
              <div className="rounded-2xl bg-white dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 shadow-sm p-6 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <History className="w-4 h-4 text-slate-500" /> Run History
                  </h3>
                  <button
                    onClick={() => refreshRuns(activeWorkflow.id)}
                    className="text-xs text-blue-600 dark:text-blue-400 font-semibold"
                  >
                    Refresh
                  </button>
                </div>

                {runs.length === 0 ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    No runs yet. This workflow has not been triggered.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {runs.map((run) => (
                      <div key={run.id} className="py-2.5">
                        <div className="flex items-center justify-between gap-3 text-xs">
                          <button
                            onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                            className="flex items-center gap-2 min-w-0 text-left"
                          >
                            <span className={`font-bold ${runStatusClass(run.status)}`}>{run.status}</span>
                            <span className="text-slate-500 dark:text-slate-400 truncate">
                              {new Date(run.queuedAt).toLocaleString()}
                            </span>
                            {run.ranInline && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">
                                inline
                              </span>
                            )}
                          </button>
                          {(run.status === 'FAILED' || run.status === 'DEAD_LETTER') && (
                            <button
                              onClick={() => handleReplay(run.id)}
                              className="text-blue-600 dark:text-blue-400 font-semibold shrink-0"
                            >
                              Replay
                            </button>
                          )}
                        </div>
                        {run.error && (
                          <p className="text-[11px] text-red-600 dark:text-red-400 mt-1 truncate">{run.error}</p>
                        )}
                        {expandedRun === run.id && (
                          <ol className="mt-2 space-y-1.5 pl-1">
                            {(run.steps ?? []).length === 0 ? (
                              <li className="text-[11px] text-slate-500">No steps recorded.</li>
                            ) : (
                              run.steps!.map((s) => (
                                <li key={s.id} className="flex items-start gap-2 text-[11px]">
                                  <StepIcon status={s.status} />
                                  <div className="min-w-0">
                                    <span className="font-semibold text-slate-700 dark:text-slate-300">
                                      {s.action ?? s.kind}
                                    </span>
                                    {s.error && <span className="text-red-600 dark:text-red-400"> — {s.error}</span>}
                                    {s.output != null && (
                                      <pre className="mt-1 p-2 rounded bg-slate-50 dark:bg-slate-800/60 text-[10px] text-slate-600 dark:text-slate-300 overflow-x-auto">
                                        {JSON.stringify(s.output)}
                                      </pre>
                                    )}
                                  </div>
                                </li>
                              ))
                            )}
                          </ol>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="p-12 rounded-2xl bg-slate-50 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 shadow-sm text-center flex flex-col items-center justify-center min-h-[400px]">
              <GitFork className="w-12 h-12 text-blue-600 dark:text-blue-400 mb-3" />
              <p className="text-slate-700 dark:text-slate-300 font-medium mb-1">Select or create a workflow</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mb-4">
                Automate what happens after a message arrives, a lead is created, a booking is confirmed, or a call
                ends.
              </p>
              <button
                onClick={() => setShowNewModal(true)}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow-lg shadow-blue-500/20"
              >
                Create Workflow
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Modal 1: create workflow */}
      {showNewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <GitFork className="w-5 h-5 text-blue-600 dark:text-blue-400" /> New Workflow
              </h2>
              <button onClick={() => setShowNewModal(false)} className="text-slate-500 hover:text-slate-900 dark:hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateWorkflow} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Workflow name</label>
                <input
                  required
                  type="text"
                  value={wfName}
                  onChange={(e) => setWfName(e.target.value)}
                  placeholder="e.g. Escalate urgent messages"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Trigger event</label>
                <select
                  value={wfTrigger}
                  onChange={(e) => setWfTrigger(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                >
                  {(capabilities?.triggers ?? Object.keys(TRIGGER_LABELS)).map((t) => (
                    <option key={t} value={t}>
                      {TRIGGER_LABELS[t] ?? t}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Description (optional)</label>
                <textarea
                  rows={2}
                  value={wfDescription}
                  onChange={(e) => setWfDescription(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewModal(false)}
                  className="px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300 font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold shadow-lg shadow-blue-500/20"
                >
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal 2: node editor */}
      {showNodeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Plus className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                {editingNodeId ? 'Edit step' : 'Add step'}
              </h2>
              <button onClick={() => setShowNodeModal(false)} className="text-slate-500 hover:text-slate-900 dark:hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Step type</label>
                <select
                  value={nodeKind}
                  onChange={(e) => setNodeKind(e.target.value as NodeKind)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                >
                  <option value="ACTION">Action — do something</option>
                  <option value="CONDITION">Condition — only continue if…</option>
                  <option value="DELAY">Delay — wait before continuing</option>
                </select>
              </div>

              {nodeKind === 'ACTION' && (
                <>
                  <div>
                    <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Action</label>
                    <select
                      value={nodeAction}
                      onChange={(e) => {
                        setNodeAction(e.target.value);
                        setNodeConfig({});
                      }}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                    >
                      {(capabilities?.actions ?? []).map((a) => (
                        <option key={a.action} value={a.action}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {(actionSpec?.fields ?? []).map((f) => (
                    <div key={f.key}>
                      <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">
                        {f.label}
                        {f.required && <span className="text-red-500"> *</span>}
                      </label>
                      {f.key === 'message' || f.key === 'description' ? (
                        <textarea
                          rows={3}
                          value={nodeConfig[f.key] ?? ''}
                          onChange={(e) => setNodeConfig({ ...nodeConfig, [f.key]: e.target.value })}
                          className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                        />
                      ) : (
                        <input
                          type="text"
                          value={nodeConfig[f.key] ?? ''}
                          onChange={(e) => setNodeConfig({ ...nodeConfig, [f.key]: e.target.value })}
                          className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                        />
                      )}
                      {f.hint && <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">{f.hint}</p>}
                    </div>
                  ))}

                  <p className="text-[10px] text-slate-500 dark:text-slate-400">
                    Use <code className="px-1 rounded bg-slate-100 dark:bg-slate-800">{'{{ contact.fullName }}'}</code>{' '}
                    to insert values from the triggering event. Unknown fields resolve to nothing rather than printing
                    the placeholder.
                  </p>
                </>
              )}

              {nodeKind === 'CONDITION' && (
                <>
                  <div>
                    <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Field</label>
                    <input
                      type="text"
                      value={condField}
                      onChange={(e) => setCondField(e.target.value)}
                      placeholder="message, status, contact.fullName…"
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                    />
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                      A path into the triggering event. Steps after this one only run when the test passes.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Operator</label>
                      <select
                        value={condOperator}
                        onChange={(e) => setCondOperator(e.target.value)}
                        className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                      >
                        {(capabilities?.operators ?? ['EQUALS', 'CONTAINS']).map((op) => (
                          <option key={op} value={op}>
                            {op.replace(/_/g, ' ').toLowerCase()}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Value</label>
                      <input
                        type="text"
                        disabled={condOperator === 'IS_SET' || condOperator === 'IS_EMPTY'}
                        value={condValue}
                        onChange={(e) => setCondValue(e.target.value)}
                        className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none disabled:opacity-40"
                      />
                    </div>
                  </div>
                </>
              )}

              {nodeKind === 'DELAY' && (
                <div>
                  <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Wait (minutes)</label>
                  <input
                    type="number"
                    min={1}
                    value={delayMinutes}
                    onChange={(e) => setDelayMinutes(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                  />
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                    Maximum 7 days. The run pauses here and resumes automatically.
                  </p>
                </div>
              )}

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowNodeModal(false)}
                  className="px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300 font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveNode}
                  className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold shadow-lg shadow-blue-500/20"
                >
                  {editingNodeId ? 'Update step' : 'Add step'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function runStatusClass(status: string): string {
  switch (status) {
    case 'SUCCEEDED':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'FAILED':
    case 'DEAD_LETTER':
      return 'text-red-600 dark:text-red-400';
    case 'RUNNING':
      return 'text-blue-600 dark:text-blue-400';
    default:
      return 'text-slate-500 dark:text-slate-400';
  }
}

function StepIcon({ status }: { status: string }) {
  if (status === 'SUCCEEDED') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />;
  if (status === 'FAILED') return <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />;
  if (status === 'SKIPPED') return <MinusCircle className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />;
  return <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />;
}
