/**
 * When a caller needs a person: queue a callback an officer will work.
 *
 * ── The design ──────────────────────────────────────────────────────────────
 *
 * The AI answers every call. When it cannot help — or the caller asks for a
 * person — it does NOT transfer the call. It promises a callback, writes it to
 * the callback queue, and reads the reference back. An officer works that
 * queue from the dashboard's Callbacks page and rings the citizen.
 *
 * That replaces a live transfer to a forwarding number, deliberately. A
 * transfer only works while an officer is free to answer at the exact moment
 * a citizen asks, and fails exactly when the line is busiest; a queued
 * callback is still there an hour later, carries the citizen's own words, and
 * is worked in order. It also means a line needs no forwarding number at all.
 *
 * ── Why a CallbackRequest and not a ticket ──────────────────────────────────
 *
 * This used to file a HIGH-priority Ticket. Tickets are a different screen
 * from the queue officers dial from, so a caller promised "someone will call
 * you back" was promised it from a list nobody calls from. The callback queue
 * is the one place the promise and the thing that keeps it are the same row:
 * the dispatcher retries it, the console shows its reference, and it closes
 * when somebody actually reaches the citizen.
 *
 * Shared by every carrier — Twilio and Infobip both call this — so what a
 * citizen is told when they ask for help does not depend on which network
 * carried their call. A copy per carrier would be a second place for the
 * wording, the reference format or the withheld-number rule to drift.
 */
import {
  prisma,
  ensureContactForPhone,
  normalizePhoneNumber,
  callbackReference,
  nextServiceTime,
  outboundContactHoursFrom,
  OPEN_CALLBACK_STATUSES,
} from '@ace/database';

export type HandoffCallbackResult =
  | {
      kind: 'queued';
      reference: string;
      /** When an officer can first act on it — the next moment the office is open. */
      dueAt: Date;
      /** The office is closed right now, so the callback waits for it to open. */
      outsideHours: boolean;
      /** The citizen already had an open request; it was reused, not duplicated. */
      existing: boolean;
    }
  /**
   * No number to ring back. A callback queued against a withheld number is a
   * promise nobody can keep, and keying a contact on it would give every
   * withheld caller in the State one shared record.
   */
  | { kind: 'withheld' }
  /** It could not be written. The caller is still told, and told the truth. */
  | { kind: 'failed' };

/**
 * Queue the callback. Never throws: the caller is still on the line and must
 * be told something either way.
 */
export async function queueHandoffCallback(params: {
  organizationId: string;
  fromNumber: string;
  /** What the citizen said, so the officer knows why before dialling. */
  lastUtterance: string;
  onError?: (err: unknown) => void;
  /** Injected so tests can pin the clock against the agency's hours. */
  now?: Date;
}): Promise<HandoffCallbackResult> {
  try {
    // The shared helper refuses to key a contact on a withheld or agency-owned
    // number, and matches every stored shape, so the request lands on the
    // record the citizen already has.
    const contact = await ensureContactForPhone(prisma, params.organizationId, params.fromNumber);
    if (!contact) return { kind: 'withheld' };

    // One open request per citizen. Somebody who rings twice in an afternoon
    // asking for a person needs one call back, not two officers phoning them
    // at once, and the second call should hear the reference they already
    // hold rather than a new one that makes the first look lost.
    const open = await prisma.callbackRequest.findFirst({
      where: {
        organizationId: params.organizationId,
        contactId: contact.id,
        status: { in: [...OPEN_CALLBACK_STATUSES] as any },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, dueAt: true },
    });
    const now = params.now ?? new Date();
    if (open) {
      return {
        kind: 'queued',
        reference: callbackReference(open.id),
        dueAt: open.dueAt,
        outsideHours: open.dueAt.getTime() > now.getTime() + 60_000,
        existing: true,
      };
    }

    // Due the next moment the agency takes outbound calls. A promise made at
    // 22:00 is due at opening time, not at 22:00 — the queue then shows it as
    // waiting for the office rather than as already overdue.
    const hours = await outboundContactHoursFrom(prisma, params.organizationId);
    const dueAt = nextServiceTime(now, hours);
    const outsideHours = dueAt.getTime() > now.getTime() + 60_000;

    const record = await prisma.callbackRequest.create({
      data: {
        organizationId: params.organizationId,
        contactId: contact.id,
        phoneNumber: normalizePhoneNumber(params.fromNumber) || params.fromNumber,
        reason:
          `Asked on a phone call to speak to a person. What they said: ` +
          `"${params.lastUtterance.trim().slice(0, 800)}"`,
        // Stored as what the caller was TOLD, which is what the queue shows
        // beside the reference. It names no time, because nothing here can
        // promise one: an officer rings when one is free.
        promisedText: outsideHours ? 'When the office next opens' : 'As soon as an officer is free',
        dueAt,
      },
      select: { id: true },
    });

    return {
      kind: 'queued',
      reference: callbackReference(record.id),
      dueAt,
      outsideHours,
      existing: false,
    };
  } catch (err) {
    params.onError?.(err);
    return { kind: 'failed' };
  }
}

/**
 * What the caller hears — chosen from what actually happened, never from what
 * was intended.
 *
 * It promises a CALL, not a time: an officer rings when one is free, and
 * quoting "within the hour" would be a promise this queue cannot keep. It
 * never says the call is being put through, because it is not.
 */
export function handoffCallbackPromise(result: HandoffCallbackResult): string {
  switch (result.kind) {
    case 'queued': {
      // Read exactly as the orchestrator's own callback confirmation reads it,
      // so a citizen quoting it back at a desk quotes the same string.
      const ref = result.reference;
      if (result.existing) {
        return (
          `You already have a callback request with us, reference ${ref}. ` +
          `An officer will call you back on this number — there is no need to call again.`
        );
      }
      return result.outsideHours
        ? `I've asked an officer to call you back on this number. Our office is closed at the moment, ` +
            `so they will call when it next opens. Your reference is ${ref}.`
        : `I've asked an officer to call you back on this number as soon as one is free. ` +
            `Your reference is ${ref}.`;
    }
    case 'withheld':
      return (
        `I'd like to arrange for an officer to call you back, but your number isn't showing, so they ` +
        `would have no way to reach you. Please call again from a number that is shown, and I'll set it up.`
      );
    case 'failed':
      return (
        `I'm sorry — I wasn't able to arrange a callback just now. Please call again shortly and ` +
        `a member of the team will help you.`
      );
  }
}
