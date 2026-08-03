import { Controller, Get, Post, Patch, Body, Param, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '@ace/shared-types';
import { prisma } from '@ace/database';

@Controller('api/conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  /**
   * GET /api/conversations
   * Returns all conversations for the organization, newest first.
   */
  @Get()
  async getConversations(@Req() req: { user: AuthUser }) {
    return prisma.conversation.findMany({
      where: { organizationId: req.user.organizationId },
      include: {
        contact: {
          select: {
            id: true,
            fullName: true,
            phoneNumber: true,
            email: true,
          },
        },
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
          select: { content: true, sender: true, sentAt: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  }

  /**
   * GET /api/conversations/:id/messages
   * Returns all messages for a conversation.
   */
  @Get(':id/messages')
  async getMessages(
    @Req() req: { user: AuthUser },
    @Param('id') id: string
  ) {
    // Verify conversation belongs to this org
    const conv = await prisma.conversation.findFirst({
      where: { id, organizationId: req.user.organizationId },
    });
    if (!conv) return [];

    return prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { sentAt: 'asc' },
    });
  }

  /**
   * POST /api/conversations/:id/messages
   * Human agent sends a reply in a conversation.
   */
  @Post(':id/messages')
  async sendMessage(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { content: string }
  ) {
    const conv = await prisma.conversation.findFirst({
      where: { id, organizationId: req.user.organizationId },
    });
    if (!conv) throw new Error('Conversation not found');

    const message = await prisma.message.create({
      data: {
        conversationId: id,
        content: body.content,
        sender: 'HUMAN_AGENT',
      },
    });

    await prisma.conversation.update({
      where: { id },
      data: { updatedAt: new Date(), lastMessageAt: new Date() },
    });

    return message;
  }

  /**
   * PATCH /api/conversations/:id/handoff
   * Toggles human handoff (sets status)
   */
  @Patch(':id/handoff')
  async toggleHandoff(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { handoff: boolean }
  ) {
    const conv = await prisma.conversation.findFirst({
      where: { id, organizationId: req.user.organizationId },
    });
    if (!conv) throw new Error('Conversation not found');
    
    return prisma.conversation.update({
      where: { id },
      data: { isHumanHandoffActive: body.handoff, updatedAt: new Date() },
    });
  }
}
