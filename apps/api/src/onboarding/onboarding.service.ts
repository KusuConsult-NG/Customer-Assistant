import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SELFIE_MAX_UPLOAD_ATTEMPTS, createSelfieRequest, hashSelfieToken, prisma, selfieUploadUrl, withWhatsAppCredentials } from '@ace/database';
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

    const body =
      channel === 'WHATSAPP'
        ? `Hi ${firstName}, to finish setting up your account${reason} we need a quick selfie.\n\n` +
          `You can reply to this chat with a photo of yourself, or use this secure link:\n${uploadUrl}\n\n` +
          `The link works once and expires soon. We will never ask you for your PIN or password.`
        : `Hi ${firstName}, thanks for your call. To finish setting up your account${reason} we need a quick selfie.\n\n` +
          `Please use this secure link:\n${uploadUrl}\n\n` +
          `The link works once and expires soon. We will never ask you for your PIN or password.`;

    const config = withWhatsAppCredentials(
      await prisma.whatsAppConfig.findFirst({ where: { organizationId, isActive: true } })
    );
    if (!config?.phoneNumberId || !config?.accessToken) {
      return {
        delivered: false,
        via: null,
        note:
          'WhatsApp is not configured for this organization, so the customer was not messaged. ' +
          'Send them the upload link yourself, or configure WhatsApp under Settings → Integrations.',
      };
    }

    try {
      const client = new WhatsAppCloudClient({
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
        verifyToken: config.webhookVerifyToken ?? '',
      });
      await client.sendTextMessage(contact.phoneNumber, body);

      // Mirror it into the transcript so the agent sees what the customer was asked.
      const conversation = await prisma.conversation.findFirst({
        where: { organizationId, contactId: contact.id },
        orderBy: { updatedAt: 'desc' },
      });
      if (conversation) {
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: MessageSender.SYSTEM,
            content: body,
          },
        }).catch(() => {});
      }

      return { delivered: true, via: 'WHATSAPP', note: 'Sent on WhatsApp.' };
    } catch (err: any) {
      log.warn('selfie_request_delivery_failed', { organizationId, requestId, error: err?.message });
      return {
        delivered: false,
        via: null,
        note: `WhatsApp delivery failed: ${err?.message ?? 'unknown error'}. Share the upload link manually.`,
      };
    }
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
      include: { contact: { select: { fullName: true } }, organization: { select: { name: true, logoUrl: true } } },
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
    return {
      // First name only: the page is reachable by anyone holding the link.
      firstName: request.contact.fullName.split(' ')[0] ?? '',
      organizationName: request.organization.name,
      organizationLogoUrl: request.organization.logoUrl ?? null,
      purpose: request.purpose,
      expiresAt: request.expiresAt,
      maxBytes: MAX_IMAGE_BYTES,
    };
  }

  /** Accepts an upload from the public page. */
  async submitViaLink(token: string, imageBase64: string) {
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

    return { accepted: true, message: 'Thank you — we have received your photo.' };
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
}
