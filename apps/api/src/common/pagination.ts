/**
 * Shared list-pagination helpers.
 *
 * Two defects these exist to prevent, both found by driving the running API:
 *
 *  1. UNSTABLE ORDERING. Ordering by `createdAt` alone is not deterministic when
 *     rows share a timestamp — which happens constantly with bulk imports and is
 *     possible for any two rows written in the same millisecond. PostgreSQL is free
 *     to return tied rows in a different order for each query, so a user paging
 *     through a list sees some records twice and never sees others at all.
 *     Every list therefore breaks ties on the primary key.
 *
 *  2. UNBOUNDED PAGE SIZE. `?limit=999999999` returned the entire table in one
 *     response — an unauthenticated-cost denial of service against both the database
 *     and the API's heap, available to any logged-in user.
 */

/** Largest page any client may request. */
export const MAX_PAGE_SIZE = 200;

/** Page size used when the client does not specify one. */
export const DEFAULT_PAGE_SIZE = 50;

export interface PageParams {
  page: number;
  limit: number;
  skip: number;
}

/**
 * Coerces arbitrary client input into a safe page/limit pair.
 * Handles undefined, empty string, negative, zero, NaN and absurdly large values.
 */
export function resolvePaging(rawPage?: unknown, rawLimit?: unknown): PageParams {
  const parsedPage = Number.parseInt(String(rawPage ?? ''), 10);
  const parsedLimit = Number.parseInt(String(rawLimit ?? ''), 10);

  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;

  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Deterministic ordering: newest first, ties broken by id so the sequence is total
 * and stable across separate queries.
 */
export const STABLE_DESC = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

export function pageEnvelope<T>(data: T[], total: number, { page, limit }: PageParams) {
  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}
