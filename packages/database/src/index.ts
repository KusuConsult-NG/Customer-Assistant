import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

/**
 * Connection pool sizing.
 *
 * Load testing the running API found this to be the single hardest capacity limit
 * in the product: with `connection_limit=10` on DATABASE_URL, 100 concurrent
 * authenticated readers produced ~5% HTTP 500s and a p95 of 60 seconds, all from
 * `Timed out fetching a new connection from the connection pool`.
 *
 * Two things drive pool pressure per request:
 *   1. JwtStrategy re-checks the user on every authenticated request (so that
 *      logout, deactivation and role changes take effect immediately rather than
 *      whenever a token happens to expire). That is one extra primary-key lookup.
 *   2. The handler's own queries.
 *
 * So budget roughly 2–3 connections per concurrent in-flight request, and size the
 * pool per PROCESS: total connections = connection_limit × number of app instances,
 * which must stay under what the database (or its pooler) will accept.
 *
 * Set DATABASE_CONNECTION_LIMIT to override. It is applied here rather than by
 * hand-editing the URL so the value is visible, documented and consistent across
 * every process that imports this client.
 */
const DEFAULT_CONNECTION_LIMIT = 25;
const DEFAULT_POOL_TIMEOUT_SECONDS = 20;

function buildDatabaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;

  try {
    const url = new URL(raw);

    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', process.env.DATABASE_CONNECTION_LIMIT ?? String(DEFAULT_CONNECTION_LIMIT));
    } else if (process.env.DATABASE_CONNECTION_LIMIT) {
      url.searchParams.set('connection_limit', process.env.DATABASE_CONNECTION_LIMIT);
    }

    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', process.env.DATABASE_POOL_TIMEOUT ?? String(DEFAULT_POOL_TIMEOUT_SECONDS));
    }

    return url.toString();
  } catch {
    // A URL we cannot parse (unencoded characters in the password, for instance) is
    // passed through untouched rather than dropped.
    return raw;
  }
}

let globalPrisma: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (!globalPrisma) {
    const url = buildDatabaseUrl();
    globalPrisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
      ...(url ? { datasources: { db: { url } } } : {}),
    });
  }
  return globalPrisma;
}

export const prisma = getPrismaClient();
