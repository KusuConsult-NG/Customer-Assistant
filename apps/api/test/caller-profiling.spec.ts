/**
 * The Contact Centre's standard operating script, on the phone line.
 *
 * The State's script for the Citizen Contact Centre (Phases 1, 2, 3, 6, 8 and
 * 10) replaced the five compulsory profile questions. What it changes, and what
 * this pins without a live model:
 *
 *  - Phase 1: the greeting opens with the time of day and ends by asking the
 *    caller's full name — and the name is OPTIONAL.
 *  - Phase 2: the LGA, ward and community, and whether the calling number may
 *    be used for follow-up (or another number, read back first). Nothing else
 *    is asked: no home address, occupation or preferred language.
 *  - Phase 3: follow-up questions by area — infrastructure, healthcare,
 *    education, public administration.
 *  - Phase 6 → 8: the report is read back and confirmed BEFORE it is
 *    registered (unless it is an emergency still happening), then filed as a
 *    classified, located case with a reference and the office it belongs to.
 *  - A returning caller is greeted by name before saying a word and asked only
 *    to confirm their location.
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
import { runInNewContext } from 'vm';
import { prisma } from '@ace/database';
import { AgentToolsModule } from '../src/agent-tools/agent-tools.module';
import { AgentToolsService } from '../src/agent-tools/agent-tools.service';
import { WorkflowTriggerModule } from '../src/workflows/workflow-trigger.module';
import { AGENT_KEY_PREFIX } from '../src/agent-tools/agent-key.guard';
import { caseClassFor } from '../src/agent-tools/call-report';
import {
  SYSTEM_PROMPT,
  TOOL_NAMES,
  agentDefinitionFor,
  agentPromptFor,
  agentToolCatalog,
  dynamicVariablesFor,
  firstMessageFor,
  renderWelcome,
  timeOfDayGreeting,
} from '../src/agent-tools/agent-tool-catalog';

const SCRIPT_FIELDS = ['fullName', 'lga', 'ward', 'community'];

/**
 * The Plateau tenant's greeting and persona live in a script that writes them
 * to the database (`scripts/update-state-info-center.js`), and the script runs
 * `main()` against a database when it is loaded. So each constant's expression
 * is read out of its source and evaluated alone, in an empty context. If the
 * script is restructured so these can no longer be found, this fails by saying
 * so — not by passing.
 */
function plateauConstant(name: 'STATE_WELCOME_MESSAGE' | 'STATE_PERSONA_PROMPT'): string {
  const source = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'update-state-info-center.js'), 'utf8');
  const match = new RegExp(`const ${name} =\\s*([\\s\\S]*?\`);\\n`).exec(source);
  if (!match) throw new Error(`${name} was not found in scripts/update-state-info-center.js`);
  const value = runInNewContext(match[1], {});
  if (typeof value !== 'string') throw new Error(`${name} did not evaluate to a string`);
  return value;
}

/** The questions the old flow asked, which the script no longer asks. */
const DROPPED_QUESTIONS = [
  /what do you do for work/i,
  /May I also know your occupation/i,
  /which language do you prefer we speak/i,
  /which language would you prefer we speak/i,
  /->\s*occupation/i,
  /where do you stay/i,
  /area or street .*do you stay/i,
  /5 (basic )?profile details/i,
];

/** Wording that, in any form, makes a profile question compulsory. */
const COMPULSION = [/MANDATORY 5-QUESTION/i, /DO NOT SKIP THE 5 QUESTIONS/i, /must collect their 5/i];

