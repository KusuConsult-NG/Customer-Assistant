/**
 * Stop a BullMQ worker when the Redis PROVIDER refuses on quota.
 *
 * Upstash's free plan answers every command with "ERR max requests limit
 * exceeded" once its request allowance is spent. BullMQ treats that as a
 * transient error and retries immediately — and every retry is itself a
 * request, so on the live deployment two workers were each logging the error
 * about seven times a second, holding the quota at its limit and flooding the
 * logs until nothing else in them could be read.
 *
 * Retrying cannot succeed until the provider's allowance resets or the plan is
 * upgraded, so the worker is CLOSED, once, with one line saying why and what
 * still works. Both callers have a path that does not need the queue: the
 * workflow runner's inline sweeper, and inline indexing of text documents. The
 * next process start tries again, which costs a handful of requests rather
 * than half a million.
 */
const QUOTA = /max requests limit exceeded|max daily request limit|max monthly request limit/i;

export function isRedisQuotaError(err: unknown): boolean {
  return QUOTA.test(String((err as any)?.message ?? err ?? ''));
}

export function stopOnRedisQuota(
  worker: { close: () => Promise<unknown> },
  name: string,
  report: (message: string) => void,
): (err: unknown) => boolean {
  let stopped = false;
  return (err: unknown) => {
    if (!isRedisQuotaError(err)) return false;
    if (!stopped) {
      stopped = true;
      report(
        `${name}: the Redis provider refused on quota (${String((err as any)?.message ?? err).slice(0, 120)}). ` +
          'Worker stopped instead of retrying, because every retry spends more of the same quota. ' +
          'Queued work falls back to the inline path. Upgrade the Redis plan or unset REDIS_URL, then restart.',
      );
      void worker.close().catch(() => undefined);
    }
    return true;
  };
}
