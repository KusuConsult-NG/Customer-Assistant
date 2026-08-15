import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { prisma } from '@ace/database';
import { ConversationOrchestrator } from '@ace/orchestrator';
import { ChannelType, MessageSender } from '@ace/shared-types';
import { AceLogger } from '../config/logger';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { WorkflowTriggerService } from '../workflows/workflow-trigger.service';

const log = new AceLogger('WidgetService');

/** Newest messages returned to the widget on reconnect. */
const HISTORY_LIMIT = 50;

/** Conversation turns fed back to the AI as context. */
const AI_CONTEXT_TURNS = 12;

@Injectable()
export class WidgetService {
  private orchestrator = new ConversationOrchestrator();

  constructor(
    private webhookDispatcher: WebhookDispatcherService,
    private workflows: WorkflowTriggerService
  ) {}

  /**
   * Resolves the tenant that owns an embedded widget.
   *
   * The credential is a real API key: `regenerateApiKey()` issues `ace_live_pk_<hex>`
   * and stores only its SHA-256 hash, so we look the key up by hash. An organization
   * id is also accepted, because the widget generator page embeds one for
   * self-hosted installs.
   *
   * There is deliberately NO fallback.
   *
   * The previous implementation ended with:
   *
   *     if (!org) org = await prisma.organization.findFirst({ … });   // any org
   *
   * so a wrong, blank, expired or simply guessed key silently resolved to whichever
   * organization happened to be first in the table. That served the wrong tenant's
   * name, logo, welcome message and AI persona to the visitor, filed the visitor's
   * contact record and chat transcript under that unrelated tenant, and let anyone
   * embed the script on any site to talk to a stranger's knowledge base. It is a
   * hard failure now.
   */
  private async resolveOrganization(credential: string) {
    const key = (credential ?? '').trim();
    if (!key) {
      throw new UnauthorizedException('A widget API key is required.');
    }

    // API key path
    if (key.startsWith('ace_live_pk_') || key.startsWith('ace_test_pk_')) {
      const apiKey = await prisma.apiKey.findUnique({
        where: { keyHash: createHash('sha256').update(key).digest('hex') },
        include: { organization: true },
      });

      if (!apiKey) throw new UnauthorizedException('Invalid widget API key.');

      // Awaited, not fire-and-forget. This is the only audit trail showing which
      // key was used and when — the record that answers "was this key active when
      // the incident happened?". A dropped promise loses that silently, and the
      // write is a single indexed update on a non-hot path.
      await prisma.apiKey
        .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
        .catch(() => {});

      return apiKey.organization;
    }

    // Organization id path (UUID)
    const org = await prisma.organization.findUnique({ where: { id: key } });
    if (!org) throw new UnauthorizedException('Invalid widget API key.');
    return org;
  }

  async getWidgetConfig(credential: string) {
    const org = await this.resolveOrganization(credential);

    return {
      organizationId: org.id,
      organizationName: org.name,
      welcomeMessage: org.welcomeMessage || 'Hello! How can we assist you today?',
      logoUrl: org.logoUrl || null,
      primaryColor: '#3b82f6',
      secondaryColor: '#1e40af',
      position: 'bottom-right',
      enableChat: true,
      // Voice calling from the widget has no implementation behind it (there is no
      // WebRTC or click-to-call endpoint), so it is not advertised as available.
      enableVoiceCall: false,
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
    const org = await this.resolveOrganization(data.apiKey ?? '');
    const organizationId = org.id;

    const contact = await this.resolveContact(organizationId, data);
    const conversation = await this.resolveConversation(organizationId, contact.id, data.sessionId);

    // Save Customer Message
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: MessageSender.CUSTOMER,
        content: data.message,
        metadata: { sessionId: data.sessionId },
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

    this.workflows.emitAsync(organizationId, 'MESSAGE_RECEIVED', {
      channel: 'WEBCHAT',
      message: data.message,
      conversationId: conversation.id,
      contactId: contact.id,
      contactPhone: contact.phoneNumber,
      contact: { id: contact.id, fullName: contact.fullName, phoneNumber: contact.phoneNumber, email: contact.email },
    });

    // Load recent turns so the assistant has conversational memory. The previous
    // version passed `history: []` on every request, so the widget AI could not
    // remember anything the visitor had said one message earlier.
    const recent = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { sentAt: 'desc' },
      take: AI_CONTEXT_TURNS,
    });

    let aiReply = '';
    let handedOff = conversation.isHumanHandoffActive;

