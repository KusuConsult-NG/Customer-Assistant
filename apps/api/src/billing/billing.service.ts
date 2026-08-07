import { Injectable, InternalServerErrorException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
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
   * AI-Assisted Payment Guidance for Customer Services & Invoices.
   *
   * Produces the payment instructions the AI assistant reads out to a customer over
   * WhatsApp / voice / webchat.
   *
   * SAFETY: every detail here comes from the organization's own configuration.
   * The previous implementation returned a hardcoded "Providus Bank / 9928374102"
   * account with the tenant's name appended, plus USSD strings assembled from a
   * random reference (`*737*000*<4 digits>#`). Those are not real payment channels:
   * following them would have sent a customer's money to an account the tenant does
   * not own, or to nobody at all. When an organization has not configured payment
   * details we say so instead of inventing them.
   */
  async generateServicePaymentGuidance(
    organizationId: string,
    serviceName: string,
    amountNgn: number
  ) {
    const org = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org) throw new NotFoundException(`Organization not found: ${organizationId}`);

    const reference = `ACE_SVC_${organizationId.slice(0, 6)}_${randomBytes(4).toString('hex').toUpperCase()}`;
    const formattedAmount = `₦${amountNgn.toLocaleString('en-NG')}`;

    // Card payment is only offered when Paystack is actually wired up.
    const checkoutUrl = process.env.PAYSTACK_SECRET_KEY
      ? (await this.createServiceCheckoutLink(org.id, serviceName, amountNgn, reference))
      : null;

    const bankTransfer =
      org.payoutBankName && org.payoutAccountNumber
        ? {
            bankName: org.payoutBankName,
            accountName: org.payoutAccountName ?? org.name,
            accountNumber: org.payoutAccountNumber,
            instructions:
              `Transfer exactly ${formattedAmount} to ${org.payoutBankName}, account ` +
              `${org.payoutAccountNumber} (${org.payoutAccountName ?? org.name}), ` +
              `using reference ${reference}.`,
          }
        : null;

    const options: string[] = [];
    if (checkoutUrl) options.push(`1️⃣ *Pay by card (Paystack)*: ${checkoutUrl}`);
    if (bankTransfer) {
      options.push(
        `${options.length + 1}️⃣ *Bank transfer*\n` +
        `• Bank: *${bankTransfer.bankName}*\n` +
        `• Account Name: *${bankTransfer.accountName}*\n` +
        `• Account Number: \`${bankTransfer.accountNumber}\`\n` +
        `• Reference: \`${reference}\``
      );
    }
    if (org.payoutUssdCode) {
      options.push(`${options.length + 1}️⃣ *USSD*: dial \`${org.payoutUssdCode}\``);
    }

    const configured = options.length > 0;

    const aiGuidanceText = configured
      ? `💳 *Payment for ${serviceName}*\n\n` +
        `Amount: *${formattedAmount}*\nReference: \`${reference}\`\n\n` +
        `${options.join('\n\n')}\n\n` +
        `📌 After paying, reply *"PAID"* with your receipt and our team will confirm it.`
      : `Thanks — the total for *${serviceName}* is *${formattedAmount}*.\n\n` +
        `I don't have our payment details on file to share right now, so I'm passing you ` +
        `to a colleague who can send them to you directly.`;

    return {
      reference,
      serviceName,
      amountNgn,
      formattedAmount,
      /** False when the organization has configured no payment channel at all. */
      configured,
      checkoutUrl,
      bankTransfer,
      ussdCode: org.payoutUssdCode ?? null,
      aiGuidanceText,
      /** Signals to the orchestrator that a human should take over. */
      shouldHandoff: !configured,
    };
  }

  /**
   * Creates a real Paystack checkout link for a one-off service charge.
   * Returns null (rather than a link to a route that does not exist) on failure.
   */
  private async createServiceCheckoutLink(
    organizationId: string,
    serviceName: string,
    amountNgn: number,
    reference: string
  ): Promise<string | null> {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) return null;

    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { users: { where: { role: 'OWNER' }, select: { email: true }, take: 1 } },
    });
    const email = org?.users[0]?.email;
    if (!email) return null;

    try {
      const response = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          amount: Math.round(amountNgn * 100),
          reference,
          currency: 'NGN',
          metadata: { organizationId, serviceName, kind: 'SERVICE_CHARGE' },
        }),
      });
      if (!response.ok) {
        log.warn('paystack_service_link_failed', { organizationId, httpStatus: response.status });
        return null;
      }
      const data: any = await response.json();
      return data?.data?.authorization_url ?? null;
    } catch (err: any) {
      log.error('paystack_service_link_error', err, { organizationId });
      return null;
    }
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
      // Do NOT silently activate the plan. This branch used to call activatePlan(),
      // which meant that on any deployment without PAYSTACK_SECRET_KEY the "Upgrade"
      // button granted the ENTERPRISE plan to anyone who clicked it, for free.
      log.error(
        'paystack_not_configured',
        new Error('PAYSTACK_SECRET_KEY missing'),
        { organizationId, plan }
      );
      throw new ServiceUnavailableException(
        'Online payments are not configured on this deployment. ' +
        'Set PAYSTACK_SECRET_KEY, or ask an owner to activate the plan manually.'
      );
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
        // Paystack redirects the customer's BROWSER here after payment, so it must be
        // a page in the dashboard. It pointed at `${API_BASE_URL}/api/billing/paystack/callback`
        // — an API route that has never existed — so every paying customer landed on
        // a 404 immediately after being charged.
        callback_url: `${(process.env.WEB_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')}/billing/success`,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      log.error('paystack_init_failed', new Error(errText), {
        organizationId,
        plan,
        httpStatus: response.status,
      });
      // Previously this returned `{ status: true, message: 'Paystack checkout session
      // created', data: { authorization_url: null } }` — the dashboard read `status`
      // as success and showed a confirmation for a checkout that does not exist.
      throw new ServiceUnavailableException(
        `Could not start the payment session with Paystack (HTTP ${response.status}). Please try again.`
      );
    }

    const data: any = await response.json();

    if (!data?.data?.authorization_url) {
      log.error('paystack_init_no_url', new Error(JSON.stringify(data).slice(0, 300)), { organizationId, plan });
      throw new ServiceUnavailableException('Paystack did not return a checkout URL. Please try again.');
    }

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

        if (!organizationId || !plan) {
          // A one-off service charge (see generateServicePaymentGuidance) carries no
          // plan, so this is expected traffic, not necessarily an error.
          log.info('paystack_charge_success_not_a_subscription', {
            event: 'non_subscription_charge',
            reference,
            hasOrgId: !!organizationId,
            hasPlan:  !!plan,
          });
          break;
        }

        // Validate the plan against our own price list rather than trusting the
        // metadata round-trip, and confirm the customer actually paid that plan's
        // price. Without this a crafted (or replayed-with-edits) payload could
        // activate ENTERPRISE off a ₦1 charge.
        const expectedKobo = PLAN_PRICES_KOBO[plan as SubscriptionPlan];
        if (!expectedKobo) {
          log.warn('paystack_unknown_plan_in_metadata', { event: 'unknown_plan', reference, plan });
          break;
        }
        if (amountPaidKobo < expectedKobo) {
          log.warn('paystack_underpayment_ignored', {
            event: 'underpayment',
            reference,
            organizationId,
            plan,
            expectedNgn: expectedKobo / 100,
            paidNgn: amountPaidKobo / 100,
          });
          break;
        }

        const renewsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        // Update the Organization with the confirmed subscription plan and status.
        // In a future iteration this should write to a dedicated Subscription table
        // to support per-seat billing, proration, and multi-plan history.
        await prisma.organization.update({
          where: { id: organizationId },
          data: {
            subscriptionPlan:     plan,
            subscriptionStatus:   'ACTIVE',
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
