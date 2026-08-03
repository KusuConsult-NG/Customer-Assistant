import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { WebSocketServer } from 'ws';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { validateEnvironment } from './config/env.validation';
import { attachRedisAdapter } from './config/socket-redis-adapter';
import { TwilioMediaStreamHandler } from './telephony/twilio-media-stream.handler';

async function bootstrap() {
  // ── 1. Validate all required environment variables BEFORE creating the app ──
  // If any required variable is missing or is still a placeholder value,
  // validateEnvironment() calls process.exit(1) with a clear error message.
  // This ensures the server never starts in a misconfigured state.
  validateEnvironment();

  const logger = new Logger('ACE_Platform');

  // ── 2. Create NestJS app with rawBody enabled ──────────────────────────────
  // rawBody: true is REQUIRED for:
  //   - WhatsApp webhook HMAC-SHA256 signature verification (X-Hub-Signature-256)
  //   - Paystack webhook HMAC-SHA256 signature verification (X-Paystack-Signature)
  // Without this, request.rawBody is undefined and signature checks always fail.
  const app = await NestFactory.create(AppModule, {
    rawBody:    true,
    bufferLogs: true,
  });

  // ── 3. CORS configuration ──────────────────────────────────────────────────
  // In production, replace '*' with your actual dashboard origin.
  const allowedOrigin = process.env.CORS_ORIGIN || '*';
  app.enableCors({
    origin:         allowedOrigin,
    credentials:    allowedOrigin !== '*',
    methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Hub-Signature-256', 'X-Paystack-Signature'],
  });

  if (allowedOrigin === '*') {
    logger.warn('CORS is open to all origins (CORS_ORIGIN=*). Set CORS_ORIGIN to your dashboard URL in production.');
  }

  // ── 4. Helmet HTTP security headers ────────────────────────────────────────
  // Sets X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security,
  // X-DNS-Prefetch-Control, Referrer-Policy, and more.
  // CSP is relaxed in development so the NestJS debug UI still works.
  app.use(
    helmet({
      contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
      crossOriginEmbedderPolicy: false, // Required for WhatsApp/Twilio embedded iframes
    })
  );
  logger.log('🛡️  Helmet security headers: ENABLED');

  // ── 5. Global validation pipe ──────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist:             true,
      transform:             true,
      forbidNonWhitelisted:  true,
      transformOptions:      { enableImplicitConversion: true },
    })
  );

  // ── 6. Global request size limits ─────────────────────────────────────────
  app.use(require('express').json({ limit: '1mb' }));
  app.use(require('express').urlencoded({ extended: true, limit: '1mb' }));

  // ── 6. Start listening ────────────────────────────────────────────────────
  const port = parseInt(process.env.PORT ?? '4000', 10);
  await app.listen(port);

  // ── 7. Attach Redis adapter for multi-pod Socket.IO ───────────────────────
  // Must run AFTER app.listen() so the Socket.IO server is fully initialised.
  await attachRedisAdapter(app);

  // ── 8. Mount raw WebSocket server for Twilio Media Streams ────────────────
  //
  // WHY a separate raw `ws` server:
  //   Twilio Media Streams opens a plain WebSocket connection using its own
  //   binary-framed JSON protocol. Socket.IO wraps WebSockets with its own
  //   handshake ("0{...}" handshake frame, namespace negotiation, etc.).
  //   Twilio does NOT speak Socket.IO — it would fail the upgrade and disconnect.
  //
  //   We create a `ws.WebSocketServer` with `noServer: true`, which means it
  //   does NOT bind to a port itself. Instead, we intercept HTTP upgrade requests
  //   on the NestJS HTTP server and selectively hand off only Twilio's media
  //   stream path to this server.
  //
  // Path convention:
  //   /telephony/stream/:callSid?orgId=…&from=…&to=…
  //   The TelephonyService embeds these query params in the TwiML it returns
  //   to Twilio, so we can identify the session without a database round-trip.
  //
  const twilioHandler = app.get(TwilioMediaStreamHandler);
  const twilioWss     = new WebSocketServer({ noServer: true });

  const httpServer = app.getHttpServer();
  httpServer.on('upgrade', (req: any, socket: any, head: any) => {
    // Only handle paths that match our Twilio stream pattern
    const match = req.url?.match(/^\/telephony\/stream\/([^?/]+)/);
    if (!match) {
      // All other upgrade requests (e.g. Socket.IO) are handled by NestJS
      return;
    }

    const callSid = match[1];

    twilioWss.handleUpgrade(req, socket, head, (ws) => {
      // Parse session params from query string (embedded by TelephonyService in TwiML)
      const url            = new URL(req.url, `http://localhost`);
      const organizationId = url.searchParams.get('orgId') ?? '';
      const fromNumber     = url.searchParams.get('from') ?? '';
      const toNumber       = url.searchParams.get('to') ?? '';

      logger.log(`📞 Twilio Media Stream connected: callSid=${callSid} org=${organizationId || 'unset'}`);

      // handleConnection is async (DB lookups for org config + Deepgram WS setup).
      // We MUST .catch() it here — without this any error during startup becomes
      // a silent unhandled promise rejection that leaves the session half-initialised.
      twilioHandler.handleConnection(ws, callSid, organizationId, fromNumber, toNumber)
        .catch((err) => logger.error(`Twilio stream setup failed for ${callSid}: ${err?.message ?? err}`));
    });
  });

  logger.log(`🚀 ACE Platform API running at http://localhost:${port}`);
  logger.log(`📡 Environment: ${process.env.NODE_ENV ?? 'development'}`);
  logger.log(`🔒 CORS Origin: ${allowedOrigin}`);
  logger.log(`📦 Raw body buffering: ENABLED (required for webhook signature verification)`);
  logger.log(`📞 Twilio Media Streams: listening on /telephony/stream/:callSid`);
}

bootstrap().catch((err) => {
  console.error('Fatal: ACE Platform failed to start:', err);
  process.exit(1);
});
