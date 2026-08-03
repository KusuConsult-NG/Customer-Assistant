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
    let org = await prisma.organization.findFirst({
      where: { id: apiKeyOrOrgId },
      select: {
        id: true,
        name: true,
        welcomeMessage: true,
        aiPersonaPrompt: true,
        logoUrl: true,
        phone: true,
      },
    });

    if (!org) {
      org = await prisma.organization.findFirst({
        select: {
          id: true,
          name: true,
          welcomeMessage: true,
          aiPersonaPrompt: true,
          logoUrl: true,
          phone: true,
        },
      });
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

    // Find or create Contact
    let contact = null;
    if (data.customerPhone || data.customerEmail) {
      contact = await prisma.contact.findFirst({
        where: {
          organizationId,
          OR: [
            ...(data.customerPhone ? [{ phoneNumber: data.customerPhone }] : []),
            ...(data.customerEmail ? [{ email: data.customerEmail }] : []),
          ],
        },
      });
    }

    if (!contact) {
      contact = await prisma.contact.create({
        data: {
          organizationId,
          fullName: data.customerName || 'Web Visitor',
          phoneNumber: data.customerPhone || `web_${Date.now()}`,
          email: data.customerEmail,
          tags: ['web-widget'],
        },
      });
    }

    // Find or create Conversation
    let conversation = await prisma.conversation.findFirst({
      where: {
        organizationId,
        contactId: contact.id,
        channel: ChannelType.WEBCHAT,
      },
      include: { messages: true },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          organizationId,
          contactId: contact.id,
          channel: ChannelType.WEBCHAT,
          isHumanHandoffActive: false,
        },
        include: { messages: true },
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
          history: [],
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

  async getSessionHistory(apiKey: string, sessionId: string) {
    const config = await this.getWidgetConfig(apiKey);
    const conversation = await prisma.conversation.findFirst({
      where: {
        organizationId: config.organizationId,
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
