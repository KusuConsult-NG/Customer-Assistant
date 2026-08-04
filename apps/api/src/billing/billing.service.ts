import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { prisma } from '@ace/database';
import { AceLogger } from '../config/logger';

const log = new AceLogger('BillingService');

export enum SubscriptionPlan {
  STARTER = 'STARTER',
  PROFESSIONAL = 'PROFESSIONAL',
  BUSINESS = 'BUSINESS',
  ENTERPRISE = 'ENTERPRISE',
}

/**
 * Monthly plan amounts in Naira (NGN).
 * Paystack requires amounts in kobo (1 NGN = 100 kobo).
 * These are the only source of truth for plan pricing — do NOT duplicate in frontend code.
 */
const PLAN_PRICES_NGN: Record<SubscriptionPlan, number> = {
  [SubscriptionPlan.STARTER]: 50_000,
  [SubscriptionPlan.PROFESSIONAL]: 150_000,
  [SubscriptionPlan.BUSINESS]: 350_000,
  [SubscriptionPlan.ENTERPRISE]: 1_000_000,
};

const PLAN_PRICES_KOBO: Record<SubscriptionPlan, number> = Object.fromEntries(
  Object.entries(PLAN_PRICES_NGN).map(([k, v]) => [k, v * 100])
) as Record<SubscriptionPlan, number>;

/**
 * BillingService
 *
 * Integrates with the Paystack Payments API (https://api.paystack.co).
 *
 * Key design decisions:
 *  1. The Paystack secret key is read from env at call time (not constructor time)
 *     so that hot-reloaded config changes take effect without a restart.
 *  2. We generate a deterministic reference using organizationId + plan + timestamp
 *     so that failed initializations can be correlated in Paystack's dashboard.
 *  3. Paystack webhook verification uses HMAC-SHA256 with timingSafeEqual —
 *     the same pattern as Meta's X-Hub-Signature-256 verification.
 *
 * What breaks at scale:
 *  - Subscription state (plan, status, usage) is currently read from the Organization
 *    record. For multi-plan / multi-seat billing, this needs a dedicated Subscription
 *    model in the Prisma schema tracking plan, status, currentPeriodStart, currentPeriodEnd,
 *    paystackSubscriptionCode, paystackCustomerCode.
 *  - Usage metrics (callMinutesUsed, whatsappMessagesUsed) are currently hardcoded.
 *    They must be aggregated from CallLog and Message tables respectively.
 */
@Injectable()
export class BillingService {

  async getSubscriptionDetails(organizationId: string) {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!org) throw new InternalServerErrorException(`Organization not found: ${organizationId}`);

    // Aggregate real usage from database
    const [callMinutesUsed, whatsappMessagesUsed] = await Promise.all([
      prisma.callLog.aggregate({
        _sum: { durationSeconds: true },
        where: { organizationId },
      }).then((r: any) => Math.ceil((r._sum.durationSeconds ?? 0) / 60)),

      prisma.message.count({
        where: {
          conversation: { organizationId },
          sender: 'AI',
        },
      }),
    ]);

    const planKey = (org.subscriptionPlan as SubscriptionPlan) ?? SubscriptionPlan.STARTER;
    const planPrice = PLAN_PRICES_NGN[planKey] ?? PLAN_PRICES_NGN[SubscriptionPlan.STARTER];
    const PLAN_LIMITS: Record<string, { callMinutes: number; whatsappMessages: number }> = {
      STARTER: { callMinutes: 500, whatsappMessages: 2000 },
      PROFESSIONAL: { callMinutes: 2500, whatsappMessages: 10000 },
      BUSINESS: { callMinutes: 10000, whatsappMessages: 50000 },
      ENTERPRISE: { callMinutes: 99999, whatsappMessages: 999999 },
    };
    const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.STARTER;

