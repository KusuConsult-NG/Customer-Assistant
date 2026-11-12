import { Test } from '@nestjs/testing';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { ElevenLabsWebhookService } from '../src/agent-tools/elevenlabs-webhook.service';
import { MissedCallFollowUpService } from '../src/agent-tools/missed-call-followup.service';
import { ElevenLabsApi } from '../src/agent-tools/elevenlabs-client';
import { ElevenLabsCallSyncService, toPostCallPayload } from '../src/agent-tools/elevenlabs-call-sync.service';

/**
 * The toll-free line took real calls and the dashboard showed none: a call
 * reached the database only if the ElevenLabs workspace's post-call webhook
 * pointed here, and it did not. The sync PULLS finished conversations instead.
 *
 * The conversation below is shaped like the SDK's response for the real call
 * (`conv_2501m78de6v2erw8vwv1b7n1xy6q`): a sip_trunking phone call, camelCase.
 */
describe('ElevenLabs call sync — finished calls reach the dashboard without the webhook', () => {
  let sync: ElevenLabsCallSyncService;
  let orgId: string;
  let otherOrgId: string;
  const agentId = `agent_${randomBytes(4).toString('hex')}`;
  const convId = `conv_${randomBytes(6).toString('hex')}`;
  const liveId = `conv_${randomBytes(6).toString('hex')}`;
  const callSid = `SCL_${randomBytes(6).toString('hex')}`;
  const caller = '+2347036171049';

  const sipConversation = {
    agentId,
    conversationId: convId,
    status: 'done',
    transcript: [
      { role: 'agent', message: 'Hello! Welcome to the Citizen Information Center.', timeInCallSecs: 0 },
      { role: 'user', message: 'Who is the Commissioner for Health?', timeInCallSecs: 11 },
    ],
    metadata: {
      startTimeUnixSecs: 1794505121,
      callDurationSecs: 182,
      terminationReason: 'Client disconnected: 1000',
      phoneCall: {
        type: 'sip_trunking',
        direction: 'inbound',
        phoneNumberId: 'phnum_x',
        agentNumber: '+2348000000456',
        externalNumber: caller,
        callSid,
      },
    },
    analysis: { transcriptSummary: 'Asked about a commissioner.', callSuccessful: 'success', callSummaryTitle: 'Leadership' },
  };

  const listed: any[] = [];
  const client = {
    conversationalAi: {
      conversations: {
        list: jest.fn(async (req: any) => {
          // Scoped to the tenant's own agent, never the whole workspace.
          expect(req.agentId).toBe(agentId);
          return { conversations: listed, hasMore: false };
        }),
        get: jest.fn(async (id: string) => {
          if (id === convId) return sipConversation;
          throw new Error(`unexpected get ${id}`);
        }),
      },
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ElevenLabsCallSyncService,
        ElevenLabsWebhookService,
        { provide: MissedCallFollowUpService, useValue: { followUp: jest.fn() } },
        { provide: ElevenLabsApi, useValue: { keyFor: () => 'k', for: () => client } },
      ],
    }).compile();
    sync = moduleRef.get(ElevenLabsCallSyncService);

    const org = await prisma.organization.create({
      data: { name: 'Sync Agency', slug: `sync-${randomBytes(4).toString('hex')}`, industry: 'OTHER' },
    });
    orgId = org.id;
    const other = await prisma.organization.create({
      data: { name: 'Other Agency', slug: `sync-other-${randomBytes(4).toString('hex')}`, industry: 'OTHER' },
    });
    otherOrgId = other.id;
    await prisma.hostedAgentConfig.create({ data: { organizationId: orgId, agentId } });
  }, 60_000);

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
  });

  it('maps the SDK conversation to the post-call payload ingest() reads', () => {
    const p = toPostCallPayload(sipConversation);
    expect(p.data?.agent_id).toBe(agentId);
    expect(p.data?.metadata?.phone_call?.call_sid).toBe(callSid);
    expect(p.data?.metadata?.phone_call?.external_number).toBe(caller);
    expect(p.data?.transcript?.[1]).toEqual({ role: 'user', message: 'Who is the Commissioner for Health?', time_in_call_secs: 11 });
    expect(p.data?.analysis?.transcript_summary).toBe('Asked about a commissioner.');
  });

  it('stores a finished SIP call as a call record, against the caller, as SIP_TRUNK', async () => {
    listed.splice(0, listed.length,
      { conversationId: convId, status: 'done' },
      // Still in progress: left for the next sweep, not stored half-finished.
      { conversationId: liveId, status: 'in-progress' },
    );
    const r = await sync.syncOrganization(orgId);
    expect(r).toMatchObject({ seen: 1, stored: 1, alreadyStored: 0, skipped: [] });

    const log = await prisma.callLog.findUnique({ where: { callSid } });
    expect(log).toMatchObject({
      organizationId: orgId,
      direction: 'INBOUND',
      status: 'COMPLETED',
      durationSeconds: 182,
      provider: 'SIP_TRUNK',
      fromNumber: caller,
      toNumber: '+2348000000456',
      summary: 'Asked about a commissioner.',
    });
    expect(log!.transcript).toContain('Who is the Commissioner for Health?');
    const contact = await prisma.contact.findUnique({ where: { id: log!.contactId! } });
    expect(contact!.phoneNumber).toBe(caller);
    expect(client.conversationalAi.conversations.get).not.toHaveBeenCalledWith(liveId);
  });

  it('does not store a call twice, or fetch it again, on the next sweep', async () => {
    client.conversationalAi.conversations.get.mockClear();
    const r = await sync.syncOrganization(orgId);
    expect(r).toMatchObject({ seen: 1, stored: 0, alreadyStored: 1 });
    expect(await prisma.callLog.count({ where: { callSid } })).toBe(1);
  });

  it("never files one agency's call under another", async () => {
    // The other agency has no agent: nothing is listed for it, nothing stored.
    const r = await sync.syncOrganization(otherOrgId);
    expect(r.seen).toBe(0);
    expect(await prisma.callLog.count({ where: { organizationId: otherOrgId } })).toBe(0);
  });
});
