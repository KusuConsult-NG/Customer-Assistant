/**
 * Authenticates a hosted voice/chat agent (ElevenLabs and anything like it) and
 * resolves WHICH TENANT it is acting for.
 *
 * The tenant is derived from the credential, never from the request body. A
 * hosted agent is configured by a third party and its tool calls are shaped by
 * an LLM; if `organizationId` were a parameter, one tenant's agent — or anyone
 * who learned the URL — could read and write another tenant's bookings by
 * changing a string. Per-organization keys make that unrepresentable rather
 * than merely forbidden.
 *
 * Keys reuse the existing ApiKey table and are stored only as SHA-256 hashes,
 * exactly like widget keys. The prefix differs (`ace_agent_sk_` vs the widget's
 * `ace_live_pk_`) because these are SECRET, server-to-server credentials: a
 * widget key is published in every visitor's page source, an agent key must
 * never be.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { prisma } from '@ace/database';

export const AGENT_KEY_PREFIX = 'ace_agent_sk_';

export interface AgentRequestContext {
  organizationId: string;
  organizationName: string;
}

@Injectable()
export class AgentKeyGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();

    const header: string = req.headers?.authorization ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!key) throw new UnauthorizedException('Missing agent key.');

    // Reject anything that is not an agent key before touching the database, so
    // a widget key pasted into an agent config fails loudly instead of silently
    // authenticating a public credential against write endpoints.
    if (!key.startsWith(AGENT_KEY_PREFIX)) {
      throw new UnauthorizedException('Not an agent key.');
    }

    const record = await prisma.apiKey.findUnique({
      where: { keyHash: createHash('sha256').update(key).digest('hex') },
      include: { organization: { select: { id: true, name: true } } },
    });
    if (!record?.organization) throw new UnauthorizedException('Invalid agent key.');

    // Best-effort: a failed touch must not fail the customer's call.
    await prisma.apiKey
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    const ctx: AgentRequestContext = {
      organizationId: record.organization.id,
      organizationName: record.organization.name,
    };
    req.agent = ctx;
    return true;
  }
}
