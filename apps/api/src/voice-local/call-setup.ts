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
/**
 * The script with only what this kind of caller needs. Every reply sends the
 * whole script (about 10,000 tokens), so instructions for another kind of
 * caller are paid for on every turn: a new caller never needs the
 * returning-caller and correction rules, a returning caller never needs the
 * new-caller steps, and this line never places calls, so the rule for a call
 * WE made is never used. A caller whose status is not known keeps them all.
 * Still identical for every call of the same kind, so the provider's prompt
 * cache serves it.
 */
export function scriptForCaller(template: string, status: string | undefined): string {
  const drop = (text: string, start: string) => text.split('\n').filter((line) => !line.startsWith(start)).join('\n');
  let out = drop(template, '- WHEN WE CALLED THEM');
  if (status === 'new' || status === 'withheld') {
    out = drop(drop(out, '  - RETURNING CALLER'), '  - CORRECTIONS:');
  } else if (status === 'returning') {
    out = drop(out, '  - NEW OR UNPROFILED CALLER');
  }
  return out;
}

export function callSystemPrompt(org: AgentOrganization & { timezone?: string | null }, persona: TeamPersona, vars: CallVariables, now: Date): string {
  const template = scriptForCaller(agentPromptFor(org, persona), vars.sip_callerstatus);
  const used = [...new Set([...template.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]))];
  return (
    template +
    `\n\n## This call\n\nThe {{placeholders}} above stand for these values on this call. Always say the value; never say a placeholder or its braces aloud.\n` +
    used.map((k) => `- {{${k}}} = ${vars[k] ? JSON.stringify(vars[k]) : '(none)'}`).join('\n') +
    `\n\nIt is now ${now.toLocaleString('en-GB', { timeZone: org.timezone || 'Africa/Lagos', dateStyle: 'full', timeStyle: 'short' })} at the agency.` +
    ` Caller status: ${vars.sip_callerstatus || 'unknown'}.` +
    `\nYou are speaking on a telephone line. Sound like a warm, natural Nigerian colleague in a free-flowing conversation — NEVER like a robot or newsreader. Keep each turn short: usually one or two sentences and ONE question, then stop and let the caller answer. Longer turns only for the script's read-backs (a name, a location, the PHASE 6 summary), a reference number, and details the caller asked for (three items at a time, then ask whether to continue). Never use lists, headings, or symbols.` +
    `\nNEVER say filler phrases like "let me check", "wait a second", "one moment", or "hold on" — this overrides any such expression suggested by the agency's text above. Call any tool silently and answer directly. Never repeat "How may I assist you today?" or repeat a location confirmation question you already asked.` +
    `\nEvery character you write is read aloud. Never write stage directions or notes such as "[Ending the call now.]"; to end the call, say goodbye and call end_call.` +
    `\nWhen you save a detail with update-caller-profile, write your spoken reply (your thanks and your next question) in the SAME response as the save, never a save on its own: the caller then hears you at once.` +
    `\nSave each detail the caller confirms with update-caller-profile straight away, in the same reply in which they confirm it. Never say you have updated, saved, registered or noted something unless the tool that does it was called in that reply and succeeded.` +
    `\nWhen a caller clearly names their Local Government Area, call update-caller-profile with that lga in the SAME reply in which you ask for their ward and community — do not wait to save it together with them. If you are not sure which LGA they said, read it back first.` +
    `\nWhen the caller has just answered your question, you may open your reply with one of the script's own short acknowledgements, word for word: "Okay, thank you.", "Thank you for that information." or "Thank you for confirming that." (the voice has these ready, so the caller hears you at once), then go on in the same reply. Vary them and never use the same one twice in a row. When the caller has asked you something, is upset, or is reporting an emergency, answer them directly instead.` +
    `\nNever ask a question the caller has already answered in this call (if they said "for two weeks", do not ask when it started); skip that question and ask the next one.` +
    `\nWhenever you read a caller's location back to them, say ALL of it: community, ward and LGA ("So you are in Rantya, Gyel B ward, Jos South. Is that correct?"), using the value on file for any part they did not just give. Never read back only the part that changed.` +
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
