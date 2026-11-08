/**
 * The line an agency's outbound calls are placed from.
 *
 * ONE definition, used by `TelephonyService.initiateOutboundCall` (which
 * dials) and by the callback queue (which has to know, before it claims a
 * promise, whether this process can dial it at all). Two copies of "which line
 * is the outbound one" would eventually disagree, and the disagreement would
 * be a citizen's promise held for an officer on a line the dialler would have
 * rung — or dialled on one it refuses.
 *
 * The default line, or the oldest when none is marked. Any config, not only
 * isDefault: OrganizationsService.updateTelephonyConfig never writes
 * isDefault, so an isDefault-only lookup returned null for every agency
 * configured through the dashboard and outbound calls were placed from the
 * placeholder number +2348030000000, which no carrier would accept as a
 * verified caller ID.
 *
 * A plain function rather than a provider method because the dispatcher's
 * tests build it with a fake telephony service that only knows how to dial.
 */
import { prisma } from '@ace/database';

export async function outboundLineFor(organizationId: string) {
  return (
    (await prisma.telephonyConfig.findFirst({ where: { organizationId, isDefault: true } })) ??
    (await prisma.telephonyConfig.findFirst({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    }))
  );
}

/**
 * Is this agency's outbound line one an OFFICER dials, from the browser?
 *
 * True for Infobip: this process places no Infobip calls, so a promise on
 * such a line is held for an officer rather than claimed and failed — a
 * failed claim spends one of the citizen's attempts on a dial nobody placed.
 */
export async function isOfficerDialledLine(organizationId: string): Promise<boolean> {
  const line = await outboundLineFor(organizationId);
  return (line?.provider as string | undefined) === 'INFOBIP';
}
