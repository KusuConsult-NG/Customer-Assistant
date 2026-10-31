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

/**
 * The client is cached on `globalThis`, not in a module-level variable.
 *
 * A module-level `let` is one client per MODULE REGISTRY, and a registry is not
 * a process: anything that re-evaluates this module — a bundler reloading, a
 * dev server recompiling — gets a second client, and a second connection pool
 * that nothing closes.
 *
 * It does NOT fix the same problem under Jest, which gives every test file a
 * fresh `globalThis` (and a fresh `process`) as well as a fresh registry, so no
 * in-process cache can be shared between files. That is handled where it has to
 * be, by releasing the pool when a file ends — see
 * `apps/api/test/support/release-db-connections.ts`.
 */
const PRISMA_SINGLETON = Symbol.for('ace.prisma.client');

interface PrismaGlobal {
  [PRISMA_SINGLETON]?: PrismaClient;
}

export function getPrismaClient(): PrismaClient {
  const store = globalThis as unknown as PrismaGlobal;
  if (!store[PRISMA_SINGLETON]) {
    const url = buildDatabaseUrl();
    store[PRISMA_SINGLETON] = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
      ...(url ? { datasources: { db: { url } } } : {}),
    });
  }
  return store[PRISMA_SINGLETON]!;
}

export const prisma = getPrismaClient();

export * from './selfie-request';

export * from './secret-box';
export * from './credentials';
export * from './enrollment';
export * from './phone-number';
export * from './ticket-number';
export * from './state-geography';
export * from './service-locations';
export * from './booking-conflicts';
export * from './service-hours';
export * from './service-catalogue';
export * from './availability';
export * from './audit';
