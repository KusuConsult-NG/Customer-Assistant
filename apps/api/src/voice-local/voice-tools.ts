import { agentToolCatalog, CALLER_VARIABLE, CONVERSATION_VARIABLE, TOOL_NAMES, type ToolName } from '../agent-tools/agent-tool-catalog';
import type { AgentToolsService, ToolResult } from '../agent-tools/agent-tools.service';

/**
 * The SAME tools the ElevenLabs agent calls, offered to the local model.
 *
 * Built from `agentToolCatalog` — the one source of every tool's name,
 * description and parameters — so the two engines cannot drift into telling
 * citizens different things. Parameters the catalog BINDS to the platform
 * (the caller's number, the conversation id) are removed from what the model
 * sees and filled in by the session, exactly as ElevenLabs fills them from
 * dynamic variables: a model-supplied phone number could cancel a stranger's
 * appointment.
 *
 * `handoff` is left out: it is disabled for live transfer and only ever told
 * the agent to use request-callback, which this model is offered directly.
 */
export const LOCAL_TOOLS: ToolName[] = TOOL_NAMES.filter((t) => t !== 'handoff');

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const END_CALL_TOOL: OpenAiTool = {
  type: 'function',
  function: {
    name: 'end_call',
    description:
      'Hang up. Call ONLY after the PHASE 10 farewell has been said and the caller confirmed they are done, or after two unanswered "are you still there?" checks.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

export function localToolDefinitions(): OpenAiTool[] {
  const catalog = agentToolCatalog({ baseUrl: 'http://local.invalid', authorization: 'local' });
  const defs = LOCAL_TOOLS.map((name) => {
    const cfg: any = (catalog[name] as any).toolConfig;
    const schema = cfg.apiSchema.requestBodySchema;
    const properties: Record<string, unknown> = {};
    const bound = new Set<string>();
    for (const [key, prop] of Object.entries<any>(schema.properties ?? {})) {
      if (prop?.dynamicVariable) {
        bound.add(key);
        continue;
      }
      properties[key] = { type: prop.type, ...(prop.description ? { description: prop.description } : {}) };
    }
    return {
      type: 'function' as const,
      function: {
        name,
        description: cfg.description,
        parameters: {
          type: 'object',
          properties,
          required: (schema.required ?? []).filter((r: string) => !bound.has(r)),
        },
      },
    };
  });
  return [...defs, END_CALL_TOOL];
}

/** Which catalog parameters are bound, and to what — read from the catalog, never restated. */
export function boundParameters(): Record<string, Record<string, string>> {
  const catalog = agentToolCatalog({ baseUrl: 'http://local.invalid', authorization: 'local' });
  const out: Record<string, Record<string, string>> = {};
  for (const name of LOCAL_TOOLS) {
    const props = (catalog[name] as any).toolConfig.apiSchema.requestBodySchema.properties ?? {};
    for (const [key, prop] of Object.entries<any>(props)) {
      if (prop?.dynamicVariable) (out[name] ??= {})[key] = prop.dynamicVariable;
    }
  }
  return out;
}

export interface CallIdentity {
  organizationId: string;
  /** The caller's number as the carrier gave it (E.164), or '' when withheld. */
  callerNumber: string;
  conversationId: string;
}

/**
 * Run one tool exactly as the HTTP controller would, with the bound
 * parameters supplied by the session. A thrown error becomes an honest failed
 * result for the model — never an exception that leaves the caller in silence.
 */
export async function runLocalTool(
  tools: AgentToolsService,
  name: string,
  rawArgs: Record<string, any>,
  who: CallIdentity,
): Promise<ToolResult | { ok: false; message: string }> {
  const bound = boundParameters()[name] ?? {};
  const args: Record<string, any> = { ...rawArgs };
  for (const [key, variable] of Object.entries(bound)) {
    if (variable === CALLER_VARIABLE) args[key] = who.callerNumber;
    if (variable === CONVERSATION_VARIABLE) args[key] = who.conversationId;
  }
  const org = who.organizationId;
  try {
    switch (name as ToolName) {
      case 'lookup-customer':
        return await tools.lookupCustomer(org, args.phoneNumber ?? '');
      case 'update-caller-profile':
        return await tools.updateCallerProfile(org, args as any);
      case 'check-booking':
        return await tools.checkBooking(org, args.phoneNumber ?? '');
      case 'check-availability':
        return await tools.checkAvailability(org, args);
      case 'book-appointment':
        return await tools.bookAppointment(org, args as any);
      case 'reschedule-booking':
        return await tools.rescheduleBooking(org, args.phoneNumber ?? '', args.newStartTime ?? '', args.reference);
      case 'cancel-booking':
        return await tools.cancelBooking(org, args.phoneNumber ?? '', args.reason, args.reference);
      case 'create-ticket':
        return await tools.createTicket(org, args as any);
      case 'request-callback':
        return await tools.requestCallback(org, args as any);
      case 'payment-details':
        return await tools.paymentDetails(org);
      case 'search-knowledge':
        return await tools.searchKnowledge(org, args.query ?? '');
      case 'register-enrollee':
        return await tools.registerEnrollee(org, args as any);
      default:
        return { ok: false, message: `There is no tool called ${name}. Do not call it again.` };
    }
  } catch (err: any) {
    return {
      ok: false,
      message:
        'That did not work just now, so nothing was saved. Tell the caller honestly and offer a desk-officer callback. ' +
        `(${String(err?.message ?? err).slice(0, 160)})`,
    };
  }
}
