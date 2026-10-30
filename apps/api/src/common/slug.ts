import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';

/**
 * A unique organization slug.
 *
 * One definition, used by self-service registration and by platform
 * provisioning. Two of these would drift, and the drift would be in what a
 * tenant's public URLs look like.
 *
 * The random suffix is not decoration: without it, two agencies with similar
 * names race for the same slug, and the loser's creation fails on a unique
 * constraint at the end of a multi-step provisioning flow.
 */
export async function generateUniqueSlug(organizationName: string): Promise<string> {
  const base =
    organizationName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'org';

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${base}-${randomBytes(3).toString('hex')}`;
    const clash = await prisma.organization.findUnique({ where: { slug: candidate } });
    if (!clash) return candidate;
  }
  return `${base}-${randomBytes(8).toString('hex')}`;
}
