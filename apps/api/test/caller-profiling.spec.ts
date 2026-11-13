/**
 * Collecting a new caller's five profile details — what fd15a41 changed.
 *
 * Two live calls skipped profiling entirely: the agent asked "How can I help
 * you today?", the caller answered with their topic, and the five questions
 * (full name, LGA, home address, occupation, preferred language) were never
 * asked. fd15a41 changed four things. This pins each one where it can be
 * pinned without a live model:
 *
 *  1. The first thing the agent says no longer invites the caller to state
 *     their business, and the prompt's FIRST section says to identify the
 *     caller before anything else, "can you hear me?" included.
 *  2. The instruction that let a caller skip profiling by naming a topic is
 *     gone from every place the agent's prompt is built from.
 *  3. `lookup-customer` tells the agent, in data it acts on, exactly which
 *     details are missing — for a number never seen, a placeholder "Caller
 *     (···1234)" left by an earlier unprofiled call, and a partly profiled
 *     record — and stops telling it "DO NOT claim their details are missing"
 *     about a caller whose details are missing.
 *  4. Every tool is given 25 seconds, not 10 (asserted on the definitions
 *     here, and on what a re-sync actually sends in elevenlabs-agent.spec.ts).
 *
 * What this cannot prove: that the model OBEYS the prompt. Only a real or
 * simulated conversation with the agent shows that.
 */
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { prisma } from '@ace/database';
import { AgentToolsModule } from '../src/agent-tools/agent-tools.module';
import { AgentToolsService } from '../src/agent-tools/agent-tools.service';
import { WorkflowTriggerModule } from '../src/workflows/workflow-trigger.module';
import { AGENT_KEY_PREFIX } from '../src/agent-tools/agent-key.guard';
import {
  SYSTEM_PROMPT,
  TOOL_NAMES,
  agentPromptFor,
  agentToolCatalog,
  dynamicVariablesFor,
  firstMessageFor,
} from '../src/agent-tools/agent-tool-catalog';

const FIVE_FIELDS = ['fullName', 'lga', 'homeAddress', 'occupation', 'preferredLanguage'];

/**
 * The Plateau tenant's greeting and persona live in a script that writes them
 * to the database (`scripts/update-state-info-center.js`), and the script runs
 * `main()` against a database when it is loaded. So the two constants are read
 * out of its source rather than required. If the script is restructured so
 * these can no longer be found, this fails by saying so — not by passing.
 */
function plateauConstant(name: 'STATE_WELCOME_MESSAGE' | 'STATE_PERSONA_PROMPT'): string {
  const source = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'update-state-info-center.js'), 'utf8');
  const match = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(source);
  if (!match) throw new Error(`${name} was not found in scripts/update-state-info-center.js`);
  return match[1];
}

/** Wording that, in any form, lets a caller skip profiling by having a question. */
const SKIP_LOOPHOLES = [
  /do not force them/i,
  /if (a|the) caller skips any (profile question|detail)/i,
  /urgent question first/i,
  /do not insist — save what you have/i,
];

