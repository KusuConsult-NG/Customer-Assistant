"use client";

import React, { useEffect, useState, useCallback } from 'react';
import { API_URL } from '@/lib/api';
import {
  GitFork,
  Plus,
  Trash2,
  Play,
  CheckCircle2,
  XCircle,
  MessageSquare,
  PhoneCall,
  UserPlus,
  Zap,
  Bot,
  ArrowRight,
  Settings2,
  X,
  Sparkles,
  Layers,
  Save
} from 'lucide-react';

interface WorkflowNode {
  id: string;
  type: 'TRIGGER' | 'CONDITION' | 'ACTION';
  label: string;
  detail: string;
  color: string;
}

interface Workflow {
  id: string;
  name: string;
  description?: string;
  triggerType: string;
  nodes: WorkflowNode[];
  edges: any[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [activeWorkflow, setActiveWorkflow] = useState<Workflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusNotice, setStatusNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // New Workflow Modal
  const [showNewModal, setShowNewModal] = useState(false);
  const [wfName, setWfName] = useState('');
  const [wfDescription, setWfDescription] = useState('');
  const [wfTrigger, setWfTrigger] = useState('WHATSAPP_INBOUND');

  // Node Adder Modal
  const [showNodeModal, setShowNodeModal] = useState(false);
  const [nodeType, setNodeType] = useState<'TRIGGER' | 'CONDITION' | 'ACTION'>('ACTION');
  const [nodeLabel, setNodeLabel] = useState('Send AI Automated Reply');
  const [nodeDetail, setNodeDetail] = useState('Process user intent with GPT-4o RAG knowledge');

  const getHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('ace_token') : ''}`,
  });

  const fetchWorkflows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/workflows`, { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setWorkflows(data || []);
        if (data.length > 0 && !activeWorkflow) {
          setActiveWorkflow(data[0]);
        }
      }
    } catch (e) {
      console.error('Failed to fetch workflows:', e);
    } finally {
      setLoading(false);
    }
  }, [activeWorkflow]);

  useEffect(() => {
    fetchWorkflows();
  }, [fetchWorkflows]);

  const handleCreateWorkflow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wfName.trim()) return;

    const initialNodes: WorkflowNode[] = [
      {
        id: 'node-1',
        type: 'TRIGGER',
        label: wfTrigger === 'WHATSAPP_INBOUND' ? 'Inbound WhatsApp Message' : 'Inbound Voice Call',
        detail: 'Triggered when a customer reaches out via ' + (wfTrigger === 'WHATSAPP_INBOUND' ? 'WhatsApp' : 'Phone Call'),
        color: 'from-blue-500 to-indigo-600',
      },
      {
        id: 'node-2',
        type: 'ACTION',
        label: 'Send AI Automated Response',
        detail: 'RAG Knowledge Lookup & Natural LLM Generation',
        color: 'from-purple-500 to-pink-600',
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
          edges: [{ from: 'node-1', to: 'node-2' }],
        }),
      });

      if (res.ok) {
        const created = await res.json();
        setStatusNotice({ type: 'success', text: `Workflow "${created.name}" created!` });
        setShowNewModal(false);
        setWfName('');
        setWfDescription('');
        setActiveWorkflow(created);
        fetchWorkflows();
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
          edges: activeWorkflow.edges,
          isActive: activeWorkflow.isActive,
        }),
      });

      if (res.ok) {
        setStatusNotice({ type: 'success', text: 'Workflow graph saved successfully!' });
        fetchWorkflows();
      }
    } catch {
      setStatusNotice({ type: 'error', text: 'Failed to save workflow.' });
    }
  };

  const handleToggleActive = async (id: string, currentStatus: boolean) => {
    try {
      const res = await fetch(`${API_URL}/api/workflows/${id}`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({ isActive: !currentStatus }),
      });
      if (res.ok) {
        setWorkflows(prev => prev.map(w => w.id === id ? { ...w, isActive: !currentStatus } : w));
        if (activeWorkflow?.id === id) {
          setActiveWorkflow({ ...activeWorkflow, isActive: !currentStatus });
        }
      }
    } catch {
      alert('Failed to update workflow status.');
    }
  };

  const handleDeleteWorkflow = async (id: string) => {
    if (!confirm('Are you sure you want to delete this visual workflow?')) return;
    try {
      const res = await fetch(`${API_URL}/api/workflows/${id}`, {
        method: 'DELETE',
        headers: getHeaders(),
      });
      if (res.ok) {
        setWorkflows(prev => prev.filter(w => w.id !== id));
        if (activeWorkflow?.id === id) {
          setActiveWorkflow(null);
        }
      }
    } catch {
      alert('Failed to delete workflow.');
    }
  };

  const handleAddNode = () => {
    if (!activeWorkflow) return;
    const newNode: WorkflowNode = {
      id: `node-${Date.now()}`,
      type: nodeType,
      label: nodeLabel,
      detail: nodeDetail,
      color: nodeType === 'CONDITION' ? 'from-amber-500 to-orange-600' : 'from-emerald-500 to-teal-600',
    };

    const updatedNodes = [...(activeWorkflow.nodes || []), newNode];
    setActiveWorkflow({ ...activeWorkflow, nodes: updatedNodes });
    setShowNodeModal(false);
  };

  const handleTestExecute = async () => {
    if (!activeWorkflow) return;
    try {
      const res = await fetch(`${API_URL}/api/workflows/${activeWorkflow.id}/execute`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ triggerType: activeWorkflow.triggerType }),
      });

      if (res.ok) {
        const result = await res.json();
        // The API matches workflows but does NOT run their actions — there is no
        // action executor in this build. Reporting "executed cleanly" told operators
        // their automation was live when no message was sent and no record changed.
        setStatusNotice({
          type: result.executed ? 'success' : 'error',
          text: result.executed
            ? `Executed ${result.matchedCount ?? result.triggeredCount} workflow(s).`
            : `Matched ${result.matchedCount ?? result.triggeredCount ?? 0} workflow(s) — but actions were NOT run. `
              + `Workflow execution is not implemented in this build.`,
        });
      }
    } catch {
      setStatusNotice({ type: 'error', text: 'Error simulating workflow execution.' });
    }
  };

  return (
    <div className="space-y-6 max-w-7xl pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <GitFork className="w-6 h-6 text-blue-600 dark:text-blue-400" /> Visual Workflow Automation Engine
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Build visual decision graphs to automate AI responses, CRM lead routing, and human handoff triggers.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowNewModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-all text-sm shadow-lg shadow-blue-500/20"
          >
            <Plus className="w-4 h-4" /> New Automation Graph
          </button>
        </div>
      </div>

      {statusNotice && (
        <div className={`p-4 rounded-xl text-sm border flex items-center justify-between ${
          statusNotice.type === 'success'
            ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20 text-emerald-600 dark:text-emerald-400'
            : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-400'
        }`}>
          <span>{statusNotice.text}</span>
          <button onClick={() => setStatusNotice(null)}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Main Grid: Sidebar List + Canvas */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left column: Workflows list */}
        <div className="lg:col-span-1 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400">Workflows ({workflows.length})</h3>
          
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <div key={i} className="h-16 bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm rounded-xl animate-pulse" />)}
            </div>
          ) : workflows.length === 0 ? (
            <div className="p-6 rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 text-center text-xs text-slate-600 dark:text-slate-400">
              No workflows saved. Click "New Automation Graph" to build your first flow.
            </div>
          ) : (
            workflows.map((wf) => (
              <div
                key={wf.id}
                onClick={() => setActiveWorkflow(wf)}
                className={`p-4 rounded-2xl border transition-all cursor-pointer space-y-2 ${
                  activeWorkflow?.id === wf.id
                    ? 'bg-blue-50 dark:bg-blue-500/10 border-blue-500/40 text-white shadow-lg'
                    : 'bg-white dark:bg-slate-900/80 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:text-white hover:bg-slate-50 dark:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-sm text-slate-900 dark:text-white truncate">{wf.name}</span>
                  <span className={`w-2 h-2 rounded-full ${wf.isActive ? 'bg-emerald-400' : 'bg-gray-600'}`} />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{wf.description || 'Custom trigger graph'}</p>
                <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 pt-1">
                  <span className="font-mono">{wf.triggerType}</span>
                  <span>{wf.nodes?.length || 0} nodes</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Right column: Visual Graph Canvas */}
        <div className="lg:col-span-3">
          {activeWorkflow ? (
            <div className="rounded-2xl bg-slate-50 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 shadow-sm border border-slate-200 dark:border-slate-700 p-6 space-y-6 flex flex-col justify-between min-h-[520px] relative overflow-hidden">
              <div className="absolute inset-0 bg-[radial-gradient(#ffffff_1px,transparent_1px)] [background-size:16px_16px] opacity-5 pointer-events-none" />

              {/* Canvas Header Toolbar */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4 relative z-10">
                <div>
                  <div className="flex items-center gap-3">
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">{activeWorkflow.name}</h2>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                      activeWorkflow.isActive
                        ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20'
                        : 'bg-slate-100 dark:bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-500/20'
                    }`}>
                      {activeWorkflow.isActive ? 'ACTIVE' : 'PAUSED'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{activeWorkflow.description || 'No description provided'}</p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleToggleActive(activeWorkflow.id, activeWorkflow.isActive)}
                    className="px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:text-white font-medium"
                  >
                    {activeWorkflow.isActive ? 'Pause Workflow' : 'Activate Workflow'}
                  </button>
                  <button
                    onClick={handleTestExecute}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600/20 border border-emerald-200 dark:border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-600/30 text-xs font-semibold"
                  >
                    <Play className="w-3.5 h-3.5" /> Test Simulation
                  </button>
                  <button
                    onClick={handleSaveWorkflow}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-lg shadow-blue-500/20"
                  >
                    <Save className="w-3.5 h-3.5" /> Save Graph
                  </button>
                  <button
                    onClick={() => handleDeleteWorkflow(activeWorkflow.id)}
                    className="p-2 rounded-xl text-slate-500 dark:text-slate-400 hover:text-red-600 dark:text-red-400 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Node Visual Flowchart Canvas */}
              <div className="py-8 relative z-10 flex flex-col items-center justify-center space-y-6">
                {(activeWorkflow.nodes || []).map((node, index) => (
                  <React.Fragment key={node.id}>
                    {/* Node Card */}
                    <div className="w-full max-w-md p-5 rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-slate-200 dark:border-slate-700 shadow-xl hover:border-blue-500/40 transition-all group relative">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className={`w-3 h-3 rounded-full bg-gradient-to-r ${node.color || 'from-blue-500 to-indigo-600'}`} />
                          <span className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400">{node.type}</span>
                        </div>
                        <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400">Step #{index + 1}</span>
                      </div>
                      <h4 className="font-bold text-slate-900 dark:text-white text-base mb-1">{node.label}</h4>
                      <p className="text-xs text-slate-600 dark:text-slate-400">{node.detail}</p>
                    </div>

                    {/* Connector Arrow */}
                    {index < (activeWorkflow.nodes.length - 1) && (
                      <div className="flex flex-col items-center text-blue-600 dark:text-blue-400">
                        <div className="w-0.5 h-6 bg-gradient-to-b from-blue-500 to-purple-500" />
                        <ArrowRight className="w-4 h-4 rotate-90 my-1 text-purple-600 dark:text-purple-400 animate-bounce" />
                      </div>
                    )}
                  </React.Fragment>
                ))}

                {/* Add Step Node Button */}
                <button
                  onClick={() => setShowNodeModal(true)}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-dashed border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:text-white hover:border-blue-400 transition-all text-xs font-semibold mt-4"
                >
                  <Plus className="w-4 h-4" /> Add Action / Condition Step
                </button>
              </div>
            </div>
          ) : (
            <div className="p-12 rounded-2xl bg-slate-50 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 shadow-sm border border-slate-200 dark:border-slate-700 text-center flex flex-col items-center justify-center min-h-[400px]">
              <GitFork className="w-12 h-12 text-blue-600 dark:text-blue-400 mb-3" />
              <p className="text-slate-700 dark:text-slate-300 font-medium mb-1">Select or Create a Visual Automation Graph</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mb-4">
                Automate real-time triggers across WhatsApp, Telephony calls, and CRM lead pipelines.
              </p>
              <button
                onClick={() => setShowNewModal(true)}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow-lg shadow-blue-500/20"
              >
                Create Automation Flow
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Modal 1: Create New Workflow */}
      {showNewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 space-y-5 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <GitFork className="w-5 h-5 text-blue-600 dark:text-blue-400" /> New Visual Workflow
              </h2>
              <button onClick={() => setShowNewModal(false)} className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateWorkflow} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Workflow Name</label>
                <input
                  required
                  type="text"
                  value={wfName}
                  onChange={(e) => setWfName(e.target.value)}
                  placeholder="e.g. VIP Customer Lead Qualification"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Trigger Event</label>
                <select
                  value={wfTrigger}
                  onChange={(e) => setWfTrigger(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-sm border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                >
                  <option value="WHATSAPP_INBOUND">Incoming WhatsApp Message</option>
                  <option value="VOICE_CALL_INBOUND">Incoming Phone Call</option>
                  <option value="CONTACT_CREATED">New CRM Contact Created</option>
                  <option value="LEAD_CAPTURED">New Lead Captured</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Description (Optional)</label>
                <textarea
                  rows={2}
                  value={wfDescription}
                  onChange={(e) => setWfDescription(e.target.value)}
                  placeholder="Summarize what this automation graph handles..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewModal(false)}
                  className="px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300 font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold shadow-lg shadow-blue-500/20"
                >
                  Build Graph
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal 2: Add Node Step */}
      {showNodeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 space-y-5 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Plus className="w-5 h-5 text-blue-600 dark:text-blue-400" /> Add Step Node
              </h2>
              <button onClick={() => setShowNodeModal(false)} className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Node Type</label>
                <select
                  value={nodeType}
                  onChange={(e) => setNodeType(e.target.value as any)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-sm border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                >
                  <option value="ACTION">ACTION (Execute Task)</option>
                  <option value="CONDITION">CONDITION (Filter Branch)</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Step Title</label>
                <input
                  type="text"
                  value={nodeLabel}
                  onChange={(e) => setNodeLabel(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                />
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-400 font-medium mb-1">Step Specification Detail</label>
                <input
                  type="text"
                  value={nodeDetail}
                  onChange={(e) => setNodeDetail(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowNodeModal(false)}
                  className="px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300 font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleAddNode}
                  className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold shadow-lg shadow-blue-500/20"
                >
                  Add Node
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
