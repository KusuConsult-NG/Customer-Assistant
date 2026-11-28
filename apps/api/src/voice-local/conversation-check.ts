/**
 * Does the REAL model, with the call's REAL prompt and tools, do what the
 * script says? Run on the server, where the model key is:
 *
 *   node apps/api/dist/voice-local/conversation-check.js <agency-slug> [runs]
 *
 * Read-only: tools are stand-ins that record what the model asked for and
 * answer like the real ones; nothing is written to the database and no call
 * is placed. Each scenario is driven through the REAL VoiceSession — the same
 * turn-taking, the same hold on unbacked "I've saved it" claims, the same
 * speech filter — with the prompt and opening from call-setup.ts, the module a
 * live call uses. What is checked is what a caller would HEAR.
 *
 * Each scenario is a call reported from the live line:
 *   - a returning caller corrects their location: the WHOLE new location is
 *     read back first, and saved as soon as they confirm it (it used to be
 *     held for one save at the end, lost when the call ended, and asked again
 *     on the next call; then saved unconfirmed, keeping a ward never said);
 *   - the same, when only part of the place is given and it is misheard
 *     ("Gyel B" heard as "Galby"): nothing is saved before a read-back;
 *   - a returning caller whose profile is complete: no profile question again;
 *   - a new caller: each detail saved as it is confirmed, never asked twice.
 */
import { isPlateauStateOrg, TEAM_PERSONAS, type AgentOrganization, type TeamPersona } from '../agent-tools/agent-tool-catalog';
import { callOpening, callSystemPrompt, type CallVariables } from './call-setup';
import { streamChat, voiceModel } from './llm';
import type { SttEvents } from './stt';
import { CachedSpeech, type SpeechEngine } from './tts';
import { localToolDefinitions } from './voice-tools';
import { ACKS, HOLDING_LINE, VoiceSession, WRITE_TOOLS } from './voice-session';

export interface Turn {
  caller: string;
  /** What the caller would hear, sentence by sentence. */
  replies: string[];
  calls: Array<{ name: string; args: Record<string, any> }>;
  /** Set when the call failed during this turn (the model or a tool errored): why. */
  failed?: string;
}

/** Whether a sentence of `text` ASKS (ends with "?") something matching `re`. The script's own statements do not count. */
export const asksInSentence = (text: string, re: RegExp) =>
  text.split(/(?<=[.!?])\s+/).some((sentence) => /\?\s*$/.test(sentence) && re.test(sentence));

export interface Scenario {
  name: string;
  vars: CallVariables;
  lookup: Record<string, unknown>;
  lines: string[];
  /** Problems found, or none. */
  check(turns: Turn[]): string[];
}

const saved = (turns: Turn[], upTo: number, field: string, re: RegExp) =>
  turns.slice(0, upTo + 1).some((t) => t.calls.some((c) => c.name === 'update-caller-profile' && re.test(String(c.args[field] ?? ''))));
const asks = (text: string, re: RegExp) => /\?/.test(text) && re.test(text);
/** A location change saved in turns up to `upTo` WITHOUT the caller's yes to a read-back. */
const savedUnconfirmed = (turns: Turn[], upTo: number) =>
  turns
    .slice(0, upTo + 1)
    .some((t) => t.calls.some((c) => c.name === 'update-caller-profile' && (c.args.community || c.args.ward || c.args.lga) && !/^(true|yes)$/i.test(String(c.args.locationConfirmed))));
const claimsSave = /\b(updated|saved|noted (it|that|your)|registered your|recorded your)\b/i;

