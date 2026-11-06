import { Injectable } from '@nestjs/common';
import { prisma, withWhatsAppCredentials, phoneNumberVariants, createTicketWithUniqueNumber } from '@ace/database';
import { WhatsAppCloudClient } from '@ace/whatsapp-sdk';
import { randomBytes } from 'crypto';
import { AceLogger } from '../config/logger';
import { assertPublicHttpUrl } from '../common/url-safety';
import { OnboardingService } from '../onboarding/onboarding.service';
import { ActionType, WorkflowNode, interpolate } from './workflow.types';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';

const log = new AceLogger('WorkflowActions');

export interface ActionContext {
  organizationId: string;
  /** The trigger payload, also used as the template interpolation context. */
  payload: Record<string, any>;
}

export interface ActionResult {
  /** What the action produced — recorded on the run step so it is auditable. */
  output: Record<string, any>;
}

/**
 * Performs workflow actions.
 *
 * Every method here does the real thing and returns what it produced, or throws.
 * There is no branch that logs an intention and returns success: that is precisely
 * what the previous "engine" did (an empty `switch` with `// Trigger WhatsApp SDK
 * message send` comments), and it is why an operator could watch a green dashboard
 * while nothing whatsoever happened.
 */
@Injectable()
export class WorkflowActionsService {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly webhookDispatcher: WebhookDispatcherService
  ) {}

  async execute(node: WorkflowNode, ctx: ActionContext): Promise<ActionResult> {
    const config = interpolate(node.config ?? {}, ctx.payload);

    switch (node.action as ActionType) {
      case 'SEND_WHATSAPP':      return this.sendWhatsApp(config, ctx);
      case 'CREATE_TICKET':      return this.createTicket(config, ctx);
      case 'UPDATE_LEAD_STATUS': return this.updateLeadStatus(config, ctx);
      case 'UPDATE_DEAL_STAGE':  return this.updateDealStage(config, ctx);
      case 'TAG_CONTACT':        return this.tagContact(config, ctx);
      case 'SET_HANDOFF':        return this.setHandoff(config, ctx);
      case 'REQUEST_SELFIE':     return this.requestSelfie(config, ctx);
      case 'HTTP_WEBHOOK':       return this.httpWebhook(config, ctx);
      default:
        throw new Error(`Unknown workflow action "${node.action}".`);
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private async sendWhatsApp(config: any, ctx: ActionContext): Promise<ActionResult> {
    const to = String(config.to ?? ctx.payload?.contact?.phoneNumber ?? ctx.payload?.contactPhone ?? '').trim();
    const message = String(config.message ?? '').trim();

    if (!to) throw new Error('SEND_WHATSAPP: no recipient. Set config.to or trigger with a payload containing contact.phoneNumber.');
    if (!message) throw new Error('SEND_WHATSAPP: config.message is empty.');

    const waConfig = withWhatsAppCredentials(
      await prisma.whatsAppConfig.findFirst({
        where: { organizationId: ctx.organizationId, isActive: true },
      })
    );
    if (!waConfig?.phoneNumberId || !waConfig?.accessToken) {
      throw new Error(
        'SEND_WHATSAPP: WhatsApp is not connected for this organization. ' +
        'Configure it under Settings → WhatsApp Integration.'
      );
    }

    const client = new WhatsAppCloudClient({
      phoneNumberId: waConfig.phoneNumberId,
      accessToken: waConfig.accessToken,
      verifyToken: waConfig.webhookVerifyToken ?? '',
    });

    // Throws on any non-2xx from Meta — the step is then recorded FAILED and retried
    // by the queue, rather than being reported as delivered.
    const result: any = await client.sendTextMessage(to, message);
    const wamid = result?.messages?.[0]?.id ?? null;

    // Mirror into the conversation transcript so an officer opening the thread
    // sees what the automation said on the agency's behalf.
    //
    // The thread is CREATED if it does not exist. It used to be written only
    // when one already did, which is the opposite of when it matters: for a
    // citizen the agency had never messaged — most of the people an
    // automation reaches first — the message went out and then appeared
    // nowhere. An officer opening their record saw no sign the agency had
    // written to them, and wrote again.
    //
    // Only ever after Meta accepted the send, so nothing is recorded as said
    // that was not sent.
    const contact = await prisma.contact.findFirst({
      where: { organizationId: ctx.organizationId, phoneNumber: { in: phoneNumberVariants(to) } },
    });
    if (contact) {
      let conversation = await prisma.conversation.findFirst({
        where: { organizationId: ctx.organizationId, contactId: contact.id, channel: 'WHATSAPP' },
      });
      if (!conversation) {
        conversation = await prisma.conversation
          .create({
            data: { organizationId: ctx.organizationId, contactId: contact.id, channel: 'WHATSAPP' },
          })
          // Two automations reaching the same citizen at once: the unique
          // constraint settles it and the loser re-reads.
          .catch(async (err: any) => {
            if (err?.code !== 'P2002') throw err;
            return prisma.conversation.findFirst({
              where: { organizationId: ctx.organizationId, contactId: contact.id, channel: 'WHATSAPP' },
            });
          });
      }
      if (conversation) {
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: 'SYSTEM',
            content: message,
            metadata: { source: 'workflow', wamid },
          },
        });
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: new Date() },
        });
      }
    }

    log.info('workflow_action_whatsapp_sent', { organizationId: ctx.organizationId, wamid });
    return { output: { wamid, to: to.slice(-4).padStart(to.length, '*'), messageLength: message.length } };
  }

  private async createTicket(config: any, ctx: ActionContext): Promise<ActionResult> {
    const contactId = await this.resolveContactId(config, ctx);
    if (!contactId) throw new Error('CREATE_TICKET: could not resolve a contact from the config or trigger payload.');

    const subject = String(config.subject ?? 'Workflow follow-up').slice(0, 200);
    const description = String(config.description ?? 'Created by workflow automation.').slice(0, 4000);
    const priority = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(String(config.priority).toUpperCase())
      ? String(config.priority).toUpperCase()
      : 'MEDIUM';

    // The SHARED generator, not a fourth hand-rolled one.
    //
    // This built `WF-<base36 time>-<THREE random bytes>` with its own retry
    // loop. Three bytes is 2^24, which the shared module documents as not
    // enough — the birthday bound makes a repeat likelier than not across a
    // few thousand references in one millisecond, and CI measured exactly
    // that. The loop also retried a P2002 on ANY column, so a duplicate on
    // something else was retried four more times and then reported as a
    // numbering collision.
    const ticket = await createTicketWithUniqueNumber(
      (ticketNumber) =>
        prisma.ticket.create({
          data: {
            organizationId: ctx.organizationId,
            contactId,
            ticketNumber,
            subject,
            description,
            priority: priority as any,
            status: 'OPEN',
            updatedAt: new Date(),
          },
        }),
      'WF'
    );
    log.info('workflow_action_ticket_created', { organizationId: ctx.organizationId, ticketId: ticket.id });
    return { output: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber, priority } };
  }

  private async updateLeadStatus(config: any, ctx: ActionContext): Promise<ActionResult> {
    const status = String(config.status ?? '').toUpperCase();
    const valid = ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED'];
    if (!valid.includes(status)) throw new Error(`UPDATE_LEAD_STATUS: status must be one of ${valid.join(', ')}.`);

    const leadId = config.leadId ?? ctx.payload?.leadId ?? ctx.payload?.lead?.id;
    const lead = leadId
      ? await prisma.lead.findFirst({ where: { id: String(leadId), organizationId: ctx.organizationId } })
      : null;
    if (!lead) throw new Error('UPDATE_LEAD_STATUS: no lead in the trigger payload and none given in config.leadId.');

    await prisma.lead.update({ where: { id: lead.id }, data: { status: status as any } });
    return { output: { leadId: lead.id, status } };
  }

  private async updateDealStage(config: any, ctx: ActionContext): Promise<ActionResult> {
    const stage = String(config.stage ?? '').toUpperCase();
    const valid = ['DISCOVERY', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'];
    if (!valid.includes(stage)) throw new Error(`UPDATE_DEAL_STAGE: stage must be one of ${valid.join(', ')}.`);

    const dealId = config.dealId ?? ctx.payload?.dealId ?? ctx.payload?.deal?.id;
    const deal = dealId
      ? await prisma.deal.findFirst({ where: { id: String(dealId), organizationId: ctx.organizationId } })
      : null;
    if (!deal) throw new Error('UPDATE_DEAL_STAGE: no deal in the trigger payload and none given in config.dealId.');

    await prisma.deal.update({ where: { id: deal.id }, data: { stage: stage as any } });
    return { output: { dealId: deal.id, stage } };
  }

  private async tagContact(config: any, ctx: ActionContext): Promise<ActionResult> {
    const tags = (Array.isArray(config.tags) ? config.tags : String(config.tags ?? '').split(','))
      .map((t: any) => String(t).trim())
      .filter(Boolean);
    if (!tags.length) throw new Error('TAG_CONTACT: config.tags is empty.');

    const contactId = await this.resolveContactId(config, ctx);
    if (!contactId) throw new Error('TAG_CONTACT: could not resolve a contact.');

    const contact = await prisma.contact.findFirst({ where: { id: contactId, organizationId: ctx.organizationId } });
    if (!contact) throw new Error('TAG_CONTACT: contact not found in this organization.');

    const merged = Array.from(new Set([...(contact.tags ?? []), ...tags]));
    await prisma.contact.update({ where: { id: contact.id }, data: { tags: merged } });
    return { output: { contactId: contact.id, tags: merged } };
  }

  private async setHandoff(config: any, ctx: ActionContext): Promise<ActionResult> {
    const handoff = config.handoff !== false;
    const conversationId = config.conversationId ?? ctx.payload?.conversationId ?? ctx.payload?.conversation?.id;
    if (!conversationId) throw new Error('SET_HANDOFF: no conversation in the trigger payload and none given in config.conversationId.');

    const conversation = await prisma.conversation.findFirst({
      where: { id: String(conversationId), organizationId: ctx.organizationId },
    });
    if (!conversation) throw new Error('SET_HANDOFF: conversation not found in this organization.');

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { isHumanHandoffActive: handoff, ...(handoff ? {} : { assignedUserId: null, handoffReason: null }) },
    });

    // An automation handing a thread to a person is a handover like any other,
    // and the one most likely to surprise the agency — nobody clicked anything.
    // Only the transition, and only when activating: SET_HANDOFF can also
    // release one, which is not this event.
    if (handoff && !conversation.isHumanHandoffActive) {
      this.webhookDispatcher
        .handoverRequested(ctx.organizationId, conversation.id, 'WORKFLOW')
        .catch(() => {});
    }

    return { output: { conversationId: conversation.id, isHumanHandoffActive: handoff } };
  }

  /**
   * Asks the customer for an onboarding selfie.
   *
   * Fails loudly when no contact can be resolved: a selfie request with nobody to
   * send it to is not a partial success, and reporting one would leave an onboarding
   * step silently incomplete.
   */
  private async requestSelfie(config: any, ctx: ActionContext): Promise<ActionResult> {
    const contactId = await this.resolveContactId(config, ctx);
    if (!contactId) {
      throw new Error('REQUEST_SELFIE: could not resolve a contact from the config or trigger payload.');
    }

    const channel = String(config.channel ?? ctx.payload?.channel ?? 'WHATSAPP').toUpperCase();
    const result = await this.onboarding.requestSelfie(ctx.organizationId, {
      contactId,
      channel: (['WHATSAPP', 'VOICE', 'WEB'].includes(channel) ? channel : 'WHATSAPP') as any,
      purpose: config.purpose ? String(config.purpose) : undefined,
      expiresInHours: config.expiresInHours ? Number(config.expiresInHours) : undefined,
      conversationId: ctx.payload?.conversationId,
      callSid: ctx.payload?.callSid,
    });

    // Delivery failure is reported, not hidden. The run still succeeds — the request
    // exists and an agent can send the link — but the step output says what happened.
    log.info('workflow_action_selfie_requested', {
      organizationId: ctx.organizationId,
      requestId: result.id,
      delivered: result.delivery.delivered,
    });

    return {
      output: {
        selfieRequestId: result.id,
        contactId,
        channel: result.channel,
        expiresAt: result.expiresAt,
        delivered: result.delivery.delivered,
        deliveryNote: result.delivery.note,
      },
    };
  }

  private async httpWebhook(config: any, ctx: ActionContext): Promise<ActionResult> {
    const url = String(config.url ?? '').trim();
    if (!url) throw new Error('HTTP_WEBHOOK: config.url is empty.');

    // The URL is supplied by an organization admin, which makes this a request-forgery
    // primitive without the same guard the crawler and webhook dispatcher use.
    await assertPublicHttpUrl(url);

    const body = JSON.stringify({
      source: 'ace-workflow',
      organizationId: ctx.organizationId,
      payload: ctx.payload,
      ...(config.body && typeof config.body === 'object' ? { data: config.body } : {}),
    });

    const res = await fetch(url, {
      method: String(config.method ?? 'POST').toUpperCase(),
      headers: { 'Content-Type': 'application/json', ...(config.headers ?? {}) },
      body,
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });

    if (!res.ok) {
      throw new Error(`HTTP_WEBHOOK: ${url} returned ${res.status}.`);
    }
    return { output: { url, status: res.status } };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Resolves a contact from explicit config, the payload, or a phone number. */
  private async resolveContactId(config: any, ctx: ActionContext): Promise<string | null> {
    const direct = config.contactId ?? ctx.payload?.contactId ?? ctx.payload?.contact?.id;
    if (direct) {
      const found = await prisma.contact.findFirst({
        where: { id: String(direct), organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (found) return found.id;
    }

    const phone = config.contactPhone ?? ctx.payload?.contactPhone ?? ctx.payload?.contact?.phoneNumber;
    if (phone) {
      const byPhone = await prisma.contact.findFirst({
        where: {
          organizationId: ctx.organizationId,
          phoneNumber: { in: phoneNumberVariants(String(phone)) },
        },
        select: { id: true },
      });
      if (byPhone) return byPhone.id;
    }
    return null;
  }
}
