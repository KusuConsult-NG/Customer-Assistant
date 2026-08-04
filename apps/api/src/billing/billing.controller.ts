import { Controller, Get, Post, Body, Req, Headers, UseGuards } from '@nestjs/common';
import { BillingService, SubscriptionPlan } from './billing.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
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

  @UseGuards(JwtAuthGuard)
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

  @UseGuards(JwtAuthGuard)
  @Roles('OWNER', 'ADMIN')
  @Post('activate')
  async activate(
    @Req() req: { user: AuthUser },
    @Body() body: { plan: SubscriptionPlan }
  ) {
    return this.billingService.activatePlan(req.user.organizationId, body.plan);
  }

  @Post('paystack-webhook')
  async handleWebhook(@Body() body: any, @Headers('x-paystack-signature') signature: string) {
    await this.billingService.handlePaystackWebhook(body, signature);
    return { status: 'success' };
  }
}
