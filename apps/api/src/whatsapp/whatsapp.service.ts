import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { WhatsAppCloudClient } from '@ace/whatsapp-sdk';
import { ConversationOrchestrator } from '@ace/orchestrator';
import { ChannelType, MessageSender } from '@ace/shared-types';
import { AceLogger } from '../config/logger';

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

  constructor(private webhookDispatcher: WebhookDispatcherService) {}

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
      let config = await prisma.whatsAppConfig.findFirst({
        where: { phoneNumberId },
      });

      if (!config) {
        // Fallback: any active config (supports single-tenant deployments with
        // a single WhatsApp number not yet mapped to a specific incoming number ID)
        config = await prisma.whatsAppConfig.findFirst({ where: { isActive: true } });
      }

      if (!config) {
        log.warn('whatsapp_no_config_found', {
          correlationId,
          event: 'config_not_found',
          phoneNumberId,
          fromNumber: fromNumber.slice(-4),
        });
        return;
      }

      const organizationId = config.organizationId;

      log.debug('whatsapp_org_resolved', { correlationId, organizationId });

      // ── 2. Upsert Contact (race-safe) ────────────────────────────────────────
      const contact = await this.upsertContact(organizationId, fromNumber, correlationId);

      // ── 3. Upsert Conversation ────────────────────────────────────────────────
      const conversation = await this.upsertConversation(organizationId, contact.id, correlationId);

      // ── 4. Persist inbound message ────────────────────────────────────────────
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          sender: MessageSender.CUSTOMER,
          content: textContent,
          mediaUrl: mediaUrl ?? null,
          mediaType: mediaType ?? null,
          metadata: { messageId, messageType: message.type },
        },
      });

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });

      this.webhookDispatcher.dispatch(organizationId, 'message.received', {
        contactPhone: fromNumber,
        message: textContent,
        conversationId: conversation.id,
      }).catch(err => log.error('webhook_dispatch_failed', err, { correlationId }));

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
  private async upsertContact(organizationId: string, phoneNumber: string, correlationId: string) {
    try {
      const existing = await prisma.contact.findFirst({
        where: { organizationId, phoneNumber },
      });

      if (existing) return existing;

      return await prisma.contact.create({
        data: {
          organizationId,
          phoneNumber,
          fullName: `WhatsApp Contact (···${phoneNumber.slice(-4)})`,
        },
      });
    } catch (err: any) {
      // P2002 = Unique constraint violation (race condition: another request created it first)
      if (err.code === 'P2002') {
        log.debug('contact_race_condition_resolved', { correlationId, phoneNumber: phoneNumber.slice(-4) });
        const contact = await prisma.contact.findFirst({ where: { organizationId, phoneNumber } });
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
    return prisma.conversation.findMany({
      where: { organizationId },
      include: {
        contact: true,
        messages: { orderBy: { sentAt: 'asc' }, take: 50 },
        assignedUser: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: { lastMessageAt: 'desc' },
      take: 100, // paginate: never return unbounded result sets
    });
  }

  async sendAgentMessage(conversationId: string, content: string, agentUserId: string) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        contact: true,
        organization: { include: { whatsAppConfigs: { where: { isActive: true }, take: 1 } } },
      },
    });

    if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);

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

    const config = conversation.organization.whatsAppConfigs[0];

    // Throws with a clear message if credentials missing — agent sees this in the UI
    const client = resolveWhatsAppClient(config ?? {});
    await client.sendTextMessage(conversation.contact.phoneNumber, content);

    return msg;
  }

  async toggleHumanHandoff(conversationId: string, isHumanHandoffActive: boolean, agentUserId?: string) {
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
}
