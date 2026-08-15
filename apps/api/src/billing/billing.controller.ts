import { Controller, Get, Post, Body, Req, Headers, UseGuards, BadRequestException } from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { BillingService, SubscriptionPlan } from './billing.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser } from '@ace/shared-types';

@Controller('api/billing')
export class BillingController {
  constructor(private billingService: BillingService) {}

  @UseGuards(JwtAuthGuard)
  @Get('subscription')
  async getSubscription(@Req() req: { user: AuthUser }) {
    return this.billingService.getSubscriptionDetails(req.user.organizationId);
  }

  // Guard order matters: JwtAuthGuard attaches req.user, RolesGuard reads it.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  @Post('checkout')
  async checkout(
    @Req() req: { user: AuthUser },
    @Body() body: { plan: SubscriptionPlan }
  ) {
    return this.billingService.initializePaystackTransaction(
      req.user.organizationId,
      body.plan,
      req.user.email
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  @Post('activate')
  async activate(
    @Req() req: { user: AuthUser },
    @Body() body: { plan: SubscriptionPlan }
  ) {
    return this.billingService.activatePlan(req.user.organizationId, body.plan);
  }

  @UseGuards(JwtAuthGuard)
  @Post('service-payment-guidance')
  async getServicePaymentGuidance(
    @Req() req: { user: AuthUser },
    @Body() body: { serviceName: string; amountNgn: number; contactPhone?: string }
  ) {
    return this.billingService.generateServicePaymentGuidance(
      req.user.organizationId,
      body.serviceName,
      body.amountNgn,
      body.contactPhone
    );
  }

  /**
   * Paystack webhook.
   *
   * MUST receive the raw request Buffer (req.rawBody), never the parsed @Body():
   * HMAC-SHA256 is computed over the exact bytes Paystack sent. The previous
   * version passed the parsed JSON object, which made createHmac().update()
   * throw a TypeError on every single webhook — payments never activated plans.
   *
   * @SkipThrottle — authenticity is enforced by signature verification;
   * rate-limiting a payment webhook can drop charge.success events.
   */
  @SkipThrottle()
  @Post('paystack-webhook')
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature: string
  ) {
    if (!req.rawBody) {
      // rawBody requires NestFactory.create(AppModule, { rawBody: true }) and
      // no competing body parser registered ahead of Nest's (see main.ts).
      throw new BadRequestException('Raw request body unavailable — cannot verify webhook signature');
    }
    await this.billingService.handlePaystackWebhook(req.rawBody, signature);
    return { status: 'success' };
  }
}
