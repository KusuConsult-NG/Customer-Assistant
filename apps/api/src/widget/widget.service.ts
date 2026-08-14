import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@ace/database';
import { ConversationOrchestrator } from '@ace/orchestrator';
import { ChannelType, MessageSender } from '@ace/shared-types';
import { AceLogger } from '../config/logger';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';

const log = new AceLogger('WidgetService');

@Injectable()
export class WidgetService {
  private orchestrator = new ConversationOrchestrator();

  constructor(private webhookDispatcher: WebhookDispatcherService) {}

  async getWidgetConfig(apiKeyOrOrgId: string) {
    const orgSelect = {
      id: true,
      name: true,
      welcomeMessage: true,
      aiPersonaPrompt: true,
      logoUrl: true,
      phone: true,
    } as const;

    let org = null;
    if (apiKeyOrOrgId) {
      org = await prisma.organization.findFirst({
        where: { id: apiKeyOrOrgId },
        select: orgSelect,
      });
      // Tenant isolation: a key WAS provided but matches nothing. Do NOT fall
      // back to "any organization" — that would route this visitor's chat (and
      // their conversation history) into an unrelated tenant's CRM.
      if (!org) {
        throw new NotFoundException(
          'Organization not found for the provided widget key. Check the embed snippet on Settings → Widget.'
        );
      }
    } else {
      // No key at all: single-tenant/demo convenience — use the only org.
      // In a multi-tenant deployment the embed snippet always includes the key.
      org = await prisma.organization.findFirst({ select: orgSelect });
    }

    if (!org) throw new NotFoundException('Organization not found for widget');

    return {
      organizationId: org.id,
      organizationName: org.name,
      welcomeMessage: org.welcomeMessage || 'Hello! How can we assist you today?',
      logoUrl: org.logoUrl || null,
      primaryColor: '#3b82f6',
      secondaryColor: '#1e40af',
      position: 'bottom-right',
      enableChat: true,
      enableVoiceCall: true,
    };
  }

  async processWidgetChat(data: {
    apiKey?: string;
    sessionId: string;
    message: string;
    customerName?: string;
    customerEmail?: string;
    customerPhone?: string;
  }) {
    const config = await this.getWidgetConfig(data.apiKey || '');
    const organizationId = config.organizationId;

    // Find or create Contact.
    // Anonymous visitors are identified by their widget sessionId, giving them a
    // STABLE synthetic identity (web_<sessionId>). The previous web_<Date.now()>
    // scheme minted a brand-new contact + conversation for EVERY message, so the
    // AI never saw history and the CRM filled with one-message ghost contacts.
    const anonymousIdentity = `web_${data.sessionId || Date.now()}`;

    let contact = await prisma.contact.findFirst({
      where: {
        organizationId,
        OR: [
          ...(data.customerPhone ? [{ phoneNumber: data.customerPhone }] : []),
          ...(data.customerEmail ? [{ email: data.customerEmail }] : []),
          { phoneNumber: anonymousIdentity },
        ],
      },
    });

    if (!contact) {
      try {
        contact = await prisma.contact.create({
          data: {
            organizationId,
            fullName: data.customerName || 'Web Visitor',
            phoneNumber: data.customerPhone || anonymousIdentity,
            email: data.customerEmail,
            tags: ['web-widget'],
          },
        });
      } catch (err: any) {
        // P2002: two concurrent first-messages from the same session raced on
        // @@unique([organizationId, phoneNumber]) — the other request won.
        if (err.code !== 'P2002') throw err;
        contact = await prisma.contact.findFirst({
          where: { organizationId, phoneNumber: data.customerPhone || anonymousIdentity },
        });
        if (!contact) throw err;
      }
    }

    // Find or create Conversation (messages: last 10 only — enough for AI
    // context without loading an unbounded thread on every message)
    const lastMessages = { orderBy: { sentAt: 'desc' as const }, take: 10 };
    let conversation = await prisma.conversation.findFirst({
      where: {
        organizationId,
        contactId: contact.id,
        channel: ChannelType.WEBCHAT,
      },
      include: { messages: lastMessages },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          organizationId,
          contactId: contact.id,
          channel: ChannelType.WEBCHAT,
          isHumanHandoffActive: false,
        },
        include: { messages: lastMessages },
      });
    }

    // Save Customer Message
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: MessageSender.CUSTOMER,
        content: data.message,
      },
    });

    // Dispatch Webhook Event
    this.webhookDispatcher.dispatch(organizationId, 'message.received', {
      contactName: contact.fullName,
      contactPhone: contact.phoneNumber,
      message: data.message,
      conversationId: conversation.id,
      channel: 'WEBCHAT',
    }).catch(() => {});

    // Generate AI Response
    let aiReply = 'Thank you for reaching out! Our team has received your message.';

    try {
      const orchestratorResult = await this.orchestrator.processIncomingMessage(
        {
          conversationId: conversation.id,
          organizationId,
          customerPhoneNumber: contact.phoneNumber,
          channel: ChannelType.WEBCHAT,
          // Last 10 messages, restored to chronological order — previously []
          // so the widget AI had no memory of the conversation at all.
          history: [...conversation.messages].reverse().map((m: any) => ({
            sender: m.sender,
            content: m.content,
            timestamp: m.sentAt,
          })),
          slots: {},
          isHumanHandoffActive: conversation.isHumanHandoffActive,
        },
        data.message
      );

      if (orchestratorResult.replyText) {
        aiReply = orchestratorResult.replyText;
      }
    } catch (err: any) {
      log.error('Failed to generate AI response for widget', err);
    }

    // Save AI Message
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: MessageSender.AI,
        content: aiReply,
      },
    });

    return {
      reply: aiReply,
      conversationId: conversation.id,
      sessionId: data.sessionId,
    };
  }

  /**
   * Return the message history for THIS widget session only.
   *
   * The previous implementation ignored sessionId and returned the
   * organization's first WEBCHAT conversation — i.e. one visitor could read
   * another visitor's chat. History is now resolved via the session's stable
   * synthetic contact identity (web_<sessionId>); unknown sessions get [].
   */
  async getSessionHistory(apiKey: string, sessionId: string) {
    const config = await this.getWidgetConfig(apiKey);
    if (!sessionId) return [];

    const contact = await prisma.contact.findFirst({
      where: { organizationId: config.organizationId, phoneNumber: `web_${sessionId}` },
    });
    if (!contact) return [];

    const conversation = await prisma.conversation.findFirst({
      where: {
        organizationId: config.organizationId,
        contactId: contact.id,
        channel: ChannelType.WEBCHAT,
      },
      include: {
        messages: {
          orderBy: { sentAt: 'asc' },
          take: 50,
        },
      },
    });

    return conversation?.messages || [];
  }
}
