/**
 * When a caller asks for a person and the call cannot be put through.
 *
 * Extracted from the Twilio media-stream handler so that every carrier keeps
 * the SAME promise. The rule it encodes is the voice path's central one: a
 * transfer is never announced unless it happened. When it did not, the caller
 * must leave the call with something real — a HIGH-priority ticket a person
 * will see, and its reference read back — rather than a reassurance.
 *
 * It lived inside one carrier's handler, and a second carrier (Infobip) needs
 * exactly this. A copy would be a second place to get the reference format,
 * the withheld-number rule or the wording wrong, and the drift would be in
 * what citizens are told when they ask for help.
 */
import { prisma, ensureContactForPhone, createTicketWithUniqueNumber } from '@ace/database';

/**
 * File the ticket. Returns its number, or null when it could not be filed —
 * never throws, because the caller is still on the line and must be told
 * something either way.
 */
export async function fileHandoffTicket(params: {
  organizationId: string;
  fromNumber: string;
  /** Why the call could not be put through, in words an officer can act on. */
  whyNotTransferred: string;
  lastUtterance: string;
  onError?: (err: unknown) => void;
}): Promise<string | null> {
  try {
    // The shared helper: it matches every stored shape, so the escalation
    // lands on the record the citizen already has, and it refuses to key a
    // row on a withheld number — which would give every withheld caller in
    // the State one shared contact.
    const contact = await ensureContactForPhone(prisma, params.organizationId, params.fromNumber);
    if (!contact) {
      throw new Error(
        `the caller's number was withheld (${params.fromNumber}), so there is no record to file this against`
      );
    }

    // `createTicketWithUniqueNumber`, never a timestamp slice: a collision
    // here means the caller who just asked for a human is told we could not
    // even log it — the one moment in the product where that is least
    // affordable.
    const ticket = await createTicketWithUniqueNumber((ticketNumber) =>
      prisma.ticket.create({
        data: {
          organizationId: params.organizationId,
          contactId: contact.id,
          ticketNumber,
          subject: 'Caller asked to speak to a human',
          description:
            `A caller on ${params.fromNumber} asked to be put through to a person, but the call ` +
            `could not be transferred (${params.whyNotTransferred}). They were told someone would ` +
            `call back.\n\nWhat they said: "${params.lastUtterance}"`,
          status: 'OPEN',
          priority: 'HIGH',
        },
      })
    );
    return ticket.ticketNumber;
  } catch (err) {
    params.onError?.(err);
    return null;
  }
}

/** What the caller hears — chosen from what actually happened. */
export function handoffApology(ticketNumber: string | null): string {
  return ticketNumber
    ? `I'm sorry — I can't put you through to a colleague on this call. I've logged your request as ` +
        `reference ${ticketNumber}, and someone will call you back on this number.`
    : `I'm sorry — I can't put you through to a colleague on this call, and I wasn't able to log your ` +
        `request either. Please call us back shortly and a member of the team will help you.`;
}
