/**
 * Workflow graph schema.
 *
 * The previous shape was purely presentational:
 *
 *   { id, type: 'ACTION', label: 'Send AI Automated Response',
 *     detail: 'RAG Knowledge Lookup…', color: 'from-purple-500 to-pink-600' }
 *
 * There is nothing there to execute. `label` is a display string, not an
 * instruction — no action identifier, no recipient, no message body. That is the
 * root reason the engine "matched workflows and ran nothing": the stored graph
 * never contained enough information to do anything with.
 *
 * Nodes now carry a machine-readable `action` and a typed `config`. Legacy nodes are
 * still parsed (see normalizeNode) so existing workflows load, but a node we cannot
 * resolve to a real action is marked UNCONFIGURED and the run reports it as such
 * rather than guessing at intent.
 */

export type TriggerEvent =
  | 'MESSAGE_RECEIVED'
  | 'LEAD_CREATED'
  | 'TICKET_CREATED'
  | 'BOOKING_CONFIRMED'
  | 'DEAL_STAGE_CHANGED'
  | 'CALL_ENDED'
  | 'CONTACT_CREATED';

/** Legacy trigger names kept working. */
export const TRIGGER_ALIASES: Record<string, TriggerEvent> = {
  WHATSAPP_INBOUND: 'MESSAGE_RECEIVED',
  VOICE_INBOUND: 'CALL_ENDED',
  MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
  LEAD_CREATED: 'LEAD_CREATED',
  TICKET_CREATED: 'TICKET_CREATED',
  BOOKING_CONFIRMED: 'BOOKING_CONFIRMED',
  DEAL_STAGE_CHANGED: 'DEAL_STAGE_CHANGED',
  CALL_ENDED: 'CALL_ENDED',
  CONTACT_CREATED: 'CONTACT_CREATED',
};

export function normalizeTrigger(raw: string | undefined): TriggerEvent | null {
  if (!raw) return null;
  return TRIGGER_ALIASES[raw.toUpperCase()] ?? null;
}

export type ActionType =
  | 'SEND_WHATSAPP'
  | 'CREATE_TICKET'
  | 'UPDATE_LEAD_STATUS'
  | 'UPDATE_DEAL_STAGE'
  | 'TAG_CONTACT'
  | 'SET_HANDOFF'
  | 'REQUEST_SELFIE'
  | 'HTTP_WEBHOOK';

export const ACTION_TYPES: ActionType[] = [
  'SEND_WHATSAPP',
  'CREATE_TICKET',
  'UPDATE_LEAD_STATUS',
  'UPDATE_DEAL_STAGE',
  'TAG_CONTACT',
  'SET_HANDOFF',
  'REQUEST_SELFIE',
  'HTTP_WEBHOOK',
];

export type ConditionOperator =
  | 'EQUALS'
  | 'NOT_EQUALS'
  | 'CONTAINS'
  | 'NOT_CONTAINS'
  | 'GREATER_THAN'
  | 'LESS_THAN'
  | 'IS_SET'
  | 'IS_EMPTY';

export type NodeKind = 'TRIGGER' | 'CONDITION' | 'ACTION' | 'DELAY' | 'UNCONFIGURED';

export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  /** Human label, purely for the canvas. */
  label?: string;
  detail?: string;
  color?: string;

  // ACTION
  action?: ActionType;
  config?: Record<string, any>;

  // CONDITION
  field?: string;
  operator?: ConditionOperator;
  value?: any;

  // DELAY
  delaySeconds?: number;

  /** Set when a legacy node could not be resolved to a real action. */
  unconfiguredReason?: string;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** For CONDITION nodes: which outcome this edge follows. Absent means "always". */
  branch?: 'true' | 'false';
}

/**
 * Maps a legacy free-text node onto a real action where the intent is unambiguous.
 *
 * Deliberately conservative. A label like "Send AI Automated Response" describes a
 * behaviour the workflow engine does not own (the orchestrator already replies to
 * inbound messages), so it is NOT silently turned into a SEND_WHATSAPP with invented
 * content. Guessing here would recreate exactly the class of defect this codebase was
 * just cleaned of: doing something plausible and reporting success.
 */
function inferLegacyAction(label: string): { action: ActionType; config: Record<string, any> } | null {
  const l = label.toLowerCase();

  if (/\bcreate\b.*\b(task|ticket)\b|\bopen\b.*\bticket\b|follow[- ]?up/.test(l)) {
    return { action: 'CREATE_TICKET', config: { subject: label, description: 'Created by workflow automation.', priority: 'MEDIUM' } };
  }
  if (/\bhand(ing)?[- ]?off\b|\bescalate\b|\bhuman agent\b|\btakeover\b/.test(l)) {
    return { action: 'SET_HANDOFF', config: { handoff: true } };
  }
  if (/\bselfie\b|\bphoto of (yourself|themselves)\b|\bid photo\b/.test(l)) {
    return { action: 'REQUEST_SELFIE', config: {} };
  }
  if (/\btag\b/.test(l)) {
    return { action: 'TAG_CONTACT', config: { tags: [] } };
  }
  if (/\bwebhook\b|\bpost to\b|\bnotify .*\b(url|endpoint)\b/.test(l)) {
    return { action: 'HTTP_WEBHOOK', config: {} };
  }
  return null;
}

/**
 * Accepts both the v2 node shape and the legacy presentational one, and returns a
 * node that is either executable or explicitly marked UNCONFIGURED.
 */