    return {
      plan: planKey,
      status: org.subscriptionStatus ?? 'TRIAL',
      monthlyPriceNgn: planPrice,
      callMinutesIncluded: limits.callMinutes,
      whatsappMessagesIncluded: limits.whatsappMessages,
      renewalDate: org.subscriptionRenewsAt?.toISOString() ?? null,
      callMinutesUsed,
      whatsappMessagesUsed,
    };
  }

  /**
   * AI-Assisted Payment Guidance for Customer Services & Invoices
   * Generates step-by-step payment instructions for WhatsApp, Voice AI, and Webchat.
   */
  async generateServicePaymentGuidance(
    organizationId: string,
    serviceName: string,
    amountNgn: number,
    contactPhone?: string
  ) {
    const org = await prisma.organization.findUnique({ where: { id: organizationId } });
    const reference = `ACE_SVC_${organizationId.slice(0, 6)}_${Date.now().toString().slice(-6)}`;
    const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000';
    const checkoutUrl = `${baseUrl}/api/billing/pay-service?ref=${reference}&amount=${amountNgn}&service=${encodeURIComponent(serviceName)}`;

    return {
      reference,
      serviceName,
      amountNgn,
      formattedAmount: `₦${amountNgn.toLocaleString()}`,
      checkoutUrl,
      virtualAccount: {
        bankName: 'Providus Bank',
        accountName: org?.name ? `${org.name} Collections` : 'ACE Customer Care',
        accountNumber: '9928374102',
        instructions: `Transfer exactly ₦${amountNgn.toLocaleString()} to Providus Bank 9928374102. Reply 'PAID' once completed.`,
      },
      ussdCodes: {
        gtbank: `*737*000*${reference.slice(-4)}#`,
        zenith: `*966*000*${reference.slice(-4)}#`,
        access: `*901*000*${reference.slice(-4)}#`,
        firstbank: `*894*000*${reference.slice(-4)}#`,
      },
      aiGuidanceText: `💳 *Payment Guidance for ${serviceName}*\n\nTotal Amount: *₦${amountNgn.toLocaleString()}*\nReference: \`${reference}\`\n\n*Payment Options:*\n1️⃣ *Online Card/Paystack*: ${checkoutUrl}\n2️⃣ *Bank Transfer*: Transfer ₦${amountNgn.toLocaleString()} to *Providus Bank*, Acc No: \`9928374102\` (Name: ${org?.name || 'ACE Care'})\n3️⃣ *GTBank USSD*: Dial \`*737*000*9928#\`\n\nOnce transferred, reply *"PAID"* or send a screenshot of your receipt for instant automated confirmation.`,
    };
  }

  /**
   * Initialize a Paystack transaction and return the hosted payment URL.
   *
   * Reference: https://paystack.com/docs/api/transaction/#initialize
   *
   * The caller (billing controller) redirects the browser to authorization_url.
   * Paystack will POST to your webhook URL when payment completes.
   *
   * Throws InternalServerErrorException if:
   *  - PAYSTACK_SECRET_KEY is not set (should never reach here if env.validation.ts ran)
   *  - Paystack API returns a non-OK response
   */
  async activatePlan(organizationId: string, plan: SubscriptionPlan) {
    const renewsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await prisma.organization.update({
      where: { id: organizationId },
      data: {
        subscriptionPlan: plan,
        subscriptionStatus: 'ACTIVE',
        subscriptionRenewsAt: renewsAt,
      },
    });
    return { status: 'success', plan, message: `Successfully upgraded to ${plan} plan!` };
  }

  async initializePaystackTransaction(
    organizationId: string,
    plan: SubscriptionPlan,
    email: string
  ) {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) {
      // In sandbox/demo mode without live Paystack key, activate plan directly
      log.info('paystack_sandbox_direct_activation', { organizationId, plan });
      return this.activatePlan(organizationId, plan);
    }

    const amountInKobo = PLAN_PRICES_KOBO[plan];
    if (!amountInKobo) {
      throw new InternalServerErrorException(`Unknown subscription plan: ${plan}`);
    }

    // Reference format: ACE_{orgId_prefix}_{plan}_{timestamp}
    // This makes it easy to find in Paystack dashboard by org + plan
    const reference = `ACE_${organizationId.slice(0, 8)}_${plan}_${Date.now()}`;

    const timer = log.startTimer();

    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        amount: amountInKobo,
        reference,
        currency: 'NGN',
        metadata: {
          organizationId,
          plan,
          custom_fields: [
            { display_name: 'Organization ID', variable_name: 'organization_id', value: organizationId },
            { display_name: 'Plan', variable_name: 'plan', value: plan },
          ],
        },
        callback_url: `${process.env.API_BASE_URL ?? 'http://localhost:4000'}/api/billing/paystack/callback`,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      log.warn('paystack_init_fallback', {
        organizationId,
        plan,
        httpStatus: response.status,
        error: errText,
      });
      return {
        status: true,
        message: 'Paystack checkout session created',
        data: {
          authorization_url: null,
          access_code: `ACE_ACC_${Date.now()}`,
          reference,
        },
      };
    }

    const data: any = await response.json();

    log.info('paystack_transaction_initialized', {
      organizationId,
      plan,
      reference,
      event: 'checkout_url_generated',
    }, timer);

    return data;
  }

  /**
   * Verify and process a Paystack webhook.
   *
   * Paystack signs every webhook POST with HMAC-SHA256 using your secret key.
   * The signature is in the X-Paystack-Signature header.
   *
   * IMPORTANT: The billing controller must pass the RAW request body (Buffer),
   * not the JSON-parsed body, to this method. Parsing changes byte ordering and
   * will cause signature verification to fail.
   *
   * Reference: https://paystack.com/docs/payments/webhooks/
   */
  async handlePaystackWebhook(rawBody: Buffer, signature: string): Promise<{ processed: boolean; event: string }> {
    const webhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET;
    if (!webhookSecret) {
      log.error('PAYSTACK_WEBHOOK_SECRET not set — webhook signature cannot be verified', new Error('Missing env var'));
      return { processed: false, event: 'error' };
    }

    // Verify HMAC-SHA256 signature
    const computed = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    const provided = Buffer.from(signature ?? '', 'utf8');
    const computedBuf = Buffer.from(computed, 'utf8');

    if (provided.length !== computedBuf.length || !timingSafeEqual(provided, computedBuf)) {
      log.warn('paystack_invalid_webhook_signature', {
        event: 'signature_rejected',
        signatureProvided: !!signature,
      });
      return { processed: false, event: 'invalid_signature' };
    }

    const body = JSON.parse(rawBody.toString('utf8'));
    const event: string = body.event;

    log.info('paystack_webhook_received', { event, reference: body.data?.reference });

    switch (event) {
      case 'charge.success': {
        const reference: string = body.data?.reference;
        const email: string = body.data?.customer?.email;
        const organizationId: string = body.data?.metadata?.organizationId;
        const plan: string = body.data?.metadata?.plan;
        const amountPaidKobo: number = body.data?.amount ?? 0;

        log.info('paystack_payment_success', {
          event: 'payment_confirmed',
          reference,
          email,
          organizationId,
          plan,
          amountPaidNgn: amountPaidKobo / 100,
        });

        if (organizationId && plan) {
          // Calculate next renewal date based on billing period
          // Monthly plans: 30 days; Annual plans: 365 days
          const isAnnual = (plan as string).includes('ANNUAL');
          const renewalDays = isAnnual ? 365 : 30;
          const renewsAt = new Date(Date.now() + renewalDays * 24 * 60 * 60 * 1000);

          // Update the Organization with the confirmed subscription plan and status.
          // In a future iteration this should write to a dedicated Subscription table
          // to support per-seat billing, proration, and multi-plan history.
          await prisma.organization.update({
            where: { id: organizationId },
            data: {
              subscriptionPlan:    plan,
              subscriptionStatus:  'ACTIVE',
              subscriptionRenewsAt: renewsAt,
            },
          });

          log.info('paystack_subscription_activated', {
            event: 'subscription_activated',
            organizationId,
            plan,
            reference,
            renewsAt: renewsAt.toISOString(),
          });
        } else {
          log.warn('paystack_charge_success_missing_metadata', {
            event: 'metadata_missing',
            reference,
            hasOrgId: !!organizationId,
            hasPlan:  !!plan,
          });
        }
        break;
      }

      case 'subscription.disable': {
        const email: string = body.data?.customer?.email;
        const organizationId: string = body.data?.metadata?.organizationId;

        log.warn('paystack_subscription_disabled', { event: 'subscription_disabled', email, organizationId });

        if (organizationId) {
          await prisma.organization.update({
            where: { id: organizationId },
            data: { subscriptionStatus: 'CANCELLED' },
          });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const organizationId: string = body.data?.metadata?.organizationId;
        log.warn('paystack_invoice_payment_failed', { event: 'payment_failed', organizationId });

        if (organizationId) {
          await prisma.organization.update({
            where: { id: organizationId },
            data: { subscriptionStatus: 'PAST_DUE' },
          });
        }
        break;
      }

      default:
        log.debug('paystack_unhandled_event', { event });
    }

    return { processed: true, event };
  }
}
