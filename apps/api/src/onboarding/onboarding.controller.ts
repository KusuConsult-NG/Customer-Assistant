import {
  BadRequestException,
  HttpCode,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Redirect,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OnboardingService, SelfieChannel } from './onboarding.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser } from '@ace/shared-types';

const CHANNELS: SelfieChannel[] = ['WHATSAPP', 'VOICE', 'WEB'];

/** Operator-facing endpoints. Authenticated and tenant-scoped. */
@Controller('api/onboarding')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post('selfie-requests')
  async request(
    @Req() req: { user: AuthUser },
    @Body() body: {
      contactId: string;
      channel?: string;
      purpose?: string;
      expiresInHours?: number;
      conversationId?: string;
      callSid?: string;
    }
  ) {
    if (!body?.contactId) throw new BadRequestException('contactId is required');
    if (body.channel && !CHANNELS.includes(body.channel.toUpperCase() as SelfieChannel)) {
      throw new BadRequestException(`channel must be one of ${CHANNELS.join(', ')}`);
    }
    return this.onboarding.requestSelfie(req.user.organizationId, {
      contactId: body.contactId,
      channel: body.channel?.toUpperCase() as SelfieChannel | undefined,
      purpose: body.purpose,
      expiresInHours: body.expiresInHours,
      conversationId: body.conversationId,
      callSid: body.callSid,
      requestedByUserId: req.user.userId,
    });
  }

  @Get('selfie-requests')
  async list(
    @Req() req: { user: AuthUser },
    @Query('contactId') contactId?: string,
    @Query('limit') limit?: string
  ) {
    return this.onboarding.listRequests(req.user.organizationId, contactId, parseInt(limit ?? '50', 10) || 50);
  }

  /** Short-lived signed URL for the stored photo. */
  @Get('selfie-requests/:id/image')
  async image(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.onboarding.getImageUrl(req.user.organizationId, id);
  }

  // Cancelling creates nothing, so it answers 200 rather than Nest's POST default of 201.
  @HttpCode(200)
  @Post('selfie-requests/:id/cancel')
  async cancel(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.onboarding.cancelRequest(req.user.organizationId, id);
  }

  /** Erases the request and the stored image. Restricted: this destroys personal data. */
  @Roles('OWNER', 'ADMIN')
  @Delete('selfie-requests/:id')
  async remove(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.onboarding.deleteRequest(req.user.organizationId, id);
  }
}

/**
 * Customer-facing upload endpoints.
 *
 * Unauthenticated by necessity — the customer has a link, not an account — so the
 * one-time token is the entire credential. Everything that follows from that:
 *
 *  - Tight throttling, because the token is the only thing standing between the
 *    internet and an upload endpoint.
 *  - No tenant or contact identifiers in the response, so a stolen link leaks a first
 *    name and a company name and nothing else.
 *  - Attempts counted server-side against the token, not the IP.
 */
@Controller('api/public/selfie')
export class PublicSelfieController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token')
  async describe(@Param('token') token: string) {
    return this.onboarding.describeUploadLink(token);
  }

  // Enough headroom for a customer retaking a photo several times on a bad
  // connection; still far too tight to be useful as an open upload endpoint.
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post(':token')
  async submit(
    @Param('token') token: string,
    @Body() body: { imageBase64?: string; dependents?: Array<{ fullName: string; relationship: string; dob?: string }> }
  ) {
    if (!body?.imageBase64) throw new BadRequestException('No image was received. Please take the photo again.');
    return this.onboarding.submitViaLink(token, body.imageBase64, body.dependents);
  }
}

/**
 * Reverse-proxy for the citizen-facing selfie PAGE.
 *
 * The tunnel exposes only port 4000 (API); the Next.js web app on 3000 is
 * reachable from localhost alone. So the HTML a citizen opens from a WhatsApp
 * link is fetched through here:
 *
 *   GET /selfie/:token  → HTML page from the web app
 *
 * The page's own assets — `/_next/*` and `/icon.svg` — are NOT routed here.
 * They are served by a middleware in `main.ts` that intercepts those URLs
 * before Nest's router runs, and without them the page renders as a broken
 * white screen: the browser requests every chunk and stylesheet from the
 * tunnel URL, which is this API.
 *
 * This doc used to list those three as routes on this controller, and they
 * did exist here — shadowed by that middleware and therefore never reached,
 * with `_next/static/*path` using Express 5 wildcard syntax that matched
 * nothing on Express 4 regardless. They have been removed; the middleware is
 * the single implementation.
 */
@Controller()
export class SelfieRedirectController {
  private get webBase(): string {
    return (process.env.WEB_INTERNAL_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  }

  // ── Page routes ────────────────────────────────────────────────────────────

  @Get('selfie/:token')
  async proxySelfie(
    @Param('token') token: string,
    @Req() req: any,
    @Query() query: Record<string, string>
  ) {
    return this.proxyToWeb(`/selfie/${token}`, query, req.res);
  }

  // ── Static assets are NOT routed here ──────────────────────────────────────
  //
  // Three routes used to sit at this point — `_next/static/*path`,
  // `_next/image` and `icon.svg` — duplicating a middleware in `main.ts` that
  // intercepts every `/_next/*` and `/icon.svg` request before Nest's router
  // sees it. So they were unreachable in the running app, and one of them had
  // never worked at all: `*path` is Express 5 wildcard syntax and this runs on
  // Express 4, where it matched nothing.
  //
  // Two implementations of one proxy is the drift this codebase keeps warning
  // about, and the dead copy is the one that looked authoritative because it
  // sat beside the HTML route. The middleware stays because it is the one that
  // actually runs; it is covered by the HTTP harness, which exercises the real
  // bootstrapped server rather than a test module without it.

  // ── Shared helpers ─────────────────────────────────────────────────────────

  private async proxyToWeb(path: string, query: Record<string, string>, res: any): Promise<void> {
    const qs = new URLSearchParams(query).toString();
    const target = `${this.webBase}${path}${qs ? '?' + qs : ''}`;
    try {
      const upstream = await fetch(target);
      res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'text/html; charset=utf-8');
      // Cache-Control: same as what Next.js would send for pages
      res.setHeader('Cache-Control', upstream.headers.get('cache-control') ?? 'no-store');
      const html = await upstream.text();
      res.status(upstream.status).send(html);
    } catch {
      res.status(502).send('<h1>Service temporarily unavailable. Please try again.</h1>');
    }
  }

}