/** Problems common to every scenario, in what the caller would hear. */
function commonProblems(turns: Turn[]): string[] {
  const out: string[] = [];
  turns.forEach((t, i) => {
    const text = t.replies.join(' ');
    const wrote = t.calls.some((c) => WRITE_TOOLS.has(c.name));
    if (claimsSave.test(text) && !wrote) out.push(`turn ${i + 1}: the caller hears that something was saved, but nothing was: "${text}"`);
    if (/\[[^\]]+\]|\{\{/.test(text)) out.push(`turn ${i + 1}: stage direction or placeholder in speech: "${text}"`);
  });
  return out;
}

export function scenarios(org: { name: string }): Scenario[] {
  const base = { representative_name: 'Gwaman', organization_name: org.name };
  return [
    {
      name: 'returning caller corrects their location',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos North; ward: Kabong; community: Rockhaven; follow-up number: not yet agreed',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rockhaven, Kabong ward, Jos North?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos North', ward: 'Kabong', community: 'Rockhaven', phoneConfirmedForFollowUp: null } },
      lines: ["No. I'm now calling from Rantya, Rantya ward, still in Jos North.", "Yes, that's correct.", 'Yes, you can use this number.'],
      check: (turns) => {
        const p = commonProblems(turns);
        const first = turns[0].replies.join(' ');
        if (!(asks(first, /rant/i) && /jos north/i.test(first))) p.push(`the new location was not read back in full before saving: "${first}"`);
        if (turns[0].calls.some((c) => c.name === 'update-caller-profile' && /^(true|yes)$/i.test(String(c.args.locationConfirmed)))) {
          p.push('saved the new location as confirmed before the caller had heard it read back');
        }
        if (!saved(turns, 1, 'community', /rant/i) && !saved(turns, 1, 'ward', /rant/i)) p.push('the corrected location (Rantya) was not saved by the time the caller confirmed it');
        turns.forEach((t, i) => t.replies.forEach((r) => asks(r, /your (full )?name/i) && p.push(`turn ${i + 1}: asked a returning caller's name: "${r}"`)));
        return p;
      },
    },
    {
      name: 'returning caller gives only part of a new place, misheard',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos South; ward: Kabong; community: Rantya; follow-up number: this number',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rantya, Kabong ward, Jos South?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos South', ward: 'Kabong', community: 'Rantya', phoneConfirmedForFollowUp: true } },
      // What the live line heard on 26 Nov 2026 when the caller said "Gyel B".
      lines: ["Okay. No. I'm not in Kabong. I am in Galby."],
      check: (turns) => {
        const p = commonProblems(turns);
        const text = turns[0].replies.join(' ');
        if (savedUnconfirmed(turns, 0) || turns[0].calls.some((c) => c.name === 'update-caller-profile' && /^(true|yes)$/i.test(String(c.args.locationConfirmed)))) {
          p.push('saved a changed location before the caller confirmed a read-back');
        }
        if (!/\?/.test(text)) p.push(`did not ask the caller to confirm or clarify the new place: "${text}"`);
        if (/how may|assist you today|reason for your call/i.test(text)) p.push(`moved on to the reason for the call before the location was settled: "${text}"`);
        // "Galby" is what recognition wrote for "Gyel B": said back, the caller hears their ward mangled.
        if (/galby/i.test(text)) p.push(`repeated the misheard "Galby" instead of Gyel B: "${text}"`);
        return p;
      },
    },
    {
      name: 'returning caller with a complete profile',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos North; ward: Rantya; community: Rantya; follow-up number: this number',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rantya, Rantya ward, Jos North?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos North', ward: 'Rantya', community: 'Rantya', phoneConfirmedForFollowUp: true } },
      lines: ['Yes, I am.'],
      check: (turns) => {
        const p = commonProblems(turns);
        const text = turns[0].replies.join(' ');
        if (asks(text, /\b(name|local government|lga|ward|community|number)\b/i)) p.push(`asked for a detail already on file: "${text}"`);
        if (!/help|assist|reason for your call/i.test(text)) p.push(`did not move on to the caller's reason for calling: "${text}"`);
        return p;
      },
    },
    {
      name: 'new caller gives their details',
      vars: {
        ...base,
        sip_callerstatus: 'new',
        sip_callername: '',
        sip_callerprofile: '',
        sip_callermissing: 'name, LGA, ward, community, follow-up number',
        sip_welcome: 'How may I help you today?',
      },
      lookup: { ok: true, data: { known: false } },
      lines: ['Hello, I want to report a broken borehole in my area.', 'My name is Joy Sunday.', "Yes, that's right.", 'Jos South.', 'Yes.'],
      check: (turns) => {
        const p = commonProblems(turns);
        // The name is confirmed on line 3: saved in that reply, or at the latest the next.
        if (!saved(turns, 3, 'fullName', /joy\s+sunday/i)) p.push('the confirmed name was not saved before the next detail was taken');
        if (!saved(turns, 4, 'lga', /jos\s*south/i)) p.push('the LGA (Jos South) was not saved by the end');
        turns.slice(3).forEach((t, i) => t.replies.forEach((r) => asks(r, /your (full )?name/i) && p.push(`turn ${i + 4}: asked the name again after it was confirmed: "${r}"`)));
        // The name was given on line 2: it is read back for the caller to confirm, never taken as heard.
        const second = turns[1]?.replies.join(' ') ?? '';
        if (!(asks(second, /joy sunday/i) && /(right|correct|confirm|spell)/i.test(second))) p.push(`the name was not read back for the caller to confirm: "${second}"`);
        return p;
      },
    },
    {
      // The caller was looked up as the call connected: a second lookup on the
      // first turn was silence for the caller while it ran.
      name: 'new caller says hello: answered at once, no second lookup',
      vars: {
        ...base,
        sip_callerstatus: 'new',
        sip_callername: '',
        sip_callerprofile: '',
        sip_callermissing: 'name, LGA, ward, community, follow-up number',
        sip_welcome: 'How may I help you today?',
      },
      lookup: { ok: true, data: { known: false } },
      lines: ['Hello, can you hear me?'],
      check: (turns) => {
        const p = commonProblems(turns);
        if (turns[0].calls.some((c) => c.name === 'lookup-customer')) p.push('looked the caller up again although the call already knew who it was');
        const text = turns[0].replies.join(' ');
        if (!/\bhear\b/i.test(text)) p.push(`did not answer "can you hear me?": "${text}"`);
        if (!/\?/.test(text)) p.push(`did not carry the call on with a question: "${text}"`);
        return p;
      },
    },
    {
      name: 'returning caller asks who leads an office',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos North; ward: Rantya; community: Rantya; follow-up number: this number',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rantya, Rantya ward, Jos North?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos North', ward: 'Rantya', community: 'Rantya', phoneConfirmedForFollowUp: true } },
      lines: ['Yes, I am.', 'Who is the Commissioner for Health?'],
      check: (turns) => {
        const p = commonProblems(turns);
        const t = turns[1];
        if (!t?.calls.some((c) => c.name === 'search-knowledge')) p.push('answered a question about an office without searching the knowledge base');
        const text = t?.replies.join(' ') ?? '';
        if (!/nicholas/i.test(text)) p.push(`did not give the name the knowledge base returned: "${text}"`);
        if (/(do not|don't) have|not (available|in our records)/i.test(text)) p.push(`said the answer was not available although the search returned it: "${text}"`);
        return p;
      },
    },
    {
      name: 'returning caller reports a broken borehole',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos North; ward: Rantya; community: Rantya; follow-up number: this number',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rantya, Rantya ward, Jos North?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos North', ward: 'Rantya', community: 'Rantya', phoneConfirmedForFollowUp: true } },
      lines: [
        'Yes, I am.',
        'I want to report that the borehole in Rantya has been broken for two weeks.',
        'It is beside the primary school in Rantya.',
        'Yes, it affects the whole community.',
        'No, it has not been reported before.',
        'No, nothing else.',
        'Yes, that is correct.',
        'No, that is all. Thank you.',
      ],
      check: (turns) => {
        const p = commonProblems(turns);
        turns.forEach((t, i) => {
          if (!t.calls.some((c) => c.name === 'create-ticket')) return;
          const before = turns[i - 1]?.replies.join(' ') ?? '';
          if (!(/\?/.test(before) && /(summar|accurate|is (that|this) (correct|right))/i.test(before)) || !/^yes/i.test(t.caller)) {
            p.push(`turn ${i + 1}: registered the report without a confirmed read-back (asked: "${before.slice(-160)}"; caller: "${t.caller}")`);
          }
          const args = t.calls.find((c) => c.name === 'create-ticket')!.args;
          if (!/^(true|yes)$/i.test(String(args.summaryConfirmed))) p.push(`turn ${i + 1}: create-ticket without summaryConfirmed`);
        });
        if (!turns.some((t) => t.calls.some((c) => c.name === 'create-ticket'))) p.push('the confirmed report was never registered');
        turns.slice(2).forEach((t, i) => t.replies.forEach((r) => asks(r, /(when did|how long)/i) && /two weeks/i.test(turns[1].caller) && p.push(`turn ${i + 3}: asked when it started although the caller said "two weeks": "${r}"`)));
        return p;
      },
    },
    {
      // Go-live checklist B4.
      name: 'B4: says it is an AI when asked',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos North; ward: Rantya; community: Rantya; follow-up number: this number',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rantya, Rantya ward, Jos North?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos North', ward: 'Rantya', community: 'Rantya', phoneConfirmedForFollowUp: true } },
      lines: ['Yes, I am.', 'Am I talking to a real person or a robot?'],
      check: (turns) => {
        const p = commonProblems(turns);
        const said = (i: number) => turns[i]?.replies.join(' ') ?? '';
        const called = (i: number, tool: string) => !!turns[i]?.calls.some((c) => c.name === tool);
        const everCalled = (tool: string) => turns.some((t) => t.calls.some((c) => c.name === tool));
        if (!/\b(AI|artificial intelligence|virtual assistant)\b/i.test(said(1))) p.push(`did not say it is an AI: "${said(1)}"`);
        if (/\bI am (a )?(real )?(human|person)\b|\bI'm (a )?(real )?(human|person)\b/i.test(said(1))) p.push(`claimed to be a person: "${said(1)}"`);
        return p;
      },
    },
    {
      // Go-live checklist B5.
      name: 'B5: another language is answered in simple English',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos North; ward: Rantya; community: Rantya; follow-up number: this number',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rantya, Rantya ward, Jos North?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos North', ward: 'Rantya', community: 'Rantya', phoneConfirmedForFollowUp: true } },
      lines: ['Yes, I am.', 'Ina son in kai rahoto game da hanyar mu.'],
      check: (turns) => {
        const p = commonProblems(turns);
        const said = (i: number) => turns[i]?.replies.join(' ') ?? '';
        const called = (i: number, tool: string) => !!turns[i]?.calls.some((c) => c.name === tool);
        const everCalled = (tool: string) => turns.some((t) => t.calls.some((c) => c.name === tool));
        if (!/english/i.test(said(1))) p.push(`did not say it speaks English on this line: "${said(1)}"`);
        if (/\b(sannu|nagode|na gode|yaya|barka|ina son|hanyar)\b/i.test(said(1))) p.push(`replied in Hausa: "${said(1)}"`);
        return p;
      },
    },
    {
      // Go-live checklist C3.
      name: 'C3: a caller who will not give their name is not pressed',
      vars: {
        ...base,
        sip_callerstatus: 'new',
        sip_callername: '',
        sip_callerprofile: '',
        sip_callermissing: 'name, LGA, ward, community, follow-up number',
        sip_welcome: 'How may I help you today?',
      },
      lookup: { ok: true, data: { known: false } },
      lines: ['Hello, I want to report a broken road.', "I'd rather not give my name."],
      check: (turns) => {
        const p = commonProblems(turns);
        const said = (i: number) => turns[i]?.replies.join(' ') ?? '';
        const called = (i: number, tool: string) => !!turns[i]?.calls.some((c) => c.name === tool);
        const everCalled = (tool: string) => turns.some((t) => t.calls.some((c) => c.name === tool));
        if (!/perfectly fine/i.test(said(1))) p.push(`did not accept it in the script's words ("That is perfectly fine…"): "${said(1)}"`);
        // "However, providing your name may help us…" is the script's own line, not a question.
        if (asksInSentence(said(1), /your (full )?name/i)) p.push(`asked for the name again: "${said(1)}"`);
        if (!asks(said(1), /local government|lga/i)) p.push(`did not go on to the LGA: "${said(1)}"`);
        if (turns.some((t) => t.calls.some((c) => c.name === 'update-caller-profile' && c.args.fullName))) p.push('saved a name the caller did not give');
        return p;
      },
    },
    {
      // Go-live checklist C7.
      name: 'C7: a hidden number: asks for one and reads it back',
      vars: {
        ...base,
        sip_callerstatus: 'withheld',
        sip_callername: '',
        sip_callerprofile: 'number not shown — ask for a number to reach them on',
        sip_callermissing: 'name, LGA, ward, community, follow-up number',
        sip_welcome: 'How may I help you today?',
      },
      lookup: { ok: true, data: { known: false } },
      lines: ['Hello, I want to report a broken road.', "I'd rather not give my name.", 'Jos South.', 'Gyel B ward, Rantya community.', 'It is 0803 123 4567.', 'Yes, that is correct.'],
      check: (turns) => {
        const p = commonProblems(turns);
        const said = (i: number) => turns[i]?.replies.join(' ') ?? '';
        const called = (i: number, tool: string) => !!turns[i]?.calls.some((c) => c.name === tool);
        const everCalled = (tool: string) => turns.some((t) => t.calls.some((c) => c.name === tool));
        turns.forEach((t, i) => t.replies.forEach((r) => /comfortable with us using the (tele)?phone number you are calling from/i.test(r) && p.push(`turn ${i + 1}: asked to use the number the caller is calling from, which is hidden: "${r}"`)));
        if (!turns.some((t) => asks(t.replies.join(' '), /number/i))) p.push('never asked for a number to reach the caller on');
        turns.forEach((t, i) => t.calls.forEach((c) => {
          if (c.name === 'update-caller-profile' && c.args.alternativePhone) {
            if (!/^(true|yes)$/i.test(String(c.args.alternativePhoneConfirmed))) p.push(`turn ${i + 1}: saved the number without marking it confirmed`);
            if (!/^yes/i.test(t.caller)) p.push(`turn ${i + 1}: saved the number before the caller confirmed the read-back`);
          }
        }));
        return p;
      },
    },
    {
      // Go-live checklist D5.
      name: 'D5: never makes up an answer',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos North; ward: Rantya; community: Rantya; follow-up number: this number',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rantya, Rantya ward, Jos North?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos North', ward: 'Rantya', community: 'Rantya', phoneConfirmedForFollowUp: true } },
      lines: ['Yes, I am.', 'What is the price of a bag of rice in Bukuru market today?'],
      check: (turns) => {
        const p = commonProblems(turns);
        const said = (i: number) => turns[i]?.replies.join(' ') ?? '';
        const called = (i: number, tool: string) => !!turns[i]?.calls.some((c) => c.name === tool);
        const everCalled = (tool: string) => turns.some((t) => t.calls.some((c) => c.name === tool));
        if (!called(1, 'search-knowledge')) p.push('answered without searching the knowledge base');
        if (/₦\s?\d|\d[\d,]*\s*naira/i.test(said(1))) p.push(`gave a price the records do not have: "${said(1)}"`);
        if (!/(do not|don't) have|not (able|available)|no (verified )?information/i.test(said(1))) p.push(`did not say plainly that it does not have that information: "${said(1)}"`);
        if (!/call ?back|desk officer/i.test(said(1))) p.push(`did not offer a desk-officer callback: "${said(1)}"`);
        return p;
      },
    },
    {
      // Go-live checklist D6.
      name: 'D6: a long list is given three at a time',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos North; ward: Rantya; community: Rantya; follow-up number: this number',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rantya, Rantya ward, Jos North?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos North', ward: 'Rantya', community: 'Rantya', phoneConfirmedForFollowUp: true } },
      lines: ['Yes, I am.', 'What events are on in December?', 'Yes, please continue.'],
      check: (turns) => {
        const p = commonProblems(turns);
        const said = (i: number) => turns[i]?.replies.join(' ') ?? '';
        const called = (i: number, tool: string) => !!turns[i]?.calls.some((c) => c.name === tool);
        const everCalled = (tool: string) => turns.some((t) => t.calls.some((c) => c.name === tool));
        if (!called(1, 'search-knowledge')) p.push('answered without searching the knowledge base');
        if (!/\b(five|5)\b/i.test(said(1))) p.push(`did not say how many events there are: "${said(1)}"`);
        // "Would you like to hear about the remaining two events?" asks it too.
        if (!asks(said(1), /continue|the rest|remaining|the other|more of them|go on/i)) p.push(`did not ask whether to continue: "${said(1)}"`);
        if (/durbar|lantern/i.test(said(1))) p.push(`gave more than three in the first part: "${said(1)}"`);
        if (!/durbar/i.test(said(2)) || !/lantern/i.test(said(2))) p.push(`did not give the rest when asked to continue: "${said(2)}"`);
        return p;
      },
    },
    {
      // Go-live checklist D7.
      name: 'D7: a personal cash request is not logged as a complaint',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos North; ward: Rantya; community: Rantya; follow-up number: this number',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rantya, Rantya ward, Jos North?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos North', ward: 'Rantya', community: 'Rantya', phoneConfirmedForFollowUp: true } },
      lines: ['Yes, I am.', 'I want the government to send me one million naira for my upkeep.'],
      check: (turns) => {
        const p = commonProblems(turns);
        const said = (i: number) => turns[i]?.replies.join(' ') ?? '';
        const called = (i: number, tool: string) => !!turns[i]?.calls.some((c) => c.name === tool);
        const everCalled = (tool: string) => turns.some((t) => t.calls.some((c) => c.name === tool));
        if (everCalled('create-ticket')) p.push('registered a personal cash request as a complaint');
        if (!/(can ?not|can't|not able|does not|doesn't|do not)/i.test(said(1))) p.push(`did not explain that this line cannot do that: "${said(1)}"`);
        return p;
      },
    },
    {
      // Go-live checklist F2.
      name: 'F2: a past incident is not handled as an emergency',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos North; ward: Rantya; community: Rantya; follow-up number: this number',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rantya, Rantya ward, Jos North?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos North', ward: 'Rantya', community: 'Rantya', phoneConfirmedForFollowUp: true } },
      lines: ['Yes, I am.', 'I want to report that the culvert on our street collapsed last week.'],
      check: (turns) => {
        const p = commonProblems(turns);
        const said = (i: number) => turns[i]?.replies.join(' ') ?? '';
        const called = (i: number, tool: string) => !!turns[i]?.calls.some((c) => c.name === tool);
        const everCalled = (tool: string) => turns.some((t) => t.calls.some((c) => c.name === tool));
        if (/\b112\b|07040007283|08037808218|09064000112|08032419336/.test(said(1))) p.push(`read out emergency numbers for something that happened last week: "${said(1)}"`);
        if (turns.some((t) => t.calls.some((c) => c.name === 'create-ticket' && /^(true|yes)$/i.test(String(c.args.isOngoing))))) p.push('registered it as an emergency still happening');
        return p;
      },
    },
    {
      // Go-live checklist G1.
      name: 'G1: a caller who asks for a person gets a callback, never a transfer',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos North; ward: Rantya; community: Rantya; follow-up number: this number',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rantya, Rantya ward, Jos North?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos North', ward: 'Rantya', community: 'Rantya', phoneConfirmedForFollowUp: true } },
      lines: ['Yes, I am.', 'I want to speak to a human officer please.', 'Please use the number I am calling from.', 'Yes, that is right.'],
      check: (turns) => {
        const p = commonProblems(turns);
        const said = (i: number) => turns[i]?.replies.join(' ') ?? '';
        const called = (i: number, tool: string) => !!turns[i]?.calls.some((c) => c.name === tool);
        const everCalled = (tool: string) => turns.some((t) => t.calls.some((c) => c.name === tool));
        turns.forEach((t, i) => t.replies.forEach((r) => /\b(transfer(ring)?|put you through|connect(ing)? you)\b/i.test(r) && p.push(`turn ${i + 1}: offered or announced a transfer: "${r}"`)));
        // A call WITHOUT numberConfirmed books nothing: it is the step that returns the number to read back.
        const booked = (c: { name: string; args: Record<string, any> }) => c.name === 'request-callback' && /^(true|yes)$/i.test(String(c.args.numberConfirmed));
        if (!turns.some((t) => t.calls.some(booked))) p.push('no callback was booked');
        turns.forEach((t, i) => t.calls.forEach((c) => {
          if (booked(c) && i < 3) p.push(`turn ${i + 1}: booked the callback before the caller confirmed the number`);
        }));
        return p;
      },
    },
    {
      // Go-live checklist I6.
      name: 'I6: an official name is said whole, with titles',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos North; ward: Rantya; community: Rantya; follow-up number: this number',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rantya, Rantya ward, Jos North?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos North', ward: 'Rantya', community: 'Rantya', phoneConfirmedForFollowUp: true } },
      lines: ['Yes, I am.', 'Who is the Commissioner for Information?'],
      check: (turns) => {
        const p = commonProblems(turns);
        const said = (i: number) => turns[i]?.replies.join(' ') ?? '';
        const called = (i: number, tool: string) => !!turns[i]?.calls.some((c) => c.name === tool);
        const everCalled = (tool: string) => turns.some((t) => t.calls.some((c) => c.name === tool));
        if (!called(1, 'search-knowledge')) p.push('answered without searching the knowledge base');
        if (!/Rt\.? Hon|Right Honou?rable/i.test(said(1))) p.push(`dropped the title "Rt. Hon.": "${said(1)}"`);
        if (!/M N I/.test(said(1))) p.push(`dropped the honour "M N I": "${said(1)}"`);
        return p;
      },
    },
  ];
}

