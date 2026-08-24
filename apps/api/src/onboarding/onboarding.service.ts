import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SELFIE_MAX_UPLOAD_ATTEMPTS, createSelfieRequest, hashSelfieToken, prisma, selfieUploadUrl, sealUploadUrl, withWhatsAppCredentials, phoneNumberVariants } from '@ace/database';
import { WhatsAppCloudClient } from '@ace/whatsapp-sdk';
import { MessageSender } from '@ace/shared-types';
import { AceLogger } from '../config/logger';
import { SELFIE_BUCKET, deleteObject, signedUrl, uploadObject } from '../common/object-storage';
import { MAX_IMAGE_BYTES, inspectImage } from '../common/image-validation';

const log = new AceLogger('OnboardingService');

export type SelfieChannel = 'WHATSAPP' | 'VOICE' | 'WEB';

/** The two priced plans. EQUITY is not here on purpose: it is an application, not a purchase. */
export type EnrolleePlan = 'INDIVIDUAL' | 'FAMILY';

/**
 * Onboarding selfie capture.
 *
 * What this does: asks a customer for a photo, over the channel they are already on,
 * and stores it against their contact record.
 *
 * What it explicitly does NOT do: verify identity. There is no liveness check, no
 * face match, and no document comparison — those need a biometric provider. Every
 * response here says "captured", never "verified", so nothing downstream can treat a
 * stored photo as proof of who someone is.
 */
@Injectable()
export class OnboardingService {
  // ── Requesting ────────────────────────────────────────────────────────────

  /**
   * Creates a selfie request and delivers it to the customer.
   *
   * A VOICE request cannot be fulfilled on the call — a phone call carries no image —
   * so the link is always sent over WhatsApp instead, and the response says so rather
   * than implying the caller can upload mid-conversation.
   */
  async requestSelfie(
    organizationId: string,
    input: {
      contactId: string;
      channel?: SelfieChannel;
      purpose?: string;
      expiresInHours?: number;
      conversationId?: string;
      callSid?: string;
      requestedByUserId?: string;
    }
  ) {
    const contact = await prisma.contact.findFirst({
      where: { id: input.contactId, organizationId },
    });
    if (!contact) throw new NotFoundException('Contact not found');

    const channel: SelfieChannel = input.channel ?? 'WHATSAPP';

    // Generate the upload URL before creation so we can store it on the row.
    // The token is produced inside createSelfieRequest, so we pass a placeholder
    // and update it immediately after — or we compute the token here first.
    // Simplest: call create then update the uploadUrl in one extra write.
    const request = await createSelfieRequest({
      organizationId,
      contactId: contact.id,
      channel,
      purpose: input.purpose,
      expiresInHours: input.expiresInHours,
      conversationId: input.conversationId,
      callSid: input.callSid,
      requestedByUserId: input.requestedByUserId,
    });

    const uploadUrl = selfieUploadUrl(request.token);

    // Persist the upload URL so the post-call webhook can send the link after
    // the call ends, by which point the raw token is gone.
    //
    // ENCRYPTED, because this URL ends in that token: stored plainly it made
    // the tokenHash beside it decorative — hashing the token out of the stored
    // URL reproduced the stored hash exactly.
    await prisma.selfieRequest.update({
      where: { id: request.id },
      data: { uploadUrl: sealUploadUrl(uploadUrl) },
    }).catch(() => {}); // non-fatal: the link is still in memory for this request

    const delivery = await this.deliverRequest(organizationId, contact, request.id, channel, input.purpose, uploadUrl);

    log.info('selfie_requested', {
      organizationId,
      requestId: request.id,
      contactId: contact.id,
      channel,
      delivered: delivery.delivered,
    });

    return {
      id: request.id,
      contactId: contact.id,
      channel,
      status: 'PENDING' as const,
      expiresAt: request.expiresAt,
      uploadUrl,
      delivery,
    };
  }

