/**
 * Outbound WhatsApp calls and messages through ElevenLabs Agents.
 *
 * Inbound needs nothing from us — the agent answers and calls back into
 * /api/agent-tools. Outbound is the reverse: WE initiate, so we hold the
 * workspace key and ask ElevenLabs to start a conversation.
 *
 * Two things about WhatsApp shape this API and are worth stating plainly,
 * because both look like bugs when they surprise you:
 *
 *  1. An outbound CALL needs an approved call-permission template. WhatsApp
 *     does not let a business ring a user unprompted; the template asks first.
 *     Without one configured there is no call to place, so we refuse rather
 *     than pretend.
 *  2. An outbound MESSAGE outside the 24-hour service window must be a
 *     template too. Free-form text is only allowed inside the window.
 *
 * Failure is never smoothed over. This platform's rule is that a provider
 * failure throws with the reason rather than recording a call that did not
 * happen — a fabricated call record is worse than an error, because it looks
 * like proof the customer was contacted.
 */
import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { prisma } from '@ace/database';
import { ElevenLabsApi } from './elevenlabs-client';

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';

/** Values handed to the agent for this one conversation. */
export interface ConversationContext {
  /** Merged into conversation_initiation_client_data.dynamic_variables. */
  dynamicVariables?: Record<string, unknown>;
  /** Overrides the agent's opening line for this conversation only. */
  firstMessage?: string;
  /** BCP-47 language for ASR and TTS, e.g. "en". */
  language?: string;
}

export interface OutboundCallResult {
  success: boolean;
  message: string;
  conversationId?: string;
}

@Injectable()
export class ElevenLabsOutboundService {
  private readonly log = new Logger('ElevenLabsOutbound');

  constructor(private readonly api: ElevenLabsApi) {}

