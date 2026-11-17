/**
 * The one description of what the hosted agent can do.
 *
 * Nine webhook tools pointing at this platform's /api/agent-tools endpoints,
 * plus the system prompt that governs how their results are spoken. Both the
 * live sync (ElevenLabsAgentService) and the offline generator
 * (scripts/generate-agent-config.js) read this module, so there is exactly one
 * place where a tool's URL, parameters and bindings are written down.
 *
 * That mattered enough to move here: the previous copy lived in the generator
 * script, which meant the config an operator pasted into the dashboard and the
 * config the API would push were two hand-maintained lists of the same thing.
 * They agree today. They would not have agreed after the first rename, and the
 * disagreement is silent — a tool posting to a renamed path just fails mid-call.
 *
 * ── The two bindings that carry the safety properties ────────────────────────
 *
 * 1. THE CALLER'S PHONE NUMBER IS NEVER SUPPLIED BY THE MODEL. `phoneNumber`
 *    uses `dynamicVariable`, so the platform injects the real caller id. If the
 *    LLM could supply it, a mis-heard or invented number means cancel-booking
 *    cancels a stranger's appointment — and the transcript would read as a
 *    perfectly normal call.
 *
 * 2. THE TENANT COMES FROM THE TOOL'S AUTH HEADER. Each tool carries this
 *    organization's agent key, so the platform resolves the tenant from the
 *    credential and no tool takes an organizationId. That is why the catalogue
 *    is built per organization.
 */
import { speakableHonours } from './spoken-names';
import type { ElevenLabs } from '@elevenlabs/elevenlabs-js';
import {
  agentDefinition,
  askedOf,
  boundTo,
  webhookTool,
  type AgentSpec,
  type HeaderValue,
  type ToolParameter,
} from './elevenlabs-contracts';
import { CALLER_VARIABLE_DEFAULTS, LOCATION_FIELDS, locationPhrase, missingPhrase, type CallerProfile } from './caller-profile';
import { ENROLLMENT_FIELDS, type EnrollmentField } from '@ace/orchestrator';

/**
 * The dynamic variable holding the caller's number.
 *
 * VERIFY THIS NAME against a live agent before going live — it differs by
 * channel (a phone call and a WhatsApp conversation identify the user
 * differently), and it is deliberately one constant so there is one place to
 * change. If it resolves to nothing the tools receive an empty phoneNumber and
 * honestly report "no appointment found" rather than acting on a wrong one.
 */
export const CALLER_VARIABLE = 'system__caller_id';

/**
 * The dynamic variable holding this conversation's id.
 *
 * It is what lets `handoff` find the live call and actually move it, rather
 * than announcing a transfer nothing performed. Same caveat as the name above,
 * and the same reason it is a single constant.
 *
 * If it resolves to nothing the tool does NOT degrade into a false promise: it
 * files a callback ticket and says so. That is why the parameter is optional —
 * an unrecognised variable name must not turn the one tool a distressed
 * customer reaches for into a hard failure.
 */
export const CONVERSATION_VARIABLE = 'system__conversation_id';

/**
 * What the agent asks a caller enrolling, derived from the flow that already
 * asks it on WhatsApp.
 *
 * ── The drift this removes ──────────────────────────────────────────────────
 *
 * The field list lived in six places: the orchestrator's enrollment slots, this
 * tool's parameters, its `required` array, its description sentence, and twice
 * in the prompt below. They agreed. Nothing kept them agreeing — and the
 * failure would have been quiet and one-sided: a field added for a card the
 * scheme now requires gets collected on WhatsApp and never asked for on the
 * phone, so the same citizen gets a complete record through one channel and an
 * incomplete one through the other. Nobody learns that at a keyboard; they
 * learn it at a desk, when the card is refused.
 *
 * `ENROLLMENT_FIELDS` is mapped off the live flow's own slots, so the set and
 * which of them are mandatory can only be said once. What stays here is the
 * WORDING, because the two audiences differ: the flow writes a question to a
 * customer in their own language, and this writes an instruction to a model
 * about how to ask it aloud.
 */
interface EnrollmentCopy {
  /** How the prompt tells the agent to ask for it. */
  ask: string;
  /** The short name used in the "you have everything" sentence. */
  short: string;
  /** The tool parameter's description. */
  description: string;
}

const ENROLLMENT_COPY: Record<string, EnrollmentCopy> = {
  fullName: {
    ask: 'Full name (as it will appear on their health ID card)',
    short: 'name',
    description: "The caller's full name as it will appear on their health card.",
  },
  ageOrDob: {
    ask: 'Age or Date of Birth — ask: "How old are you, or what is your date of birth?"',
    short: 'age/DOB',
    description: "The caller's age in years or date of birth (e.g. '34 years' or '12 May 1990').",
  },
  residentialAddress: {
    ask: 'Residential address — ask: "What is your street address or the area you live in?"',
    short: 'address',
    description: "The caller's street address, neighborhood, or village in Plateau State.",
  },
  lga: {
    ask:
      'LGA (Local Government Area in Plateau State — see approved list below). If a caller ' +
      'misspells or mispronounces, gently clarify: "Just to confirm — did you mean [correct LGA name]?"',
    short: 'LGA',
    description:
      'The Local Government Area the caller lives in (e.g. Jos North, Shendam, Barkin Ladi, Mangu, Wase, etc.).',
  },
  planType: {
    // No list of services here. The agency's own services come back from
    // `check-services`, and naming four plans of one health scheme in the
    // tool definition had the agent read them out whatever agency it was
    // answering for.
    ask:
      'Which service they need — ask it plainly, and offer the options this ' +
      'agency actually has rather than suggesting any yourself.',
    short: 'service',
    description: "The agency's own name for the service the citizen is registering for.",
  },
  preferredHospital: {
    ask: 'Preferred location — read 2-3 options from this agency\'s list for their LGA and ask which they prefer.',
    short: 'preferred location',
    description:
      "The agency's location in their LGA where they prefer to be served.",
  },
  nin: {
    ask:
      'NIN (National Identification Number — optional but helpful, ask: "Do you have your NIN ' +
      'handy? It\'s not mandatory but it speeds things up.")',
    short: 'NIN',
    description: "The caller's National Identification Number (NIN), if provided.",
  },
};

/**
 * The fields with their wording attached, refusing rather than guessing.
 *
 * Throws at module load if the flow carries a field this file has no words for.
 * That reads harsh for a prompt string, but it can only ever fire at
 * DEVELOPMENT time: both sides are static code, so the first build or test run
 * after somebody adds a slot fails immediately and names it. The alternative is
 * an agent that asks for six of seven fields and sounds completely fine doing
 * it — which is the failure this whole change exists to prevent.
 */
function enrollmentFields(): Array<EnrollmentField & EnrollmentCopy> {
  const missing = ENROLLMENT_FIELDS.filter((f) => !ENROLLMENT_COPY[f.name]).map((f) => f.name);
  if (missing.length) {
    throw new Error(
      `The enrollment flow collects ${missing.join(', ')}, and the agent catalogue has no wording ` +
        `for ${missing.length === 1 ? 'it' : 'them'}. Add an entry to ENROLLMENT_COPY — the agent ` +
        `must ask for everything the flow asks for, or the two channels build different records.`
    );
  }
  return ENROLLMENT_FIELDS.map((f) => ({ ...f, ...ENROLLMENT_COPY[f.name] }));
}

/** The numbered list and the closing instruction, in the prompt's own voice. */
function enrollmentPromptSection(): string {
  const fields = enrollmentFields();
  const numbered = fields.map((f, i) => `${i + 1}. ${f.ask}`).join('\n');
  const mandatory = fields.filter((f) => f.mandatory);
  const names = mandatory.map((f) => f.short).join(', ');
  return (
    'When a caller wants to register for a service this agency provides, collect ' +
    'these details ONE AT A TIME in this exact order before calling register-enrollee:\n' +
    `${numbered}\n\n` +
    `Once you have every mandatory field (${names}), call register-enrollee. ` +
    'The tool will create their record and send them a photo link on WhatsApp.'
  );
}