    try {
      const result = await this.orchestrator.processIncomingMessage(
        {
          conversationId: conversation.id,
          organizationId,
          customerPhoneNumber: data.customerPhone?.trim() || undefined,
          channel: ChannelType.WEBCHAT,
          history: recent.reverse().map((m) => ({
            sender: m.sender as any,
            content: m.content,
            timestamp: m.sentAt,
          })),
          slots: {},
          isHumanHandoffActive: conversation.isHumanHandoffActive,
        },
        data.message
      );

      aiReply = result.replyText;

      if (result.shouldHandoff && !conversation.isHumanHandoffActive) {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { isHumanHandoffActive: true, handoffReason: result.handoffReason },
        });
        handedOff = true;
      }
    } catch (err: any) {
      log.error('widget_ai_response_failed', err, { organizationId, conversationId: conversation.id });
      aiReply = '';
    }

    if (!aiReply) {
      aiReply = 'Thanks for reaching out! A member of our team will follow up with you shortly.';
    }

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: MessageSender.AI,
        content: aiReply,
      },
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });

    return {
      reply: aiReply,
      conversationId: conversation.id,
      sessionId: data.sessionId,
      handedOffToHuman: handedOff,
    };
  }

  /**
   * Returns the transcript for THIS widget session only.
   *
   * The previous implementation ignored `sessionId` entirely and returned
   * `findFirst({ organizationId, channel: WEBCHAT })` — i.e. it handed every visitor
   * the full chat transcript of whichever webchat conversation happened to come back
   * first, including whatever personal details that other customer had typed.
   */
  async getSessionHistory(credential: string, sessionId: string) {
    const org = await this.resolveOrganization(credential);
    if (!sessionId?.trim()) return [];

    const conversation = await prisma.conversation.findFirst({
      where: {
        organizationId: org.id,
        channel: ChannelType.WEBCHAT,
        contact: { phoneNumber: this.sessionContactKey(sessionId) },
      },
      include: {
        messages: { orderBy: { sentAt: 'asc' }, take: HISTORY_LIMIT },
      },
    });

    return conversation?.messages ?? [];
  }

  /**
   * Anonymous web visitors have no phone number, but Contact.phoneNumber is required
   * and `@@unique([organizationId, phoneNumber])`. We derive a stable synthetic key
   * from the widget session id so that a returning visitor maps to the same contact
   * instead of creating a new `web_<timestamp>` record on every single page load.
   */
  private sessionContactKey(sessionId: string): string {
    return `web:${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`;
  }

  private async resolveContact(
    organizationId: string,
    data: { sessionId: string; customerName?: string; customerEmail?: string; customerPhone?: string }
  ) {
    const phone = data.customerPhone?.trim();
    const email = data.customerEmail?.trim().toLowerCase();

    if (phone || email) {
      const known = await prisma.contact.findFirst({
        where: {
          organizationId,
          OR: [
            ...(phone ? [{ phoneNumber: phone }] : []),
            ...(email ? [{ email }] : []),
          ],
        },
      });
      if (known) return known;
    }

    const sessionKey = this.sessionContactKey(data.sessionId);
    const existing = await prisma.contact.findFirst({
      where: { organizationId, phoneNumber: phone ?? sessionKey },
    });
    if (existing) return existing;

    try {
      return await prisma.contact.create({
        data: {
          organizationId,
          fullName: data.customerName?.trim() || 'Web Visitor',
          phoneNumber: phone ?? sessionKey,
          email,
          tags: ['web-widget'],
        },
      });
    } catch (err: any) {
      if (err.code === 'P2002') {
        const raced = await prisma.contact.findFirst({
          where: { organizationId, phoneNumber: phone ?? sessionKey },
        });
        if (raced) return raced;
      }
      throw err;
    }
  }

  private async resolveConversation(organizationId: string, contactId: string, sessionId: string) {
    const existing = await prisma.conversation.findFirst({
      where: { organizationId, contactId, channel: ChannelType.WEBCHAT },
    });
    if (existing) return existing;

    try {
      return await prisma.conversation.create({
        data: {
          organizationId,
          contactId,
          channel: ChannelType.WEBCHAT,
          isHumanHandoffActive: false,
        },
      });
    } catch (err: any) {
      if (err.code === 'P2002') {
        const raced = await prisma.conversation.findFirst({
          where: { organizationId, contactId, channel: ChannelType.WEBCHAT },
        });
        if (raced) return raced;
      }
      throw err;
    }
  }
}
