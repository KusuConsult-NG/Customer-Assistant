/**
 * POST /api/webhooks/elevenlabs — deliveries from ElevenLabs after a
 * conversation finishes.
 *
 * Security contract, identical in shape to the Meta webhook next door:
 * VERIFY, then ACK, then process.
 *
 *  1. The HMAC is checked against the RAW body before anything else happens.
 *     Unverified, this endpoint would let anyone who learns the URL write call
 *     transcripts and contacts into any tenant's CRM by posting an agent id.
 *  2. A missing secret or a missing rawBody is a 500, not a 403 — those are our
 *     bugs, and a 500 makes ElevenLabs retry, so the conversation is delayed
 *     rather than lost while the configuration is fixed.
 *  3. A bad signature is a 403 and nothing is read from the body.
 *  4. Only then do we ACK, and only then do we write anything.
 *
 * Processing runs after the ACK. A failure there does not trigger a retry
 * storm — and the data is not gone, because the same conversation can be
 * re-fetched from the conversations API by the id this logs on failure.
 */
import { Controller, Headers, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { AceLogger, generateCorrelationId } from '../config/logger';
import { signatureHeaderName, verifyElevenLabsSignature } from './elevenlabs-signature';
import { ElevenLabsWebhookService } from './elevenlabs-webhook.service';

const log = new AceLogger('ElevenLabsWebhookController');

@Controller('api/webhooks')
export class ElevenLabsWebhookController {
  constructor(private readonly webhook: ElevenLabsWebhookService) {}

  /**
   * @SkipThrottle — calls end in bursts, and a throttled 429 would be retried
   * by ElevenLabs rather than dropped, so throttling buys nothing and costs
   * delivery latency. The signature is what keeps this endpoint safe.
   */
  @SkipThrottle()
  @Post('elevenlabs')
  @HttpCode(200)
  async handle(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers() headers: Record<string, string>,
    @Res() res: Response
  ): Promise<void> {
    const correlationId = generateCorrelationId();

    const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
    if (!secret) {
      log.error(
        'ELEVENLABS_WEBHOOK_SECRET is not set — the delivery cannot be verified',
        new Error('Missing env var'),
        { correlationId }
      );
      res.status(500).send('Server misconfiguration');
      return;
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      log.error(
        'rawBody is undefined. NestFactory.create must keep { rawBody: true } and no second body parser may be registered — see main.ts',
        new Error('Missing rawBody'),
        { correlationId }
      );
      res.status(500).send('Server misconfiguration');
      return;
    }

    const headerName = signatureHeaderName();
    const signature = headers[headerName];
    const verdict = verifyElevenLabsSignature(rawBody, signature, secret);

    if (!verdict.ok) {
      log.warn('elevenlabs_webhook_rejected', {
        correlationId,
        reason: verdict.reason,
        expectedHeader: headerName,
        // The header name is documented but was never confirmed against a live
        // delivery from this environment. Listing what actually arrived turns a
        // wrong guess into a one-line fix instead of a silent 403 loop.
        ...(signature
          ? {}
          : { headersReceived: Object.keys(headers).filter((h) => h.includes('sign')) }),
      });
      res.status(403).send('Invalid signature');
      return;
    }

    // Verified. Parse only now — before this point the body is untrusted bytes.
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      log.warn('elevenlabs_webhook_unparseable', { correlationId });
      res.status(400).send('Malformed JSON');
      return;
    }

    res.status(200).send('OK');

    this.webhook
      .ingest(payload as any, correlationId)
      .then((outcome) => {
        if (!outcome.handled) {
          log.info('elevenlabs_webhook_not_stored', { correlationId, reason: outcome.reason });
        }
      })
      .catch((err) => {
        // Named loudly: the conversation is still retrievable from ElevenLabs
        // by this id, so this log is the difference between a recoverable gap
        // and a lost transcript.
        log.error('elevenlabs_webhook_processing_failed', err, {
          correlationId,
          conversationId: (payload as any)?.data?.conversation_id ?? null,
        });
      });
  }
}