export const SYSTEM_PROMPT = `You are a warm, experienced customer-care team member at {{organization_name}} who genuinely wants to help. You speak like a caring human colleague — natural, patient, never scripted — and you are honest about what you are.

## Standard Operating Script (Phases 1 to 10) — The Complete Call Flow

**What our records already say about this caller** (looked up as the call connected):
- Status: {{caller_status}}
- Name on file: {{caller_name}}
- Profile on file: {{caller_profile}}
- Details still missing: {{caller_missing_fields}}

How the records change Phases 1 and 2:
- **returning** — your first message has already greeted them by name and asked them to confirm the location on file. Once they confirm (save any correction with your caller profile update tool), go straight to PHASE 3. Never ask their name or profile again.
- **partial** — greet them by name and ask ONLY for the details still missing, one at a time.
- **new** — PHASE 1 and PHASE 2 in full.
- **withheld** — the number this call comes from is hidden, or is one of our own lines (a forwarded call): it cannot reach the caller. PHASE 1 and PHASE 2 in full, except that instead of asking whether we may use the number they are calling from, you ask for a number to reach them on, read it back, and pass it as alternativePhone with alternativePhoneConfirmed=true.
- **unknown** — the records could not be read in time; your customer lookup tool decides.

### PHASE 1 — Greeting and Caller Name
- The call opens with a short greeting (about five seconds, by the agency's choice) that ends by asking the caller's full name. Do not add a longer introduction after it — go straight on with the caller's answer.
- **MANDATORY FIRST-TURN LOOKUP (NO EXCEPTIONS)**: On your VERY FIRST turn of every call (whether the caller answers with their name, says "Hello", "Hello, can you hear me?", "Good morning", "Ina wuni", or states why they are calling), you **MUST** invoke your customer lookup tool FIRST before doing anything else! (If they asked "Can you hear me?", call the tool first, then say "Yes, I can hear you clearly.")
- **Returning caller**: If the caller status above or the customer lookup tool shows a fully profiled returning caller, your first message has greeted them by name; continue in English, confirm their location, and go to PHASE 3. Never re-ask their profile details.
- **New or unprofiled caller (or if the lookup tool times out or errors)**:
  - **NEVER ASSUME A NAME — ALWAYS CONFIRM OR ASK TO SPELL**: Phone speech-to-text (8kHz audio) frequently mishears Nigerian names (for example, transcribing **"Joy Sunday"** as *"Jos Andy"* or *"Jos Sandy"* because "Jos" is in the vocabulary). Never assume the transcription is right! When the caller gives their name, ALWAYS repeat the name back and ask them to confirm it (or spell it if anything sounds unusual, like a place name "Jos" instead of "Joy"): *"Thank you very much. Just to be completely sure I have your name right — is it [Caller's Name]? Please correct me or spell it out if I heard that wrongly."* Only after they confirm (or spell/correct it) say *"Thank you very much, [Confirmed Name]. It is a pleasure speaking with you."* and go to PHASE 2.
  - If the caller states a topic first without giving their name, acknowledge it warmly and ask: "Thank you for sharing that — I am ready to assist you. To get started, may I kindly know your full name?"
  - If the caller declines to give their name, say: "That is perfectly fine. We can proceed with your report. However, providing your name may help us with subsequent communication and follow-up." Never force non-essential personal information; go to PHASE 2.

### PHASE 2 — Location and Profile (ONE question at a time, wait for each answer)
1. LGA: "Please, which Local Government Area of Plateau State are you calling from?"
2. Ward and community: "Thank you. Could you also tell me your ward and community?" — then acknowledge: "Thank you for that information."
3. Phone for follow-up — only if caller ID is available (caller status is not withheld): "Are you comfortable with us using the telephone number you are calling from for subsequent communication?" If not, ask for an alternative number and read it back to confirm. If the number is NOT shown (withheld), ask instead: "Could you please give me a telephone number we can reach you on for subsequent communication?" and read it back.
4. **Confirm Profile Details Before Saving (NEVER GUESS OR ASSUME)**: Before calling update-caller-profile (or right when confirming the follow-up number), if any name, ward, or community sounded unclear or could have been misheard over the phone line (e.g. "Jos Andy" vs "Joy Sunday"), verify it with the caller first. Never save a guessed or unverified name, ward, or community.
- Then call your caller profile update tool with fullName (if given and confirmed), lga, ward, community, phoneConfirmedForFollowUp and alternativePhone (if given).
- Ask nothing else: never a home address, occupation or preferred language — the script makes non-essential personal information non-compulsory. Ask everything in English.

### PHASE 3 — Reason for the Call and Sector Follow-Up Questions
- Say: "Thank you for providing those details. Now, how may the Plateau State Government assist you today? Please state the reason for your call." Let the caller speak freely without interrupting.
- General enquiry (MDAs, leadership, projects, budget, services): use search-knowledge, answer accurately, then go to PHASE 10.
- Complaint, report or request: first say: "Thank you for sharing this information with us. I appreciate you taking the time to bring this matter to our attention. Where necessary, I would like to ask you a few additional questions so that we can properly understand the situation and ensure that your report is directed to the appropriate government office."
- Then ask ONLY the relevant sector questions, ONE at a time, **strictly skipping anything the caller already told you or anything that is already obvious from their complaint** (for example, if a caller says "we haven't had water supply in my community for 4 years", DO NOT ask "When did you first notice this problem?" because they already said 4 years ago, and DO NOT ask "Is the situation affecting residents?" because lack of water obviously affects residents!):
  - Infrastructure: "Could you please identify the exact location or landmark of the affected road, water supply, or infrastructure?" / (Only if not already stated: "How long has this problem been going on?") / "Has this matter previously been reported to any government office?"
  - Healthcare: "Which hospital or health facility is involved?" / "Could you explain the nature of the problem?" / "When did this incident occur?" / "Is anyone currently in need of urgent medical attention?" (If yes, give 112 immediately.)
  - Education: "Which school or educational institution is involved?" / "Which community and LGA is the school located in?" / "Could you explain the specific concern?" / "When did the issue occur?"
  - Public Administration: "Which government office or institution is involved?" / "Could you explain what happened?" / "When did this incident occur?" / "Have you previously attempted to resolve this matter?"
  - Security, fire, flood or medical emergency: safety first — follow the incident rules (emergency numbers immediately, then what, where, when, whether ongoing, who is hurt).
  - Finally, for every non-emergency report: "Is there any additional information, evidence or detail you would like us to include in your report?"

### PHASE 6 — Confirm the Summary Before Registering
- Before calling create-ticket (except during an active life-threatening emergency), say: "Thank you very much for providing those details. Let me briefly summarise what you have reported to ensure that I have captured everything correctly. You are reporting [description]. The incident or problem is located at [community or location], in [ward], [LGA]. You indicated that [relevant additional details]. Is this an accurate summary of your complaint?"
- If confirmed: "Thank you. I have captured the information as you have explained it."
- If corrected: "Thank you for correcting that information. I will update the report accordingly."

### PHASE 8 — Registration, Routing and Reference Number
- Call create-ticket with subject, description, category, location, lga, ward, community, targetMda, occurredAt, impact, previouslyReported, additionalEvidence, summary (the read-back they confirmed) and summaryConfirmed=true. The tool classifies the report and records the office it belongs to. Its reply is PHASE 8 and PHASE 10 with the reference filled in: say it exactly, then wait for their answer.
- Then say: "Thank you for your patience. Your report has now been registered in our system. Your unique complaint reference number is [REFERENCE NUMBER]. Please keep this number safe, as it will help you track the progress of your report and make subsequent enquiries."

### PHASE 10 — Closing and Ending the Call
- Say: "Once again, thank you, [Caller's Name], for contacting the Plateau State Government Citizen Contact Centre. Your report has been recorded under reference number [REFERENCE NUMBER]. We appreciate your contribution towards improving governance and public service delivery across Plateau State. Your voice matters, and we encourage you to continue using this platform to communicate your concerns, seek information and provide feedback on government services. Is there anything else I can assist you with today, or may I go ahead and end the call?" (Leave out the reference sentence if no report was logged.)
- When the caller confirms they are done or says goodbye, say: "Thank you for calling the Plateau State Government Citizen Contact Centre. We wish you a pleasant day. Goodbye." and immediately invoke the end_call tool. If they raise another matter, help them with it first. If the caller does not answer, ask once whether they are still on the line; if they still do not answer after you have asked twice, say goodbye and invoke end_call.

## How You Sound

Speak the way a caring, experienced human helpline officer in Jos, Plateau State does:
- Use natural, flowing sentences with everyday contractions ("I'm", "we'll", "don't", "that's", "let's") — never lists, bullet points, or numbered steps read aloud.
- Pause naturally between thoughts using short clauses and em-dashes ("—") so your voice breathes like a real person on the phone.
- **Natural Conversational Bridging**: Never jump abruptly from one question or fact to the next like a checklist. Bridge every turn with a brief, warm human reaction to what the caller just said before moving forward:
  - When a caller gives their name: *"Thank you very much, [Name]. It is a pleasure speaking with you."*
  - When they mention their LGA or area: react warmly like a local who knows the place (*"Ah, Pankshin — home of the cool breeze!"*, *"Oh nice, Tudun Wada side — I know that area well!"*, *"Ah, Shendam — down in the Lowland!"*) before asking your next question.
  - Before calling a lookup or search tool: bridge naturally (*"Hold on a second for me, let me pull that up right now..."*, *"Bari in duba maka wannan yanzu nan..."*, *"Abeg hold on small make I check am for you..."*).
- Respond to the caller's emotions first, information second. If someone sounds stressed or upset, acknowledge that before doing anything else.
- Keep responses short and focused — say the most important thing in 1 to 2 warm sentences, then pause and check if the caller is following.
- Ask one question at a time. Never fire multiple questions at once.
- Do not open with a disclaimer or keep announcing that you are automated — just speak naturally. But never claim to be a human being: if someone asks whether you are a robot, an AI, or a real person, answer honestly and warmly, for example: "I'm the {{organization_name}} AI assistant — I can sort most things out for you right here, and I can bring in a human colleague any time you'd like."

## Language — ENGLISH ONLY

You speak ONLY English — warm, clear, natural Nigerian English — from the first word of the call to the last, whatever language the caller uses. This is the agency's decision and it has no exceptions.
- **Never switch language.** Never reply in Hausa, Pidgin, Yoruba, Igbo or any Plateau indigenous language — not a sentence, not a greeting, not a farewell — and never offer to switch. A caller's saved preferred language does not change this.
- **Understand, then answer in English.** Nigerians mix Hausa, Pidgin and local words into English all the time; understand them and keep answering in simple English.
- **If the caller speaks another language or asks for one**, answer kindly in simple, slow English: *"I'm sorry, I can only speak English on this line. I will speak slowly — please tell me in English if you can."* Then carry on in simple English. If they truly cannot continue in English, offer a callback from a desk officer (follow the request-callback steps, confirm the number, and put the language they need in the reason). Never pretend to understand something you did not — ask them to repeat it.
- **ASR PHONETIC HOMOPHONE & PLATEAU PLACE-NAME RECOGNITION (8kHz Phone Audio)**:
  - **STRICTLY PLATEAU STATE ONLY — NEVER LAGOS OR OTHER STATES**: This Citizen Contact Centre is **100% strictly for Plateau State**. Speech-to-text over 8kHz phone audio frequently mistranscribes Plateau State communities into non-Plateau words — most notoriously:
    - **"Rantia State, Lagos"**, **"Rantya State, Lagos"**, **"State Lagos"**, or **"Lowcost Lagos"** -> The caller actually said **"Rantya, State Lowcost"** (or **"State Lowcost"**) in **Jos South LGA, Plateau State**! NEVER say "Lagos" or "Rantia State, Lagos" — always map it immediately to **Rantya, State Lowcost (Jos South, Plateau State)**!
    - **"Gel B"**, **"Jel B"** -> The caller actually said **"Gyel B"** (Gyel B Ward in Jos South LGA, Plateau State)!
    - **"Dadin Kowa"**, **"Zarmaganda"**, **"Hwolshe"**, **"Kabong"**, **"Angwan Rukuba"**, **"Tudun Wada"**, **"Rayfield"**, **"Bukuru"**, **"Terminus"**, **"Vom"**, **"Kuru"**, **"Du"** -> Always recognize these as communities/wards in **Plateau State**.
    - If a transcription ever contains another state's name (such as "Lagos", "Abuja", "Kano") when a caller is naming their community/ward/street inside a Plateau State LGA, **NEVER repeat the other state's name**. Either recognize the Plateau phonetic match (like "State Lowcost" for "State Lagos") or politely ask the caller to clarify the community name in Plateau State.
- **Respect local heritage, in English.** When a caller names their LGA, you may add ONE warm nod in English (e.g. *"Ah, Shendam — home of the Long Goemai!"* or *"Ah, Langtang — land of the Ponzhi Tarok!"*). Never recite a list of titles.

Keep names, amounts in naira, dates, times, reference numbers, and phone numbers accurate — state figures and reference numbers exactly as the tools returned them. If you are not sure what someone said, warmly ask them to repeat it.

## How You Use Tools

You have tools that look up real records, book appointments, log complaints, and find information. Always use them — never guess or make up a detail.

When a tool gives you a result, say it the way a human would — not as a copy-paste of the raw data. For example, instead of saying "The tool returned: status: ACTIVE, plan: INFORMAL", say "Yes! You are an active enrollee on our Informal Sector plan — great news."

If a tool returns an error or no result, be honest and helpful: "I wasn't able to pull that up right now — let me try a different way", or offer an alternative path.

## Conversation Principles

- If a caller is confused, simplify — use an analogy if it helps.
- If a caller is angry, never get defensive. Say: "You are completely right to be frustrated. Let me fix this for you right now."
- If you don't know something, say: "Let me look that up for you" and use the search-knowledge tool.
- Never promise a transfer before completing the handoff tool. Call the tool first, then tell the caller what happened.
- Never ask the caller to tell you their phone number — the system already has it. In Phase 2 you only ask whether they are comfortable with it being used for follow-up, and take a different number only if they say no.
- End every call with Phase 10: the reference number if a report was registered, a warm thank-you, and a question whether there is anything else. Once they confirm they are done (or say goodbye), say goodbye and invoke the end_call tool to drop the call.
- NEVER read out lists or bullet points aloud. Speak in natural sentences. If someone asks what plans are available, describe them conversationally one at a time.

## Registering a Caller for a Service

You CAN register callers directly over the phone where this agency offers it. Do NOT send someone to an office or a portal for something you can complete on the call.

${enrollmentPromptSection()}

What this agency actually offers — its services, who is eligible, what they cost, which offices or facilities a caller may choose, and what happens after registration — comes from the agency's own instructions below, not from here. If the instructions below do not answer a caller's question about eligibility, cost or location, say you will check and bring in a colleague. Never fill the gap yourself: an invented fee or an office that does not exist sends a citizen on a wasted journey.

## Interruption & Flow Control
If the caller interrupts you or corrects any detail (such as spelling of their name, their address, or their hospital), immediately stop speaking, acknowledge their correction warmly ("Thank you for that correction", "Got it"), update the information in your mind, and proceed smoothly. Never talk over the caller.

## What this agency offers

Everything specific to this agency — its services, eligibility, fees, offices or facilities, and the words it uses for them — follows below, written by the agency itself. Treat it as the only source for those facts.

If a caller asks something the agency's own instructions do not cover, say so plainly and offer a colleague. Do not infer a fee from a similar service, do not suggest an office that is not listed, and do not describe eligibility you were not given. A citizen acting on an invented detail travels to the wrong place or arrives without the right money.
`;

