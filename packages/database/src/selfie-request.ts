import { createHash, randomBytes } from 'crypto';
import { decryptSecret, encryptSecret } from './secret-box';
import { prisma } from './index';

/**
 * Selfie-request creation, shared by the API's OnboardingService and the conversation
 * orchestrator.
 *
 * It lives here, next to Prisma, because both callers need identical token semantics
 * and there is exactly one safe way to get them:
 *
 *   The raw token is returned once and never stored. The row holds only its SHA-256.
 *   That means a link genuinely cannot be recovered — not by an operator, not by the
 *   AI, not by anyone with database access. The cost is that "resend my link" has to
 *   mint a new request; the benefit is that a database leak does not hand an attacker
 *   the ability to upload a photo as any customer being onboarded.
 */

export const SELFIE_DEFAULT_EXPIRY_HOURS = 24;
export const SELFIE_MAX_EXPIRY_HOURS = 72;
export const SELFIE_MAX_UPLOAD_ATTEMPTS = 5;

export function hashSelfieToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateSelfieRequestInput {
  organizationId: string;
  contactId: string;
  channel: 'WHATSAPP' | 'VOICE' | 'WEB';
  purpose?: string;
  expiresInHours?: number;
  conversationId?: string;
  callSid?: string;
  requestedByUserId?: string;
  /**
   * Pre-computed public URL, stored so post-call delivery can send the link
   * after the call ends — by which point the raw token is long gone.
   *
   * ENCRYPTED at rest, because the URL ENDS IN THE RAW TOKEN. Stored plainly it
   * made the hashing beside it pointless: `sha256(token from uploadUrl)` equals
   * the stored `tokenHash` exactly, so anyone who could read this table held a
   * working one-time upload link for every pending request — and the people
   * those links belong to are enrollees about to upload a photograph of
   * themselves.
   */
  uploadUrl?: string;
}

export interface CreatedSelfieRequest {
  id: string;
  expiresAt: Date;
  /** Returned exactly once. Put it in the link; do not persist or log it. */
  token: string;
}

/**
 * Creates a request and supersedes any other pending one for the same contact.
 *
 * The supersede is not tidiness: with two pending requests, an inbound photo matches
 * both and which one it closes is arbitrary.
 */
export async function createSelfieRequest(input: CreateSelfieRequestInput): Promise<CreatedSelfieRequest> {
  const hours = Math.min(Math.max(input.expiresInHours ?? SELFIE_DEFAULT_EXPIRY_HOURS, 1), SELFIE_MAX_EXPIRY_HOURS);
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000);

  await prisma.selfieRequest.updateMany({
    where: { contactId: input.contactId, organizationId: input.organizationId, status: 'PENDING' },
    data: { status: 'CANCELLED', rejectionReason: 'Superseded by a newer request.' },
  });

  const token = randomBytes(32).toString('base64url');

  const request = await prisma.selfieRequest.create({
    data: {
      organizationId: input.organizationId,
      contactId: input.contactId,
      channel: input.channel,
      purpose: input.purpose?.slice(0, 200) ?? null,
      conversationId: input.conversationId ?? null,
      callSid: input.callSid ?? null,
      tokenHash: hashSelfieToken(token),
      uploadUrl: sealUploadUrl(input.uploadUrl),
      expiresAt,
      requestedByUserId: input.requestedByUserId ?? null,
    },
  });

  return { id: request.id, expiresAt: request.expiresAt, token };
}

/**
 * Encrypt an upload URL for storage, and read one back.
 *
 * Separate helpers rather than inline calls for the same reason the credential
 * resolvers exist: a missed read does not fail loudly, it hands a `v1.…`
 * ciphertext to Twilio as the link text and the enrollee receives an SMS
 * containing gibberish instead of a way to finish enrolling.
 *
 * Legacy plaintext still reads, so rows written before this keep working — and
 * they are exactly the rows whose links are already exposed, so they should be
 * re-issued rather than trusted.
 */
export function sealUploadUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === '') return null;
  return encryptSecret(url);
}

export function openUploadUrl(stored: string | null | undefined, label = 'SelfieRequest.uploadUrl'): string | null {
  if (stored === null || stored === undefined || stored === '') return null;
  return decryptSecret(stored, label);
}

/** Public base URL for the selfie upload link sent to patients. */
export function selfieUploadUrl(token: string): string {
  // The API's /selfie/:token redirects (302) to the web app's camera page.
  // Using API_BASE_URL (ngrok) means a single public tunnel covers both the API
  // and the patient-facing selfie UI — no second tunnel needed.
  const base = (
    process.env.API_BASE_URL ||
    process.env.WEB_BASE_URL ||
    'http://localhost:4000'
  ).replace(/\/+$/, '');
  return `${base}/selfie/${token}`;
}
