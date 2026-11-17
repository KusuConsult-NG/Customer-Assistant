/**
 * Giving the Plateau assistant a different name on each call.
 *
 * The name a caller hears is in the agent's FIRST MESSAGE, which ElevenLabs
 * reads from the agent's configuration when the call connects. With the
 * conversation-start webhook off ("all circuits are busy" when on), the only
 * way to change it is to PATCH the live agent BETWEEN calls, so the name is
 * always staged for the NEXT caller.
 *
 * Callers kept hearing Nanpan, for three reasons this module and its callers
 * now close:
 *   1. Every Sync configuration wrote the DEFAULT persona's greeting — Nanpan —
 *      so the first call after every sync was Nanpan. Sync now stages a roster
 *      name too (`syncAgent`).
 *   2. The only trigger was the agent's turn-1 lookup. A call where the model
 *      skipped it left the next caller on the same name. The post-call webhook
 *      now rotates as well.
 *   3. Nobody could see whether a rotation happened. The outcome of the last
 *      one is kept here and shown on the Hosted Agent screen.
 */
import { prisma } from '@ace/database';
import {
  dynamicVariablesFor,
  isPlateauStateOrg,
  openingForUnknownCaller,
  pickPlateauMalePersona,
  renderWelcome,
} from './agent-tool-catalog';
import { ElevenLabsApi } from './elevenlabs-client';

export interface NameRotationRecord {
  at: string;
  /** What asked for it: the turn-1 lookup, the end of a call, or a sync. */
  trigger: string;
  outcome: 'rotated' | 'refused' | 'failed';
  /** The name staged for the next call, when it was staged. */
  name?: string;
  /** ElevenLabs' own words when it refused, or the error. */
  detail?: string;
}

/** Last outcome per organization, on this server. */
const lastRotation = new Map<string, NameRotationRecord>();

export function lastNameRotation(organizationId: string): NameRotationRecord | null {
  return lastRotation.get(organizationId) ?? null;
}

export function recordNameRotation(organizationId: string, record: NameRotationRecord): void {
  lastRotation.set(organizationId, record);
}

interface Logger {
  log(message: string): void;
  warn(message: string): void;
}

/**
 * Stage a new roster name on the live agent for the next call.
 *
 * Never throws: it runs beside a live call or a webhook that has already been
 * acknowledged, and a failed rotation must cost nothing but the rotation.
 */
export async function rotatePlateauAssistantName(
  organizationId: string,
  api: ElevenLabsApi,
  log: Logger,
  trigger: string
): Promise<void> {
  // Never from a test run: it would PATCH a real agent.
  if (process.env.NODE_ENV === 'test') return;
  const record = (r: Omit<NameRotationRecord, 'at' | 'trigger'>) =>
    recordNameRotation(organizationId, { at: new Date().toISOString(), trigger, ...r });
  try {
    const [org, config] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: organizationId },
        select: { name: true, slug: true, timezone: true, welcomeMessage: true, aiPersonaPrompt: true },
      }),
      prisma.hostedAgentConfig.findUnique({
        where: { organizationId },
        select: { agentId: true, apiKey: true },
      }),
    ]);
    if (!org || !config?.agentId || !isPlateauStateOrg(org)) return;
    // The AGENCY's workspace key, never ELEVENLABS_API_KEY: the agent lives in
    // the agency's own workspace and the shared key is refused there. keyFor
    // throws when there is no usable key; the catch below records it.
    const apiKey = api.keyFor(organizationId, config.apiKey);

    const next = pickPlateauMalePersona();
    const baseUrl = (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
    const res = await fetch(`${baseUrl}/v1/convai/agents/${config.agentId}`, {
      method: 'PATCH',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_config: {
          agent: {
            first_message: openingForUnknownCaller(renderWelcome(org, new Date(), next)),
            dynamic_variables: { dynamic_variable_placeholders: dynamicVariablesFor(org, next) },
          },
        },
        // Nothing under platform_settings: whether the conversation-start
        // webhook is on is decided in ONE place, syncAgent.
      }),
    });
    // Report what ElevenLabs did, not what was asked.
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      log.warn(`rotate_plateau_persona_refused org=${organizationId} trigger=${trigger} status=${res.status} ${detail}`);
      record({ outcome: 'refused', detail: `HTTP ${res.status} ${detail}`.trim() });
      return;
    }
    log.log(`rotated_plateau_persona org=${organizationId} trigger=${trigger} next_name=${next.name}`);
    record({ outcome: 'rotated', name: next.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`rotate_plateau_persona_failed org=${organizationId} trigger=${trigger} err=${message}`);
    record({ outcome: 'failed', detail: message });
  }
}
