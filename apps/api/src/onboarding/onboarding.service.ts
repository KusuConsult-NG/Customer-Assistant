import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SELFIE_MAX_UPLOAD_ATTEMPTS, createSelfieRequest, hashSelfieToken, prisma, selfieUploadUrl, sealUploadUrl, withWhatsAppCredentials, phoneNumberVariants } from '@ace/database';
import { WhatsAppCloudClient } from '@ace/whatsapp-sdk';
import { MessageSender } from '@ace/shared-types';
import { AceLogger } from '../config/logger';
import { SELFIE_BUCKET, deleteObject, signedUrl, uploadObject } from '../common/object-storage';
import { MAX_IMAGE_BYTES, inspectImage } from '../common/image-validation';

const log = new AceLogger('OnboardingService');

export type SelfieChannel = 'WHATSAPP' | 'VOICE' | 'WEB';

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

  // ── Public Online Payment Processing ─────────────────────────────────────
  async lookupEnrolleeForPayment(query: string) {
    if (!query || query.trim().length < 3) {
      throw new BadRequestException('Please provide a valid phone number or reference ID.');
    }
    const q = query.trim();
    const contact = await prisma.contact.findFirst({
      where: {
        OR: [
          { phoneNumber: { in: phoneNumberVariants(q) } },
          { id: { startsWith: q.toLowerCase() } },
        ],
      },
      include: {
        selfieRequests: { where: { status: 'RECEIVED' }, orderBy: { updatedAt: 'desc' }, take: 1 },
      },
    });

    if (!contact) {
      throw new NotFoundException('No enrollee found with that phone number or reference ID.');
    }

    const meta = (contact.metadata as Record<string, any>) || {};
    const planType = meta.planType || 'Informal Sector Individual Plan';
    const isEquity = Boolean(meta.isEquity || /equity|bhcpf|vulnerable|free/i.test(planType));
    const isFamily = planType.toLowerCase().includes('family');
    const amount = isEquity ? 0 : isFamily ? 50000 : 12000;
    const policyId = meta.policyId || `PLS/${new Date().getFullYear()}/${contact.id.slice(0, 8).toUpperCase()}`;

    return {
      contactId: contact.id,
      fullName: contact.fullName,
      phoneNumber: contact.phoneNumber,
      planType,
      isEquity,
      lga: meta.lga || contact.city || 'Plateau State',
      preferredHospital: meta.preferredHospital || 'General Hospital Jos',
      policyId,
      amount,
      paymentStatus: meta.paymentStatus || (isEquity ? 'WAIVED_SUBSIDIZED' : 'PENDING'),
      enrollmentStatus: meta.enrollmentStatus || (contact.tags.includes('enrolled-active') ? 'ENROLLED_ACTIVE' : isEquity ? 'PENDING_EQUITY_REVIEW' : 'PENDING_REVIEW'),
      hasPhoto: contact.selfieRequests.length > 0,
      dependents: meta.dependents || [],
    };
  }

  async confirmEnrolleePayment(
    contactId: string,
    paymentReference: string,
    amount: number,
    equityCategory?: string
  ) {
    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    if (!contact) throw new NotFoundException('Enrollee not found.');

    const meta = (contact.metadata as Record<string, any>) || {};
    const policyId = meta.policyId || `PLS/${new Date().getFullYear()}/${contact.id.slice(0, 8).toUpperCase()}`;
    const isEquity = amount === 0 || Boolean(meta.isEquity) || Boolean(equityCategory);

    const newTags = Array.from(
      new Set([
        ...(contact.tags || []),
        isEquity ? 'equity-applicant' : 'enrolled-active',
        isEquity ? 'equity-subsidized' : 'paid-enrollee',
      ])
    );

    const enrollmentStatus = isEquity ? 'PENDING_EQUITY_REVIEW' : 'ENROLLED_ACTIVE';
    const paymentStatus = isEquity ? 'WAIVED_SUBSIDIZED' : 'PAID';

    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        tags: newTags,
        metadata: {
          ...meta,
          policyId,
          isEquity,
          equityCategory: equityCategory || meta.equityCategory || null,
          paymentStatus,
          paidAmount: amount,
          paymentReference,
          paidAt: new Date().toISOString(),
          enrollmentStatus,
        },
      },
    });

    const noteContent = isEquity
      ? `PLASCHEMA Equity Free Coverage Application: Qualifying Category "${equityCategory || 'Vulnerable Group'}" (₦0 Subsidized). Awaiting verification at CRM desk.`
      : `Online Premium Payment Confirmed: ₦${amount.toLocaleString()} (Ref: ${paymentReference}). Policy ID issued: ${policyId}`;

    await prisma.note
      .create({
        data: {
          contactId: contact.id,
          content: noteContent,
        },
      })
      .catch(() => {});

    return {
      success: true,
      policyId,
      fullName: contact.fullName,
      status: enrollmentStatus,
      isEquity,
      message: isEquity
        ? `Free Equity Plan registered successfully. Your profile has been sent to the PLASCHEMA verification desk.`
        : `Premium payment of ₦${amount.toLocaleString()} confirmed. Policy ID: ${policyId}`,
    };
  }
}
