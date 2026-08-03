import {
  Controller,
  Get,
  Post,
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
import { AuthUser } from '@ace/shared-types';
import { AceLogger, generateCorrelationId } from '../config/logger';

const log = new AceLogger('WhatsappController');

/**
 * Verifies the X-Hub-Signature-256 header sent by Meta on every webhook POST.
 *
 * Why this matters: Without HMAC verification, any attacker who discovers your
 * webhook URL can inject arbitrary messages, trigger AI responses, create contacts,
 * and exhaust your Paystack billing quota — all without owning a WhatsApp number.
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
   * Security contract:
   *  1. We always respond 200 immediately (Meta requires this within 20s or it retries).
   *  2. We verify the HMAC-SHA256 signature BEFORE any database or business logic.
   *  3. Processing is async — the response is sent before await completes.
   *
   * @SkipThrottle — Meta delivers messages in bursts during high-traffic periods
   *  and retries if we return non-200. Throttling these webhooks would cause message loss.
   *  Security is handled by HMAC-SHA256 signature verification, not rate limiting.
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
    // Always ACK immediately — Meta will retry if we take > 20s
    res.status(200).send('EVENT_RECEIVED');

    const correlationId = generateCorrelationId();
    const timer = log.startTimer();

    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (!appSecret) {
      log.error('WHATSAPP_APP_SECRET not configured — webhook signature cannot be verified', new Error('Missing env var'), { correlationId });
      return;
    }

    // Use the raw body buffer for HMAC — NOT the parsed JSON body
    const rawBody = req.rawBody;
    if (!rawBody) {
      log.error('rawBody is undefined. Ensure NestFactory.create(AppModule, { rawBody: true }) in main.ts', new Error('Missing rawBody'), { correlationId });
      return;
    }

    if (!verifyMetaSignature(rawBody, signature, appSecret)) {
      log.warn('whatsapp_invalid_signature', {
        correlationId,
        event: 'signature_rejected',
        signatureProvided: !!signature,
      });
      // Do not process — silently drop. We already sent 200 to Meta.
      return;
    }

    log.info('whatsapp_webhook_received', {
      correlationId,
      event: 'webhook_processing',
      messageCount: body?.entry?.[0]?.changes?.[0]?.value?.messages?.length ?? 0,
    });

    // Process asynchronously — any errors are caught inside the service
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
    return this.whatsappService.sendAgentMessage(id, body.content, req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('conversations/:id/handoff')
  async toggleHandoff(
    @Param('id') id: string,
    @Req() req: { user: AuthUser },
    @Body() body: { isHumanHandoffActive: boolean }
  ) {
    if (typeof body.isHumanHandoffActive !== 'boolean') {
      throw new BadRequestException('isHumanHandoffActive must be a boolean');
    }
    return this.whatsappService.toggleHumanHandoff(id, body.isHumanHandoffActive, req.user.userId);
  }
}
