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
import { CanActivate, ExecutionContext, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { prisma } from '@ace/database';

export const AGENT_KEY_PREFIX = 'ace_agent_sk_';

export interface AgentRequestContext {
  organizationId: string;
  organizationName: string;
}

interface CachedAgentKey {
  id: string;
  ctx: AgentRequestContext;
  cachedAt: number;
  lastTouchedAt: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const TOUCH_INTERVAL_MS = 60_000;
const DB_LOOKUP_TIMEOUT_MS = 1_500;

@Injectable()
export class AgentKeyGuard implements CanActivate, OnModuleInit {
  private static readonly cache = new Map<string, CachedAgentKey>();

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await AgentKeyGuard.warmCache();
  }

  static async warmCache(): Promise<void> {
    try {
      const records = await prisma.apiKey.findMany({
        where: { keyPrefix: { startsWith: AGENT_KEY_PREFIX } },
        include: { organization: { select: { id: true, name: true } } },
      });
      const now = Date.now();
      for (const r of records) {
        if (r.organization) {
          const existing = AgentKeyGuard.cache.get(r.keyHash);
          AgentKeyGuard.cache.set(r.keyHash, {
            id: r.id,
            ctx: { organizationId: r.organization.id, organizationName: r.organization.name },
            cachedAt: now,
            lastTouchedAt: existing?.lastTouchedAt ?? 0,
          });
        }
      }
    } catch {
      // Best-effort startup warm-up; live requests will populate on demand.
    }
  }

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

    const keyHash = createHash('sha256').update(key).digest('hex');
    const now = Date.now();
    const cached = AgentKeyGuard.cache.get(keyHash);

    if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
      req.agent = cached.ctx;
      this.touchKeyAsync(cached, now);
      return true;
    }

    let record: { id: string; organization: { id: string; name: string } | null } | null = null;
    try {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<null>((_, reject) => {
        timer = setTimeout(() => reject(new Error('agent_key_lookup_timeout')), DB_LOOKUP_TIMEOUT_MS);
      });
      try {
        record = await Promise.race([
          prisma.apiKey.findUnique({
            where: { keyHash },
            include: { organization: { select: { id: true, name: true } } },
          }),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // If the database pool is temporarily stalled or reconnecting, serve from
      // a previously verified entry so a live phone call is never dropped.
      if (cached) {
        cached.cachedAt = now;
        req.agent = cached.ctx;
        return true;
      }
      throw err;
    }

    if (!record?.organization) {
      AgentKeyGuard.cache.delete(keyHash);
      throw new UnauthorizedException('Invalid agent key.');
    }

    const ctx: AgentRequestContext = {
      organizationId: record.organization.id,
      organizationName: record.organization.name,
    };
    const entry: CachedAgentKey = {
      id: record.id,
      ctx,
      cachedAt: now,
      lastTouchedAt: cached?.lastTouchedAt ?? 0,
    };
    AgentKeyGuard.cache.set(keyHash, entry);
    this.touchKeyAsync(entry, now);

    req.agent = ctx;
    return true;
  }

  private touchKeyAsync(entry: CachedAgentKey, now: number): void {
    if (now - entry.lastTouchedAt < TOUCH_INTERVAL_MS) return;
    entry.lastTouchedAt = now;
    // Never await on the request path: a slow write must not delay call setup.
    void prisma.apiKey
      .update({ where: { id: entry.id }, data: { lastUsedAt: new Date(now) } })
      .catch(() => {});
  }
}
