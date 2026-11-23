import { prisma, phoneNumberVariants } from '@ace/database';

/**
 * The agency that owns a dialled number: its TelephonyConfig line, and failing
 * that the agency named by `fallbackSlug` (a bridge whose carrier delivers
 * every call to one extension, whatever number was dialled).
 *
 * Two agencies claiming one number answers null rather than guessing: a guess
 * files one agency's caller under another's records.
 */
export async function organizationForDialledNumber(calledNumber: string, fallbackSlug?: string): Promise<string | null> {
  const variants = phoneNumberVariants(calledNumber);
  if (variants.length) {
    const lines = await prisma.telephonyConfig.findMany({
      where: { phoneNumber: { in: variants } },
      select: { organizationId: true },
      take: 2,
    });
    const orgs = [...new Set(lines.map((l) => l.organizationId))];
    if (orgs.length === 1) return orgs[0];
    if (orgs.length > 1) return null;
  }
  const slug = fallbackSlug?.trim();
  if (!slug) return null;
  const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
  return org?.id ?? null;
}