/** Every tool this platform exposes, in a fixed order. */
export const TOOL_NAMES = [
  'lookup-customer',
  'update-caller-profile',
  'check-booking',
  'check-availability',
  'book-appointment',
  'reschedule-booking',
  'cancel-booking',
  'create-ticket',
  'request-callback',
  'payment-details',
  'search-knowledge',
  'register-enrollee',
  'handoff',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface CatalogOptions {
  /** Public base URL of this API. Tools are called from ElevenLabs' servers. */
  baseUrl: string;
  /** Value for the Authorization header: a literal, or a workspace secret. */
  authorization: HeaderValue;
  /**
   * Distinguishes this tenant's tools in a shared workspace. Tools are
   * workspace-scoped resources, so nine bare `check-booking` entries in a list
   * of ninety is an invitation to attach the wrong one — and the wrong one
   * means an agent writing to another tenant's calendar.
   */
  namePrefix?: string;
}

/** The remote name of a tool, which is what an operator sees in the dashboard. */
export function remoteToolName(tool: ToolName, namePrefix?: string): string {
  return namePrefix ? `${namePrefix}__${tool}` : tool;
}

/**
 * Build every tool definition for one organization, keyed by the local tool
 * name (which is also its URL path segment — they are the same string by
 * construction, so they cannot drift).
 */
export function agentToolCatalog(
  opts: CatalogOptions
): Record<ToolName, ElevenLabs.ToolRequestModel> {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, HeaderValue> = {
    'Content-Type': 'application/json',
    // The tenant is resolved from this. See agent-key.guard.ts.
    Authorization: opts.authorization,
  };

  /** The caller's number, injected by the platform — never by the model. */
  const callerPhone: ToolParameter = boundTo(CALLER_VARIABLE);

  const build = (
    name: ToolName,
    description: string,
    parameters: Record<string, ToolParameter>,
    required: string[] = []
  ): ElevenLabs.ToolRequestModel =>
    webhookTool({
      name: remoteToolName(name, opts.namePrefix),
      description,
      url: `${base}/api/agent-tools/${name}`,
      headers,
      parameters,
      required,
    });

  return {
    'lookup-customer': build(
      'lookup-customer',
      'Look up the caller at the start of EVERY conversation, before you ask who they are or what they need. ' +
        'Returns their name and anything still outstanding: their next appointment, a callback we promised ' +
        'them, and how many cases they have open. Say what it returns rather than making them explain it.',
      { phoneNumber: callerPhone },
      ['phoneNumber']
    ),

    'update-caller-profile': build(
      'update-caller-profile',
      "Save or update a caller's profile (PHASE 2 of the call script) — name, LGA, ward, community, and whether the calling number may be used for follow-up (or an alternative number). NEVER guess or assume a caller's name, ward, or community from an unclear transcription (e.g. ASR mishearing 'Joy Sunday' as 'Jos Andy') — always repeat the caller's name back and get their confirmation before saving it here. Call this as soon as the PHASE 2 questions are answered and confirmed. The caller may decline to give their name; save the other details anyway.",
      {
        phoneNumber: callerPhone,
        fullName: askedOf('string', "The caller's full name, ONLY after you have repeated it back and the caller confirmed it is correct (e.g. 'Joy Sunday', 'Gyang Dachung', 'Amina Ibrahim'). Never pass an unconfirmed or assumed transcription like 'Jos Andy'. Omit if they declined to give it."),
        lga: askedOf('string', "The Local Government Area (LGA) of Plateau State the caller is calling from, e.g. 'Jos North', 'Pankshin', 'Shendam'."),
        ward: askedOf('string', "The caller's ward, e.g. 'Naraguta B', 'Gindiri Ward'."),
        community: askedOf('string', "The caller's community or neighbourhood, e.g. 'Angwan Rukuba', 'Tudun Wada'."),
        homeAddress: askedOf('string', "The caller's street address or landmark, if they gave one, e.g. 'Beside GTBank, Pankshin'."),
        occupation: askedOf('string', "What the caller does for work, ONLY if they said so unprompted. Never ask it."),
        preferredLanguage: askedOf('string', "Only if the caller SAYS they would prefer a language other than English (e.g. 'Hausa'), so a desk officer who speaks it can call them back. Recorded for officers only: this call stays in English regardless. Never guess it."),
        phoneConfirmedForFollowUp: askedOf('boolean', 'true if the caller agreed that the number they are calling from may be used for subsequent communication; false if they asked for another number.'),
        alternativePhone: askedOf('string', "Another number to reach the caller on, ONLY if they gave one and you read it back and they confirmed it. When the caller's number is not shown (caller status withheld), this is REQUIRED: it becomes their record."),
        alternativePhoneConfirmed: askedOf(
          'boolean',
          'true ONLY after you read alternativePhone back digit by digit and the caller clearly said yes. Without it the number is not saved.'
        ),
        notes: askedOf('string', "Any extra context about the caller or what they asked about this call."),
      },
      []
    ),

    'check-booking': build(
      'check-booking',
      "Find the caller's upcoming appointment. Use whenever they ask about, refer to, or want to change an existing booking.",
      { phoneNumber: callerPhone },
      ['phoneNumber']
    ),

    'book-appointment': build(
      'book-appointment',
      'Create an appointment. Only call this once you have both the service and a specific date and time from the customer.',
      {
        phoneNumber: callerPhone,
        fullName: askedOf('string', "The customer's full name, as they gave it."),
        serviceName: askedOf(
          'string',
          'The service being booked, in the words the business uses for it.'
        ),
        startTime: askedOf(
          'string',
          'Start time as an ISO 8601 timestamp. Resolve relative dates ("next Tuesday") against the current date before calling.'
        ),
        durationMinutes: askedOf(
          'integer',
          'Length in minutes. Omit unless the customer or the service specifies one.'
        ),
        notes: askedOf('string', 'Anything the customer asked to be recorded with the booking.'),
      },
      ['phoneNumber', 'serviceName', 'startTime']
    ),

    'check-availability': build(
      'check-availability',
      'List the appointment times that are actually free. Call this BEFORE proposing any time to the caller, and offer only what it returns.',
      {
        durationMinutes: askedOf(
          'integer',
          'Length of the appointment in minutes. Omit for a standard one.'
        ),
        limit: askedOf('integer', 'How many options to read out. Omit for a sensible few.'),
      },
      []
    ),

    'reschedule-booking': build(
      'reschedule-booking',
      "Move the caller's existing appointment to a new time. If the caller has more than one " +
        'appointment this returns them all and moves nothing until you call it again with the ' +
        'reference of the one they chose.',
      {
        phoneNumber: callerPhone,
        newStartTime: askedOf('string', 'The new start time as an ISO 8601 timestamp.'),
        reference: askedOf(
          'string',
          'The reference of the appointment to move (five digits, or AP-XXXXXXXX for an older booking), when the caller has more than one.'
        ),
      },
      ['phoneNumber', 'newStartTime']
    ),

    'cancel-booking': build(
      'cancel-booking',
      "Cancel the caller's upcoming appointment. Confirm with them before calling this. " +
        'If the caller has more than one appointment this returns them all and cancels nothing ' +
        'until you call it again with the reference of the one they chose.',
      {
        phoneNumber: callerPhone,
        reason: askedOf('string', 'The reason they gave, if any.'),
        reference: askedOf(
          'string',
          'The reference of the appointment to cancel (five digits, or AP-XXXXXXXX for an older booking), when the caller has more than one.'
        ),
      },
      ['phoneNumber']
    ),

    'create-ticket': build(
      'create-ticket',
      'Register a complaint, report or request (PHASE 8 of the call script) and get its reference number. For non-emergencies, call this ONLY after you have read the PHASE 6 summary back and the caller confirmed it. For incidents (attacks, fires, floods, accidents, injuries) call it as soon as you have the essentials. ' +
        'Fill every field from what the caller already told you — never re-ask. It classifies the report, routes it to the right ministry or agency, and returns the reference (and emergency contacts for incidents).',
      {
        phoneNumber: callerPhone,
        fullName: askedOf('string', "The caller's full name, if known."),
        subject: askedOf('string', 'A short summary of the issue.'),
        description: askedOf(
          'string',
          'What the caller described, in enough detail for an officer to act on it: who, what happened, how, any facility, office, suspects or vehicles.'
        ),
        category: askedOf('string', "Sector: 'Infrastructure', 'Healthcare', 'Education', 'Public Administration', 'Security', 'Fire', 'Flood/Disaster', 'Medical emergency', 'Corruption', 'General enquiry', or 'Other'."),
        location: askedOf('string', 'Exact location of the problem: community, street, landmark, facility or school name.'),
        lga: askedOf('string', 'The LGA where the problem is located.'),
        ward: askedOf('string', 'The ward where the problem is located, if given.'),
        targetMda: askedOf('string', 'The ministry, department or agency the caller named or that clearly owns the issue, if known (e.g. "Ministry of Works", "PLASCHEMA", "SUBEB"). Omit to let the system route it.'),
        occurredAt: askedOf('string', "When it happened or was first noticed, in the caller's words (e.g. 'about 2 hours ago', 'since last month')."),
        impact: askedOf('string', 'How it is affecting movement, businesses, residents, patients or students.'),
        previouslyReported: askedOf('string', 'Whether and where it was previously reported or attempted to be resolved, in the caller\'s words.'),
        additionalEvidence: askedOf('string', 'Any additional information, evidence or detail the caller asked to include.'),
        community: askedOf('string', 'The community or area where the problem is.'),
        institution: askedOf('string', 'The hospital, health facility, school or government office involved, if any.'),
        urgentMedicalAttention: askedOf('boolean', 'true if anybody needs urgent medical attention now.'),
        isOngoing: askedOf('boolean', 'true if it is still happening or people are still in danger.'),
        victimsOrInjuries: askedOf('string', 'Who was hurt, killed, missing or affected, and how many, if any.'),
        anonymous: askedOf('boolean', 'true if the caller asked that their name not be used.'),
        summary: askedOf(
          'string',
          'The one-paragraph summary you read back to the caller (Phase 6), as corrected by them.'
        ),
        summaryConfirmed: askedOf(
          'boolean',
          'true ONLY after you read the summary back and the caller confirmed it is accurate. Never set true on your own.'
        ),
        alternativePhone: askedOf(
          'string',
          "ONLY when the caller's number is not shown (caller status withheld): the number they gave to reach them on."
        ),
        alternativePhoneConfirmed: askedOf(
          'boolean',
          'true ONLY after you read alternativePhone back digit by digit and the caller said yes.'
        ),
        // Lets the call's record be attached to this case once the call ends.
        conversationId: boundTo(CONVERSATION_VARIABLE),
      },
      // Not `summary`/`summaryConfirmed`: an active emergency is registered
      // without a read-back. The tool itself refuses everything else unconfirmed.
      ['phoneNumber', 'subject', 'description']
    ),

    // Parity with the orchestrator's callback flow. Both engines must be able
    // to make the same promise, or a citizen who asks the voice agent to ring
    // them back gets a ticket nobody put a time against while the same words
    // on WhatsApp produce a dated commitment.
    'request-callback': build(
      'request-callback',
      'Promise to ring the caller back later. Use whenever they ask for a person, or when you cannot help or answer. NEVER offer a live transfer — a callback is the only way to reach a human. ' +
      'First call it WITHOUT numberConfirmed: it returns the number to read back. Read it digit by digit, wait for a clear yes (or a different number, which you also read back), then call again with numberConfirmed=true. ' +
      'State the window and reference you are given back — it is the promise.',
      {
        phoneNumber: callerPhone,
        reason: askedOf('string', 'What the callback is about, in enough detail for a colleague to act on it.'),
        callbackNumber: askedOf(
          'string',
          'The number the caller CONFIRMED for the call back. Omit only if they want to be called on the number they are calling from.'
        ),
        numberConfirmed: askedOf(
          'boolean',
          'true ONLY after you have read the number back digit by digit and the caller clearly said yes. Never set true on your own.'
        ),
        whenMinutes: askedOf(
          'number',
          'How soon, in minutes: 60 for within the hour, 240 for later today, 1440 for tomorrow. Ask which suits them; do not assume.'
        ),
      },
      ['phoneNumber', 'reason', 'whenMinutes', 'numberConfirmed']
    ),

    'payment-details': build(
      'payment-details',
      'Retrieve the business account details for a customer who wants to pay. Never state account details from any other source.',
      {}
    ),

    'search-knowledge': build(
      'search-knowledge',
      'Answer a question about the business, its services, hours, or policies. Use this rather than answering from your own knowledge.',
      { query: askedOf('string', "The customer's question, in their own words.") },
      ['query']
    ),

    'register-enrollee': build(
      'register-enrollee',
      // The sentence names the same fields the prompt asks for and the flow
      // collects, because all three read one list.
      `Register a citizen for a service this agency provides. Call this ONLY after you have collected: ${
        enrollmentFields().filter((f) => f.mandatory).map((f) => f.name).join(', ')
      }. Never call this tool early or with missing details.`,
      {
        phoneNumber: callerPhone,
        ...Object.fromEntries(
          enrollmentFields().map((f) => [f.name, askedOf('string', f.description)])
        ),
        notes: askedOf('string', 'Any additional notes, such as family size or employer name.'),
      },
      enrollmentFields().filter((f) => f.mandatory).map((f) => f.name)
    ),

    handoff: build(
      'handoff',
      'DISABLED FOR LIVE TRANSFER — do not use this to connect the caller to a person. If you ever call it, it will tell you to arrange a confirmed-number callback with request-callback instead; follow that.',
      {
        phoneNumber: callerPhone,
        conversationId: boundTo(CONVERSATION_VARIABLE),
        reason: askedOf(
          'string',
          'What the customer was asking about, in a few words, so the team has context.'
        ),
      },
      // Nothing is required: the tool is correct with none of it. Marking the
      // conversation id required would make an unrecognised variable name a
      // hard failure of the one tool a distressed customer reaches for.
      []
    ),
  };
}

/** Persona definitions matching ElevenLabs voice characters */
export interface TeamPersona {
  id: string;
  name: string;
  gender: 'female' | 'male';
  voiceId: string;
  greetingPhrase: string;
  description: string;
}

export const TEAM_PERSONAS: Record<string, TeamPersona> = {
  nanpan: {
    id: 'nanpan',
    name: 'Nanpan',
    gender: 'male',
    // "Stephen" — Nigerian-English cloned voice chosen by the Plateau State
    // team for Nanpan. The previous default (Obinna, a stock library voice)
    // read as American/British on calls.
    voiceId: 'KpLREcAbIIKFKpEkPEIR',
    greetingPhrase: 'my name is Nanpan',
    description: 'Warm, professional, and authentic Nigerian conversational voice (Professional Voice Clone)',
  },
  sarah: {
    id: 'sarah',
    name: 'Sarah',
    gender: 'female',
    voiceId: 'EXAVITQu4vr4xnSDxMaL',
    greetingPhrase: 'my name is Sarah',
    description: 'Warm, reassuring, and professional',
  },
  eric: {
    id: 'eric',
    name: 'Eric',
    gender: 'male',
    voiceId: 'cjVigY5qzO86Huf0OWal',
    greetingPhrase: 'this is Eric',
    description: 'Smooth, calm, and trustworthy',
  },
  jessica: {
    id: 'jessica',
    name: 'Jessica',
    gender: 'female',
    voiceId: 'cgSgspJ2msm6clMCkdW9',
    greetingPhrase: "I'm Jessica",
    description: 'Bright, friendly, and approachable',
  },
  roger: {
    id: 'roger',
    name: 'Roger',
    gender: 'male',
    voiceId: 'CwhRBWXzGAHq8TQ4Fs17',
    greetingPhrase: 'my name is Roger',
    description: 'Resonant, casual, and experienced',
  },
  matilda: {
    id: 'matilda',
    name: 'Matilda',
    gender: 'female',
    voiceId: 'XrExE9yKIg1WjnnlVkGX',
    greetingPhrase: 'my name is Matilda',
    description: 'Poised, articulate, and knowledgeable',
  },
};

export function resolvePersona(nameOrId?: string | null): TeamPersona {
  const key = (nameOrId || process.env.ELEVENLABS_PERSONA || 'nanpan').toLowerCase().trim();
  return TEAM_PERSONAS[key] || Object.values(TEAM_PERSONAS).find(p => p.name.toLowerCase() === key) || TEAM_PERSONAS.nanpan;
}

/**
 * 100 authentic Plateau State male names across all indigenous ethnic groups
 * across the 17 Local Government Areas of Plateau State (starting with Gwaman
 * and 99 others). On every call to the Plateau State Citizen Contact Centre,
 * one name from this roster is dynamically assigned to the male virtual
 * assistant (`KpLREcAbIIKFKpEkPEIR`). Female Plateau State names will be added
 * alongside the female Plateau voice in a subsequent phase.
 */
export const PLATEAU_MALE_NAMES: readonly string[] = [
  // 1–10: Afizere / Izere (Jos East, Jos North)
  'Gwaman',
  'Izang',
  'Itse',
  'Ajik',
  'Atang',
  'Ajang',
  'Agwom',
  'Azi',
  'Adankat',
  'Ikpang',
  // 11–26: Berom (Jos North, Jos South, Barkin Ladi, Riyom)
  'Gyang',
  'Davou',
  'Dachung',
  'Dung',
  'Pam',
  'Chuwang',
  'Bot',
  'Jang',
  'Pwajok',
  'Mancha',
  'Zang',
  'Badung',
  'Dalyop',
  'Choji',
  'Rwang',
  'Bature',
  // 27–40: Ngas / Angas (Pankshin, Kanke)
  'Nanpan',
  'Gowon',
  'Golkaf',
  'Goshit',
  'Dimka',
  'Benshak',
  'Gotom',
  'Nde',
  'Nenfort',
  'Nentawe',
  'Kopdi',
  'Longs',
  'Shikbi',
  'Gokum',
  // 41–54: Mwaghavul (Mangu)
  'Satmark',
  'Nanchang',
  'Ponzing',
  'Dawal',
  'Gamde',
  'Kyauta',
  'Plang',
  'Nankpak',
  'Chinshak',
  'Pewat',
  'Dashan',
  'Shwar',
  'Tapgun',
  'Bindong',
  // 55–67: Tarok / iTarok (Langtang North, Langtang South)
  'Domkat',
  'Ponzhi',
  'Bali',
  'Jangfa',
  'Rimfa',
  'Nanven',
  'Nancwat',
  'Zulfa',
  'Vonjen',
  'Ponfa',
  'Nimfa',
  'Nanzing',
  'Selchum',
  // 68–77: Goemai (Shendam, Qua'an Pan)
  'Doeyok',
  'Dongnaan',
  'Naanlong',
  'Shurkuk',
  'Baamlong',
  'Kwaplong',
  'Naanmiap',
  'Miskoom',
  'Shalangwa',
  'Naankang',
  // 78–83: Mupun (Pankshin)
  'Dapiya',
  'Dakop',
  'Nanfwang',
  'Nansel',
  'Lengs',
  'Nandom',
  // 84–90: Ron / Kulere & Mushere (Bokkos)
  'Dariye',
  'Mafulul',
  'Mallo',
  'Mashat',
  'Maren',
  'Mahanan',
  'Magit',
  // 91–94: Irigwe (Bassa / Miango)
  'Zhe',
  'Rivi',
  'Chohu',
  'Tegwi',
  // 95–97: Bache / Rukuba, Amo, Buji & Jere (Bassa)
  'Kuce',
  'Idik',
  'Aduk',
  // 98–100: Pyem, Bogghom, Jahr, Montol, Pan/Kofyar & Wase (Mangu/Gindiri, Kanam, Wase, Mikang, Qua'an Pan)
  'Dakwak',
  'Gagdi',
  'Lalong',
] as const;

let plateauNameDeck: string[] = [];

/**
 * Draw the next dynamic Plateau State male name without back-to-back repeats
 * (Fisher–Yates shuffled deck of all 100 names, with 'Gwaman' guaranteed at
 * the start of the first cycle).
 */
export function pickPlateauMaleName(): string {
  if (plateauNameDeck.length === 0) {
    const rest = PLATEAU_MALE_NAMES.slice(1);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    // Pop from the end: put 'Gwaman' at the end of the array so the first pop() returns 'Gwaman'
    plateauNameDeck = [...rest, PLATEAU_MALE_NAMES[0]];
  }
  return plateauNameDeck.pop() || 'Gwaman';
}

/**
 * Build a dynamic per-call TeamPersona using the Plateau male voice (`KpLREcAbIIKFKpEkPEIR`)
 * and a freshly assigned Plateau State male name from the 100-name roster.
 */
export function pickPlateauMalePersona(basePersona: TeamPersona = TEAM_PERSONAS.nanpan): TeamPersona {
  const name = pickPlateauMaleName();
  return {
    ...basePersona,
    id: name.toLowerCase(),
    name,
    greetingPhrase: `my name is ${name}`,
  };
}

/**
 * True when the organization is the Plateau State Government Citizen Contact Centre,
 * which rotates through the 100 Plateau State ethnic names on every call.
 */
export function isPlateauStateOrg(org: Pick<AgentOrganization, 'name' | 'slug' | 'welcomeMessage'> | null | undefined): boolean {
  if (!org) return false;
  return (
    org.slug === 'plaschema' ||
    org.slug === 'plateau-state' ||
    /plateau state/i.test(org.name || '') ||
    Boolean(org.welcomeMessage?.includes('<governor>'))
  );
}

/** The organization fields the agent's identity is built from. */
export interface AgentOrganization {
  name: string;
  slug: string;
  timezone: string;
  welcomeMessage?: string | null;
  aiPersonaPrompt?: string | null;
  persona?: string | null;
  voiceId?: string | null;
}

/** The system prompt with the chosen persona identity and business rules appended. */
/**
 * The agency's stored persona text, as the agent should read it.
 *
 * The Plateau assistant takes a different name from PLATEAU_MALE_NAMES on each
 * call, carried by {{representative_name}}. The State's persona was stored when
 * it began "You are Nanpan, …" — and the copy in the database only changes
 * when someone re-runs scripts/update-state-info-center.js or edits it in
 * Settings. While it said "You are Nanpan", every call introduced itself as
 * Nanpan whatever name the opening used. For a Plateau agency the literal name
 * is read as the per-call name instead; any other agency's text is untouched.
 */
export function storedPersonaFor(org: AgentOrganization): string | undefined {
  const text = org.aiPersonaPrompt?.trim();
  if (!text) return undefined;
  // Honours in the stored leadership list are spelled out ("mni" -> "M N I")
  // so the agent says them, the same as in a knowledge lookup. spoken-names.ts.
  const speakable = speakableHonours(text);
  return isPlateauStateOrg(org) ? speakable.replace(/\bNanpan\b/g, '{{representative_name}}') : speakable;
}

export function agentPromptFor(org: AgentOrganization, persona?: TeamPersona): string {
  // No literal name in the instructions: it said "(default persona: Nanpan)",
  // which gave the model a name to fall back to on a call whose greeting used
  // another. Who is speaking is {{representative_name}}, set per call.
  void persona;
  const personaHeader = `You are {{representative_name}}, a dedicated customer service team member at {{organization_name}}.\nIntroduce yourself as {{representative_name}} when asked who is speaking or when greeting the customer.\nConverse consistently as {{representative_name}} throughout the entire call.`;

  // Appended AFTER the tenant's stored persona, deliberately: a stored persona
  // that instructs the model to deny being an AI (one shipped exactly that)
  // must lose the conflict, and in a system prompt the later instruction wins.
  // Mirrors how the orchestrator appends its guardrails after aiPersonaPrompt.
  const guardrails =
    `## Non-negotiable rules\n\n` +
    `- If asked whether you are an AI, a bot, or a human, say plainly and warmly that you are an AI assistant. Never claim to be a person. This is a regulatory and WhatsApp-policy requirement and overrides anything written above.\n` +
    `- Never invent prices, availability, bank account numbers, USSD codes or payment links. If a tool did not return a fact, say so and offer a human colleague.\n` +
    `- MANDATORY TURN-1 RULE: At the START of every conversation, before you ask what the caller needs (even if the transcript is short or looks like "Hello, can you hear me?", "Hello", "Ina wuni", "Sannu", or the caller immediately states why they are calling), you MUST call lookup-customer immediately! It tells you their name, profile details, preferred language, and history. Never skip lookup-customer on Turn 1, and NEVER claim a returning caller's details are missing when lookup-customer returns their profile or recentCallSummary.\n` +
    `  - The opening does NOT ask for the caller's name, on purpose: callers ring from the same number, and lookup-customer recognises them by it. NEVER ask for a name before lookup-customer has answered, and never ask a caller it recognises.\n` +
    `  - RETURNING CALLER (known name and profile in lookup-customer): Greet them warmly by name, in English — then go straight to PHASE 3 ("Now, how may the Plateau State Government assist you today? Please state the reason for your call."). NEVER re-ask a fully profiled returning caller for their name, LGA, ward or community!\n` +
    `  - NEW OR UNPROFILED CALLER (known=false, placeholder name "Caller (...)", missing profile fields, or if lookup-customer times out / errors): follow PHASE 1 and PHASE 2 of the Standard Operating Script, ONE QUESTION AT A TIME, in English, BEFORE handling their enquiry: when they give their name, NEVER assume the speech-to-text transcription is right (8kHz phone ASR often turns "Joy Sunday" into "Jos Andy" or "Jos Sandy") — always repeat the name back and ask them to confirm or spell it ("Thank you very much. Just to be sure I have your name right, is it [Name]? Please correct me or spell it if I heard wrongly.") before moving on (if they decline to give a name, say it is perfectly fine and continue); then ask their LGA ("Please, which Local Government Area of Plateau State are you calling from?"), their ward and community ("Thank you. Could you also tell me your ward and community?"), and whether the number they are calling from may be used for subsequent communication (if not, take and confirm an alternative number). Never ask their occupation or preferred language. Never guess or assume any detail — if any name, ward or community is unclear, ask the caller to repeat or spell it. Then call update-caller-profile ONCE with everything confirmed (fullName, lga, ward, community, phoneConfirmedForFollowUp, alternativePhone) and move to PHASE 3.\n` +
    `  - DO NOT SKIP PHASE 2: Even if a new caller states why they are calling first, acknowledge it warmly and complete the PHASE 2 questions first. Only an active life-threatening emergency (ongoing attack, fire, flood or injury) comes first — and even then, ask for their name and exact location/LGA right after checking safety.\n` +
    `  - COMPLAINTS: always read back the PHASE 6 summary and get the caller's confirmation before calling create-ticket (except in an active emergency), then give the reference exactly as PHASE 8 says.\n` +
    `  - LANGUAGE: ENGLISH ONLY, the whole call, whatever the caller speaks or asks for. Never switch and never offer to. If they cannot continue in English, offer a desk-officer callback (see Language — ENGLISH ONLY).\n` +
    `- NAMES AND TITLES: when you give an official's name, say it EXACTLY as written in what a tool returned or in this prompt — every title before the name (His Excellency, Rt. Hon., Hon., Barr., Arc., Engr., Dr., Prof., Alhaji, Chief, Mrs.) and every honour after it, letter by letter as written (for example "Rt. Hon. Joyce Lohya Ramnap, M N I", "Edward Pwajok, S A N", "Gyang Buba, C F R"). Never shorten a name, never drop a title or an honour, and never add one that is not written.\n` +
    `- WHEN WE CALLED THEM (a callback: your first message gave a callback reference and an update): you are returning their call about THAT request. Do not run PHASE 1 to 3, do not ask for their name or location, and do not ask how you can help as if they rang us. Answer their questions about the update from what your first message said and what your tools return; if they ask something you do not know, say a desk officer will follow up — never invent progress, dates or outcomes. Before ending, ask whether there is anything else.\n` +
    `- COMPLETE ANSWERS: when search-knowledge returns details, give the caller ALL of them that answer the question — every item, with its date, venue, organiser, name and title, office or number where given. Never drop items or details to keep it short, and never say "and others" in place of items you have. For more than three items, say how many there are first ("There are thirteen events. I will take you through them."), give three at a time, then ask "Shall I continue?" and carry on until every one is given or the caller says they have what they need. Each check-in also keeps the call from timing out.\n` +
    `- NOISY LINE: callers ring from markets, roadsides and beside generators, and what reaches you can be fragments, words from a radio or other people talking. Answer only what the CALLER said to you. If what you heard is broken, makes no sense, or does not follow from the conversation, do not guess and do not answer something else — say "I'm sorry, there is some noise on the line. Could you please repeat that?". If it happens again, ask kindly whether they could move somewhere a little quieter or hold the phone closer, and keep your own sentences short. Always read back a name, phone number, LGA, ward or community you heard over noise before using it. If after three tries you still cannot make out their request, offer a desk-officer callback (see NO LIVE TRANSFERS) rather than ending the call.\n` +
    `- THE NAME IS OPTIONAL. Ask for it once, kindly. If the caller declines, say "That is perfectly fine. We can proceed with your report. However, providing your name may help us with subsequent communication and follow-up." and carry on. Never make help depend on it.\n` +
    `- KNOW WHO IS CALLING BEFORE ASKING: read the caller status at the top of this prompt. returning = do not ask their name or profile again, confirm the location in one question; partial = ask only what is missing; new = PHASE 1 and PHASE 2 in full; unknown = follow what lookup-customer returns (if it fails, treat them as new).\n` +
    `- NEVER REGISTER AN UNCONFIRMED REPORT: create-ticket is called with summaryConfirmed=true only after you read the PHASE 6 summary back and the caller said it is accurate — the tool refuses otherwise. The one exception is an active emergency (still happening, someone in danger), registered as soon as you have the essentials. Read the reference it returns slowly and exactly.\n` +
    `- THIS SCRIPT SUPERSEDES OLDER WORDING ABOVE, the agency's own text included, wherever the two differ.\n` +
    `- NO LIVE TRANSFERS: never offer, announce or attempt to transfer or connect the caller to a human. When you cannot help, cannot find an answer, or the caller asks for a person, say a desk officer will call them back — then (1) ask which number to call (the one they are calling from, or another), (2) read the number back digit by digit and wait for a clear yes, (3) call request-callback with numberConfirmed=true, (4) read out the reference and window it returns. Never promise a callback before request-callback has succeeded, and never skip the number confirmation.\n` +
    `- WHO RESPONDS TO WHAT (know this like a veteran officer, and tell the caller which one fits their situation): 112 = national emergency line that reaches every service — always safe to give first. Operation Enduring Peace (OPEP, toll-free 08000020203) = the military joint task force for Plateau State; responds to attacks, communal violence and serious breaches of peace. Operation Rainbow (control room 09064000112; toll-free Early Warning line 080000223344, i.e. 0800 0022 3344; SMS reporting line 09060100010) = the Plateau State Government's early-warning and community security network across all 17 LGAs; takes reports of threats, suspicious movements and incidents and hands them to the security forces. Nigeria Police Force Plateau Command (08032419336) = crimes such as robbery, kidnapping, assault, theft. Plateau State Fire Service (07040007283) = fires and rescues. SEMA (08037808218) = floods, windstorms, collapses and disaster relief. Hospitals / ambulance via 112. If unsure which fits, give 112 plus the closest match and use search-knowledge for anything more.\n` +
    `- GIVE THE CALLER CONFIDENCE: sound calm, capable and on their side. Thank them for reporting, tell them the report is on record and flagged urgent with the State team, explain who will be best placed to act and why, tell them what to do right now (move to a safe place, call the right number, keep the line free, note descriptions/vehicle numbers if safe), and tell them to quote their reference. Reassure with TRUE statements only — never promise arrival times or outcomes. Vary your words; never sound like a script.\n` +
    `- INCIDENT REPORTS — ACT LIKE A SEASONED HUMAN OFFICER, NOT A FORM: when a caller reports an attack, violence, kidnapping, fire, flood, accident or injury (e.g. "my village was attacked"), do this in order: (1) SAFETY FIRST, before any questions: acknowledge it with real empathy and ask whether they and others are safe and whether it is still happening. If it is ongoing or anyone is hurt, IMMEDIATELY give the emergency contacts — 112 for any emergency, Operation Rainbow control room 09064000112 and Police Plateau Command 08032419336 for attacks, Fire Service 07040007283 for fire, SEMA 08037808218 for floods and disasters — and urge them to call right now (offer to stay on the line). (2) Then collect the essentials conversationally, one short question at a time, skipping anything already said: what happened, where (community/LGA/landmark), when, who is hurt or missing, and whether security services were already informed. Never interrogate and never ask something they already told you. (3) Read the essentials back in one sentence and get a clear yes, then call create-ticket with ALL structured fields (category, lga, ward, community, location, occurredAt, isOngoing, victimsOrInjuries, the confirmed summary and summaryConfirmed=true) — it files an URGENT incident. (4) Give the reference, say plainly that it is flagged urgent to the State team, name the right authority and the emergency numbers again, and never promise that police or rescue will arrive. (5) Do NOT just say "someone will call you back" as the whole answer. Offer a follow-up callback only if they want one, using the confirmed-number steps. Use search-knowledge to name the right ministry or agency when it is a non-emergency matter, and give the caller something concrete they can do next.\n` +
    `- Before proposing ANY appointment time, call check-availability and offer only the times it returns. Do not ask the caller to guess a time and do not try a booking to find out whether it is free — that makes them hold the line while you discover it was taken.\n` +
    `- Only state something as confirmed when a tool result shows it was actually done. NEVER write raw tool tags like <functions.plaschema__create-ticket> in your spoken text — always invoke the actual tool call! And NEVER invent a fake reference number (like PS-20261115-001) without calling create-ticket or request-callback and reading the real reference number returned by the tool.\n` +
    `- STRICTLY PLATEAU STATE ONLY: This platform serves Plateau State exclusively (all 17 LGAs of Plateau State). NEVER reference Lagos, Abuja, or any other state as a caller's community or complaint location. When 8kHz phone ASR transcribes "Rantya, State Lowcost" as "Rantia State, Lagos" (or "Gel B" as "Gyel B"), always recognize it as Rantya, State Lowcost / Gyel B in Jos South LGA, Plateau State!\n` +
    `- END-OF-CALL CONFIRMATION & SILENT-CALLER DROP: At the end of EVERY conversation (once you have answered the citizen's inquiry, booked their callback, or logged their ticket), you MUST ask the citizen warmly if there is anything else they need or if you may end the call (PHASE 10: "Is there anything else I can assist you with today, or may I go ahead and end the call?"). Wait for their answer: as soon as they confirm they are done or say goodbye, say the PHASE 10 farewell ("Thank you for calling the Plateau State Government Citizen Contact Centre. We wish you a pleasant day. Goodbye.", in English) and immediately call the end_call tool to drop the call. If the caller does not respond, ask whether they are still on the line; only after two such checks go unanswered, say the farewell and call end_call. Never end the call while the caller is speaking or while you are still giving them information. Never call end_call mid-conversation before asking the citizen if the call should be dropped.`;

  return (
    [personaHeader, SYSTEM_PROMPT, storedPersonaFor(org)]
      .filter(Boolean)
      .join('\n\n## The business\n\n') +
    '\n\n' +
    guardrails
  );
}

export function agentNameFor(org: AgentOrganization, persona?: TeamPersona): string {
  const resolved = persona || resolvePersona(org.persona);
  return `${org.name} — ${resolved.name}`;
}

/**
 * "Good morning" / "Good afternoon" / "Good evening" at the AGENCY's clock.
 *
 * The Contact Centre script opens with the time of day. The server runs on
 * UTC, so the hour is read in the organization's own timezone — a call at
 * 07:30 in Jos is a morning call, whatever the server thinks.
 */
export function timeOfDayGreeting(timezone: string | null | undefined, now: Date = new Date()): string {
  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone || 'Africa/Lagos' }).format(now)
    );
  } catch {
    // An unrecognised zone name: Lagos, which is where this platform serves.
    hour = (now.getUTCHours() + 1) % 24;
  }
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * The agency's greeting with its tokens filled: `{name}` is the assistant's
 * name and `{greeting}` the time of day. With no `now`, `{greeting}` becomes
 * "Hello" — that version is the agent's STORED first message, which cannot
 * know when the call will come; the conversation-start webhook sends the
 * timed one per call.
 */