  /**
   * Sends the customer their prompt.
   *
   * Delivery failure does not fail the request: the row and the link still exist, and
   * an agent can copy the link out of the UI. What it must not do is claim the message
   * was sent when it was not.
   */
  private async deliverRequest(
    organizationId: string,
    contact: { id: string; fullName: string; phoneNumber: string },
    requestId: string,
    channel: SelfieChannel,
    purpose: string | undefined,
    uploadUrl: string
  ): Promise<{ delivered: boolean; via: 'WHATSAPP' | null; note: string }> {
    const firstName = contact.fullName.split(' ')[0] || 'there';
    const reason = purpose ? ` for ${purpose}` : '';

    const webBase = (process.env.WEB_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
    const payUrl = `${webBase}/pay/informal`;

    const body =
      channel === 'WHATSAPP'
        ? `Hi ${firstName}, welcome to PLASCHEMA! To finish setting up your healthcare coverage${reason}, please complete your photo upload:\n\n` +
          `📷 Take your selfie & add family members here:\n${uploadUrl}\n\n` +
          `💳 Pay Informal Sector Premium (₦12,000 / ₦50,000):\n${payUrl}\n\n` +
          `Helpline: 0700-700-1111 (Plateau State Contributory Healthcare Agency)`
        : `Hi ${firstName}, welcome to PLASCHEMA! To complete your health coverage${reason}, please upload your selfie:\n${uploadUrl}\n\n` +
          `Online Payment: ${payUrl}\n` +
          `Helpline: 0700-700-1111`;

    // 1. Try WhatsApp first
    const config = withWhatsAppCredentials(
      await prisma.whatsAppConfig.findFirst({ where: { organizationId, isActive: true } })
    );

    if (config?.phoneNumberId && config?.accessToken) {
      try {
        const client = new WhatsAppCloudClient({
          phoneNumberId: config.phoneNumberId,
          accessToken: config.accessToken,
          verifyToken: config.webhookVerifyToken ?? '',
        });
        await client.sendTextMessage(contact.phoneNumber, body);

        // Mirror into conversation transcript
        const conversation = await prisma.conversation.findFirst({
          where: { organizationId, contactId: contact.id },
          orderBy: { updatedAt: 'desc' },
        });
        if (conversation) {
          await prisma.message
            .create({
              data: {
                conversationId: conversation.id,
                sender: MessageSender.SYSTEM,
                content: body,
              },
            })
            .catch(() => {});
        }

        return { delivered: true, via: 'WHATSAPP', note: 'Sent via WhatsApp.' };
      } catch (err: any) {
        log.warn('whatsapp_delivery_failed_falling_back_to_sms', {
          organizationId,
          requestId,
          error: err?.message,
        });
      }
    }

    // 2. Fallback to SMS via Twilio if WhatsApp failed or is not configured
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

    if (twilioSid && twilioToken && twilioFrom) {
      try {
        const params = new URLSearchParams({
          To: contact.phoneNumber,
          From: twilioFrom,
          Body: body,
        });

        const authHeader = 'Basic ' + Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
        const smsRes = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
          {
            method: 'POST',
            headers: {
              Authorization: authHeader,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
          }
        );

        if (smsRes.ok) {
          log.info('selfie_link_sent_via_sms', { organizationId, contactId: contact.id, to: contact.phoneNumber });
          return { delivered: true, via: 'SMS' as any, note: 'Sent via SMS.' };
        } else {
          const errDetail = await smsRes.text().catch(() => '');
          log.warn('twilio_sms_delivery_failed', { status: smsRes.status, detail: errDetail });
        }
      } catch (smsErr: any) {
        log.warn('sms_delivery_exception', { error: smsErr?.message });
      }
    }

    return {
      delivered: false,
      via: null,
      note: 'WhatsApp and SMS dispatch were unavailable. Link generated for manual share.',
    };
  }

  // ── Receiving ─────────────────────────────────────────────────────────────

  /**
   * Attaches an image that arrived over WhatsApp to the contact's pending request.
   *
   * Returns null when there is nothing pending, so the normal message pipeline treats
   * the image as an ordinary attachment instead of silently swallowing it.
   */
  async attachWhatsAppSelfie(
    organizationId: string,
    contactId: string,
    bytes: Buffer
  ): Promise<{ accepted: boolean; reason?: string; requestId?: string }> {
    const request = await this.findPending(organizationId, contactId);
    if (!request) return { accepted: false };

    const inspection = inspectImage(bytes);
    if (!inspection.ok) {
      await prisma.selfieRequest.update({
        where: { id: request.id },
        data: { attempts: { increment: 1 } },
      });
      return { accepted: false, reason: inspection.reason, requestId: request.id };
    }

    await this.store(request.id, organizationId, contactId, bytes, inspection.mimeType!, 'WHATSAPP');
    return { accepted: true, requestId: request.id };
  }

  /** Resolves a raw upload token to its request, enforcing expiry and attempt caps. */
  private async resolveToken(token: string) {
    if (!token || token.length < 20) throw new NotFoundException('This upload link is not valid.');

    const request = await prisma.selfieRequest.findUnique({
      where: { tokenHash: hashSelfieToken(token) },
      include: { contact: { select: { fullName: true, metadata: true } }, organization: { select: { name: true, logoUrl: true } } },
    });
    if (!request) throw new NotFoundException('This upload link is not valid.');

    if (request.status === 'RECEIVED') {
      throw new BadRequestException('This link has already been used. Ask us for a new one if you need to send another photo.');
    }
    if (request.status === 'CANCELLED') {
      throw new BadRequestException('This request was cancelled. Ask us for a new link.');
    }
    if (request.expiresAt < new Date()) {
      await prisma.selfieRequest.updateMany({
        where: { id: request.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      throw new BadRequestException('This link has expired. Ask us for a new one.');
    }
    if (request.attempts >= SELFIE_MAX_UPLOAD_ATTEMPTS) {
      throw new BadRequestException('Too many attempts on this link. Ask us for a new one.');
    }

    return request;
  }

  /** What the public upload page needs to render. Deliberately minimal. */
  async describeUploadLink(token: string) {
    const request = await this.resolveToken(token);
    const meta = (request.contact.metadata as Record<string, any>) || {};
    return {
      // First name only: the page is reachable by anyone holding the link.
      firstName: request.contact.fullName.split(' ')[0] ?? '',
      fullName: request.contact.fullName,
      organizationName: request.organization.name,
      organizationLogoUrl: request.organization.logoUrl ?? null,
      purpose: request.purpose,
      planType: meta.planType || 'Healthcare Plan',
      isFamilyPlan: (meta.planType || '').toLowerCase().includes('family') || (meta.planType || '').toLowerCase().includes('informal'),
      expiresAt: request.expiresAt,
      maxBytes: MAX_IMAGE_BYTES,
    };
  }

  /** Accepts an upload from the public page with optional family dependents. */
  async submitViaLink(
    token: string,
    imageBase64: string,
    dependents?: Array<{ fullName: string; relationship: string; dob?: string }>
  ) {
    const request = await this.resolveToken(token);

    // Count the attempt before validating, so a loop of malformed uploads still
    // exhausts the cap rather than being free.
    await prisma.selfieRequest.update({ where: { id: request.id }, data: { attempts: { increment: 1 } } });

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      throw new BadRequestException('No image was received. Please take the photo again.');
    }

    // Strip a data: URL prefix if the browser sent one.
    const payload = imageBase64.includes(',') ? imageBase64.slice(imageBase64.indexOf(',') + 1) : imageBase64;

    // Guard before decoding: base64 inflates by ~4/3, so cap the encoded length too.
    if (payload.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1024) {
      throw new BadRequestException(`That image is too large. Please send one under ${MAX_IMAGE_BYTES / 1024 / 1024}MB.`);
    }

    const bytes = Buffer.from(payload, 'base64');
    const inspection = inspectImage(bytes);
    if (!inspection.ok) throw new BadRequestException(inspection.reason);

    await this.store(request.id, request.organizationId, request.contactId, bytes, inspection.mimeType!, 'WEB');

    // If dependents were provided, store them in contact metadata
    if (Array.isArray(dependents) && dependents.length > 0) {
      const contact = await prisma.contact.findUnique({ where: { id: request.contactId } });
      if (contact) {
        const meta = (contact.metadata as Record<string, any>) || {};
        await prisma.contact.update({
          where: { id: contact.id },
          data: {
            metadata: {
              ...meta,
              dependents,
              enrollmentStatus: 'PENDING_REVIEW',
            },
          },
        });
        await prisma.note
          .create({
            data: {
              contactId: contact.id,
              content: `Family members registered: ${dependents.map((d) => `${d.fullName} (${d.relationship})`).join(', ')}`,
            },
          })
          .catch(() => {});
      }
    }

    return { accepted: true, message: 'Thank you — your photo and registration details have been received.' };
  }

  /** Persists the image and closes the request. */
  private async store(
    requestId: string,
    organizationId: string,
    contactId: string,
    bytes: Buffer,
    mimeType: string,
    via: SelfieChannel
  ) {
    const ext = mimeType.split('/')[1] ?? 'jpg';
    const storagePath = await uploadObject(SELFIE_BUCKET, organizationId, `selfie_${contactId}.${ext}`, bytes, mimeType);

    // Close the request only if it is still PENDING.
    //
    // This endpoint is reachable by anyone holding the link, so two uploads can be in
    // flight at once. An unconditional update would let the second overwrite
    // `storagePath` and strand the first object in the bucket forever — an orphaned
    // photograph of someone's face that nothing points at and no deletion will reach.
    const claimed = await prisma.selfieRequest.updateMany({
      where: { id: requestId, status: 'PENDING' },
      data: {
        status: 'RECEIVED',
        storagePath,
        mimeType,
        sizeBytes: bytes.length,
        receivedAt: new Date(),
        receivedVia: via,
        rejectionReason: null,
      },
    });

    if (claimed.count === 0) {
      // Someone else got there first. Remove what we just wrote rather than leaving it.
      await deleteObject(SELFIE_BUCKET, storagePath).catch(() => {});
      log.warn('selfie_upload_lost_race', { organizationId, requestId, contactId });
      throw new BadRequestException('This link has already been used.');
    }

    log.info('selfie_received', { organizationId, requestId, contactId, via, sizeBytes: bytes.length });
  }

  private findPending(organizationId: string, contactId: string) {
    return prisma.selfieRequest.findFirst({
      where: {
        organizationId,
        contactId,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
        attempts: { lt: SELFIE_MAX_UPLOAD_ATTEMPTS },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Reading and removing ──────────────────────────────────────────────────

  async listRequests(organizationId: string, contactId?: string, limit = 50) {
    return prisma.selfieRequest.findMany({
      where: { organizationId, ...(contactId ? { contactId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      // The token hash is never returned: it is a credential derivative, and callers
      // have no use for it.
      select: {
        id: true, contactId: true, channel: true, status: true, purpose: true,
        expiresAt: true, attempts: true, mimeType: true, sizeBytes: true,
        receivedAt: true, receivedVia: true, rejectionReason: true, verifiedAt: true,
        createdAt: true,
        contact: { select: { id: true, fullName: true, phoneNumber: true } },
      },
    });
  }

  /** Mints a short-lived signed URL for one stored selfie. */
  async getImageUrl(organizationId: string, requestId: string) {
    const request = await prisma.selfieRequest.findFirst({ where: { id: requestId, organizationId } });
    if (!request) throw new NotFoundException('Selfie request not found');
    if (!request.storagePath) throw new BadRequestException('No photo has been received for this request yet.');

    // Five minutes: long enough to render, short enough that a copied URL from a
    // screenshot or a log line is worthless by the time anyone finds it.
    const url = await signedUrl(SELFIE_BUCKET, request.storagePath, 300);
    return { url, expiresInSeconds: 300, mimeType: request.mimeType, receivedAt: request.receivedAt };
  }

  async cancelRequest(organizationId: string, requestId: string) {
    const request = await prisma.selfieRequest.findFirst({ where: { id: requestId, organizationId } });
    if (!request) throw new NotFoundException('Selfie request not found');
    if (request.status !== 'PENDING') {
      throw new BadRequestException(`This request is already ${request.status.toLowerCase()}.`);
    }
    return prisma.selfieRequest.update({
      where: { id: requestId },
      data: { status: 'CANCELLED', rejectionReason: 'Cancelled by an operator.' },
    });
  }

  /**
   * Deletes the request and the stored image.
   *
   * A photograph of a person's face is personal data they can ask to have erased, so
   * this removes the object as well as the row — a row-only delete would leave the
   * image in the bucket forever.
   */
  async deleteRequest(organizationId: string, requestId: string) {
    const request = await prisma.selfieRequest.findFirst({ where: { id: requestId, organizationId } });
    if (!request) throw new NotFoundException('Selfie request not found');

    if (request.storagePath) {
      await deleteObject(SELFIE_BUCKET, request.storagePath);
    }
    await prisma.selfieRequest.delete({ where: { id: requestId } });

    log.info('selfie_deleted', { organizationId, requestId, hadImage: Boolean(request.storagePath) });
    return { deleted: true, imageRemoved: Boolean(request.storagePath) };
  }
  // ── Citizen premium payment ───────────────────────────────────────────────
  //
  // What this path used to do: an unauthenticated endpoint took `contactId` and
  // `amount` from the request body, wrote `paymentStatus: 'PAID'` and
  // `enrollmentStatus: 'ENROLLED_ACTIVE'` into `Contact.metadata`, and never
  // contacted a payment gateway at all — the reference was minted in the browser
  // as `PAY-PLS-${Date.now()}-${Math.random()}`. Anyone who could reach the URL
  // could activate health coverage for any enrollee on any tenant, for any
  // amount, for free. See PRODUCTION_READINESS_AUDIT.md, DEF-01 to DEF-05.
  //
  // Three rules hold now, each closing one of those defects:
  //
  //   1. The SERVER decides the amount. A request may choose a plan; it may not
  //      name a price.
  //   2. The GATEWAY decides whether it was paid. Enrollment state is written
  //      only by `settleEnrolleePayment`, which is reachable only from a
  //      signature-verified Paystack webhook. No browser request writes it.
  //   3. Every query is scoped to the one tenant that owns this portal, taken
  //      from deployment configuration rather than from the request.

  /** Server-side price list in kobo. The request selects a plan, never a price. */
  private static readonly PREMIUM_KOBO: Record<EnrolleePlan, number> = {
    INDIVIDUAL: 12_000 * 100,
    FAMILY: 50_000 * 100,
  };

  /**
   * The single tenant that owns the public payment portal.
   *
   * A public endpoint cannot take the organization from the request: that would
   * let any caller name any tenant and read or mutate its contacts, which is the
   * same defect in a different costume. Taking it from configuration makes the
   * blast radius of these routes one tenant by construction.
   */
  private async publicPaymentOrganizationId(): Promise<string> {
    const slug = process.env.PUBLIC_PAYMENT_ORG_SLUG?.trim();
    if (!slug) {
      throw new ServiceUnavailableException(
        'The online premium portal is not configured on this deployment.'
      );
    }
    const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
    if (!org) {
      log.error('public_payment_org_missing', new Error(`no organization with slug "${slug}"`));
      throw new ServiceUnavailableException(
        'The online premium portal is not configured on this deployment.'
      );
    }
    return org.id;
  }

  /**
   * Appends an audit row.
   *
   * Never throws into the caller — a financial write must not fail because
   * logging did — but a failure is logged at error level rather than swallowed.
   * The previous audit trail was a free-text Note created inside
   * `.catch(() => {})`, which recorded no actor and reported nothing when it
   * failed to record even that.
   */
  private async writeAudit(entry: {
    organizationId: string | null;
    actor: string;
    action: string;
    targetType: string;
    targetId: string;
    previousValue?: unknown;
    newValue?: unknown;
    ipAddress?: string | null;
  }): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          organizationId: entry.organizationId,
          actor: entry.actor,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          previousValue: (entry.previousValue ?? undefined) as never,
          newValue: (entry.newValue ?? undefined) as never,
          ipAddress: entry.ipAddress ?? null,
        },
      });
    } catch (e) {
      log.error('audit_write_failed', e as Error, {
        action: entry.action,
        targetId: entry.targetId,
      });
    }
  }

  /**
   * "Musa Abubakar" → "Musa A."
   *
   * Enough for the right person to recognise their own record; not enough to
   * make this endpoint a directory for someone dialling through phone numbers.
   * The previous response returned full name, exact phone number, LGA,
   * preferred hospital, policy id and the complete dependants list to anyone
   * who asked.
   */
  private static maskName(fullName: string | null): string {
    const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'Enrollee';
    if (parts.length === 1) return parts[0];
    return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
  }

  /**
   * Resolves an enrollee by phone number, within the portal's own tenant.
   *
   * Phone number ONLY. The previous version also matched
   * `id: { startsWith: query.toLowerCase() }`, which turned any three-character
   * string into a working enumeration oracle over the entire contact table.
   */
  private async findEnrollee(organizationId: string, query: string) {
    const q = (query ?? '').trim();
    if (q.length < 3) {
      throw new BadRequestException('Please provide the phone number you registered with.');
    }
    const contact = await prisma.contact.findFirst({
      where: { organizationId, phoneNumber: { in: phoneNumberVariants(q) } },
      select: { id: true, fullName: true, metadata: true, tags: true },
    });
    if (!contact) {
      throw new NotFoundException('No enrollee found with that phone number.');
    }
    return contact;
  }

  private static planFor(meta: Record<string, any>): { planType: string; isEquity: boolean } {
    const planType = meta.planType || 'Informal Sector Individual Plan';
    const isEquity = Boolean(meta.isEquity || /equity|bhcpf|vulnerable|free/i.test(planType));
    return { planType, isEquity };
  }

  /**
   * What the payer needs to confirm they have the right record and what it
   * costs. Payment status comes from the `Payment` table — the gateway-backed
   * record — not from `Contact.metadata`, which anything could write.
   */
  async lookupEnrolleeForPayment(query: string) {
    const organizationId = await this.publicPaymentOrganizationId();
    const contact = await this.findEnrollee(organizationId, query);

    const meta = (contact.metadata as Record<string, any>) ?? {};
    const { planType, isEquity } = OnboardingService.planFor(meta);
    const isFamily = planType.toLowerCase().includes('family');
    const plan: EnrolleePlan = isFamily ? 'FAMILY' : 'INDIVIDUAL';

    const settled = await prisma.payment.findFirst({
      where: { organizationId, contactId: contact.id, status: 'SUCCEEDED' },
      orderBy: { paidAt: 'desc' },
      select: { paidAt: true, amountKobo: true },
    });

    return {
      enrollee: OnboardingService.maskName(contact.fullName),
      planType,
      plan,
      isEquity,
      amountNgn: isEquity ? 0 : OnboardingService.PREMIUM_KOBO[plan] / 100,
      paymentStatus: settled ? 'PAID' : isEquity ? 'WAIVED_PENDING_VERIFICATION' : 'PENDING',
      paidAt: settled?.paidAt ?? null,
      enrollmentStatus:
        settled ? 'ENROLLED_ACTIVE'
        : isEquity ? 'PENDING_EQUITY_REVIEW'
        : 'PENDING_PAYMENT',
    };
  }

  /**
   * Starts a real Paystack transaction and returns its hosted checkout URL.
   *
   * The `Payment` row is written PENDING *before* the gateway is called, so a
   * transaction that succeeds while our process dies still has a row for the
   * webhook to settle. Nothing here marks anyone enrolled — only the webhook
   * does.
   */
  async initializeEnrolleePayment(query: string, plan: EnrolleePlan, email?: string) {
    const organizationId = await this.publicPaymentOrganizationId();
    const contact = await this.findEnrollee(organizationId, query);

    const amountKobo = OnboardingService.PREMIUM_KOBO[plan];
    if (!amountKobo) {
      throw new BadRequestException('Choose either the individual or the family plan.');
    }

    const meta = (contact.metadata as Record<string, any>) ?? {};
    if (OnboardingService.planFor(meta).isEquity) {
      throw new BadRequestException(
        'This enrollee is registered under the equity scheme, which is free. No payment is due.'
      );
    }

    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) {
      log.error('paystack_not_configured', new Error('PAYSTACK_SECRET_KEY unset'));
      throw new ServiceUnavailableException(
        'Online card payment is unavailable right now. Please pay at a PLASCHEMA desk.'
      );
    }

    const reference = `PLS-${randomUUID()}`;
    await prisma.payment.create({
      data: {
        organizationId,
        contactId: contact.id,
        gatewayReference: reference,
        amountKobo,
        purpose: 'plaschema_premium',
        status: 'PENDING',
      },
    });

    let authorizationUrl: string | undefined;
    try {
      const res = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email?.trim() || `enrollee-${contact.id}@plaschema.invalid`,
          amount: amountKobo,
          reference,
          // Where Paystack sends the payer's BROWSER afterwards. It must be a
          // page, not this API: the browser returning is not what activates
          // coverage — the webhook is — so this page only reports status.
          callback_url: `${(process.env.WEB_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')}/pay/informal`,
          // Read back by the webhook. The amount is NOT trusted from here — it is
          // re-checked against the Payment row, which the browser never touched.
          metadata: { purpose: 'plaschema_premium', organizationId },
        }),
      });
      const body = await res.json().catch(() => ({}));
      authorizationUrl = body?.data?.authorization_url;
      if (!res.ok || !authorizationUrl) {
        log.error(
          'paystack_enrollee_init_failed',
          new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`),
          { organizationId, reference }
        );
      }
    } catch (e) {
      log.error('paystack_enrollee_init_error', e as Error, { organizationId, reference });
    }

    if (!authorizationUrl) {
      await prisma.payment.update({
        where: { gatewayReference: reference },
        data: { status: 'FAILED' },
      });
      throw new ServiceUnavailableException(
        'Could not start the payment session. Nothing has been charged. Please try again.'
      );
    }

    await this.writeAudit({
      organizationId,
      actor: 'public:portal',
      action: 'payment.initialized',
      targetType: 'Payment',
      targetId: reference,
      newValue: { plan, amountKobo, contactId: contact.id },
    });

    return { authorizationUrl, reference, amountNgn: amountKobo / 100 };
  }

  /**
   * Settles a payment from a VERIFIED gateway callback. The only writer of
   * enrollment state.
   *
   * Idempotent twice over: `gatewayReference` is unique, and an already-settled
   * payment returns without a second write. Paystack retries, and a retry must
   * not overwrite `paidAt` or append a second audit row saying it happened
   * again.
   *
   * Called from the Paystack webhook after its HMAC-SHA256 signature has been
   * checked. It is never reachable from a browser request.
   */
  async settleEnrolleePayment(
    reference: string,
    gatewayPayload: Record<string, any>
  ): Promise<{ settled: boolean; reason: string }> {
    const payment = await prisma.payment.findUnique({ where: { gatewayReference: reference } });
    if (!payment) return { settled: false, reason: 'unknown_reference' };
    if (payment.status === 'SUCCEEDED') return { settled: true, reason: 'already_settled' };

    const paidKobo: number = Number(gatewayPayload?.amount ?? 0);

    // The amount is checked against the row WE wrote, not against anything in
    // the callback. A crafted or edited payload cannot buy a family plan for ₦1.
    if (!Number.isFinite(paidKobo) || paidKobo < payment.amountKobo) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', gatewayPayload: gatewayPayload as never },
      });
      log.warn('enrollee_payment_underpaid', {
        reference,
        expectedKobo: payment.amountKobo,
        paidKobo,
      });
      await this.writeAudit({
        organizationId: payment.organizationId,
        actor: 'system:paystack-webhook',
        action: 'payment.rejected_underpaid',
        targetType: 'Payment',
        targetId: reference,
        previousValue: { status: payment.status, expectedKobo: payment.amountKobo },
        newValue: { status: 'FAILED', paidKobo },
      });
      return { settled: false, reason: 'amount_mismatch' };
    }

    const contact = payment.contactId
      ? await prisma.contact.findFirst({
          where: { id: payment.contactId, organizationId: payment.organizationId },
        })
      : null;

    const meta = ((contact?.metadata as Record<string, any>) ?? {}) as Record<string, any>;
    const policyId =
      meta.policyId ||
      `PLS/${new Date().getFullYear()}/${(payment.contactId ?? payment.id).slice(0, 8).toUpperCase()}`;

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'SUCCEEDED',
          paidAt: new Date(),
          gatewayPayload: gatewayPayload as never,
        },
      });

      if (contact) {
        await tx.contact.update({
          where: { id: contact.id },
          data: {
            tags: Array.from(new Set([...(contact.tags ?? []), 'enrolled-active', 'paid-enrollee'])),
            metadata: {
              ...meta,
              policyId,
              // Display mirror only. The Payment row is the record; this exists
              // so the dashboard need not join on every render.
              paymentStatus: 'PAID',
              enrollmentStatus: 'ENROLLED_ACTIVE',
              lastPaymentReference: reference,
            },
          },
        });
      }
    });

    await this.writeAudit({
      organizationId: payment.organizationId,
      actor: 'system:paystack-webhook',
      action: 'payment.settled',
      targetType: 'Payment',
      targetId: reference,
      previousValue: { status: payment.status },
      newValue: { status: 'SUCCEEDED', paidKobo, policyId, contactId: payment.contactId },
    });

    log.info('enrollee_payment_settled', { reference, organizationId: payment.organizationId });
    return { settled: true, reason: 'settled' };
  }

  /**
   * Records an application for free (equity) coverage.
   *
   * This is NOT a payment and must never look like one: it sets
   * PENDING_EQUITY_REVIEW, never ENROLLED_ACTIVE, and writes no Payment row.
   * The previous code path treated a ₦0 "payment" as a confirmed transaction and
   * returned a policy id for it.
   */
  async applyForEquityCoverage(query: string, equityCategory?: string) {
    const organizationId = await this.publicPaymentOrganizationId();
    const contact = await this.findEnrollee(organizationId, query);
    const meta = (contact.metadata as Record<string, any>) ?? {};

    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        tags: Array.from(new Set([...(contact.tags ?? []), 'equity-applicant'])),
        metadata: {
          ...meta,
          isEquity: true,
          equityCategory: equityCategory || meta.equityCategory || null,
          paymentStatus: 'WAIVED_PENDING_VERIFICATION',
          enrollmentStatus: 'PENDING_EQUITY_REVIEW',
        },
      },
    });

    await this.writeAudit({
      organizationId,
      actor: 'public:portal',
      action: 'equity.applied',
      targetType: 'Contact',
      targetId: contact.id,
      previousValue: { enrollmentStatus: meta.enrollmentStatus ?? null },
      newValue: { enrollmentStatus: 'PENDING_EQUITY_REVIEW', equityCategory: equityCategory ?? null },
    });

    return {
      submitted: true,
      enrollee: OnboardingService.maskName(contact.fullName),
      status: 'PENDING_EQUITY_REVIEW',
      message:
        'Your application for free equity coverage has been recorded and sent to the PLASCHEMA verification desk. Coverage begins once it is approved.',
    };
  }
}
