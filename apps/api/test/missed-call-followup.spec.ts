/**
 * Following up a caller the platform could not connect.
 *
 * The message itself is the easy part. What is being tested here is the set of
 * refusals around it, because every one of them is a way this feature turns
 * from a kindness into a nuisance:
 *
 *   - one follow-up per PERSON, not per failed call. Somebody who redials four
 *     times in two minutes is four rows and one worried human.
 *   - nothing at all if they got through since. The failure is stale, and the
 *     apology would be for something that no longer happened.
 *   - nothing if no Meta-approved template is configured, because the provider
 *     would reject the send and the log would record a follow-up that does not
 *     exist.
 *   - a redelivered webhook must not produce a second message.
 *   - and if the send fails, the conversation must say so rather than showing
 *     staff a message the customer never received.
 */
import { Test } from '@nestjs/testing';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { MissedCallFollowUpService } from '../src/agent-tools/missed-call-followup.service';
import { ElevenLabsOutboundService } from '../src/agent-tools/elevenlabs-outbound.service';

describe('MissedCallFollowUpService', () => {
  let service: MissedCallFollowUpService;
  let sendTemplate: jest.Mock;
  let orgId: string;
  let contactId: string;

  jest.setTimeout(60000);

  const CALLER = '+2348030007777';

  beforeAll(async () => {
    sendTemplate = jest.fn().mockResolvedValue({ conversationId: 'conv_x' });
    const moduleRef = await Test.createTestingModule({
      providers: [
        MissedCallFollowUpService,
        { provide: ElevenLabsOutboundService, useValue: { sendWhatsAppTemplate: sendTemplate } },
      ],
    }).compile();
    service = moduleRef.get(MissedCallFollowUpService);

    const org = await prisma.organization.create({
      data: { name: 'Followup Ltd', slug: `followup-${randomBytes(4).toString('hex')}`, industry: 'CLINIC' },
    });
    orgId = org.id;
    const contact = await prisma.contact.create({
      data: { organizationId: orgId, phoneNumber: CALLER, fullName: 'Amina Yusuf' },
    });
    contactId = contact.id;
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  });

  beforeEach(async () => {
    sendTemplate.mockClear();
    sendTemplate.mockResolvedValue({ conversationId: 'conv_x' });
    await prisma.message.deleteMany({ where: { conversation: { organizationId: orgId } } });
    await prisma.conversation.deleteMany({ where: { organizationId: orgId } });
    await prisma.callLog.deleteMany({ where: { organizationId: orgId } });
    await prisma.hostedAgentConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.hostedAgentConfig.create({
      data: {
        organizationId: orgId,
        agentId: `agent_${randomBytes(4).toString('hex')}`,
        missedCallTemplateName: 'plaschema_missed_call',
        missedCallTemplateLanguage: 'en',
      },
    });
  });

  const run = (over: Partial<Parameters<MissedCallFollowUpService['followUp']>[0]> = {}) =>
    service.followUp({
      organizationId: orgId,
      contactId,
      customerNumber: CALLER,
      callSid: `CA${randomBytes(6).toString('hex')}`,
      correlationId: 'test',
      ...over,
    });

  it('sends the approved template, addressed to the caller', async () => {
    const outcome = await run();

    expect(outcome.sent).toBe(true);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    const [org, whatsappUserId, template, language, params] = sendTemplate.mock.calls[0];
    expect(org).toBe(orgId);
    // WhatsApp identifies users without the leading "+".
    expect(whatsappUserId).toBe('2348030007777');
    expect(template).toBe('plaschema_missed_call');
    expect(language).toBe('en');
    expect(params).toEqual(['Amina']);
  });

  it('records the follow-up in the customer’s thread, where staff can see it', async () => {
    await run();

    const message = await prisma.message.findFirst({
      where: { conversation: { organizationId: orgId } },
    });
    expect(message?.content).toMatch(/Sent a WhatsApp follow-up/i);
    expect(message?.externalId).toMatch(/:missed-call-followup$/);
  });

  it('sends once per person, however many calls fail', async () => {
    await run();
    const second = await run(); // a different callSid — the same worried human

    expect(second.sent).toBe(false);
    expect(second.reason).toMatch(/already went out/i);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('does not send twice for a redelivered webhook', async () => {
    const callSid = `CA${randomBytes(6).toString('hex')}`;
    await run({ callSid });
    const replay = await run({ callSid });

    expect(replay.sent).toBe(false);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(await prisma.message.count({ where: { conversation: { organizationId: orgId } } })).toBe(1);
  });

  it('stays quiet when the caller reached us on another attempt', async () => {
    await prisma.callLog.create({
      data: {
        organizationId: orgId, contactId, callSid: `CA${randomBytes(6).toString('hex')}`,
        fromNumber: CALLER, toNumber: '+2348000000001', status: 'COMPLETED',
        durationSeconds: 60, startedAt: new Date(),
      },
    });

    const outcome = await run();

    expect(outcome.sent).toBe(false);
    expect(outcome.reason).toMatch(/reached us/i);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('skips honestly when no approved template is configured', async () => {
    await prisma.hostedAgentConfig.update({
      where: { organizationId: orgId },
      data: { missedCallTemplateName: null },
    });

    const outcome = await run();

    expect(outcome.sent).toBe(false);
    expect(outcome.reason).toMatch(/template/i);
    // Attempting it would produce a provider rejection and no message; the
    // skip has to be visible instead of looking like a delivered follow-up.
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(await prisma.message.count({ where: { conversation: { organizationId: orgId } } })).toBe(0);
  });

  it('says nothing when no contact matched the caller', async () => {
    const outcome = await run({ contactId: null });

    expect(outcome.sent).toBe(false);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('records a failed send as failed, never as a message the customer got', async () => {
    sendTemplate.mockRejectedValue(new Error('template not approved by Meta'));

    const outcome = await run();

    expect(outcome.sent).toBe(false);
    const message = await prisma.message.findFirst({
      where: { conversation: { organizationId: orgId } },
    });
    // Staff reading this thread must see that a person still needs contacting.
    expect(message?.content).toMatch(/FAILED to send/);
    expect(message?.content).toMatch(/has not been contacted/i);
    expect(message?.content).toContain('template not approved by Meta');
  });

  it('never throws — the call log must survive a broken follow-up', async () => {
    sendTemplate.mockRejectedValue(new Error('provider exploded'));
    await expect(run()).resolves.toMatchObject({ sent: false });

    // And an outright bad argument is reported, not raised.
    await expect(
      service.followUp({
        organizationId: 'does-not-exist',
        contactId: 'nope',
        customerNumber: CALLER,
        callSid: 'CA1',
        correlationId: 'test',
      })
    ).resolves.toMatchObject({ sent: false });
  });
});