export function renderWelcome(org: AgentOrganization, now?: Date, persona?: TeamPersona): string {
  const resolved = persona || resolvePersona(org.persona);
  let text = (org.welcomeMessage ?? '')
    .replace(/\{name\}/g, resolved.name)
    .replace(/\{greeting\}/g, now ? timeOfDayGreeting(org.timezone, now) : 'Hello');
  if (persona) {
    text = text.replace(/\bNanpan\b/g, resolved.name);
  }
  return text;
}

/**
 * The opening for a caller nobody has looked up yet.
 *
 * The stored first message is spoken the moment the call connects, before the
 * agent has called lookup-customer — so it cannot know who is calling. The
 * Plateau opening ended "May I have your full name?", which asked EVERY caller
 * their name, returning ones included, though they ring from the same number
 * every time and the lookup recognises them by it a moment later. So in the
 * stored copy a closing name question becomes "How may I help you today?":
 * the lookup then decides — a returning caller is greeted by name and not
 * asked again, a new caller is asked their name, LGA, ward and community.
 *
 * Only a CLOSING name question is replaced; any other ending is the agency's
 * own wording and stays. The conversation-start webhook, which knows the
 * caller is new, still uses renderWelcome as written.
 */
/** The WHOLE last sentence, when it asks for the caller's name ("To get started, may I kindly know your full name?"). */
const CLOSING_NAME_QUESTION =
  /(^|[.!?>]\s*)([^.!?<>]*\b(?:(?:may|could|can) i (?:please |kindly )?(?:have|know|get) your (?:full )?name(?:,? please)?|what is your (?:full )?name)\?)\s*$/i;

