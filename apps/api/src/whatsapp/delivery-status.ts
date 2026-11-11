/**
 * Whether a WhatsApp reply actually reached the citizen (PRD §06 "Delivery").
 *
 * Meta reports each outbound message as `sent`, then `delivered`, then `read`,
 * or `failed` with an error. Those receipts were logged and dropped, so on the
 * dashboard a reply Meta refused (24-hour window closed, number not on
 * WhatsApp, template required) looked exactly like one the citizen read.
 *
 * The receipt is recorded on the Message row it describes: `externalId` holds
 * Meta's `wamid` once the send returns, and `metadata.delivery` holds
 * `{ status, at, error? }`.
 *
 * ── Receipts arrive out of order ────────────────────────────────────────────
 *
 * Meta does not guarantee order: `read` can land before `delivered`. A status
 * therefore only ever moves FORWARD (sent < delivered < read), so a late
 * `delivered` cannot turn a read message back into an unread one. `failed` is
 * terminal and always recorded — it is the receipt somebody needs to see.
 */
import { prisma } from '@ace/database';

export type DeliveryStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

const RANK: Record<DeliveryStatus, number> = { sending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

export function isDeliveryStatus(v: unknown): v is DeliveryStatus {
  return typeof v === 'string' && v in RANK;
}

/** Should `next` replace `current`? Forward only; failed always wins. */
export function shouldAdvance(current: DeliveryStatus | null | undefined, next: DeliveryStatus): boolean {
  if (!current) return true;
  if (current === 'failed') return false;
  if (next === 'failed') return true;
  return RANK[next] > RANK[current];
}

async function mergeDelivery(messageId: string, patch: Record<string, unknown>, extra: { externalId?: string } = {}) {
  const row = await prisma.message.findUnique({ where: { id: messageId }, select: { metadata: true } });
  if (!row) return;
  const meta = (row.metadata as Record<string, unknown> | null) ?? {};
  await prisma.message.update({
    where: { id: messageId },
    data: {
      ...(extra.externalId ? { externalId: extra.externalId } : {}),
      metadata: { ...meta, delivery: { ...((meta.delivery as object) ?? {}), ...patch } } as any,
    },
  });
}

/** The send returned: remember Meta's id so its receipts can find this row. Never throws. */
export async function recordSent(messageId: string, wamid: string | undefined | null): Promise<void> {
  try {
    await mergeDelivery(
      messageId,
      { status: 'sent', at: new Date().toISOString() },
      wamid ? { externalId: wamid } : {},
    );
  } catch {
    /* recording must never break the reply path */
  }
}

/** The send threw. Never throws. */
export async function recordSendFailure(messageId: string, err: unknown): Promise<void> {
  try {
    const detail = String((err as any)?.message ?? err).slice(0, 300);
    await mergeDelivery(messageId, { status: 'failed', at: new Date().toISOString(), error: detail });
  } catch {
    /* as above */
  }
}

/**
 * Apply one Meta status receipt. Returns what happened, for tests and logs.
 * Unknown wamid → 'unknown' (a message sent outside this platform, or before
 * ids were recorded), which is not an error.
 */
export async function applyDeliveryReceipt(receipt: any): Promise<'applied' | 'stale' | 'unknown' | 'ignored'> {
  const wamid: string | undefined = receipt?.id;
  const status = receipt?.status;
  if (!wamid || !isDeliveryStatus(status)) return 'ignored';

  const row = await prisma.message.findUnique({ where: { externalId: wamid }, select: { id: true, metadata: true } });
  if (!row) return 'unknown';

  const current = ((row.metadata as any)?.delivery?.status ?? null) as DeliveryStatus | null;
  if (!shouldAdvance(current, status)) return 'stale';

  const ts = Number(receipt?.timestamp);
  const at = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : new Date().toISOString();
  const error = status === 'failed'
    ? (receipt?.errors?.[0]?.error_data?.details ?? receipt?.errors?.[0]?.title ?? receipt?.errors?.[0]?.message ?? 'failed')
    : undefined;

  await mergeDelivery(row.id, { status, at, ...(error ? { error: String(error).slice(0, 300), code: receipt?.errors?.[0]?.code ?? null } : {}) });
  return 'applied';
}
