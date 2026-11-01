import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
  Param,
  Headers,
  HttpCode,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { WhatsappService } from './whatsapp.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser } from '@ace/shared-types';
import { AceLogger, generateCorrelationId } from '../config/logger';

const log = new AceLogger('WhatsappController');

/**
 * Verifies the X-Hub-Signature-256 header sent by Meta on every webhook POST.
 *
 * Why this matters: Without HMAC verification, any attacker who discovers your
 * webhook URL can inject arbitrary messages, trigger AI responses, create contacts
 * and drive provider spend — all without owning a WhatsApp number.
 *
 * Principle: Verify the cryptographic signature BEFORE touching the body.
 * Use timingSafeEqual to prevent timing-oracle attacks.
 */
function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  try {
    const expected = signatureHeader.slice('sha256='.length);
    const computed = createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const computedBuf = Buffer.from(computed, 'utf8');
    if (expectedBuf.length !== computedBuf.length) return false;
    return timingSafeEqual(expectedBuf, computedBuf);
  } catch {
    return false;
  }
}

/**
 * ── Who may send to a citizen ───────────────────────────────────────────────
 *
 * Reading is open to every member: an officer on a call needs to see what the
 * agency has already told this citizen. Answering a thread and taking it over
 * are an agent's job, so those stay open too — restricting them to an admin
 * means the citizen waits for one.
 *
 * Creating or deleting a TEMPLATE and sending a BROADCAST are OWNER/ADMIN.
 * Those decide what citizens are told, and a broadcast sends it to every
 * number it is given. Every route here previously carried only JwtAuthGuard,
 * so a VIEWER could message an agency's whole contact list.
 *
 * The webhook routes above deliberately carry NO guard — Meta calls them, and
 * they are protected by HMAC signature verification instead.
 */
@Controller('api/whatsapp')
export class WhatsappController {
  constructor(private whatsappService: WhatsappService) {}

