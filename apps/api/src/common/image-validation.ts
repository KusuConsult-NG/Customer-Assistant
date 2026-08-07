/**
 * Image validation for customer-supplied uploads.
 *
 * The type is decided by the bytes, not by the claimed Content-Type or the file
 * extension. Both of those are attacker-controlled on a public upload endpoint, and
 * "the client said it was a JPEG" is how a private storage bucket ends up serving
 * HTML or SVG that executes in a viewer's browser.
 *
 * SVG is deliberately NOT accepted: it is a document format that can carry script,
 * and nobody takes a selfie in SVG.
 */

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/** 8 MB. Comfortably above a phone camera photo, well below a memory problem. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Below this, it is not a photograph — it is a tracking pixel or a truncated upload. */
export const MIN_IMAGE_BYTES = 1024;

export interface ImageInspection {
  ok: boolean;
  mimeType?: AllowedImageType;
  /** Present when ok is false — safe to show the customer. */
  reason?: string;
}

/** Identifies the format from magic bytes, or null if it is not a supported image. */
export function sniffImageType(bytes: Buffer): AllowedImageType | null {
  if (bytes.length < 12) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP: "RIFF" .... "WEBP"
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  return null;
}

/** Full check: size bounds plus a real image format. */
export function inspectImage(bytes: Buffer): ImageInspection {
  if (bytes.length < MIN_IMAGE_BYTES) {
    return { ok: false, reason: 'That file is too small to be a photo. Please take the picture again.' };
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `That image is ${(bytes.length / 1024 / 1024).toFixed(1)}MB. Please send one under ${MAX_IMAGE_BYTES / 1024 / 1024}MB.`,
    };
  }

  const mimeType = sniffImageType(bytes);
  if (!mimeType) {
    return { ok: false, reason: 'That does not look like a photo. Please send a JPEG, PNG or WebP image.' };
  }

  return { ok: true, mimeType };
}