describe('The Contact Centre script on the phone line', () => {
  describe('the tools, against a real database', () => {
    let app: INestApplication;
    let orgId: string;
    let key: string;
    let seq = 0;
    const runId = randomBytes(2).readUInt16BE(0) % 10000;
    const phone = () => `+23490${String(runId).padStart(4, '0')}${String((seq += 1) % 10000).padStart(4, '0')}`;
    const TOLL_FREE = `+2348000${String(runId).padStart(4, '0')}456`.slice(0, 14);

    const post = (path: string, body: any, status = 201) =>
      request(app.getHttpServer())
        .post(`/api/agent-tools/${path}`)
        .set('Authorization', `Bearer ${key}`)
        .send(body)
        .expect(status);
    const lookup = (phoneNumber: string) => post('lookup-customer', { phoneNumber });

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

    const known = (over: Record<string, any> = {}) =>
      prisma.contact.create({
        data: {
          organizationId: orgId,
          phoneNumber: phone(),
          fullName: 'Hauwa Musa',
          city: 'Jos South',
          metadata: { ward: 'Ali Kazaure', community: 'Angwan Rogo', phoneConfirmedForFollowUp: true },
          ...over,
        },
      });

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
          timezone: 'Africa/Lagos',
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

    // ── Phases 1–2: who is calling ─────────────────────────────────────────
    describe('lookup-customer', () => {
      it('a number never seen: the script from Phase 1, with only name and location missing', async () => {
        const res = await lookup(phone());
        expect(res.body.data.known).toBe(false);
        expect(res.body.data.missingProfileFields).toEqual(SCRIPT_FIELDS);
        expect(res.body.data.prompt).toMatch(/the name is optional/i);
        expect(res.body.data.prompt).toMatch(/ward and community/i);
        expect(res.body.data.prompt).toMatch(/Never ask for a home address, occupation or preferred language/);
        expect(res.body.speak).toBe('To get started, may I kindly know your full name?');
      });

      it('a placeholder left by an earlier call is a new caller, never welcomed back', async () => {
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
        expect(res.body.data.fullName).toBeNull();
        expect(res.body.speak).not.toContain('Caller (');
        expect(res.body.speak).not.toMatch(/welcome back/i);
        expect(res.body.data.prompt).toMatch(/^NEW CALLER/);
        expect(res.body.data.recentCallSummary).toMatch(/Operation Rainbow/);
      });

      it('known by name but not by place: asked only for what is missing', async () => {
        const number = phone();
        await prisma.contact.create({
          data: { organizationId: orgId, phoneNumber: number, fullName: 'Dachung Pam', city: 'Jos North' },
        });
        const res = await lookup(number);
        expect(res.body.data.known).toBe(true);
        expect(res.body.speak).toContain('Dachung Pam');
        expect(res.body.data.missingProfileFields).toEqual(['ward', 'community']);
        expect(res.body.data.prompt).toMatch(/ask ONLY for what is missing \(ward and community\)/);
        expect(res.body.data.prompt).not.toMatch(/^NEW CALLER/);
      });

      it('a returning caller is asked only to confirm where they are calling from', async () => {
        const c = await known({ preferredLanguage: 'Hausa' });
        const res = await lookup(c.phoneNumber);
        expect(res.body.data.profileComplete).toBe(true);
        expect(res.body.data.missingProfileFields).toEqual([]);
        expect(res.body.data.prompt).toMatch(/KNOWN RETURNING CALLER — do not ask for their name or location again/);
        expect(res.body.data.prompt).toContain('still calling from Angwan Rogo, Ali Kazaure ward, Jos South');
        expect(res.body.speak).toMatch(/Barka da dawowa, Hauwa Musa/);
        expect(res.body.data.prompt).toMatch(/call language_detection with 'ha' now/);
      });
    });

    describe('update-caller-profile', () => {
      it('saves the LGA in the State\'s spelling, the ward and community, and hands over to Phase 3', async () => {
        const number = phone();
        const res = await post('update-caller-profile', {
          phoneNumber: number,
          fullName: 'Nanret Davou',
          lga: 'jos north',
          ward: 'Ali Kazaure',
          community: 'Angwan Rogo',
          phoneConfirmedForFollowUp: 'yes',
        });
        expect(res.body.ok).toBe(true);
        expect(res.body.speak).toMatch(/how may the Plateau State Government assist you today\? Please state the reason for your call/);
        expect(res.body.data.instruction).toBeUndefined();
        const row = await prisma.contact.findFirst({ where: { organizationId: orgId, phoneNumber: number } });
        expect(row?.city).toBe('Jos North');
        expect(row?.metadata).toMatchObject({ ward: 'Ali Kazaure', community: 'Angwan Rogo', phoneConfirmedForFollowUp: true });
      });

      it('still saves an occupation or language a caller volunteers — it is never asked', async () => {
        const number = phone();
        const res = await post('update-caller-profile', {
          phoneNumber: number,
          lga: 'Mangu',
          ward: 'Mangu Halle',
          community: 'Mangu Town',
          occupation: 'Farmer',
          preferredLanguage: 'Hausa',
          phoneConfirmedForFollowUp: true,
        });
        expect(res.body.data.stillMissing).toEqual([]);
        const row = await prisma.contact.findFirst({ where: { organizationId: orgId, phoneNumber: number } });
        expect(row?.preferredLanguage).toBe('Hausa');
        expect(row?.metadata).toMatchObject({ occupation: 'Farmer' });
      });

      it('with the location complete, asks about the follow-up number next — nothing else', async () => {
        const res = await post('update-caller-profile', {
          phoneNumber: phone(),
          fullName: 'Pam Dung',
          lga: 'Riyom',
          ward: 'Riyom',
          community: 'Rim',
        });
        expect(res.body.speak).toBe('');
        expect(res.body.data.instruction).toMatch(/Next: Ask whether they are comfortable with us using the number they are calling from/);
        expect(res.body.data.instruction).not.toMatch(/occupation|language/i);
      });

      it('works without a name — the script says the name is optional', async () => {
        const number = phone();
        const res = await post('update-caller-profile', {
          phoneNumber: number,
          lga: 'Pankshin',
          ward: 'Chip',
          community: 'Kabwir',
          phoneConfirmedForFollowUp: true,
        });
        expect(res.body.ok).toBe(true);
        expect(res.body.data.fullName).toBeNull();
        // The location they gave is not asked for again because the name is absent.
        expect(res.body.data.stillMissing).toEqual([]);
        expect(res.body.data.instruction).toBeUndefined();
        const row = await prisma.contact.findFirst({ where: { organizationId: orgId, phoneNumber: number } });
        expect(row?.city).toBe('Pankshin');
      });

      it('does not move on to the reason for the call while the location is incomplete', async () => {
        const res = await post('update-caller-profile', { phoneNumber: phone(), fullName: 'Ladi Gyang', lga: 'Bokkos' });
        expect(res.body.speak).toBe('');
        expect(res.body.data.instruction).toMatch(/Next: Ask for their ward and community/);
      });

      it('saves another follow-up number only after it was read back and confirmed', async () => {
        const number = phone();
        const unconfirmed = await post('update-caller-profile', {
          phoneNumber: number,
          fullName: 'Kaneng Bot',
          alternativePhone: '0803 123 4567',
        });
        expect(unconfirmed.body.ok).toBe(false);
        expect(unconfirmed.body.data.numberToConfirm).toBe('+2348031234567');
        expect(await prisma.contact.findFirst({ where: { organizationId: orgId, phoneNumber: number } })).toBeNull();

        await post('update-caller-profile', {
          phoneNumber: number,
          fullName: 'Kaneng Bot',
          alternativePhone: '0803 123 4567',
          alternativePhoneConfirmed: true,
        });
        const row = await prisma.contact.findFirst({ where: { organizationId: orgId, phoneNumber: number } });
        expect(row?.metadata).toMatchObject({ alternativePhone: '+2348031234567', phoneConfirmedForFollowUp: false });
      });
    });

    // ── "If caller ID is available" ───────────────────────────────────────
    describe('a caller whose number does not show', () => {
      // A forwarded toll-free call arrives as our own line; a withheld one as
      // "anonymous". Neither reaches the caller, and the first must never be
      // treated as one person who keeps calling.
      beforeAll(async () => {
        await prisma.contact.upsert({
          where: { organizationId_phoneNumber: { organizationId: orgId, phoneNumber: TOLL_FREE } },
          create: { organizationId: orgId, phoneNumber: TOLL_FREE, fullName: 'Someone Earlier', city: 'Jos North' },
          update: { fullName: 'Someone Earlier' },
        });
      });
      const ourLineRecord = () =>
        prisma.contact.findUniqueOrThrow({ where: { organizationId_phoneNumber: { organizationId: orgId, phoneNumber: TOLL_FREE } } });

      it('lookup-customer finds nobody, and says to ask for a number instead of the consent question', async () => {
        const res = await lookup(TOLL_FREE);
        expect(res.body.data).toMatchObject({ known: false, numberShown: false });
        expect(res.body.data.prompt).toMatch(/^NUMBER NOT SHOWN/);
        expect(res.body.data.prompt).toMatch(/Could you please give me a telephone number we can reach you on/);
        expect(res.body.data.prompt).toMatch(/do not ask whether we may use the number they are calling from/);
        expect(JSON.stringify(res.body)).not.toContain('Someone Earlier');
      });

      it('update-caller-profile saves nothing until there is a number to save it against', async () => {
        const res = await post('update-caller-profile', { phoneNumber: 'anonymous', fullName: 'Nanret Davou', lga: 'Bokkos' });
        expect(res.body).toMatchObject({ ok: false, data: { saved: false, numberShown: false } });
        expect(res.body.data.instruction).toMatch(/Could you please give me a telephone number/);
        expect(await prisma.contact.count({ where: { organizationId: orgId, fullName: 'Nanret Davou', city: 'Bokkos' } })).toBe(0);
      });

      it('saves the details against the number they gave, once read back — never against our own line', async () => {
        const given = phone();
        const unconfirmed = await post('update-caller-profile', { phoneNumber: TOLL_FREE, fullName: 'Pam Dung', alternativePhone: given });
        expect(unconfirmed.body.data.numberToConfirm).toBe(given);

        const res = await post('update-caller-profile', {
          phoneNumber: TOLL_FREE,
          fullName: 'Pam Dung',
          lga: 'Riyom',
          ward: 'Riyom',
          community: 'Rim',
          alternativePhone: given,
          alternativePhoneConfirmed: true,
        });
        expect(res.body.ok).toBe(true);
        const row = await prisma.contact.findFirstOrThrow({ where: { organizationId: orgId, phoneNumber: given } });
        expect(row).toMatchObject({ fullName: 'Pam Dung', city: 'Riyom' });
        // The record IS the number they gave, so that is the one to use.
        expect(row.metadata).toMatchObject({ phoneConfirmedForFollowUp: true, alternativePhone: null });
        expect(await ourLineRecord()).toMatchObject({ fullName: 'Someone Earlier', city: 'Jos North' });
      });

      it('create-ticket registers nothing without a number, and says what to do instead', async () => {
        const res = await post('create-ticket', {
          phoneNumber: TOLL_FREE,
          subject: 'Broken borehole',
          description: 'The borehole in our community has been broken for a month.',
          category: 'infrastructure',
          summary: 'A broken borehole.',
          summaryConfirmed: true,
        });
        expect(res.body).toMatchObject({ ok: false, data: { filed: false, numberShown: false } });
        expect(res.body.data.instruction).toMatch(/they may ask for their name to be kept confidential/);
        expect(await prisma.ticket.count({ where: { organizationId: orgId, subject: 'Broken borehole' } })).toBe(0);
      });

      it('files the report against the number they gave', async () => {
        const given = phone();
        const res = await post('create-ticket', {
          phoneNumber: 'anonymous',
          fullName: 'Ladi Gyang',
          subject: 'Broken borehole at Rim',
          description: 'The borehole in our community has been broken for a month.',
          category: 'infrastructure',
          summary: 'A broken borehole at Rim.',
          summaryConfirmed: true,
          alternativePhone: given,
          alternativePhoneConfirmed: true,
        });
        expect(res.body.ok).toBe(true);
        const c = await prisma.ticket.findUniqueOrThrow({ where: { ticketNumber: res.body.data.ticketNumber }, include: { contact: true } });
        expect(c.contact.phoneNumber).toBe(given);
        expect(c.description).toMatch(new RegExp(`calling number not shown; reachable on \\${given}`));
      });

      it('the prompt asks the consent question only if caller ID is available, as the document does', () => {
        expect(SYSTEM_PROMPT).toMatch(/only if caller ID is available \(caller status is not withheld\)/);
        expect(SYSTEM_PROMPT).toMatch(/- \*\*withheld\*\* — the number this call comes from is hidden, or is one of our own lines/);
      });
    });

    // ── Phases 6 → 8: nothing is registered until the caller confirms ─────
    describe('create-ticket', () => {
      const report = (over: Record<string, any> = {}) => ({
        phoneNumber: phone(),
        fullName: 'Nanret Davou',
        subject: 'Collapsed culvert',
        description: 'The culvert on the main road has collapsed and there are deep potholes; cars cannot pass.',
        category: 'infrastructure',
        lga: 'jos south',
        ward: 'Vom',
        community: 'Vom Junction',
        occurredAt: 'last week',
        impact: 'Traders cannot reach the market',
        previouslyReported: 'No',
        summary: 'A collapsed culvert and potholes at Vom Junction, Vom ward, Jos South, since last week.',
        summaryConfirmed: true,
        ...over,
      });
      const caseFor = (ticketNumber: string) =>
        prisma.ticket.findUnique({ where: { ticketNumber }, include: { events: true } });

      it('registers nothing until the caller has confirmed the read-back', async () => {
        const r = report({ summaryConfirmed: false });
        const res = await post('create-ticket', r);
        expect(res.body.ok).toBe(false);
        expect(res.body.data.filed).toBe(false);
        expect(res.body.data.instruction).toMatch(/Is this an accurate summary of your complaint\?/);
        const contact = await prisma.contact.findFirst({ where: { organizationId: orgId, phoneNumber: r.phoneNumber } });
        expect(contact).toBeNull();
      });

      it('files a classified, located case with the confirmed summary, and reads back the reference', async () => {
        const res = await post('create-ticket', report());
        expect(res.body.ok).toBe(true);
        const ref = res.body.data.ticketNumber;
        expect(res.body.speak).toContain(`Your unique complaint reference number is ${ref}`);
        expect(res.body.speak).toMatch(/Please keep this number safe/);
        // Phase 8 in the document's words, and nothing more: the office is
        // recorded on the case, not announced.
        expect(res.body.speak).toMatch(
          /^Thank you for your patience\. Your report has now been registered in our system\. Your unique complaint reference number is /
        );
        expect(res.body.speak).not.toMatch(/directed to|routed to|marked for|attention of|Ministry/);
        // Phase 10, then the question main added so nobody is hung up on.
        expect(res.body.speak).toContain(
          `Once again, thank you, Nanret Davou, for contacting the Plateau State Government Citizen Contact Centre. ` +
            `Your report has been recorded under reference number ${ref}.`
        );
        expect(res.body.speak).toMatch(/Your voice matters/);
        expect(res.body.speak).toMatch(/Is there anything else I can assist you with today, or may I go ahead and end the call\?$/);

        const c = await caseFor(ref);
        expect(c).toMatchObject({
          // "Potholes" makes an infrastructure report a ROADS case.
          category: 'roads',
          caseStage: 'CLASSIFIED',
          lga: 'Jos South',
          ward: 'Vom',
          community: 'Vom Junction',
          channel: 'VOICE',
          // What the caller was told is what the case says.
          responsibleMda: 'Plateau State Ministry of Works / Jos Metropolitan Development Board (JMDB)',
          summary: 'A collapsed culvert and potholes at Vom Junction, Vom ward, Jos South, since last week.',
        });
        expect(c?.description).toMatch(/Effect: Traders cannot reach the market/);
        expect(c?.description).toMatch(/When: last week/);
        expect(c?.dueAt).toBeTruthy();
        expect(c?.events).toEqual([
          expect.objectContaining({ type: 'CREATED', toStage: 'CLASSIFIED', actorLabel: 'system:voice-agent' }),
        ]);
      });

      it('a road that collapsed last week is a complaint — no emergency numbers read out', async () => {
        const res = await post('create-ticket', report());
        expect(res.body.speak).not.toMatch(/SEMA|1 1 2|urgent incident/i);
        expect(res.body.data.incidentKind).toBeUndefined();
      });

      it('the same collapse while people are still in danger IS an emergency', async () => {
        const res = await post(
          'create-ticket',
          report({ description: 'The bridge is collapsing right now and two people are trapped.', isOngoing: true })
        );
        expect(res.body.data.incidentKind).toBe('disaster');
        expect(res.body.speak).toMatch(/Your report has now been registered in our system as urgent/);
        expect(res.body.speak).toMatch(/Emergency Management Agency, SEMA/);
        expect(res.body.speak).toMatch(/1 1 2/);
      });

      it('an emergency still happening is registered without waiting for a read-back', async () => {
        const res = await post(
          'create-ticket',
          report({
            description: 'Our house is on fire right now and a child is inside.',
            category: 'fire',
            isOngoing: true,
            summary: undefined,
            summaryConfirmed: undefined,
          })
        );
        expect(res.body.ok).toBe(true);
        expect(res.body.data.incidentKind).toBe('fire');
        const c = await caseFor(res.body.data.ticketNumber);
        expect(c?.responsibleMda).toBe('Plateau State Fire Service');
        expect(c?.events[0]?.body).toMatch(/emergency still in progress, without a read-back/);
      });

      it('an incident that is over is not an exception: still read back first', async () => {
        const res = await post(
          'create-ticket',
          report({ category: 'security attack', description: 'Gunmen attacked our village last night.', isOngoing: false, summaryConfirmed: undefined })
        );
        expect(res.body.ok).toBe(false);
        expect(res.body.data.filed).toBe(false);
      });

      it('marks the office from the same classification as the category — "ward" in a water report is not a hospital', async () => {
        const res = await post(
          'create-ticket',
          report({ description: 'There has been no water from the public tap in our ward for a month.' })
        );
        const c = await caseFor(res.body.data.ticketNumber);
        expect(c?.category).toBe('water');
        expect(c?.responsibleMda).toMatch(/Ministry of Works/);
      });

      it('an office the caller names is the one the case is marked for', async () => {
        const res = await post('create-ticket', report({ targetMda: 'Plateau State Water Board' }));
        expect(res.body.data.routedToMda).toBe('Plateau State Water Board');
        expect((await caseFor(res.body.data.ticketNumber))?.responsibleMda).toBe('Plateau State Water Board');
      });

      it('an attack is an incident whether or not it is still going on', async () => {
        const res = await post(
          'create-ticket',
          report({ category: 'security attack', description: 'Gunmen attacked our village last night.', isOngoing: false })
        );
        expect(res.body.data.incidentKind).toBe('security');
        const c = await caseFor(res.body.data.ticketNumber);
        expect(c?.category).toBe('security');
        expect(c?.isSensitive).toBe(true);
      });

      it('keeps infrastructure as the category when the words narrow nothing', async () => {
        const res = await post('create-ticket', report({ description: 'The new market stalls are unfinished and unsafe.' }));
        expect((await caseFor(res.body.data.ticketNumber))?.category).toBe('infrastructure');
      });

      it('files a bribe at a government office as misconduct, which is sensitive', async () => {
        const res = await post(
          'create-ticket',
          report({
            category: 'public administration',
            institution: 'Land registry',
            description: 'An officer at the land registry demanded money before releasing my file.',
          })
        );
        const c = await caseFor(res.body.data.ticketNumber);
        expect(c?.category).toBe('misconduct');
        expect(c?.isSensitive).toBe(true);
        expect(c?.description).toMatch(/Facility \/ office involved: Land registry/);
      });

      it('records a healthcare report that somebody needs urgent medical attention', async () => {
        const res = await post(
          'create-ticket',
          report({
            category: 'healthcare',
            institution: 'Comprehensive Health Centre Vom',
            description: 'There is no doctor on duty at the health centre.',
            urgentMedicalAttention: true,
          })
        );
        const c = await caseFor(res.body.data.ticketNumber);
        expect(c?.category).toBe('health');
        expect(c?.description).toMatch(/Somebody needs URGENT medical attention/);
      });

      it('honours a request not to use the caller\'s name', async () => {
        const res = await post('create-ticket', report({ category: 'education', description: 'Teachers have not come to the school for two weeks.', anonymous: true }));
        const c = await caseFor(res.body.data.ticketNumber);
        expect(c?.category).toBe('education');
        expect(c?.isAnonymous).toBe(true);
      });
    });

    // ── Before the agent says a word ───────────────────────────────────────
    describe('conversation-start', () => {
      const variablesTheAgentDefines = async () =>
        Object.keys(dynamicVariablesFor((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })) as any));

      it('refuses a request without the agent key', async () => {
        await callStarts(phone(), TOLL_FREE, null).expect(401);
      });

      it('a number never seen: status new, missing only name and location', async () => {
        const res = await callStarts(phone()).expect(200);
        expect(res.body.type).toBe('conversation_initiation_client_data');
        expect(res.body.dynamic_variables).toMatchObject({
          organization_name: 'Profiling Test Centre',
          caller_status: 'new',
          caller_name: 'not on file',
          caller_missing_fields: 'full name, LGA, ward, community',
        });
        // This agency's greeting asks for no time of day, so there is nothing to override.
        expect(res.body.conversation_config_override).toBeUndefined();
      });

      it('returns every variable the agent defines — a missing one can stop the call starting', async () => {
        const res = await callStarts(phone()).expect(200);
        for (const name of await variablesTheAgentDefines()) {
          expect({ name, present: typeof res.body.dynamic_variables[name] === 'string' }).toEqual({ name, present: true });
        }
      });

      it('a returning caller is greeted by name and asked only to confirm where they are', async () => {
        const c = await known();
        const res = await callStarts(c.phoneNumber).expect(200);
        expect(res.body.dynamic_variables).toMatchObject({
          caller_status: 'returning',
          caller_name: 'Hauwa Musa',
          caller_missing_fields: 'none',
        });
        expect(res.body.dynamic_variables.caller_profile).toMatch(/ward: Ali Kazaure; community: Angwan Rogo; follow-up number: calling number/);
        expect(res.body.dynamic_variables.caller_profile).not.toMatch(/occupation|language/);
        const first = res.body.conversation_config_override.agent.first_message;
        expect(first).toMatch(/^Good (morning|afternoon|evening), Hauwa Musa, and welcome back to Profiling Test Centre\./);
        expect(first).toMatch(/Are you still calling from Angwan Rogo, Ali Kazaure ward, Jos South\?$/);
        expect(first).not.toMatch(/how (can|may) I (help|assist)/i);
      });

      it('a caller known by name but not by LGA is asked for the LGA, in the script\'s words', async () => {
        const c = await known({ city: null });
        const res = await callStarts(c.phoneNumber).expect(200);
        expect(res.body.conversation_config_override.agent.first_message).toMatch(
          /Please, which Local Government Area of Plateau State are you calling from\?$/
        );
      });

      it('a caller who never gave an occupation or language is still a returning caller', async () => {
        const c = await known({ preferredLanguage: null });
        const res = await callStarts(c.phoneNumber).expect(200);
        expect(res.body.dynamic_variables).toMatchObject({ caller_status: 'returning', caller_missing_fields: 'none' });
      });

      it('known by name and LGA only: asked for the ward and community, in words', async () => {
        const c = await known({ metadata: {} });
        const res = await callStarts(c.phoneNumber).expect(200);
        expect(res.body.conversation_config_override.agent.first_message).toMatch(/Could you tell me your ward and community\?$/);
      });

      it('finds a returning caller whatever shape the carrier sends the number in', async () => {
        const c = await known({ fullName: 'Ladi Gyang' });
        const res = await callStarts(`0${c.phoneNumber.slice(4)}`).expect(200);
        expect(res.body.dynamic_variables.caller_name).toBe('Ladi Gyang');
      });

      it('a placeholder name is a new caller: never read out, never welcomed back', async () => {
        const number = phone();
        await prisma.contact.create({
          data: { organizationId: orgId, phoneNumber: number, fullName: `Caller (···${number.slice(-4)})` },
        });
        const res = await callStarts(number).expect(200);
        expect(res.body.dynamic_variables.caller_status).toBe('new');
        expect(JSON.stringify(res.body)).not.toContain('Caller (');
        expect(res.body.conversation_config_override).toBeUndefined();
      });

      it('an outbound callback looks up the citizen it is calling, and keeps its own first message', async () => {
        const c = await known({ fullName: 'Kaneng Bot' });
        const res = await callStarts(TOLL_FREE, c.phoneNumber).expect(200);
        expect(res.body.dynamic_variables.caller_name).toBe('Kaneng Bot');
        expect(res.body.conversation_config_override).toBeUndefined();
      });

      it('a withheld number is a caller whose number does not show, not an error', async () => {
        const res = await callStarts('anonymous').expect(200);
        expect(res.body.dynamic_variables.caller_status).toBe('withheld');
        expect(res.body.dynamic_variables.caller_profile).toMatch(/number not shown/);
      });

      it('a forwarded call arriving as our own number is never matched to whoever was saved against it', async () => {
        await prisma.contact.upsert({
          where: { organizationId_phoneNumber: { organizationId: orgId, phoneNumber: TOLL_FREE } },
          create: { organizationId: orgId, phoneNumber: TOLL_FREE, fullName: 'Someone Earlier', city: 'Jos North' },
          update: { fullName: 'Someone Earlier' },
        });
        const res = await callStarts(TOLL_FREE, TOLL_FREE).expect(200);
        expect(res.body.dynamic_variables.caller_status).toBe('withheld');
        expect(JSON.stringify(res.body)).not.toContain('Someone Earlier');
      });

      it('cannot see another agency\'s caller', async () => {
        const number = phone();
        const other = await prisma.organization.create({
          data: { name: 'Other Agency', slug: `other-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
        });
        try {
          await prisma.contact.create({ data: { organizationId: other.id, phoneNumber: number, fullName: 'Somebody Else' } });
          const res = await callStarts(number).expect(200);
          expect(res.body.dynamic_variables.caller_status).toBe('new');
          expect(JSON.stringify(res.body)).not.toContain('Somebody Else');
        } finally {
          await prisma.organization.delete({ where: { id: other.id } }).catch(() => {});
        }
      });

      describe('an agency whose greeting asks for the time of day', () => {
        const greeting =
          '{greeting}, and welcome to the Profiling Test Centre. My name is {name}. To get started, may I kindly know your full name?';
        beforeAll(async () => {
          await prisma.organization.update({ where: { id: orgId }, data: { welcomeMessage: greeting } });
        });
        afterAll(async () => {
          await prisma.organization.update({ where: { id: orgId }, data: { welcomeMessage: null } });
        });

        it('opens a new caller\'s call with "Good morning" (or afternoon, or evening) at the agency\'s own clock', async () => {
          const before = timeOfDayGreeting('Africa/Lagos');
          const res = await callStarts(phone()).expect(200);
          const after = timeOfDayGreeting('Africa/Lagos');
          const first = res.body.conversation_config_override.agent.first_message;
          expect([before, after]).toContain(first.split(',')[0]);
          expect(first).toMatch(/My name is Nanpan\. To get started, may I kindly know your full name\?$/);
          expect(first).not.toContain('{');
        });

        const realBudget = AgentToolsService.CONVERSATION_START_BUDGET_MS;
        afterEach(() => {
          AgentToolsService.CONVERSATION_START_BUDGET_MS = realBudget;
          jest.restoreAllMocks();
        });

        it('still says the time of day when the records cannot be read', async () => {
          await callStarts(phone()).expect(200); // the agency is now cached
          jest.spyOn(AgentToolsService.prototype as any, 'lookUpCaller').mockRejectedValue(new Error('pool exhausted'));
          const res = await callStarts(phone()).expect(200);
          expect(res.body.dynamic_variables.caller_status).toBe('unknown');
          expect(res.body.conversation_config_override.agent.first_message).toMatch(/^Good (morning|afternoon|evening), and welcome/);
        });
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
          expect(res.body.dynamic_variables.organization_name).toBe('Profiling Test Centre');
          for (const name of await variablesTheAgentDefines()) {
            expect(typeof res.body.dynamic_variables[name]).toBe('string');
          }
        });

        it('answers "unknown" when the lookup throws', async () => {
          jest.spyOn(AgentToolsService.prototype as any, 'lookUpCaller').mockRejectedValue(new Error('connection pool exhausted'));
          const res = await callStarts(phone()).expect(200);
          expect(res.body.dynamic_variables.caller_status).toBe('unknown');
        });
      });

      it('the whole loop: a new caller gives their details, and is greeted by name next time', async () => {
        const number = phone();

        const first = await callStarts(number).expect(200);
        expect(first.body.dynamic_variables.caller_status).toBe('new');

        // Phases 1–2, saved as the agent is told to.
        await post('update-caller-profile', {
          phoneNumber: number,
          fullName: 'Nanret Davou',
          lga: 'Bokkos',
          ward: 'Mushere',
          community: 'Mushere Central',
          phoneConfirmedForFollowUp: true,
        });

        const second = await callStarts(number).expect(200);
        expect(second.body.dynamic_variables).toMatchObject({ caller_status: 'returning', caller_name: 'Nanret Davou' });
        expect(second.body.conversation_config_override.agent.first_message).toMatch(
          /Nanret Davou, and welcome back .* Are you still calling from Mushere Central, Mushere ward, Bokkos\?$/
        );

        const tool = await lookup(number);
        expect(tool.body.data.known).toBe(true);
        expect(tool.body.data.prompt).toMatch(/KNOWN RETURNING CALLER/);
      });
    });
  });

  // ── What the agent is told ──────────────────────────────────────────────
  describe('the prompt and the first message', () => {
    const plateau = {
      name: 'Plateau State Government Citizen Contact Centre',
      slug: 'plateau-state',
      timezone: 'Africa/Lagos',
      welcomeMessage: plateauConstant('STATE_WELCOME_MESSAGE'),
      aiPersonaPrompt: plateauConstant('STATE_PERSONA_PROMPT'),
    };
    const shared = (o = plateau) => agentPromptFor({ ...o, aiPersonaPrompt: null });

    it('the Plateau greeting is Phase 1, timed, and ends by asking the name', () => {
      const morning = renderWelcome(plateau, new Date('2026-11-13T07:00:00Z')); // 08:00 in Jos
      expect(morning).toMatch(/^Good morning, and welcome to the Plateau State Government Citizen Contact Centre\. Thank you for calling\./);
      expect(morning).toMatch(/My name is Nanpan, and I am your virtual assistant from the Ministry of Information\./);
      expect(morning).toMatch(/To get started, may I kindly know your full name\?$/);
      expect(morning).not.toMatch(/how (can|may) I (help|assist)/i);
      // The stored copy cannot know the hour.
      expect(firstMessageFor(plateau)).toMatch(/^Hello, and welcome to the Plateau State Government Citizen Contact Centre/);
    });

    it('says good morning, afternoon or evening at the agency\'s own clock, not the server\'s', () => {
      // Lagos is UTC+1 all year.
      expect(timeOfDayGreeting('Africa/Lagos', new Date('2026-11-13T05:30:00Z'))).toBe('Good morning'); // 06:30
      expect(timeOfDayGreeting('Africa/Lagos', new Date('2026-11-13T10:59:00Z'))).toBe('Good morning'); // 11:59
      expect(timeOfDayGreeting('Africa/Lagos', new Date('2026-11-13T11:00:00Z'))).toBe('Good afternoon'); // 12:00
      expect(timeOfDayGreeting('Africa/Lagos', new Date('2026-11-13T16:30:00Z'))).toBe('Good evening'); // 17:30
      expect(timeOfDayGreeting('Africa/Lagos', new Date('2026-11-13T01:00:00Z'))).toBe('Good evening'); // 02:00
      // 23:30 UTC is already 00:30 the next day in Jos.
      expect(timeOfDayGreeting('Africa/Lagos', new Date('2026-11-13T23:30:00Z'))).toBe('Good evening');
    });

    it('lays out the phases in the script\'s order, before anything about tone', () => {
      const at = ['### PHASE 1', '### PHASE 2', '### PHASE 3', '### PHASE 6', '### PHASE 8', '### PHASE 10'].map((p) => SYSTEM_PROMPT.indexOf(p));
      expect(at.every((i) => i > -1)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      expect(at[at.length - 1]).toBeLessThan(SYSTEM_PROMPT.indexOf('## How You Sound'));
    });

    it('asks the follow-up questions the script lists for each area', () => {
      for (const area of ['Infrastructure:', 'Healthcare:', 'Education:', 'Public Administration:']) {
        expect(SYSTEM_PROMPT).toContain(area);
      }
      expect(SYSTEM_PROMPT).toMatch(/Is anyone currently in need of urgent medical attention\?/);
      expect(SYSTEM_PROMPT).toMatch(/Is there any additional information, evidence or detail you would like us to include in your report\?/);
    });

    it('makes the name optional, in the script\'s words', () => {
      const text = 'That is perfectly fine. We can proceed with your report.';
      expect(SYSTEM_PROMPT).toContain(text);
      expect(shared()).toMatch(/THE NAME IS OPTIONAL/);
    });

    it('no source of the prompt still asks the dropped questions or makes them compulsory', () => {
      const sources = {
        'the shared prompt': SYSTEM_PROMPT,
        'the Plateau persona': plateau.aiPersonaPrompt,
        'the composed Plateau prompt': agentPromptFor(plateau),
      };
      for (const [where, text] of Object.entries(sources)) {
        for (const pattern of [...DROPPED_QUESTIONS, ...COMPULSION]) {
          expect({ where, pattern: String(pattern), found: pattern.test(text) }).toEqual({ where, pattern: String(pattern), found: false });
        }
      }
    });

    it('the script\'s rules come after the agency persona, and say they supersede older wording', () => {
      const prompt = agentPromptFor(plateau);
      const personaAt = prompt.indexOf(plateau.aiPersonaPrompt);
      expect(personaAt).toBeGreaterThan(-1);
      const afterPersona = personaAt + plateau.aiPersonaPrompt.length;
      const ruleAt = prompt.indexOf('THIS SCRIPT SUPERSEDES OLDER WORDING ABOVE', afterPersona);
      expect(ruleAt).toBeGreaterThan(-1);
      expect(prompt.slice(ruleAt)).toMatch(/the agency's own text included/);
    });

    it('never registers an unconfirmed report', () => {
      expect(shared()).toMatch(/NEVER REGISTER AN UNCONFIRMED REPORT/);
      expect(SYSTEM_PROMPT).toMatch(/Is this an accurate summary of your complaint\?/);
    });

    it('an active emergency still comes before the script', () => {
      expect(shared()).toMatch(/Only an active life-threatening emergency \(ongoing attack, fire, flood or injury\) comes first/);
      expect(shared()).toMatch(/The one exception is an active emergency/);
      expect(SYSTEM_PROMPT).toMatch(/Before calling create-ticket \(except during an active life-threatening emergency\)/);
    });

    it('the Hausa greeting asks the name too, not "how can I help you"', () => {
      const def = agentDefinitionFor(plateau, ['t1']) as any;
      const hausa = def.conversationConfig.languagePresets.ha.overrides.agent.firstMessage as string;
      expect(hausa).not.toMatch(/Da me zan iya taimaka/);
      expect(hausa).toMatch(/cikakken sunan ka\?$/);
    });
  });

  // ── Phase 3 → case category ─────────────────────────────────────────────
  describe('caseClassFor', () => {
    it('narrows infrastructure from the caller\'s words, and keeps it when they narrow nothing', () => {
      expect(caseClassFor('infrastructure', 'deep potholes on the road').category).toBe('roads');
      expect(caseClassFor('infrastructure', 'no water from the borehole').category).toBe('water');
      expect(caseClassFor('Infrastructure', 'the market stalls are unfinished').category).toBe('infrastructure');
    });

    it('maps the script\'s other areas, loosely spelled', () => {
      expect(caseClassFor('healthcare', 'no doctor').category).toBe('health');
      expect(caseClassFor('education', 'teachers absent').category).toBe('education');
      expect(caseClassFor('Public Administration', 'my file is delayed').category).toBe('public_administration');
      expect(caseClassFor('security attack', 'gunmen').sensitive).toBe(true);
      expect(caseClassFor('flood/disaster', 'flooded').category).toBe('disaster');
    });

    it('a bribe at a public office is misconduct, and sensitive', () => {
      const c = caseClassFor('public administration', 'the officer demanded money before helping me');
      expect(c.category).toBe('misconduct');
      expect(c.sensitive).toBe(true);
    });

    it('falls back to the shared classifier when no area is named', () => {
      expect(caseClassFor(undefined, 'no light since the transformer blew').category).toBe('electricity');
      expect(caseClassFor(undefined, 'hello').category).toBe('other');
    });
  });

  // ── How long each tool is given ─────────────────────────────────────────
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

    it('the name is not a required parameter of update-caller-profile; create-ticket carries the read-back', () => {
      const catalog = agentToolCatalog({ baseUrl: 'https://api.example.test', authorization: 'Bearer test-key' }) as any;
      const schema = (n: string) => catalog[n].toolConfig.apiSchema.requestBodySchema;
      expect(schema('update-caller-profile').required).not.toContain('fullName');
      expect(Object.keys(schema('update-caller-profile').properties)).toEqual(
        expect.arrayContaining(['alternativePhone', 'alternativePhoneConfirmed', 'phoneConfirmedForFollowUp'])
      );
      // Not REQUIRED, because an emergency still happening is filed without
      // one; the tool refuses every other unconfirmed report (tested above).
      expect(schema('create-ticket').required).not.toContain('summaryConfirmed');
      expect(Object.keys(schema('create-ticket').properties)).toEqual(
        expect.arrayContaining(['summary', 'summaryConfirmed', 'community', 'targetMda'])
      );
    });
  });
});