  /**
   * GET /api/whatsapp/webhook
   * Meta webhook verification handshake. Called once when you register the webhook URL.
   * @SkipThrottle — Meta calls this exactly once. Throttling it would cause verification to fail.
   */
  @SkipThrottle()
  @Get('webhook')
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response
  ) {
    const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!expectedToken) {
      log.error('WHATSAPP_VERIFY_TOKEN is not set. Cannot verify webhook.', new Error('Missing env var'));
      return res.status(500).send('Server misconfiguration');
    }

    if (mode === 'subscribe' && token === expectedToken) {
      log.info('whatsapp_webhook_verified', { event: 'webhook_verified' });
      return res.status(200).send(challenge);
    }

    log.warn('whatsapp_webhook_verify_failed', { receivedToken: token?.slice(0, 4) + '***' });
    return res.status(403).send('Verification failed');
  }

  /**
   * POST /api/whatsapp/webhook
   *
   * Meta sends every inbound WhatsApp message here.
   *
   * Security contract — VERIFY, then ACK, then process async:
   *  1. HMAC-SHA256 signature is verified BEFORE the 200 is sent. Verification
   *     is a few microseconds — nowhere near Meta's 20s deadline.
   *  2. Invalid signature → 403. Server-side misconfiguration (missing secret,
   *     missing rawBody) → 500, so Meta RETRIES instead of the message being
   *     lost forever. The previous version ACKed 200 first, which turned every
   *     downstream failure into silent, unrecoverable message loss.
   *  3. Business processing still runs after the ACK — a processing error does
   *     not trigger a Meta retry storm for a message we did receive intact.
   *
   * @SkipThrottle — Meta delivers messages in bursts and retries on non-200.
   *  Security is handled by signature verification, not rate limiting.
   */
  @SkipThrottle()
  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: any,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Res() res: Response
  ) {
    const correlationId = generateCorrelationId();
    const timer = log.startTimer();

    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (!appSecret) {
      log.error('WHATSAPP_APP_SECRET not configured — webhook signature cannot be verified', new Error('Missing env var'), { correlationId });
      // 500 → Meta retries; messages are delayed, not lost, while config is fixed.
      res.status(500).send('Server misconfiguration');
      return;
    }

    // Use the raw body buffer for HMAC — NOT the parsed JSON body
    const rawBody = req.rawBody;
    if (!rawBody) {
      log.error('rawBody is undefined. Ensure NestFactory.create(AppModule, { rawBody: true }) in main.ts and no competing body parser (see main.ts comments)', new Error('Missing rawBody'), { correlationId });
      res.status(500).send('Server misconfiguration');
      return;
    }

    if (!verifyMetaSignature(rawBody, signature, appSecret)) {
      log.warn('whatsapp_invalid_signature', {
        correlationId,
        event: 'signature_rejected',
        signatureProvided: !!signature,
      });
      res.status(403).send('Invalid signature');
      return;
    }

    // Signature verified — ACK now, then process asynchronously.
    res.status(200).send('EVENT_RECEIVED');

    log.info('whatsapp_webhook_received', {
      correlationId,
      event: 'webhook_processing',
      messageCount: body?.entry?.[0]?.changes?.[0]?.value?.messages?.length ?? 0,
    });

    // Any errors are caught inside the service
    this.whatsappService.processIncomingWebhook(body, correlationId).catch((err) => {
      log.error('whatsapp_webhook_processing_failed', err, { correlationId });
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get('conversations')
  async getConversations(@Req() req: { user: AuthUser }) {
    return this.whatsappService.getConversations(req.user.organizationId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('conversations/:id/messages')
  async sendAgentMessage(
    @Param('id') id: string,
    @Req() req: { user: AuthUser },
    @Body() body: { content: string }
  ) {
    if (!body.content?.trim()) throw new BadRequestException('Message content cannot be empty');
    return this.whatsappService.sendAgentMessage(
      id,
      body.content,
      req.user.userId,
      req.user.organizationId
    );
  }

  // ── Handoff lives at PATCH /api/conversations/:id/handoff ────────────────
  //
  // `POST conversations/:id/handoff` used to be here, writing the same three
  // columns as the channel-agnostic route in ConversationsController. The two
  // were not equivalent: that one notifies the console gateway and this one did
  // not, so an officer taking a thread over was invisible to every other
  // console and two of them could each think they owned the citizen.
  //
  // Handing a thread to a person is not WhatsApp-specific — VOICE and WEBCHAT
  // conversations do it too — so the single implementation is the channel-
  // agnostic one, and this duplicate is gone rather than left as a second thing
  // that can silently stop broadcasting.

  @UseGuards(JwtAuthGuard)
  @Get('templates')
  async getTemplates(@Req() req: { user: AuthUser }) {
    return this.whatsappService.getTemplates(req.user.organizationId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  @Post('templates')
  async createTemplate(
    @Req() req: { user: AuthUser },
    @Body() body: {
      name: string;
      language?: string;
      category?: string;
      headerType?: string;
      headerContent?: string;
      bodyText: string;
      footerText?: string;
      buttons?: any;
    }
  ) {
    if (!body.name || !body.bodyText) {
      throw new BadRequestException('Template name and body text are required');
    }
    return this.whatsappService.createTemplate(req.user.organizationId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  @Delete('templates/:id')
  async deleteTemplate(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.whatsappService.deleteTemplate(req.user.organizationId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('broadcasts')
  async getBroadcasts(@Req() req: { user: AuthUser }) {
    return this.whatsappService.getBroadcasts(req.user.organizationId);
  }

  /**
   * POST /api/whatsapp/broadcasts — primary path used by the frontend dashboard.
   * POST /api/whatsapp/broadcasts/send — legacy path kept for backwards-compat.
   * Both delegate to the same handler.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  @Post('broadcasts')
  async createBroadcast(
    @Req() req: { user: AuthUser },
    @Body() body: {
      name: string;
      templateId: string;
      recipients: string[];
      variables?: Record<string, string>;
    }
  ) {
    if (!body.name || !body.templateId || !body.recipients || body.recipients.length === 0) {
      throw new BadRequestException('Campaign name, templateId, and at least one recipient phone number are required');
    }
    return this.whatsappService.sendBroadcast(req.user.organizationId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  @Post('broadcasts/send')
  async sendBroadcast(
    @Req() req: { user: AuthUser },
    @Body() body: {
      name: string;
      templateId: string;
      recipients: string[];
      variables?: Record<string, string>;
    }
  ) {
    if (!body.name || !body.templateId || !body.recipients || body.recipients.length === 0) {
      throw new BadRequestException('Campaign name, templateId, and at least one recipient phone number are required');
    }
    return this.whatsappService.sendBroadcast(req.user.organizationId, body);
  }
}
