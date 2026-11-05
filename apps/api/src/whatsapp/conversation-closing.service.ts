import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, prisma, withWhatsAppCredentials } from '@ace/database';
import { WhatsAppCloudClient } from '@ace/whatsapp-sdk';
import { MessageSender } from '@ace/shared-types';
import { AceLogger } from '../config/logger';

const log = new AceLogger('ConversationClosing');

/**
 * Close a conversation that has gone quiet, and point the citizen at the
 * State's own channels.
 *
 * ── Why a sweeper and not a timer per chat ──────────────────────────────────
 *
 * A timer lives in one process. This API runs more than one, restarts on every
 * deploy, and sleeps on some plans — so a per-conversation timer silently
 * stops being a promise the moment anything restarts. A sweep over the
 * database holds no state of its own and resumes correctly after a restart,
 * which is the same reason the appointment reminders are a sweep.
 *
 * ── Claim BEFORE sending, or two pods both close the same chat ──────────────
 *
 * `Message.externalId` is UNIQUE, so inserting the closing message IS the
 * claim: a second pod attempting the same conversation gets P2002 and stops.
 * The key carries the conversation and the exact `lastMessageAt` it is closing
 * on, so a citizen who comes back next week and goes quiet again gets a fresh
 * close rather than silence — while the same quiet spell is never closed twice.
 *
 * If the send then fails the claim row is REMOVED. A row that says the agency
 * sent something it did not send is the fabrication this codebase exists to
 * keep out, and an officer reading the thread would have no way to know.
 *
 * ── What it will not interrupt ──────────────────────────────────────────────
 *
 *  - A HANDOFF. An officer is holding that conversation; a bot closing it
 *    underneath them is worse than no closing at all.
 *  - A FLOW IN PROGRESS. `flowState` means the citizen is part-way through a
 *    booking, a complaint or a registration. Closing there abandons it.
 *  - A conversation whose LAST message is the citizen's. They are owed a
 *    reply, not a sign-off — closing there is the system walking away
 *    mid-question.
 *  - Anything outside WhatsApp's 24-hour window. Meta refuses free-form
 *    messages past it, so attempting one spends a request to be told no.
 */
@Injectable()
export class ConversationClosingService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  /** How long a citizen must be silent. Minutes, settable per deployment. */
  private get quietMinutes(): number {
    const raw = Number(process.env.CONVERSATION_CLOSING_MINUTES);
    return Number.isFinite(raw) && raw >= 1 ? raw : 5;
  }

  private get disabled(): boolean {
    return process.env.CONVERSATION_CLOSING_DISABLED === '1';
  }

  onModuleInit() {
    if (this.disabled) {
      log.info('conversation_closing_disabled');
      return;
    }
    // Every minute. The window is minutes wide, so a finer sweep buys nothing
    // and a coarser one makes "5 minutes" mean something else.
    this.timer = setInterval(() => {
      this.sweep().catch((err) => log.error('conversation_closing_sweep_failed', err as Error));
    }, 60_000);
    this.timer.unref?.();
    log.info('conversation_closing_started', { quietMinutes: this.quietMinutes });
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = new Date()): Promise<{ closed: number; considered: number }> {
    if (this.disabled) return { closed: 0, considered: 0 };

    const quietSince = new Date(now.getTime() - this.quietMinutes * 60_000);
    // Meta refuses a free-form message outside 24 hours of the citizen's last
    // one, so a conversation past that is not a candidate at all.
    const windowOpensAfter = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const candidates = await prisma.conversation.findMany({
      where: {
        channel: 'WHATSAPP',
        isHumanHandoffActive: false,
        flowState: { equals: Prisma.DbNull },
        lastMessageAt: { lte: quietSince, gte: windowOpensAfter },
      },
      include: {
        contact: true,
        organization: { include: { whatsAppConfigs: { where: { isActive: true }, take: 1 } } },
        messages: { orderBy: { sentAt: 'desc' }, take: 1 },
      },
      take: 100,
    });

    let closed = 0;
    for (const conversation of candidates) {
      try {
        if (await this.closeOne(conversation)) closed++;
      } catch (err) {
        // One tenant's failure must not end the sweep for everybody else.
        log.error('conversation_closing_failed', err as Error, {
          conversationId: conversation.id,
        });
      }
    }
    return { closed, considered: candidates.length };
  }

  private async closeOne(conversation: any): Promise<boolean> {
    const last = conversation.messages[0];
    // Nothing said yet, or the citizen spoke last and is owed an answer.
    if (!last || last.sender === MessageSender.CUSTOMER) return false;

    const config = withWhatsAppCredentials(conversation.organization.whatsAppConfigs[0] as any);
    if (!config?.accessToken || !config?.phoneNumberId) return false;

    const text = closingMessage(conversation.organization.name);
    const externalId = `closing:${conversation.id}:${conversation.lastMessageAt.toISOString()}`;

    // The claim. A unique violation means another pod already has it.
    let claim;
    try {
      claim = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          sender: MessageSender.AI,
          content: text,
          externalId,
          metadata: { closedAfterSilence: true, quietMinutes: this.quietMinutes },
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') return false;
      throw err;
    }

    try {
      const client = new WhatsAppCloudClient({
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
        verifyToken: config.webhookVerifyToken ?? '',
      });
      await client.sendTextMessage(conversation.contact.phoneNumber, text);
    } catch (err) {
      // Never leave a record of something the citizen did not receive.
      await prisma.message.delete({ where: { id: claim.id } }).catch(() => undefined);
      throw err;
    }

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });
    log.info('conversation_closed_after_silence', {
      conversationId: conversation.id,
      organizationId: conversation.organizationId,
    });
    return true;
  }
}

/**
 * The sign-off.
 *
 * It names the State's own channels for general government activity, and says
 * plainly that the citizen can simply write again — a closing message that
 * reads like a door shutting is worse than none, because the next thing the
 * citizen needs is to be told they may come back.
 */
export function closingMessage(agencyName: string): string {
  return (
    `Thank you for contacting ${agencyName}. I'll close here for now — just send another ` +
    `message any time and we'll pick up where we left off.\n\n` +
    `For general news and activities of the Plateau State Government:\n` +
    `• Website: plateaustate.gov.ng\n` +
    `• Facebook: facebook.com/PLSGov\n` +
    `• Instagram: @plsgovt`
  );
}
