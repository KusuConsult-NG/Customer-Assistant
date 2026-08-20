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

/** Public payment lookup & confirmation for PLASCHEMA enrollee premiums. */
@Controller('api/public/pay')
export class PublicPaymentController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('lookup')
  async lookup(@Body() body: { query: string }) {
    return this.onboarding.lookupEnrolleeForPayment(body.query);
  }

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('confirm')
  async confirm(
    @Body()
    body: {
      contactId: string;
      paymentReference: string;
      amount: number;
      equityCategory?: string;
    }
  ) {
    if (!body?.contactId || !body?.paymentReference || typeof body?.amount !== 'number') {
      throw new BadRequestException('contactId, paymentReference, and amount (number) are required.');
    }
    return this.onboarding.confirmEnrolleePayment(body.contactId, body.paymentReference, body.amount, body.equityCategory);
  }
}

/**
 * Server-side proxy for patient-facing web pages.
 *
 * The ngrok tunnel only exposes port 4000 (API). Patient-facing pages (selfie
 * camera, payment) live in the Next.js web app on port 3000, which is only
 * reachable from localhost — not from a patient's phone.
 *
 * These routes fetch the HTML from the local Next.js app and stream it back
 * so the patient's browser sees it at the public ngrok URL. No second tunnel
 * is required; a single URL covers everything.
 *
 *   GET /selfie/:token  → proxies http://localhost:3000/selfie/:token
 *   GET /pay            → proxies http://localhost:3000/pay
 */
@Controller()
export class SelfieRedirectController {
  private get webBase(): string {
    return (process.env.WEB_INTERNAL_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  }

  @Get('selfie/:token')
  async proxySelfie(
    @Param('token') token: string,
    @Req() req: any,
    @Query() query: Record<string, string>
  ) {
    return this.proxyToWeb(`/selfie/${token}`, query, req.res);
  }

  @Get('pay')
  async proxyPay(@Req() req: any, @Query() query: Record<string, string>) {
    return this.proxyToWeb('/pay', query, req.res);
  }

  private async proxyToWeb(path: string, query: Record<string, string>, res: any): Promise<void> {
    const qs = new URLSearchParams(query).toString();
    const target = `${this.webBase}${path}${qs ? '?' + qs : ''}`;
    try {
      const upstream = await fetch(target);
      const html = await upstream.text();
      res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'text/html; charset=utf-8');
      res.status(upstream.status).send(html);
    } catch {
      res.status(502).send('<h1>Service temporarily unavailable</h1>');
    }
  }
}