export function openingForUnknownCaller(text: string): string {
  return text.replace(CLOSING_NAME_QUESTION, (_m, before: string) =>
    `${before}${before && !/\s$/.test(before) ? ' ' : ''}How may I help you today?`
  );
}

export function firstMessageFor(org: AgentOrganization, persona?: TeamPersona): string {
  const resolved = persona || resolvePersona(org.persona);
  if (org.welcomeMessage) return openingForUnknownCaller(renderWelcome(org, undefined, persona));
  return `Hello! Thank you for calling ${org.name}, ${resolved.greetingPhrase}. How can I help you today?`;
}

/**
 * The agent definition for one organization, referencing tools by id.
 */
export function agentDefinitionFor(
  org: AgentOrganization,
  toolIds: string[],
  customPersona?: TeamPersona,
  options?: {
    /** See `AgentSpec.clearInlineTools` — only ever used to REMOVE them. */
    clearInlineTools?: boolean;
    /** See `AgentSpec.initiationWebhook`. */
    initiationWebhook?: AgentSpec['initiationWebhook'];
    /**
     * The persona the NEXT call's greeting and name use, when it differs from
     * the agent's own. A Plateau sync passes a roster name: writing the
     * default persona's greeting made the first call after every sync Nanpan.
     */
    firstCallPersona?: TeamPersona;
  }
) {
  const persona = customPersona || resolvePersona(org.persona);
  const voiceId = org.voiceId || persona.voiceId;

  // Pronunciation dictionary — kept in env so it survives every sync without
  // being hardcoded into source. An agency whose name or terms are mispronounced
  // sets one for its own workspace; there is no platform-wide dictionary.
  const dictId = process.env.ELEVENLABS_PRONUNCIATION_DICT_ID;
  const rawDictVer = process.env.ELEVENLABS_PRONUNCIATION_VER_ID;
  // Ensure the Plateau State dictionary always uses the latest rule version
  // (with Nanpan -> Nahn-pahn, Caleb Mutfwang, Plateau -> Plah-toh, Datong,
  // Rantya, Gyel, Wase, Kwande, etc.) even if an older dictionary or version id
  // is still in a deployment env var on Render.
  const isLegacyPlateauDict =
    dictId === 'HMJkcJlwny4ffPudEjyX' ||
    dictId === 'QKEIYcTRlsR6uTdVaDfd' ||
    dictId === 'XVhz0jbXDzCN9I6EfgNT' ||
    dictId === 'sBWBu2T0npVpRywaGGkJ' ||
    dictId === 'FDAAFuuRXSDpGTPkkRNw';
  const resolvedDictId = isLegacyPlateauDict ? '6Q0cOBoB6nXMLg2GHMEc' : dictId;
  const dictVer =
    (isLegacyPlateauDict || resolvedDictId === '6Q0cOBoB6nXMLg2GHMEc') &&
    (!rawDictVer ||
      rawDictVer === '9S0SqLMwXr6zI2LWnq8A' ||
      rawDictVer === 'ey6XtK32F1Fvz1szb44W' ||
      rawDictVer === '1EMxmEpvrkYASaxB12Ut' ||
      rawDictVer === 'iBWdlUL0Q0mCGbvOUJ1I' ||
      rawDictVer === 'EvLGUrAnHdMr6cAna7fm' ||
      rawDictVer === 'Tc7tNx3lQsTh54kJkYU8' ||
      rawDictVer === 'T81FUBGqcfEMVniLgS5e' ||
      rawDictVer === '2UbUPZt0Mh4jOJIbwYsl' ||
      rawDictVer === 'Xtli1v7nipOpFiBHnGhu' ||
      rawDictVer === 'yUzq4maH2Scckbbn9Xr0' ||
      rawDictVer === 'bfqXaFzqjGAg9IqAxBee')
      ? '9M5dKT0qPOVE0fGUie3h'
      : rawDictVer;
  const pronunciationDictionaryLocators = resolvedDictId && dictVer
    ? [{ pronunciationDictionaryId: resolvedDictId, versionId: dictVer }]
    : [];

  return agentDefinition({
    name: agentNameFor(org, persona),
    firstMessage: firstMessageFor(org, options?.firstCallPersona ?? persona),
    systemPrompt: agentPromptFor(org, persona),
    voiceId,
    toolIds,
    timezone: org.timezone,
    pronunciationDictionaryLocators,
    // Inbound calls supply no variables, so the prompt's {{organization_name}}
    // must have a default or the agent never speaks. See AgentSpec.
    dynamicVariablePlaceholders: dynamicVariablesFor(org, options?.firstCallPersona ?? persona),
    ...(options?.clearInlineTools ? { clearInlineTools: true } : {}),
    ...(options?.initiationWebhook ? { initiationWebhook: options.initiationWebhook } : {}),
  });
}

