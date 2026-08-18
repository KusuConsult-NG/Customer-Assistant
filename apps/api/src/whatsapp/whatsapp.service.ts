import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma, withWhatsAppCredentials, normalizePhoneNumber, phoneNumberVariants } from '@ace/database';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { WhatsAppCloudClient } from '@ace/whatsapp-sdk';
import { ConversationOrchestrator } from '@ace/orchestrator';
import { ChannelType, MessageSender } from '@ace/shared-types';
import { AceLogger } from '../config/logger';
import { WorkflowTriggerService } from '../workflows/workflow-trigger.service';
import { OnboardingService } from '../onboarding/onboarding.service';

const log = new AceLogger('WhatsappService');

/**
 * Resolves the WhatsApp Cloud API client for a given phoneNumberId.
 *
 * Throws an explicit, descriptive error rather than defaulting to a placeholder.
 * This ensures that misconfiguration fails loudly at message time, not silently
 * with a fake wamid response that masks the delivery failure.
 */
function resolveWhatsAppClient(config: {
  phoneNumberId?: string | null;
  accessToken?: string | null;
  webhookVerifyToken?: string | null;
}): WhatsAppCloudClient {
  if (!config.phoneNumberId || !config.accessToken) {
    throw new Error(
      `WhatsApp Cloud API credentials are not configured for this organization. ` +
      `phoneNumberId=${config.phoneNumberId ? 'set' : 'MISSING'}, ` +
      `accessToken=${config.accessToken ? 'set' : 'MISSING'}. ` +
      `Go to Settings → WhatsApp Integration to configure your Meta Business credentials.`
    );
  }
  return new WhatsAppCloudClient({
    phoneNumberId: config.phoneNumberId,
    accessToken: config.accessToken,
    verifyToken: config.webhookVerifyToken ?? '',
  });
}

@Injectable()
export class WhatsappService {
  private orchestrator = new ConversationOrchestrator();

  constructor(
    private webhookDispatcher: WebhookDispatcherService,
    private workflows: WorkflowTriggerService,
    private onboarding: OnboardingService
  ) {}

