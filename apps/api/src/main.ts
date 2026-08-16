// Load .env BEFORE anything reads process.env. Several modules (AuthModule,
// JwtStrategy) capture env values at import time, and validateEnvironment()
// tells the operator to "fix your .env file" — which only works if something
// actually loads it. Real environment variables always win over .env entries.
// This resolves the file from the repo root rather than process.cwd(), which
// is not the root under `turbo run dev`. Must stay the first import.
import './config/load-env';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WebSocketServer } from 'ws';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { validateEnvironment } from './config/env.validation';
import { RedisSocketIoAdapter } from './config/socket-redis-adapter';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
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
  //
  // bodyParser: false + app.useBodyParser() below is REQUIRED — do not "simplify"
  // this back to a bare app.use(express.json()):
  //   Nest's own parser is the ONLY one wired with the `verify` hook that captures
  //   req.rawBody. body-parser marks a request as consumed (req._body), so any
  //   json parser registered before Nest's (e.g. a manual express.json() call in
  //   this file — the previous bug) parses first WITHOUT the hook, Nest's parser
  //   then skips, and req.rawBody is undefined on EVERY request. That silently
  //   drops every WhatsApp webhook. useBodyParser registers exactly one parser,
  //   with the rawBody hook AND our size limit.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody:    true,
    bodyParser: false,
    bufferLogs: true,
  });

  // JSON limit is configurable because the knowledge-base upload sends files as
  // base64 inside a JSON body (~4/3 size overhead). 10mb allows ~7.5MB documents.
  // At larger scale, switch uploads to multipart or direct-to-storage signed URLs.
  const jsonBodyLimit = process.env.JSON_BODY_LIMIT ?? process.env.MAX_JSON_BODY_SIZE ?? '70mb';
  app.useBodyParser('json', { limit: jsonBodyLimit });
  app.useBodyParser('urlencoded', { extended: true, limit: '1mb' });

  // Behind a load balancer / reverse proxy (Render, Nginx, Cloudflare) the
  // client IP arrives in X-Forwarded-For. Without trust proxy, ThrottlerGuard
  // rate-limits ALL users as one shared IP (the balancer's). Opt-in via env so
  // a directly-exposed deployment can't be tricked by forged XFF headers.
  if (process.env.TRUST_PROXY) {
    app.set('trust proxy', parseInt(process.env.TRUST_PROXY, 10) || 1);
  }

  // ── 3. CORS configuration ──────────────────────────────────────────────────
  // Two CORS regimes, selected per request path:
  //
  //   /api/widget/* — open to EVERY origin, always. These are the public embed
  //   endpoints: the widget script runs on customers' own websites (any domain),
  //   and its tenant security is the API key + rate limit, not the Origin header.
  //   Locking these to CORS_ORIGIN silently breaks the widget on every site the
  //   moment CORS_ORIGIN is set for production — the exact configuration where
  //   embeds are demoed. No credentials are ever allowed on this regime.
  //
  //   Everything else — locked to CORS_ORIGIN (the dashboard). Accepts a
  //   comma-separated list so staging + production dashboards can share an API.
  const allowedOrigins = (process.env.CORS_ORIGIN || '*')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const dashboardOrigin: string | string[] =
    allowedOrigins.includes('*') ? '*' : allowedOrigins;

  app.enableCors((req: any, callback: (err: Error | null, options?: any) => void) => {
    if ((req.url ?? '').startsWith('/api/widget')) {
      callback(null, {
        origin:         '*',
        credentials:    false,
        methods:        ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type'],
      });
      return;
    }
    callback(null, {
      origin:         dashboardOrigin,
      credentials:    dashboardOrigin !== '*',
      methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Hub-Signature-256', 'X-Paystack-Signature'],
    });
  });

  if (dashboardOrigin === '*') {
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

  // Map Prisma known errors (P2002 unique violation → 409, P2025 not found → 404,
  // …) to proper HTTP responses instead of opaque 500s. (From PR #1.)
  app.useGlobalFilters(new PrismaExceptionFilter());

  // ── 5. Global validation pipe ──────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist:             true,
      transform:             true,
      forbidNonWhitelisted:  true,
      transformOptions:      { enableImplicitConversion: true },
    })
  );

  // ── 6. Socket.IO Redis adapter — BEFORE listen ─────────────────────────────
  // The adapter must be registered before Nest bootstraps the WebSocket
  // gateways (which happens during listen()). The previous version ran after
  // listen() and searched for the Socket.IO server on the Express instance,
  // where it never exists — so multi-pod fan-out silently never worked.
  // connectToRedis() never throws: no/void Redis → single-node mode.
  const socketIoAdapter = new RedisSocketIoAdapter(app);
  if (process.env.REDIS_URL) {
    await socketIoAdapter.connectToRedis(process.env.REDIS_URL);
  } else {
    logger.warn(
      'REDIS_URL is not set — Socket.IO running in single-node mode. ' +
      'Set REDIS_URL and restart to enable cross-pod events.'
    );
  }
  app.useWebSocketAdapter(socketIoAdapter);

  // ── 7. Start listening ────────────────────────────────────────────────────
  // (Body size limits are configured via useBodyParser above — registering a
  //  second express.json() here would silently disable rawBody capture.)
  const port = parseInt(process.env.PORT ?? '4000', 10);
  await app.listen(port, '0.0.0.0');

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

  logger.log(`🚀 Customer Care Agent API running at http://0.0.0.0:${port}`);
  logger.log(`📡 Environment: ${process.env.NODE_ENV ?? 'development'}`);
  logger.log(`🔒 CORS Origin: ${Array.isArray(dashboardOrigin) ? dashboardOrigin.join(', ') : dashboardOrigin} (dashboard) · * (/api/widget embeds)`);
  logger.log(`📦 Raw body buffering: ENABLED (required for webhook signature verification) | JSON body limit: ${jsonBodyLimit}`);
  logger.log(`📞 Twilio Media Streams: listening on /telephony/stream/:callSid`);
}

bootstrap().catch((err) => {
  console.error('Fatal: Customer Care Agent failed to start:', err);
  process.exit(1);
});
