import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, MessageSender } from '@ace/shared-types';
import { prisma } from '@ace/database';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { AgentConsoleGateway } from './agent-console.gateway';
import { AceLogger } from '../config/logger';

const log = new AceLogger('ConversationsController');

const MESSAGE_PAGE_SIZE = 200;

@Controller('api/conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly gateway: AgentConsoleGateway
  ) {}

  /**
   * GET /api/conversations
   * Returns conversations for the caller's organization, most recently active first.
   */
  @Get()
  async getConversations(@Req() req: { user: AuthUser }) {
    return prisma.conversation.findMany({
      where: { organizationId: req.user.organizationId },
      include: {
        contact: {
          select: { id: true, fullName: true, phoneNumber: true, email: true },
        },
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
          select: { content: true, sender: true, sentAt: true },
        },
      },
      // lastMessageAt is what the UI sorts and displays; updatedAt also moves for
      // unrelated edits such as a handoff toggle, which reshuffled the inbox for no
      // visible reason.
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
    });
  }

  /**
   * GET /api/conversations/:id/messages
   */
  @Get(':id/messages')
  async getMessages(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Query('before') before?: string
  ) {
    const conv = await this.requireConversation(id, req.user.organizationId);

    return prisma.message.findMany({
      where: {
        conversationId: conv.id,
        ...(before ? { sentAt: { lt: new Date(before) } } : {}),
      },
      orderBy: { sentAt: 'asc' },
      take: MESSAGE_PAGE_SIZE,
    });
  }

  /**
   * POST /api/conversations/:id/messages
   * A human agent replies in a conversation.
   *
   * This previously wrote a Message row and returned it — and stopped there. The
   * customer never received anything: nothing was ever handed to the WhatsApp Cloud
   * API. Agents saw their reply in the transcript and reasonably assumed it had been
   * delivered. Delivery is now attempted on the conversation's own channel, and a
   * failure is reported rather than persisted as a phantom "sent" message.
   */
  @Post(':id/messages')
  async sendMessage(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { content: string }
  ) {
    const content = body?.content?.trim();
    if (!content) throw new BadRequestException('Message content cannot be empty');

    const conv = await this.requireConversation(id, req.user.organizationId);

    if (conv.channel === 'WHATSAPP') {
      // Delegates to WhatsappService, which sends over the Cloud API first and only
      // persists the message once Meta has accepted it.
      const message = await this.whatsappService.sendAgentMessage(
        conv.id,
        content,
        req.user.userId,
        req.user.organizationId
      );
      this.gateway.notifyNewMessage(req.user.organizationId, { conversationId: conv.id, message });
      return message;
    }

    // WEBCHAT and other channels are pull-based: the widget polls /api/widget/history,
    // so persisting the message *is* delivery for them.
    const message = await prisma.message.create({
      data: {
        conversationId: conv.id,
        content,
        sender: MessageSender.HUMAN_AGENT,
        metadata: { sentByAgentId: req.user.userId },
      },
    });

    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageAt: new Date(),
        isHumanHandoffActive: true,
        assignedUserId: req.user.userId,
      },
    });

    this.gateway.notifyNewMessage(req.user.organizationId, { conversationId: conv.id, message });

    if (conv.channel !== 'WEBCHAT') {
      log.warn('agent_reply_channel_not_deliverable', {
        conversationId: conv.id,
        channel: conv.channel,
        organizationId: req.user.organizationId,
      });
    }

    return message;
  }

  /**
   * PATCH /api/conversations/:id/handoff
   * Toggles human handoff for the conversation.
   */
  @Patch(':id/handoff')
  async toggleHandoff(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { handoff: boolean }
  ) {
    if (typeof body?.handoff !== 'boolean') {
      throw new BadRequestException('handoff must be a boolean');
    }

    const conv = await this.requireConversation(id, req.user.organizationId);

    const updated = await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        isHumanHandoffActive: body.handoff,
        assignedUserId: body.handoff ? req.user.userId : null,
        handoffReason: body.handoff ? undefined : null,
      },
    });

    this.gateway.notifyHandoffChanged(req.user.organizationId, updated);
    return updated;
  }

  /**
   * Every handler goes through this: an id alone is not authority to read or write a
   * conversation. Missing rows raise 404 rather than the bare `throw new Error(...)`
   * these handlers used to do, which surfaced as an opaque 500.
   */
  private async requireConversation(id: string, organizationId: string) {
    const conv = await prisma.conversation.findFirst({ where: { id, organizationId } });
    if (!conv) throw new NotFoundException('Conversation not found');
    return conv;
  }
}