  /**
   * processIncomingWebhook
   *
   * Called after HMAC signature verification passes in the controller.
   * The correlationId threads through all log lines so you can grep a single
   * request end-to-end in your log aggregator.
   *
   * Race condition mitigation for contact creation:
   *   Prisma does not expose SELECT ... FOR UPDATE in a single query. We use
   *   a two-step upsert pattern: try findFirst, on unique constraint violation
   *   (P2002) retry the findFirst. This eliminates the TOCTOU race where two
   *   concurrent webhook deliveries for the same phone number both pass the
   *   "contact not found" check and both attempt .create().
   */
  async processIncomingWebhook(body: any, correlationId: string): Promise<void> {
    const timer = log.startTimer();
    try {
      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0]?.value;
      const message = change?.messages?.[0];
      const statusReceipt = change?.statuses?.[0];

      if (statusReceipt) {
        log.info('whatsapp_status_receipt_received', {
          correlationId,
          status: statusReceipt.status,
          recipientId: statusReceipt.recipient_id,
          messageId: statusReceipt.id,
        });
        return;
      }

      if (!message) {
        log.debug('whatsapp_no_message_in_payload', { correlationId });
        return;
      }

      const phoneNumberId: string = change.metadata?.phone_number_id;
      const fromNumber: string = message.from;
      const messageId: string = message.id;

      // ── Resolve message content & media ────────────────────────────────────
      let textContent: string;
      let mediaUrl: string | undefined;
      let mediaType: string | undefined;

      if (message.text?.body) {
        textContent = message.text.body;
      } else if (message.interactive?.button_reply?.title) {
        textContent = message.interactive.button_reply.title;
      } else if (message.interactive?.list_reply?.title) {
        textContent = message.interactive.list_reply.title;
      } else if (message.type === 'image') {
        const caption = message.image?.caption ? ` — "${message.image.caption}"` : '';
        textContent = `[Customer sent an image${caption}]`;
        mediaUrl = message.image?.id ? `https://graph.facebook.com/v20.0/${message.image.id}` : undefined;
        mediaType = 'image';
      } else if (message.type === 'audio') {
        textContent = '[Customer sent a voice message]';
        mediaUrl = message.audio?.id ? `https://graph.facebook.com/v20.0/${message.audio.id}` : undefined;
        mediaType = 'audio';
      } else if (message.type === 'video') {
        const caption = message.video?.caption ? ` — "${message.video.caption}"` : '';
        textContent = `[Customer sent a video${caption}]`;
        mediaUrl = message.video?.id ? `https://graph.facebook.com/v20.0/${message.video.id}` : undefined;
        mediaType = 'video';
      } else if (message.type === 'document') {
        const filename = message.document?.filename ? ` (${message.document.filename})` : '';
        textContent = `[Customer sent a document${filename}]`;
        mediaUrl = message.document?.id ? `https://graph.facebook.com/v20.0/${message.document.id}` : undefined;
        mediaType = 'document';
      } else if (message.type === 'sticker') {
        textContent = '[Customer sent a sticker]';
        mediaType = 'sticker';
      } else if (message.type === 'location') {
        const lat = message.location?.latitude;
        const lng = message.location?.longitude;
        const name = message.location?.name ? ` (${message.location.name})` : '';
        textContent = `[Customer shared a location${name}: lat ${lat}, lng ${lng}]`;
      } else if (message.type === 'contacts') {
        textContent = '[Customer shared a contact card]';
      } else {
        textContent = `[Customer sent a ${message.type ?? 'unknown'} message]`;
      }

      log.info('whatsapp_message_received', {
        correlationId,
        event: 'message_received',
        messageId,
        fromNumber: fromNumber.slice(0, -4) + '****', // partial mask for PII
        messageType: message.type,
        phoneNumberId,
      });


      // ── 1. Resolve Organization from phone number ID ──────────────────────────
      //
      // phoneNumberId is the only tenant identifier Meta gives us, so it must match
      // exactly. There is deliberately no "fall back to any active config" branch:
      // that routed a customer's inbound message — and the AI reply, the new contact
      // record and the transcript — into an unrelated organization whenever the
      // number id was unmapped, and answered them with that org's AI persona and
      // knowledge base.
      // withWhatsAppCredentials on every read: the access token is encrypted
      // at rest, and Meta rejects a `v1.…` ciphertext as an invalid token —
      // which reads as an expired Meta credential, not a decryption bug.
      const config = withWhatsAppCredentials(
        await prisma.whatsAppConfig.findFirst({
          where: { phoneNumberId, isActive: true },
        })
      );

      if (!config) {
        log.warn('whatsapp_no_config_found', {
          correlationId,
          event: 'config_not_found',
          phoneNumberId,
          fromNumber: fromNumber.slice(-4),
          hint: 'Add this phoneNumberId under Settings → WhatsApp Integration for the owning organization.',
        });
        return;
      }

      const organizationId = config.organizationId;

      log.debug('whatsapp_org_resolved', { correlationId, organizationId });

      // Mark incoming message as read on WhatsApp
      try {
        const client = resolveWhatsAppClient(config);
        await client.markMessageAsRead(messageId);
      } catch (e) {
        log.warn('whatsapp_mark_read_failed', { correlationId, messageId });
      }

      // ── 2. Upsert Contact (race-safe) ────────────────────────────────────────
      const contact = await this.upsertContact(organizationId, fromNumber, correlationId);

      // ── 3. Upsert Conversation ────────────────────────────────────────────────
      const conversation = await this.upsertConversation(organizationId, contact.id, correlationId);

      // ── 4. Persist inbound message — and make redelivery a no-op ─────────────
      //
      // Meta's webhook delivery is AT LEAST ONCE. It retries on timeout, on network
      // error, and sometimes for no visible reason. Without a guard here a retry wrote
      // a second copy of the customer's message and then ran the whole assistant
      // pipeline again — so the customer received two replies to one question, and any
      // action the assistant took (a ticket, a booking, a payment instruction) happened
      // twice.
      //
      // The insert IS the idempotency claim. A check-then-insert would not close it:
      // two retries can be in flight simultaneously and both would pass the check. The
      // unique index on `externalId` is what actually makes this safe, and a P2002 here
      // means someone else already claimed this message — so stop, without replying.
      try {
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: MessageSender.CUSTOMER,
            content: textContent,
            mediaUrl: mediaUrl ?? null,
            mediaType: mediaType ?? null,
            externalId: messageId,
            metadata: { messageId, messageType: message.type },
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2002') {
          log.info('whatsapp_duplicate_delivery_ignored', {
            correlationId,
            organizationId,
            messageId,
            note: 'Meta redelivered a message already processed; not answering twice.',
          });
          return;
        }
        throw err;
      }

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });

      this.webhookDispatcher.dispatch(organizationId, 'message.received', {
        contactPhone: fromNumber,
        message: textContent,
        conversationId: conversation.id,
      }).catch(err => log.error('webhook_dispatch_failed', err, { correlationId }));

      this.workflows.emitAsync(organizationId, 'MESSAGE_RECEIVED', {
        channel: 'WHATSAPP',
        message: textContent,
        messageType: message.type,
        conversationId: conversation.id,
        contactId: contact.id,
        contactPhone: fromNumber,
        contact: { id: contact.id, fullName: contact.fullName, phoneNumber: contact.phoneNumber, email: contact.email },
      });

      // ── 4b. Onboarding selfie ────────────────────────────────────────────────
      //
      // If this contact was asked for a selfie and has just sent a photo, that photo
      // IS the answer — it must not fall through to the AI, which would reply to
      // "[Customer sent an image]" with generic small talk while the onboarding step
      // stayed open forever.
      //
      // The image bytes are downloaded here rather than stored as a Meta media id:
      // those ids expire, and a link that 404s in a week is not a record of anything.
      if (message.type === 'image' && message.image?.id) {
        const handled = await this.handleSelfieImage(
          organizationId, contact.id, config, message.image.id, fromNumber, conversation.id, correlationId
        );
        if (handled) return;
      }

      // ── 5. Human agent takeover check ─────────────────────────────────────────
      if (conversation.isHumanHandoffActive) {
        log.info('whatsapp_human_handoff_active', {
          correlationId,
          conversationId: conversation.id,
          organizationId,
          event: 'ai_bypassed',
        });
        return;
      }

      // ── 6. Fetch conversation history (last 10 messages) ─────────────────────
      const historyMessages = await prisma.message.findMany({
        where: { conversationId: conversation.id },
        take: 10,
        orderBy: { sentAt: 'asc' },
      });

      // ── 7. Orchestrate AI response ────────────────────────────────────────────
      const orchTimer = log.startTimer();
      const orchResult = await this.orchestrator.processIncomingMessage(
        {
          conversationId: conversation.id,
          organizationId,
          customerPhoneNumber: fromNumber,
          channel: ChannelType.WHATSAPP,
          history: historyMessages.map((m: any) => ({
            sender: m.sender as any,
            content: m.content,
            timestamp: m.sentAt,
          })),
          slots: {},
          isHumanHandoffActive: conversation.isHumanHandoffActive,
        },
        textContent
      );

      log.info('whatsapp_orchestration_complete', {
        correlationId,
        conversationId: conversation.id,
        organizationId,
        intentDetected: orchResult.intentDetected ?? 'GENERAL_INQUIRY',
        confidenceScore: orchResult.confidenceScore,
        shouldHandoff: orchResult.shouldHandoff,
      }, orchTimer);

      // ── 8. Update handoff state if triggered ──────────────────────────────────
      if (orchResult.shouldHandoff) {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            isHumanHandoffActive: true,
            handoffReason: orchResult.handoffReason,
          },
        });
        log.info('whatsapp_handoff_triggered', {
          correlationId,
          conversationId: conversation.id,
          organizationId,
          handoffReason: orchResult.handoffReason,
        });
      }

      // ── 9. Send AI reply via WhatsApp Cloud API ───────────────────────────────
      if (orchResult.replyText) {
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: MessageSender.AI,
            content: orchResult.replyText,
          },
        });

        // This will throw if credentials are missing — which is correct.
        // An unconfigured org should not silently drop messages.
        const client = resolveWhatsAppClient(config);
        const sendTimer = log.startTimer();

        try {
          const sendResult = await client.sendTextMessage(fromNumber, orchResult.replyText);
          log.info('whatsapp_reply_sent', {
            correlationId,
            conversationId: conversation.id,
            organizationId,
            wamid: sendResult?.messages?.[0]?.id,
            event: 'reply_delivered',
          }, sendTimer);
        } catch (sendErr: any) {
          log.error('whatsapp_reply_send_failed', sendErr, {
            correlationId,
            conversationId: conversation.id,
            organizationId,
            fromNumber: fromNumber.slice(-4),
          });
          // Do not rethrow: the message is persisted in DB, agent can resend manually
        }
      }

      log.info('whatsapp_webhook_processed', {
        correlationId,
        conversationId: conversation.id,
        organizationId,
        event: 'webhook_complete',
      }, timer);

    } catch (err: any) {
      log.error('whatsapp_webhook_unhandled_error', err, { correlationId });
    }
  }

  /**
   * Upsert a Contact record, handling concurrent creation race conditions.
   *
   * The @@unique([organizationId, phoneNumber]) constraint in schema.prisma
   * means the second concurrent INSERT will throw a Prisma P2002 unique violation.
   * We catch that and fall back to a findFirst — this is the correct pattern
   * for "find-or-create" without advisory locks.
   */
  /**
   * Downloads an inbound WhatsApp image and, if the contact has a pending selfie
   * request, stores it against that request.
   *
   * Returns true when the photo was consumed as a selfie (accepted OR rejected) —
   * either way the customer gets a specific reply and the AI stays out of it.
   * Returns false when there was no pending request, so the image is just an image.
   */
  private async handleSelfieImage(
    organizationId: string,
    contactId: string,
    config: { phoneNumberId: string | null; accessToken: string | null; webhookVerifyToken: string | null },
    mediaId: string,
    fromNumber: string,
    conversationId: string,
    correlationId: string
  ): Promise<boolean> {
    try {
      const client = resolveWhatsAppClient(config);
      const media = await client.downloadMedia(mediaId);
      if (!media) {
        log.warn('whatsapp_selfie_download_failed', { correlationId, organizationId, mediaId });
        return false;
      }

      const result = await this.onboarding.attachWhatsAppSelfie(organizationId, contactId, media.bytes);
      if (!result.requestId) return false; // nothing was pending — ordinary attachment

      const reply = result.accepted
        ? 'Thank you — we have received your photo and your onboarding is complete on our side.'
        : `${result.reason} Please send another photo when you can.`;

      await client.sendTextMessage(fromNumber, reply);
      await prisma.message.create({
        data: { conversationId, sender: MessageSender.SYSTEM, content: reply },
      }).catch(() => {});

      log.info('whatsapp_selfie_handled', {
        correlationId, organizationId, contactId,
        requestId: result.requestId, accepted: result.accepted,
      });
      return true;
    } catch (err: any) {
      // A selfie problem must never swallow the message. Fall through to the normal
      // pipeline so the customer still gets a response.
      log.error('whatsapp_selfie_handling_failed', err as Error, { correlationId, organizationId, contactId });
      return false;
    }
  }

  private async upsertContact(organizationId: string, phoneNumber: string, correlationId: string) {
    try {
      // Meta gives E.164 without the leading plus. Searching every shape finds
      // the row a phone call or a staff member created for the same person;
      // storing the canonical one stops the next channel making a third.
      const existing = await prisma.contact.findFirst({
        where: { organizationId, phoneNumber: { in: phoneNumberVariants(phoneNumber) } },
      });

      if (existing) return existing;

      return await prisma.contact.create({
        data: {
          organizationId,
          phoneNumber: normalizePhoneNumber(phoneNumber),
          fullName: `WhatsApp Contact (···${phoneNumber.slice(-4)})`,
        },
      });
    } catch (err: any) {
      // P2002 = Unique constraint violation (race condition: another request created it first)
      if (err.code === 'P2002') {
        log.debug('contact_race_condition_resolved', { correlationId, phoneNumber: phoneNumber.slice(-4) });
        const contact = await prisma.contact.findFirst({
          where: { organizationId, phoneNumber: { in: phoneNumberVariants(phoneNumber) } },
        });
        if (contact) return contact;
      }
      throw err;
    }
  }

  /**
   * Upsert a Conversation record for the given contact + channel.
   * Same race-safe pattern as upsertContact.
   */
  private async upsertConversation(organizationId: string, contactId: string, correlationId: string) {
    try {
      const existing = await prisma.conversation.findFirst({
        where: { organizationId, contactId, channel: ChannelType.WHATSAPP },
      });
      if (existing) return existing;

      return await prisma.conversation.create({
        data: { organizationId, contactId, channel: ChannelType.WHATSAPP },
      });
    } catch (err: any) {
      if (err.code === 'P2002') {
        log.debug('conversation_race_condition_resolved', { correlationId, contactId });
        const conv = await prisma.conversation.findFirst({
          where: { organizationId, contactId, channel: ChannelType.WHATSAPP },
        });
        if (conv) return conv;
      }
      throw err;
    }
  }

  async getConversations(organizationId: string) {
    // messages must be the LAST 50, not the first 50 — with asc+take, any
    // conversation longer than 50 messages showed only its OLDEST messages
    // and new activity never appeared in the console. Fetch desc, then
    // restore chronological order for the UI.
    const conversations = await prisma.conversation.findMany({
      where: { organizationId },
      include: {
        contact: true,
        messages: { orderBy: { sentAt: 'desc' }, take: 50 },
        assignedUser: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: { lastMessageAt: 'desc' },
      take: 100, // paginate: never return unbounded result sets
    });
    return conversations.map((c: any) => ({ ...c, messages: [...c.messages].reverse() }));
  }

  /**
   * Sends a human agent's reply out over WhatsApp.
   *
   * `organizationId` is required and enforced. The lookup used to be a bare
   * `findUnique({ where: { id: conversationId } })`, so any authenticated user of any
   * tenant could post into another tenant's conversation just by knowing (or guessing)
   * its id — the message would be delivered to that tenant's customer over that
   * tenant's WhatsApp number, and stored in their transcript.
   */
  async sendAgentMessage(
    conversationId: string,
    content: string,
    agentUserId: string,
    organizationId: string
  ) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
      include: {
        contact: true,
        organization: { include: { whatsAppConfigs: { where: { isActive: true }, take: 1 } } },
      },
    });

    if (!conversation) throw new NotFoundException(`Conversation not found: ${conversationId}`);

    // Resolve client first — throws early if credentials missing before writing to DB
    const config = conversation.organization.whatsAppConfigs[0];
    const client = resolveWhatsAppClient(config ?? {});

    // Attempt sending via Meta WhatsApp Cloud API
    await client.sendTextMessage(conversation.contact.phoneNumber, content);

    // Save to DB only after successful delivery
    const msg = await prisma.message.create({
      data: {
        conversationId,
        sender: MessageSender.HUMAN_AGENT,
        content,
        metadata: { sentByAgentId: agentUserId },
      },
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date(), isHumanHandoffActive: true, assignedUserId: agentUserId },
    });

    return msg;
  }

  async toggleHumanHandoff(
    conversationId: string,
    isHumanHandoffActive: boolean,
    organizationId: string,
    agentUserId?: string
  ) {
    // Tenant-scoped: without this check any authenticated user could seize or release
    // human handoff on another organization's live conversation.
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
      select: { id: true },
    });
    if (!conversation) throw new NotFoundException(`Conversation not found: ${conversationId}`);

    return prisma.conversation.update({
      where: { id: conversationId },
      data: {
        isHumanHandoffActive,
        assignedUserId: isHumanHandoffActive ? (agentUserId ?? null) : null,
        // Clear handoffReason when agent returns conversation to AI
        handoffReason: isHumanHandoffActive ? undefined : null,
      },
      include: { contact: true, messages: { orderBy: { sentAt: 'desc' }, take: 20 } },
    });
  }

  // ─── Template Management ──────────────────────────────────────────────────
  async getTemplates(organizationId: string) {
    return prisma.whatsAppTemplate.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createTemplate(organizationId: string, data: {
    name: string;
    language?: string;
    category?: string;
    headerType?: string;
    headerContent?: string;
    bodyText: string;
    footerText?: string;
    buttons?: any;
  }) {
    return prisma.whatsAppTemplate.create({
      data: {
        organizationId,
        name: data.name.toLowerCase().trim().replace(/\s+/g, '_'),
        language: data.language || 'en_US',
        category: data.category || 'MARKETING',
        headerType: data.headerType,
        headerContent: data.headerContent,
        bodyText: data.bodyText,
        footerText: data.footerText,
        buttons: data.buttons ? data.buttons : undefined,
        // PENDING_SUBMISSION, not APPROVED.
        //
        // Creating a row here does not register anything with Meta. Only templates
        // Meta has reviewed and approved can be used in a broadcast, so marking a
        // freshly-typed local row 'APPROVED' told operators a template was ready to
        // send when every send using it would be rejected with error 132001
        // ("template name does not exist"). Submit it in WhatsApp Manager, then set
        // metaTemplateId and status here.
        status: 'PENDING_SUBMISSION',
      },
    });
  }

  async deleteTemplate(organizationId: string, id: string) {
    const template = await prisma.whatsAppTemplate.findFirst({
      where: { id, organizationId },
    });
    if (!template) throw new NotFoundException('Template not found');
    return prisma.whatsAppTemplate.delete({ where: { id } });
  }

  // ─── Broadcast Campaigns ──────────────────────────────────────────────────
  async getBroadcasts(organizationId: string) {
    return prisma.broadcastCampaign.findMany({
      where: { organizationId },
      include: { template: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async sendBroadcast(organizationId: string, data: {
    name: string;
    templateId: string;
    recipients: string[];
    variables?: Record<string, string>;
  }) {
    const template = await prisma.whatsAppTemplate.findFirst({
      where: { id: data.templateId, organizationId },
    });

    if (!template) throw new NotFoundException('WhatsApp template not found');

    if (template.status !== 'APPROVED') {
      throw new BadRequestException(
        `Template "${template.name}" has not been approved by Meta yet (status: ${template.status}). ` +
        'Submit it in WhatsApp Manager and mark it approved before broadcasting.'
      );
    }

    const config = withWhatsAppCredentials(
      await prisma.whatsAppConfig.findFirst({
        where: { organizationId, isActive: true },
      })
    );

    const campaign = await prisma.broadcastCampaign.create({
      data: {
        organizationId,
        templateId: data.templateId,
        name: data.name,
        recipients: data.recipients,
        totalCount: data.recipients.length,
        status: 'SENDING',
        variables: data.variables ? (data.variables as any) : undefined,
        sentAt: new Date(),
      },
    });

    let sentCount = 0;
    let failedCount = 0;
    const errors: string[] = [];

    // If WhatsApp is not configured, the campaign is FAILED — not "sent".
    // This branch used to do `sentCount = data.recipients.length`, reporting a
    // fully-delivered campaign to an audience that received nothing at all.
    if (!config?.phoneNumberId || !config?.accessToken) {
      await prisma.broadcastCampaign.update({
        where: { id: campaign.id },
        data: { sentCount: 0, failedCount: data.recipients.length, status: 'FAILED' },
      });
      throw new BadRequestException(
        'WhatsApp is not connected for this organization, so no messages were sent. ' +
        'Configure your Meta credentials under Settings → WhatsApp Integration.'
      );
    }

    const client = resolveWhatsAppClient(config);

    for (const phone of data.recipients) {
      try {
        const components: any[] = [];
        if (data.variables && Object.keys(data.variables).length > 0) {
          components.push({
            type: 'body',
            parameters: Object.values(data.variables).map(v => ({ type: 'text', text: v })),
          });
        }

        await client.sendTemplateMessage(phone, template.name, template.language, components);
        sentCount++;
      } catch (err) {
        failedCount++;
        const message = (err as Error).message;
        if (errors.length < 5) errors.push(message.slice(0, 200));
        log.warn('broadcast_recipient_failed', { phone: phone.slice(-4), error: message });
      }
    }

    const campaignResult = await prisma.broadcastCampaign.update({
      where: { id: campaign.id },
      data: {
        sentCount,
        failedCount,
        status: sentCount === 0 ? 'FAILED' : failedCount > 0 ? 'PARTIAL' : 'COMPLETED',
      },
      include: { template: true },
    });

    // Surface why delivery failed instead of returning a green campaign row.
    return { ...campaignResult, errors };
  }
}