  private baseUrl(): string {
    // Data-residency deployments use a different host (api.eu.residency…,
    // api.in.residency…). Configurable so a tenant bound to a jurisdiction is
    // not silently routed through the default US endpoint.
    return (process.env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /**
   * The tenant's agent configuration. Nothing is inferred from environment
   * variables here: a wrong agent id means one tenant's customers hear another
   * tenant's agent, so it must be configured explicitly per organization.
   */
  private async configFor(organizationId: string) {
    const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId } });
    if (!config || !config.isActive) {
      throw new BadRequestException(
        'No active hosted agent is configured for this organization.'
      );
    }
    if (!config.agentId) {
      // The row exists but provisioning has not run or did not finish. Sending a
      // null agent id would either be rejected or — worse — routed somewhere by
      // default, which means this tenant's customer talking to another tenant's
      // agent.
      throw new BadRequestException(
        'This organization has no provisioned ElevenLabs agent yet — sync it before placing calls.'
      );
    }
    // Decrypts the tenant's stored key, or falls back to the shared one. The
    // ciphertext reaching the xi-api-key header would look like a revoked key
    // rather than a decryption problem, so it is resolved in exactly one place.
    const apiKey = this.api.keyFor(organizationId, config.apiKey);
    return { ...config, apiKey };
  }

  /**
   * Builds conversation_initiation_client_data.
   *
   * `dynamic_variables` is the multi-tenant hook: the agent template stays the
   * same while the values differ per conversation, so one agent can serve many
   * tenants without a copy each.
   */
  private initiationData(context?: ConversationContext) {
    if (!context) return undefined;
    const data: Record<string, unknown> = {};

    if (context.dynamicVariables && Object.keys(context.dynamicVariables).length > 0) {
      data.dynamic_variables = context.dynamicVariables;
    }
    if (context.firstMessage || context.language) {
      data.conversation_config_override = {
        agent: {
          ...(context.firstMessage ? { first_message: context.firstMessage } : {}),
          ...(context.language ? { language: context.language } : {}),
        },
      };
    }
    data.source_info = { source: 'whatsapp' };
    return Object.keys(data).length > 0 ? data : undefined;
  }

  private async post(path: string, apiKey: string, body: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}${path}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      // Network-level failure. Say so — do not report a conversation that was
      // never started.
      this.log.error(`elevenlabs_unreachable path=${path} error=${err?.message}`);
      throw new ServiceUnavailableException(
        `Could not reach ElevenLabs: ${err?.message ?? 'network error'}`
      );
    }

    const text = await res.text();
    if (!res.ok) {
      this.log.error(`elevenlabs_error path=${path} status=${res.status} body=${text.slice(0, 400)}`);
      throw new ServiceUnavailableException(
        `ElevenLabs rejected the request (HTTP ${res.status}): ${text.slice(0, 300)}`
      );
    }

    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new ServiceUnavailableException('ElevenLabs returned a response that was not JSON.');
    }
  }

  /**
   * Place an outbound WhatsApp call.
   *
   * `whatsappUserId` is the recipient's WhatsApp id (their number in
   * E.164 without the leading +, as WhatsApp identifies users).
   */
  async placeWhatsAppCall(
    organizationId: string,
    whatsappUserId: string,
    context?: ConversationContext
  ): Promise<OutboundCallResult> {
    const config = await this.configFor(organizationId);

    if (!config.whatsappPhoneNumberId) {
      throw new BadRequestException(
        'No ElevenLabs WhatsApp number is configured for this organization.'
      );
    }
    if (!config.callPermissionTemplateName) {
      // WhatsApp will not connect a business-initiated call without one, so
      // failing here is more honest than letting the provider reject it.
      throw new BadRequestException(
        'No call-permission template is configured. WhatsApp requires an approved template before a business may call a user.'
      );
    }

    const result = await this.post('/v1/convai/whatsapp/outbound-call', config.apiKey, {
      whatsapp_phone_number_id: config.whatsappPhoneNumberId,
      whatsapp_user_id: whatsappUserId,
      whatsapp_call_permission_request_template_name: config.callPermissionTemplateName,
      whatsapp_call_permission_request_template_language_code:
        config.callPermissionTemplateLanguage || 'en',
      agent_id: config.agentId,
      ...(this.initiationData(context)
        ? { conversation_initiation_client_data: this.initiationData(context) }
        : {}),
    });

    this.log.log(
      `outbound_call org=${organizationId} conversation=${result?.conversation_id ?? 'none'}`
    );
    return {
      success: Boolean(result?.success),
      message: String(result?.message ?? ''),
      conversationId: result?.conversation_id,
    };
  }

  /**
   * Send an outbound WhatsApp template message.
   *
   * `bodyParams` fill the template's body placeholders in order. Templates are
   * approved by Meta with fixed text, which is a useful property here: the
   * wording of an outbound message cannot drift, whatever the model would have
   * said.
   */
  async sendWhatsAppTemplate(
    organizationId: string,
    whatsappUserId: string,
    templateName: string,
    templateLanguage: string,
    bodyParams: string[] = [],
    context?: ConversationContext
  ): Promise<{ conversationId?: string }> {
    const config = await this.configFor(organizationId);

    if (!config.whatsappPhoneNumberId) {
      throw new BadRequestException(
        'No ElevenLabs WhatsApp number is configured for this organization.'
      );
    }
    if (!templateName?.trim()) {
      throw new BadRequestException('A template name is required.');
    }

    const result = await this.post('/v1/convai/whatsapp/outbound-message', config.apiKey, {
      whatsapp_phone_number_id: config.whatsappPhoneNumberId,
      whatsapp_user_id: whatsappUserId,
      template_name: templateName,
      template_language_code: templateLanguage || 'en',
      template_params: [
        {
          type: 'body',
          parameters: bodyParams.map((text) => ({ type: 'text', text })),
        },
      ],
      agent_id: config.agentId,
      ...(this.initiationData(context)
        ? { conversation_initiation_client_data: this.initiationData(context) }
        : {}),
    });

    this.log.log(
      `outbound_message org=${organizationId} template=${templateName} conversation=${result?.conversation_id ?? 'none'}`
    );
    return { conversationId: result?.conversation_id };
  }
}