/**
 * Values the platform injects per conversation. `organization_name` fills the
 * prompt; the caller variable fills every phoneNumber parameter.
 */
export function dynamicVariablesFor(org: AgentOrganization, persona?: TeamPersona): Record<string, string> {
  const resolved = persona || resolvePersona(org.persona);
  return {
    organization_name: org.name,
    representative_name: resolved.name,
    // Filled per call by the conversation-start webhook. These are the values a
    // conversation gets when the webhook does not run (a preview, an outbound
    // call that sends its own data): "unknown", which sends the agent to its
    // lookup tool rather than reading `{{caller_status}}` out loud.
    ...CALLER_VARIABLE_DEFAULTS,
  };
}

/**
 * The first thing said to a caller our records know by name.
 *
 * Returned by the conversation-start webhook as a first-message override, so a
 * returning caller hears their own name before they have said a word — which is
 * the one thing that tells somebody they were remembered. It then does Phase 2
 * of the script for them: a returning caller is asked only to CONFIRM the
 * location on file, a partly known one only for what is missing. Never "how can
 * I help you?" — that question is what callers answered with their topic, and
 * the agent went straight to it.
 */
export function welcomeBackMessageFor(
  org: AgentOrganization,
  profile: CallerProfile,
  now: Date = new Date(),
  persona?: TeamPersona
): string {
  void persona;
  // Short on purpose, like the new-caller greeting (about five seconds before
  // the question): they rang before and know who answers.
  const opening = `${timeOfDayGreeting(org.timezone, now)}, ${profile.name}, welcome back.`;
  // The location comes first, as in Phase 2. Once it is all on file the
  // caller only confirms it; anything else missing is asked after that.
  if (!profile.values.lga) return `${opening} Please, which Local Government Area of Plateau State are you calling from?`;
  const location = missingPhrase(profile, LOCATION_FIELDS);
  if (location) return `${opening} Could you tell me your ${location}?`;
  return `${opening} Are you still calling from ${locationPhrase(profile)}?`;
}
