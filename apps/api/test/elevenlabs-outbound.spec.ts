/**
 * Outbound WhatsApp calls and messages via ElevenLabs.
 *
 * The request shape is checked against the published contract, but the
 * properties that matter most are the refusals. This platform's rule is that a
 * provider failure throws with the reason rather than recording a call that
 * never happened — a fabricated call record is worse than an error, because it
 * reads as proof the customer was contacted.
 *
 * WhatsApp also forbids a business calling a user unprompted without an
 * approved call-permission template. Missing that, there is no call to place,
 * so the service must refuse rather than let the provider reject it later.
 */

import { Test } from '@nestjs/testing';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { ElevenLabsOutboundService } from '../src/agent-tools/elevenlabs-outbound.service';

describe('ElevenLabs outbound', () => {
  let service: ElevenLabsOutboundService;
  let orgId: string;
  let calls: Array<{ url: string; headers: any; body: any }>;
  const realFetch = global.fetch;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ElevenLabsOutboundService],
    }).compile();
    service = moduleRef.get(ElevenLabsOutboundService);

    const org = await prisma.organization.create({
      data: {
        name: 'Outbound Test',
        slug: `outbound-${randomBytes(4).toString('hex')}`,
        industry: 'OTHER',
      },
    });
    orgId = org.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    global.fetch = realFetch;
  });

  beforeEach(() => {
    calls = [];
  });

  const stubFetch = (status: number, body: any) => {
    global.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init?.headers, body: JSON.parse(init?.body ?? '{}') });
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      };
    }) as any;
  };

  const configure = (data: Record<string, unknown>) =>
    prisma.hostedAgentConfig.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId, agentId: 'agent_test', ...data },
      update: { agentId: 'agent_test', ...data },
    });

  describe('refusals', () => {
    it('refuses when no agent is configured for the organization', async () => {
      await prisma.hostedAgentConfig.deleteMany({ where: { organizationId: orgId } });
      stubFetch(200, { success: true });

      await expect(service.placeWhatsAppCall(orgId, '2348012345678')).rejects.toThrow(
        /No active hosted agent/i
      );
      expect(calls).toHaveLength(0); // never contacted the provider
    });

    it('refuses an outbound call with no call-permission template', async () => {
      await configure({
        apiKey: 'xi-test',
        whatsappPhoneNumberId: 'wa_123',
        callPermissionTemplateName: null,
      });
      stubFetch(200, { success: true });

      await expect(service.placeWhatsAppCall(orgId, '2348012345678')).rejects.toThrow(
        /call-permission template/i
      );
      // WhatsApp would refuse this anyway; we must not spend a request finding out.
      expect(calls).toHaveLength(0);
    });

    it('throws with the provider reason instead of reporting a call', async () => {
      await configure({
        apiKey: 'xi-test',
        whatsappPhoneNumberId: 'wa_123',
        callPermissionTemplateName: 'call_permission',
      });
      stubFetch(422, { detail: 'template not approved' });

      await expect(service.placeWhatsAppCall(orgId, '2348012345678')).rejects.toThrow(
        /422|template not approved/i
      );
    });

    it('throws when ElevenLabs is unreachable', async () => {
      await configure({
        apiKey: 'xi-test',
        whatsappPhoneNumberId: 'wa_123',
        callPermissionTemplateName: 'call_permission',
      });
      global.fetch = (async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }) as any;

      await expect(service.placeWhatsAppCall(orgId, '2348012345678')).rejects.toThrow(
        /Could not reach ElevenLabs/i
      );
    });
  });

  describe('request shape', () => {
    beforeEach(async () => {
      await configure({
        apiKey: 'xi-test-key',
        whatsappPhoneNumberId: 'wa_123',
        callPermissionTemplateName: 'call_permission',
        callPermissionTemplateLanguage: 'en',
      });
    });

    it('sends the documented outbound-call payload', async () => {
      stubFetch(200, { success: true, message: 'queued', conversation_id: 'conv_1' });

      const result = await service.placeWhatsAppCall(orgId, '2348012345678', {
        dynamicVariables: { organization_name: 'GateKipa' },
        firstMessage: 'Hello from GateKipa',
        language: 'en',
      });

      expect(result).toEqual({
        success: true,
        message: 'queued',
        conversationId: 'conv_1',
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/v1/convai/whatsapp/outbound-call');
      expect(calls[0].headers['xi-api-key']).toBe('xi-test-key');

      const body = calls[0].body;
      expect(body.whatsapp_phone_number_id).toBe('wa_123');
      expect(body.whatsapp_user_id).toBe('2348012345678');
      expect(body.agent_id).toBe('agent_test');
      expect(body.whatsapp_call_permission_request_template_name).toBe('call_permission');
      expect(body.whatsapp_call_permission_request_template_language_code).toBe('en');

      // dynamic_variables is the multi-tenant hook — one agent, per-conversation context.
      expect(body.conversation_initiation_client_data.dynamic_variables).toEqual({
        organization_name: 'GateKipa',
      });
      expect(
        body.conversation_initiation_client_data.conversation_config_override.agent.first_message
      ).toBe('Hello from GateKipa');
    });

    it('sends template parameters in order for an outbound message', async () => {
      stubFetch(200, { conversation_id: 'conv_2' });

      const result = await service.sendWhatsAppTemplate(
        orgId,
        '2348012345678',
        'booking_reminder',
        'en',
        ['Tuesday', '3pm']
      );

      expect(result.conversationId).toBe('conv_2');
      const body = calls[0].body;
      expect(calls[0].url).toContain('/v1/convai/whatsapp/outbound-message');
      expect(body.template_name).toBe('booking_reminder');
      expect(body.template_params).toEqual([
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Tuesday' },
            { type: 'text', text: '3pm' },
          ],
        },
      ]);
    });

    it('honours a data-residency base URL', async () => {
      const previous = process.env.ELEVENLABS_BASE_URL;
      process.env.ELEVENLABS_BASE_URL = 'https://api.eu.residency.elevenlabs.io';
      stubFetch(200, { success: true, message: 'ok' });

      await service.placeWhatsAppCall(orgId, '2348012345678');
      expect(calls[0].url).toContain('api.eu.residency.elevenlabs.io');

      if (previous === undefined) delete process.env.ELEVENLABS_BASE_URL;
      else process.env.ELEVENLABS_BASE_URL = previous;
    });
  });
});