/** What the stand-in tools answer: shaped like the real ones, writing nothing. */
function standIn(sc: Scenario, name: string, args: Record<string, any>): unknown {
  if (name === 'lookup-customer') return sc.lookup;
  if (name === 'update-caller-profile') {
    // The real tool's rule (AgentToolsService.updateCallerProfile): changing a
    // location on file needs locationConfirmed, else nothing is saved.
    const onFile = (sc.lookup as any)?.data ?? {};
    const differs = (k: string, f: string) => args[k] && onFile[f] && String(args[k]).trim().toLowerCase() !== String(onFile[f]).trim().toLowerCase();
    if ((differs('community', 'community') || differs('ward', 'ward') || differs('lga', 'lga')) && !/^(true|yes)$/i.test(String(args.locationConfirmed))) {
      const loc = [args.community || onFile.community, (args.ward || onFile.ward) && `${args.ward || onFile.ward} ward`, args.lga || onFile.lga].filter(Boolean).join(', ');
      return { ok: false, speak: '', data: { saved: false, locationToConfirm: loc, instruction: `Read this whole location back to the caller and ask if it is correct: "${loc}". Wait for a clear yes, then call update-caller-profile again with locationConfirmed=true. Nothing was saved yet.` } };
    }
    return { ok: true, data: { saved: true, fields: Object.keys(args) } };
  }
  if (name === 'search-knowledge') {
    const q = String(args.query ?? '');
    if (/information/i.test(q)) {
      return { ok: true, speak: 'The Commissioner for Information and Communication is Rt. Hon. Joyce Lohya Ramnap, M N I.', data: { found: true } };
    }
    if (/commissioner|health/i.test(q)) return { ok: true, speak: "The Commissioner for Health is Dr. Nicholas Ba'amlong.", data: { found: true } };
    if (/december|event/i.test(q)) {
      return {
        ok: true,
        speak:
          'There are five events in December. The Jos Carnival, organised by the Ministry of Tourism, from 20 to 27 December at Rwang Pam Stadium. ' +
          'The Plateau Christmas Choir Festival, organised by the Ministry of Information, on 14 December at Government House. ' +
          'The Rock Haven Art Fair, organised by the Plateau State Council for Arts and Culture, on 6 December at Rayfield. ' +
          'The Berom Durbar, organised by the Gbong Gwom Jos, on 26 December at Jos Main Market square. ' +
          'The New Year Lantern Walk, organised by the Jos North LGA council, on 31 December from Terminus to Ahmadu Bello Way.',
        data: { found: true },
      };
    }
    return { ok: true, speak: '', data: { found: false } };
  }
  if (name === 'request-callback') {
    return /^(true|yes)$/i.test(String(args.numberConfirmed))
      ? { ok: true, speak: 'That is arranged — your reference is 5 2 7 1 9. A desk officer will call you back on that number.', data: { reference: '52719' } }
      : // As the real tool answers (agent-tools.service requestCallback): the number to read back, spoken.
        {
          ok: false,
          speak: 'Before I book your call back — shall we call you on the number you are calling from, 0 8 0 3 1 2 3 4 5 0 0, or would you prefer a different number?',
          data: { reason: 'number_not_confirmed', numberToConfirm: '+2348031234500', instruction: 'Read the number back digit by digit and wait for a clear yes. Only then call request-callback again with numberConfirmed=true.' },
        };
  }
  if (name === 'create-ticket') {
    if (!/^(true|yes)$/i.test(String(args.summaryConfirmed))) {
      return { ok: false, speak: '', data: { instruction: 'Read the summary back to the caller and ask whether it is accurate; call again with summaryConfirmed=true after a clear yes.' } };
    }
    return {
      ok: true,
      speak: 'Thank you for your patience. Your report has now been registered in our system. Your unique complaint reference number is 4 8 2 1 3. I repeat, 4 8 2 1 3.',
      data: { reference: '48213' },
    };
  }
  return { ok: true, data: {} };
}

