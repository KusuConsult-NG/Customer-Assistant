import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { BillingService, SubscriptionPlan } from './billing.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser } from '@ace/shared-types';
import { ActivatePlanDto, CheckoutDto, ServicePaymentGuidanceDto } from './billing.dto';

@Controller('api/billing')
export class BillingController {
  constructor(private billingService: BillingService) {}

  @UseGuards(JwtAuthGuard)
  @Get('subscription')
  async getSubscription(@Req() req: { user: AuthUser }) {
    return this.billingService.getSubscriptionDetails(req.user.organizationId);
  }

  // RolesGuard must come *after* JwtAuthGuard in this list — guards run in order and
  // RolesGuard reads request.user, which JwtAuthGuard populates. (It used to be
  // registered as a global APP_GUARD, which runs before controller guards, so these
  // endpoints rejected every caller with 403.)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  @Post('checkout')
  async checkout(@Req() req: { user: AuthUser }, @Body() body: CheckoutDto) {
    return this.billingService.initializePaystackTransaction(
      req.user.organizationId,
      body.plan,
      req.user.email
    );
  }

  /**
   * Activates a plan from a Paystack payment reference.
   *
   * For the case where a customer paid but the webhook never arrived. The reference is
   * verified against Paystack — that it succeeded, that it belongs to this
   * organization, and that the amount covers the plan.
   *
   * This route previously took only a plan name and activated it outright. @Roles
   * ('OWNER') was doing nothing useful, because the first user of every organization
   * IS its owner: any person who signed up could grant themselves the ENTERPRISE plan
   * (₦1,000,000/month) with one request and no payment.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER')
  @Post('activate')
  async activate(@Req() req: { user: AuthUser }, @Body() body: ActivatePlanDto) {
    return this.billingService.activateFromPaymentReference(
      req.user.organizationId,
      body.plan,
      body.reference,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('service-payment-guidance')
  async getServicePaymentGuidance(
    @Req() req: { user: AuthUser },
    @Body() body: ServicePaymentGuidanceDto
  ) {
    return this.billingService.generateServicePaymentGuidance(
      req.user.organizationId,
      body.serviceName,
      body.amountNgn
    );
  }

  /**
   * Paystack webhook.
   *
   * The signature is an HMAC-SHA256 over the EXACT bytes Paystack sent, so this must
   * read `req.rawBody` (enabled by `rawBody: true` in main.ts). The previous version
   * passed the JSON-parsed `@Body()` object into `createHmac().update()`, which throws
   * a TypeError on a plain object — every webhook 500'd, so Paystack retried and then
   * disabled the endpoint, and no successful payment ever activated a subscription.
   *
   * @SkipThrottle: Paystack bursts retries and treats a 429 as a delivery failure.
   * Authenticity is established by the signature, not by rate limiting.
   */
  @SkipThrottle()
  @Post('paystack-webhook')
  @HttpCode(200)
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature: string
  ) {
    if (!req.rawBody) {
      throw new BadRequestException(
        'Raw request body unavailable — Paystack signature cannot be verified.'
      );
    }

    const result = await this.billingService.handlePaystackWebhook(req.rawBody, signature);

    // A rejected signature is reported as rejected rather than as `{status:'success'}`.
    // Returning 200 keeps Paystack from retrying a request that will never verify.
    return { status: result.processed ? 'success' : 'rejected', event: result.event };
  }
}
