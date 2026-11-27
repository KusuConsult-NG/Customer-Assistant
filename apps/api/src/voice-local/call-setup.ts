import {
  agentPromptFor,
  firstMessageFor,
  openingForUnknownCaller,
  renderWelcome,
  type AgentOrganization,
  type TeamPersona,
} from '../agent-tools/agent-tool-catalog';

/**
 * What a call on the local line tells the model, and what it says first.
 *
 * ONE definition, used by the live call (LocalVoiceService.begin) and by the
 * conversation check (conversation-check.ts) that tests the real model on the
 * server — so what is checked is exactly what a caller gets.
 */

export type CallVariables = Record<string, string | undefined>;

/** `{{name}}` → the call's value. */
export function fillVariables(text: string, vars: CallVariables): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, k) => vars[k] ?? '');
}

/**
 * The script is sent UNFILLED — identical for every call of the agency — and
 * this call's values follow it. Filled in place, it differed from the 9th
 * character on, so the model re-read all ~12,000 tokens (script and tools)
 * from scratch on every call's first reply. With a shared beginning, the
 * provider's prompt cache serves it.
 */
export function callSystemPrompt(org: AgentOrganization & { timezone?: string | null }, persona: TeamPersona, vars: CallVariables, now: Date): string {
  const template = agentPromptFor(org, persona);
  const used = [...new Set([...template.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]))];
  return (
    template +
    `\n\n## This call\n\nThe {{placeholders}} above stand for these values on this call. Always say the value; never say a placeholder or its braces aloud.\n` +
    used.map((k) => `- {{${k}}} = ${vars[k] ? JSON.stringify(vars[k]) : '(none)'}`).join('\n') +
    `\n\nIt is now ${now.toLocaleString('en-GB', { timeZone: org.timezone || 'Africa/Lagos', dateStyle: 'full', timeStyle: 'short' })} at the agency.` +
    ` Caller status: ${vars.sip_callerstatus || 'unknown'}.` +
    `\nYou are speaking on a telephone line. Speak in short spoken sentences; never use lists, headings or symbols.` +
    `\nEvery character you write is read aloud. Never write stage directions or notes such as "[Ending the call now.]"; to end the call, say goodbye and call end_call.` +
    `\nSave each detail the caller confirms with update-caller-profile straight away, in the same reply in which they confirm it. Never say you have updated, saved, registered or noted something unless the tool that does it was called in that reply and succeeded.` +
    `\nFor any question about Plateau State projects, water, roads, health, education, MDAs, leadership or services, you MUST call search-knowledge first before answering. Never guess or answer from memory; if search-knowledge has no verified match, say plainly you do not have that information and offer to book a callback (request-callback) from a desk officer.` +
    `\nPhone audio can mishear Nigerian names or places (for example hearing "Plateau State" as "Black Estate"). If a phrase sounds garbled or unfamiliar to Plateau State, NEVER repeat it back as fact — politely ask the caller to repeat what they said.`
  );
}

/**
 * The opening, at THIS moment's clock (firstMessageFor has no clock and says
 * "Hello" for {greeting}, and no pre-rendered "Good morning/afternoon/evening"
 * clip ever matched). An agency opening with a Governor part keeps it for
 * every caller; otherwise the conversation-start override, else the default.
 */
export function callOpening(org: AgentOrganization, persona: TeamPersona, vars: CallVariables, now: Date, override?: string): string {
  const hasGovernorIntro = /<governor>/i.test(org.welcomeMessage ?? '');
  return fillVariables(
    hasGovernorIntro ? openingForUnknownCaller(renderWelcome(org, now, persona)) : (override ?? firstMessageFor(org, persona)),
    vars,
  );
}