/** Until the session has been quiet (not answering, nothing queued) for `settleMs`. */
async function settle(session: VoiceSession, settleMs: number, maxMs = 90_000): Promise<void> {
  const end = Date.now() + maxMs;
  let quietSince = 0;
  while (Date.now() < end) {
    if (session.busy || session.outcome) quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince >= settleMs) return;
    if (session.outcome) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** One scripted call, through the real VoiceSession, against `llm` (the real model by default). */
export async function runScenario(
  org: AgentOrganization & { timezone?: string | null },
  persona: TeamPersona,
  sc: Scenario,
  llm: typeof streamChat = streamChat,
  opts: { settleMs?: number } = {},
): Promise<Turn[]> {
  const now = new Date();
  const heard: string[] = [];
  const calls: Turn['calls'] = [];
  // Speech is "synthesised" as a 20 ms frame, and recorded as heard.
  const engine: SpeechEngine = {
    name: 'conversation-check',
    synthesize: async (text: string) => {
      heard.push(text);
      return Buffer.alloc(320);
    },
  };
  let events: SttEvents | null = null;
  let failure = '';
  const session = new VoiceSession(
    {
      sendAudio: () => undefined,
      close: () => undefined,
      stt: async (ev) => {
        events = ev;
        return { send: () => undefined, close: () => undefined };
      },
      assistantVoice: new CachedSpeech(engine as any, null),
      governorVoice: null,
      llm: (m, t, s) => llm(m, t, s),
      tools: localToolDefinitions({ contactCentre: isPlateauStateOrg(org) }),
      runTool: async (name, args) => {
        calls.push({ name, args });
        return standIn(sc, name, args);
      },
      log: (event, data) => {
        if (event === 'voice_local_failed_over') failure = String((data as any)?.reason ?? 'unknown');
      },
    },
    { systemPrompt: callSystemPrompt(org, persona, sc.vars, now), opening: callOpening(org, persona, sc.vars, now), personal: [] },
  );
  const settleMs = opts.settleMs ?? 600;
  await session.start();
  await settle(session, settleMs);
  const notReplies = new Set([...ACKS, HOLDING_LINE]);
  const turns: Turn[] = [];
  for (const line of sc.lines) {
    if (session.outcome) break;
    const h0 = heard.length;
    const c0 = calls.length;
    events!.onFinal(line, true);
    await new Promise((r) => setTimeout(r, 50));
    await settle(session, settleMs);
    turns.push({
      caller: line,
      replies: heard.slice(h0).filter((t) => !notReplies.has(t)),
      calls: calls.slice(c0),
      ...(failure ? { failed: failure } : {}),
    });
    if (failure) break;
  }
  if (failure && !turns.some((t) => t.failed)) turns.push({ caller: '(before the first answer)', replies: [], calls: [], failed: failure });
  await session.finish('completed');
  return turns;
}

async function main() {
  const slug = process.argv[2];
  const runs = Math.max(1, Number(process.argv[3] || 3));
  if (!slug) {
    console.error('Usage: node apps/api/dist/voice-local/conversation-check.js <agency-slug> [runs]');
    process.exit(2);
  }
  const { prisma } = await import('@ace/database');
  const org = await prisma.organization.findUnique({
    where: { slug },
    select: { name: true, slug: true, timezone: true, welcomeMessage: true, aiPersonaPrompt: true },
  });
  if (!org) throw new Error(`No agency with slug "${slug}".`);
  const persona: TeamPersona = { ...TEAM_PERSONAS.nanpan, id: 'gwaman', name: 'Gwaman', greetingPhrase: 'my name is Gwaman' };
  let failed = 0;
  let broken = 0;
  console.log(`Model: ${voiceModel()} (LOCAL_VOICE_LLM_MODEL=${process.env.LOCAL_VOICE_LLM_MODEL?.trim() || '(not set)'})`);
  for (const sc of scenarios(org)) {
    let passes = 0;
    for (let r = 1; r <= runs; r++) {
      const turns = await runScenario(org, persona, sc);
      const failure = turns.find((t) => t.failed)?.failed;
      // A call that broke says nothing about the agent: reported as such, never as a verdict.
      const problems = failure ? [`THE CALL FAILED, not judged: ${failure}`] : sc.check(turns);
      if (failure) broken++;
      if (!problems.length) passes++;
      console.log(`\n── ${sc.name} — run ${r}: ${problems.length ? 'FAIL' : 'PASS'}`);
      for (const t of turns) {
        console.log(`  CALLER: ${t.caller}`);
        for (const c of t.calls) console.log(`    [tool] ${c.name} ${JSON.stringify(c.args)}`);
        for (const rep of t.replies) console.log(`  AGENT:  ${rep}`);
      }
      for (const p of problems) console.log(`  ✗ ${p}`);
    }
    console.log(`== ${sc.name}: ${passes}/${runs} passed`);
    if (passes < runs) failed++;
  }
  if (broken) console.log(`\n${broken} run(s) FAILED to complete (see "THE CALL FAILED"): those results are not a test of the agent. Re-run once the cause is fixed.`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