describe('Collecting a new caller\'s five profile details', () => {
  // ── 3. What lookup-customer tells the agent ──────────────────────────────
  describe('lookup-customer', () => {
    let app: INestApplication;
    let orgId: string;
    let key: string;
    let seq = 0;
    const runId = randomBytes(2).readUInt16BE(0) % 10000;
    const phone = () => `+23490${String(runId).padStart(4, '0')}${String((seq += 1) % 10000).padStart(4, '0')}`;

    const lookup = (phoneNumber: string) =>
      request(app.getHttpServer())
        .post('/api/agent-tools/lookup-customer')
        .set('Authorization', `Bearer ${key}`)
        .send({ phoneNumber })
        .expect(201);

    /** What ElevenLabs sends as a call connects (see its personalization docs). */
    const callStarts = (caller_id: string, called_number = TOLL_FREE, withKey: string | null = key) => {
      const r = request(app.getHttpServer())
        .post('/api/agent-tools/conversation-start')
        .send({
          caller_id,
          called_number,
          agent_id: 'agent_test',
          call_sid: `CA${randomBytes(8).toString('hex')}`,
          conversation_id: `conv_${randomBytes(8).toString('hex')}`,
        });
      return withKey ? r.set('Authorization', `Bearer ${withKey}`) : r;
    };
    const TOLL_FREE = `+2348000${String(runId).padStart(4, '0')}456`.slice(0, 14);

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [WorkflowTriggerModule, AgentToolsModule],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();

      const org = await prisma.organization.create({
        data: {
          name: 'Profiling Test Centre',
          slug: `profiling-${randomBytes(4).toString('hex')}`,
          industry: 'GOVERNMENT',
        },
      });
      orgId = org.id;
      key = `${AGENT_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
      await prisma.apiKey.create({
        data: {
          organizationId: orgId,
          keyName: 'profiling test agent key',
          keyHash: createHash('sha256').update(key).digest('hex'),
          keyPrefix: key.slice(0, 20),
        },
      });
      // The agency's own line, so an outbound call can be told from an inbound one.
      await prisma.telephonyConfig.create({
        data: { organizationId: orgId, provider: 'SIP_TRUNK', phoneNumber: TOLL_FREE },
      });
    }, 60_000);

    afterAll(async () => {
      await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
      await app?.close();
    }, 60_000);

    it('a number never seen: all five details are missing, and the first question is the full name', async () => {
      const res = await lookup(phone());
      expect(res.body.ok).toBe(true);
      expect(res.body.data.known).toBe(false);
      expect(res.body.data.profileComplete).toBe(false);
      expect(res.body.data.missingProfileFields).toEqual(FIVE_FIELDS);
      expect(res.body.data.prompt).toMatch(/MANDATORY 5-QUESTION ONBOARDING/);
      expect(res.body.speak).toMatch(/full name/i);
      // It asks; it does not invite the caller to change the subject.
      expect(res.body.speak).not.toMatch(/how can I (help|assist)/i);
    });

    it('a placeholder left by an earlier unprofiled call is onboarded, not welcomed back', async () => {
      // conv_4201…: rang once, nobody took their details, a summary was stored.
      const number = phone();
      const contact = await prisma.contact.create({
        data: { organizationId: orgId, phoneNumber: number, fullName: `Caller (···${number.slice(-4)})` },
      });
      await prisma.callLog.create({
        data: {
          organizationId: orgId,
          contactId: contact.id,
          callSid: `profiling-${randomBytes(6).toString('hex')}`,
          fromNumber: number,
          toNumber: '+2348000000000',
          status: 'COMPLETED',
          summary: 'Caller asked about the Operation Rainbow reporting line.',
        },
      });

      const res = await lookup(number);
      expect(res.body.data.known).toBe(false);
      expect(res.body.data.nameIsPlaceholder).toBe(true);
      // Our placeholder is never handed to the agent as the caller's name.
      expect(res.body.data.fullName).toBeNull();
      expect(res.body.speak).not.toContain('Caller (');
      expect(res.body.data.prompt).toMatch(/MANDATORY 5-QUESTION ONBOARDING/);
      expect(res.body.data.prompt).toMatch(/full name/i);
      // The old branch: a previous summary turned an unprofiled caller into a
      // "returning" one whose details the agent must not call missing.
      expect(res.body.speak).not.toMatch(/welcome back/i);
      expect(res.body.data.prompt).not.toMatch(/DO NOT claim their details are missing/i);
      // The summary is still there for the agent to use.
      expect(res.body.data.recentCallSummary).toMatch(/Operation Rainbow/);
    });

    it('a partly profiled caller is greeted by name and asked only for what is missing', async () => {
      const number = phone();
      await prisma.contact.create({
        data: {
          organizationId: orgId,
          phoneNumber: number,
          fullName: 'Dachung Pam',
          city: 'Jos North',
          // No address, occupation or language yet.
        },
      });

      const res = await lookup(number);
      expect(res.body.data.known).toBe(true);
      expect(res.body.speak).toContain('Dachung Pam');
      expect(res.body.data.prompt).toMatch(/PARTIALLY PROFILED/);
      expect(res.body.data.prompt).toMatch(/LGA="Jos North"/);
      expect(res.body.data.prompt).toMatch(/Address="MISSING"/);
      expect(res.body.data.prompt).toMatch(/Occupation="MISSING"/);
      expect(res.body.data.prompt).toMatch(/PreferredLanguage="MISSING"/);
      // Not the five-question script: the name is on file and must not be re-asked.
      expect(res.body.data.prompt).not.toMatch(/MANDATORY 5-QUESTION ONBOARDING/);
    });

    it('a fully profiled caller is not asked any of the five again', async () => {
      const number = phone();
      await prisma.contact.create({
        data: {
          organizationId: orgId,
          phoneNumber: number,
          fullName: 'Hauwa Musa',
          city: 'Jos South',
          address: 'Rayfield Road',
          preferredLanguage: 'Hausa',
          metadata: { occupation: 'Teacher' },
        },
      });

      const res = await lookup(number);
      expect(res.body.data.known).toBe(true);
      expect(res.body.data.prompt).toMatch(/KNOWN RETURNING CALLER/);
      expect(res.body.data.prompt).toMatch(/DO NOT ASK FOR PROFILE DETAILS AGAIN/);
      // No field is reported missing (the phrase "DETAILS ARE MISSING" appears
      // only in the instruction NOT to claim so).
      expect(res.body.data.prompt).not.toMatch(/="MISSING"/);
      expect(res.body.data.prompt).toMatch(/Occupation="Teacher"/);
      // Greeted in the language on file.
      expect(res.body.speak).toMatch(/Barka da dawowa, Hauwa Musa/);
    });

    // ── Before the agent says a word ───────────────────────────────────────
    //
    // Recognising a caller used to depend on the model choosing to call
    // lookup-customer on its first turn, and in the calls that skipped
    // profiling it did not. These pin the conversation-start webhook, which
    // ElevenLabs calls as the line connects.
    describe('conversation-start', () => {
      const variablesTheAgentDefines = async () =>
        Object.keys(
          dynamicVariablesFor(
            (await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })) as any
          )
        );

      it('refuses a request without the agent key', async () => {
        await callStarts(phone(), TOLL_FREE, null).expect(401);
      });

      it('a number never seen: status new, all five missing, and the agency\'s own greeting', async () => {
        const res = await callStarts(phone()).expect(200);
        expect(res.body.type).toBe('conversation_initiation_client_data');
        expect(res.body.dynamic_variables).toMatchObject({
          organization_name: 'Profiling Test Centre',
          caller_status: 'new',
          caller_name: 'not on file',
          caller_missing_fields: 'full name, LGA, home address, occupation, preferred language',
        });
        expect(res.body.conversation_config_override).toBeUndefined();
      });

      it('returns every variable the agent defines — a missing one can stop the call starting', async () => {
        const res = await callStarts(phone()).expect(200);
        for (const name of await variablesTheAgentDefines()) {
          expect({ name, present: typeof res.body.dynamic_variables[name] === 'string' }).toEqual({ name, present: true });
        }
      });

      it('a fully profiled caller is greeted by name before saying anything, and asked nothing', async () => {
        const number = phone();
        await prisma.contact.create({
          data: {
            organizationId: orgId,
            phoneNumber: number,
            fullName: 'Hauwa Musa',
            city: 'Jos South',
            address: 'Rayfield Road',
            preferredLanguage: 'Hausa',
            metadata: { occupation: 'Teacher' },
          },
        });

        const res = await callStarts(number).expect(200);
        expect(res.body.dynamic_variables).toMatchObject({
          caller_status: 'returning',
          caller_name: 'Hauwa Musa',
          caller_missing_fields: 'none',
        });
        expect(res.body.dynamic_variables.caller_profile).toMatch(/LGA: Jos South/);
        expect(res.body.dynamic_variables.caller_profile).toMatch(/occupation: Teacher/);
        expect(res.body.conversation_config_override.agent.first_message).toMatch(/^Welcome back, Hauwa Musa!/);
      });

      it('finds a returning caller whatever shape the carrier sends the number in', async () => {
        const number = phone();
        await prisma.contact.create({
          data: { organizationId: orgId, phoneNumber: number, fullName: 'Ladi Gyang' },
        });
        // Stored as +234…; arriving as 0… or 234… must be the same person.
        const local = `0${number.slice(4)}`;
        const res = await callStarts(local).expect(200);
        expect(res.body.dynamic_variables.caller_name).toBe('Ladi Gyang');
      });

      it('a partly profiled caller is greeted by name and asked only for what is missing', async () => {
        const number = phone();
        await prisma.contact.create({
          data: { organizationId: orgId, phoneNumber: number, fullName: 'Dachung Pam', city: 'Jos North' },
        });
        const res = await callStarts(number).expect(200);
        expect(res.body.dynamic_variables).toMatchObject({
          caller_status: 'partial',
          caller_name: 'Dachung Pam',
          caller_missing_fields: 'home address, occupation, preferred language',
        });
        expect(res.body.conversation_config_override.agent.first_message).toMatch(/^Welcome back, Dachung Pam!/);
      });

      it('a placeholder name is a new caller: never read out, never welcomed back', async () => {
        const number = phone();
        await prisma.contact.create({
          data: { organizationId: orgId, phoneNumber: number, fullName: `Caller (···${number.slice(-4)})` },
        });
        const res = await callStarts(number).expect(200);
        expect(res.body.dynamic_variables.caller_status).toBe('new');
        expect(res.body.dynamic_variables.caller_name).toBe('not on file');
        expect(JSON.stringify(res.body)).not.toContain('Caller (');
        expect(res.body.conversation_config_override).toBeUndefined();
      });

      it('an outbound callback looks up the citizen it is calling, and keeps its own first message', async () => {
        const number = phone();
        await prisma.contact.create({
          data: { organizationId: orgId, phoneNumber: number, fullName: 'Kaneng Bot' },
        });
        // Outbound over the SIP trunk: caller_id is OUR line, called_number the citizen.
        const res = await callStarts(TOLL_FREE, number).expect(200);
        expect(res.body.dynamic_variables.caller_name).toBe('Kaneng Bot');
        // "Welcome back" is for somebody who rang us.
        expect(res.body.conversation_config_override).toBeUndefined();
      });

      it('a withheld number is a new caller, not an error', async () => {
        const res = await callStarts('anonymous').expect(200);
        expect(res.body.dynamic_variables.caller_status).toBe('new');
      });

      it('cannot see another agency\'s caller', async () => {
        const number = phone();
        const other = await prisma.organization.create({
          data: { name: 'Other Agency', slug: `other-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
        });
        try {
          await prisma.contact.create({
            data: { organizationId: other.id, phoneNumber: number, fullName: 'Somebody Else' },
          });
          const res = await callStarts(number).expect(200);
          expect(res.body.dynamic_variables.caller_status).toBe('new');
          expect(JSON.stringify(res.body)).not.toContain('Somebody Else');
        } finally {
          await prisma.organization.delete({ where: { id: other.id } }).catch(() => {});
        }
      });

      describe('when the records cannot be read', () => {
        const realBudget = AgentToolsService.CONVERSATION_START_BUDGET_MS;
        afterEach(() => {
          AgentToolsService.CONVERSATION_START_BUDGET_MS = realBudget;
          jest.restoreAllMocks();
        });

        it('answers "unknown" inside the deadline instead of holding the call', async () => {
          await callStarts(phone()).expect(200); // the agency's name is now known
          AgentToolsService.CONVERSATION_START_BUDGET_MS = 300;
          jest
            .spyOn(AgentToolsService.prototype as any, 'lookUpCaller')
            .mockImplementation(() => new Promise(() => undefined)); // a database that never answers

          const started = Date.now();
          const res = await callStarts(phone()).expect(200);
          expect(Date.now() - started).toBeLessThan(2_000);
          expect(res.body.dynamic_variables.caller_status).toBe('unknown');
          // Still every variable, and still the agency's real name.
          expect(res.body.dynamic_variables.organization_name).toBe('Profiling Test Centre');
          for (const name of await variablesTheAgentDefines()) {
            expect(typeof res.body.dynamic_variables[name]).toBe('string');
          }
          expect(res.body.conversation_config_override).toBeUndefined();
        });

        it('answers "unknown" when the lookup throws', async () => {
          jest
            .spyOn(AgentToolsService.prototype as any, 'lookUpCaller')
            .mockRejectedValue(new Error('connection pool exhausted'));
          const res = await callStarts(phone()).expect(200);
          expect(res.body.dynamic_variables.caller_status).toBe('unknown');
        });
      });

      it('the whole loop: unknown on the first call, details saved, greeted by name on the next', async () => {
        const number = phone();

        // Call 1 — nobody on file.
        const first = await callStarts(number).expect(200);
        expect(first.body.dynamic_variables.caller_status).toBe('new');

        // The agent collects the five details and saves them, as the prompt tells it to.
        await request(app.getHttpServer())
          .post('/api/agent-tools/update-caller-profile')
          .set('Authorization', `Bearer ${key}`)
          .send({
            phoneNumber: number,
            fullName: 'Nanret Davou',
            lga: 'Bokkos',
            homeAddress: 'Mushere Road',
            occupation: 'Farmer',
            preferredLanguage: 'English',
          })
          .expect(201);

        // Call 2 — recognised before a word is said, and by the tool as well.
        const second = await callStarts(number).expect(200);
        expect(second.body.dynamic_variables).toMatchObject({
          caller_status: 'returning',
          caller_name: 'Nanret Davou',
          caller_missing_fields: 'none',
        });
        expect(second.body.conversation_config_override.agent.first_message).toMatch(/^Welcome back, Nanret Davou!/);

        const tool = await lookup(number);
        expect(tool.body.data.known).toBe(true);
        expect(tool.body.speak).toContain('Nanret Davou');
        expect(tool.body.data.prompt).toMatch(/KNOWN RETURNING CALLER/);
      });
    });
  });

  // ── 1 and 2. What the agent is told before the caller says anything ──────
  describe('the prompt and the first message', () => {
    const plateau = {
      name: 'Plateau State Citizen Information Centre',
      slug: 'plateau-state',
      timezone: 'Africa/Lagos',
      welcomeMessage: plateauConstant('STATE_WELCOME_MESSAGE'),
      aiPersonaPrompt: plateauConstant('STATE_PERSONA_PROMPT'),
    };

    it('the Plateau greeting does not end by asking how it can help', () => {
      const first = firstMessageFor(plateau);
      expect(first).toBe(plateau.welcomeMessage);
      expect(first).toMatch(/Nanpan/);
      // "How can I help you today?" is what the caller answered with their
      // topic, and the agent then went straight to it.
      expect(first).not.toMatch(/how can I (help|assist)/i);
    });

    it('identifying the caller is the first section of the prompt, before anything about tone', () => {
      const prompt = agentPromptFor(plateau);
      const step1 = prompt.indexOf('## Step 1 of Every Call');
      expect(step1).toBeGreaterThan(-1);
      expect(step1).toBeLessThan(prompt.indexOf('## How You Sound'));
      // Before the agency's own persona text too, which comes after the shared prompt.
      expect(step1).toBeLessThan(prompt.indexOf(plateau.aiPersonaPrompt.slice(0, 60)));
      // The exact opening from conv_7301… is named, so it cannot be read as an exception.
      expect(SYSTEM_PROMPT).toMatch(/"Hello, can you hear me\?"/);
    });

    it('names all five details, in order, in the shared prompt', () => {
      const section = SYSTEM_PROMPT.slice(
        SYSTEM_PROMPT.indexOf('## Step 1 of Every Call'),
        SYSTEM_PROMPT.indexOf('## How You Sound')
      );
      const order = ['Full Name', 'Local Government Area', 'Home / Street Address', 'Occupation', 'Preferred Language'].map(
        (label) => section.indexOf(label)
      );
      expect(order.every((i) => i > -1)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('no source of the prompt still lets a caller skip profiling by having a question', () => {
      const sources = {
        'the shared prompt': SYSTEM_PROMPT,
        'the Plateau persona': plateau.aiPersonaPrompt,
        'the composed Plateau prompt': agentPromptFor(plateau),
      };
      for (const [where, text] of Object.entries(sources)) {
        for (const loophole of SKIP_LOOPHOLES) {
          expect({ where, found: loophole.test(text) }).toEqual({ where, found: false });
        }
      }
    });

    it('the rule against skipping comes after the agency persona, so a persona cannot undo it', () => {
      const prompt = agentPromptFor(plateau);
      const personaAt = prompt.indexOf(plateau.aiPersonaPrompt);
      expect(personaAt).toBeGreaterThan(-1);
      // Searched for AFTER the persona ends. The Plateau persona carries the
      // same sentence, and matching that copy would prove nothing about the
      // rules this code appends for every agency.
      const afterPersona = personaAt + plateau.aiPersonaPrompt.length;
      expect(prompt.indexOf('DO NOT SKIP THE 5 QUESTIONS', afterPersona)).toBeGreaterThan(-1);
    });

    it('a lookup that times out or fails is treated as a new caller, not as a reason to skip', () => {
      const prompt = agentPromptFor(plateau);
      expect(prompt).toMatch(/lookup-customer times out \/ errors/);
      expect(SYSTEM_PROMPT).toMatch(/times out or returns an error/);
    });

    it('an active emergency still comes first, and still asks for a name and LGA after safety', () => {
      // Without the Plateau persona, so this is the code's own rule for every
      // agency rather than a sentence the persona happens to repeat.
      const prompt = agentPromptFor({ ...plateau, aiPersonaPrompt: null });
      expect(prompt).toMatch(/life-threatening/i);
      expect(prompt).toMatch(/Full Name and (exact )?Location\/LGA right after checking safety/);
    });
  });

  // ── 4. How long each tool is given ───────────────────────────────────────
  describe('tool timeouts', () => {
    it('every one of the tools is given 25 seconds', () => {
      const catalog = agentToolCatalog({ baseUrl: 'https://api.example.test', authorization: 'Bearer test-key' });
      expect(Object.keys(catalog).sort()).toEqual([...TOOL_NAMES].sort());
      expect(TOOL_NAMES).toHaveLength(13);
      for (const name of TOOL_NAMES) {
        const config = catalog[name].toolConfig;
        const timeout = config.type === 'webhook' ? config.responseTimeoutSecs : `not a webhook (${config.type})`;
        expect({ name, timeout }).toEqual({ name, timeout: 25 });
      }
    });
  });
});