export function normalizeNode(raw: any): WorkflowNode {
  const id = String(raw?.id ?? '');
  const label = raw?.label ? String(raw.label) : undefined;
  const base = { id, label, detail: raw?.detail, color: raw?.color };

  // v2: an explicit kind we understand.
  const kind = String(raw?.kind ?? raw?.type ?? '').toUpperCase();

  if (kind === 'TRIGGER') return { ...base, kind: 'TRIGGER' };

  if (kind === 'DELAY') {
    const seconds = Number(raw?.delaySeconds ?? raw?.config?.seconds);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return { ...base, kind: 'UNCONFIGURED', unconfiguredReason: 'DELAY node has no valid delaySeconds.' };
    }
    return { ...base, kind: 'DELAY', delaySeconds: Math.min(seconds, MAX_DELAY_SECONDS) };
  }

  if (kind === 'CONDITION') {
    const field = raw?.field ? String(raw.field) : undefined;
    const operator = raw?.operator as ConditionOperator | undefined;
    if (!field || !operator) {
      return {
        ...base,
        kind: 'UNCONFIGURED',
        unconfiguredReason:
          'CONDITION node has no field/operator. Legacy conditions stored only a text label, ' +
          'which cannot be evaluated — re-create it in the editor.',
      };
    }
    return { ...base, kind: 'CONDITION', field, operator, value: raw?.value };
  }

  if (kind === 'ACTION' || raw?.action) {
    const explicit = raw?.action ? String(raw.action).toUpperCase() : null;
    if (explicit && (ACTION_TYPES as string[]).includes(explicit)) {
      return { ...base, kind: 'ACTION', action: explicit as ActionType, config: raw?.config ?? {} };
    }
    const inferred = label ? inferLegacyAction(label) : null;
    if (inferred) {
      return { ...base, kind: 'ACTION', action: inferred.action, config: { ...inferred.config, ...(raw?.config ?? {}) } };
    }
    return {
      ...base,
      kind: 'UNCONFIGURED',
      unconfiguredReason: label
        ? `"${label}" is a description, not an action. Choose an action type in the editor.`
        : 'ACTION node has no action type.',
    };
  }

  return { ...base, kind: 'UNCONFIGURED', unconfiguredReason: `Unrecognised node kind "${kind || 'none'}".` };
}

/** Upper bound on a DELAY node, so a typo cannot park a run for a decade. */
export const MAX_DELAY_SECONDS = 7 * 24 * 60 * 60; // 7 days

/** Hard cap on nodes visited per run — a cheap cycle/runaway guard. */
export const MAX_STEPS_PER_RUN = 50;

export function normalizeEdges(raw: any): WorkflowEdge[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => ({
      from: String(e?.from ?? e?.source ?? ''),
      to: String(e?.to ?? e?.target ?? ''),
      branch: e?.branch === 'true' || e?.branch === 'false' ? e.branch : undefined,
    }))
    .filter((e) => e.from && e.to);
}

/**
 * Resolves `{{ dotted.path }}` templates against the trigger payload so action
 * configuration can reference the event that fired it — e.g. a ticket subject of
 * "Follow up with {{ contact.fullName }}".
 *
 * Unknown paths resolve to an empty string rather than the literal template, so a
 * customer never receives a message containing raw `{{ }}` markup.
 */
export function interpolate<T>(value: T, context: Record<string, any>): T {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
      const resolved = path.split('.').reduce<any>((acc, k) => (acc == null ? undefined : acc[k]), context);
      return resolved == null ? '' : String(resolved);
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, context)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, any>)) out[k] = interpolate(v, context);
    return out as unknown as T;
  }
  return value;
}

export function readPath(obj: any, path: string): any {
  return path.split('.').reduce<any>((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

export function evaluateCondition(node: WorkflowNode, payload: Record<string, any>): boolean {
  const actual = readPath(payload, node.field!);
  const expected = node.value;

  switch (node.operator) {
    case 'EQUALS':        return String(actual) === String(expected);
    case 'NOT_EQUALS':    return String(actual) !== String(expected);
    case 'CONTAINS':      return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'NOT_CONTAINS':  return !String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'GREATER_THAN':  return Number(actual) > Number(expected);
    case 'LESS_THAN':     return Number(actual) < Number(expected);
    case 'IS_SET':        return actual !== undefined && actual !== null && actual !== '';
    case 'IS_EMPTY':      return actual === undefined || actual === null || actual === '';
    default:              return false;
  }
}

/**
 * Static validation used by both the save path and the executor, so a workflow that
 * cannot run is rejected at save time rather than failing silently at 3am.
 */
export function validateGraph(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
  const problems: string[] = [];
  const ids = new Set(nodes.map((n) => n.id));

  if (!nodes.some((n) => n.kind === 'TRIGGER')) {
    problems.push('The workflow has no TRIGGER node, so nothing can start it.');
  }
  for (const n of nodes) {
    if (n.kind === 'UNCONFIGURED') {
      problems.push(`Node "${n.label ?? n.id}" is not configured: ${n.unconfiguredReason}`);
    }
  }
  for (const e of edges) {
    if (!ids.has(e.from)) problems.push(`Edge references unknown node "${e.from}".`);
    if (!ids.has(e.to)) problems.push(`Edge references unknown node "${e.to}".`);
  }
  const reachable = new Set<string>();
  const walk = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    edges.filter((e) => e.from === id).forEach((e) => walk(e.to));
  };
  nodes.filter((n) => n.kind === 'TRIGGER').forEach((n) => walk(n.id));
  for (const n of nodes) {
    if (n.kind !== 'TRIGGER' && !reachable.has(n.id)) {
      problems.push(`Node "${n.label ?? n.id}" is not connected to the trigger and will never run.`);
    }
  }
  return problems;
}
