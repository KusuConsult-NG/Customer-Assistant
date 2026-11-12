/**
 * Report a spent Redis quota ONCE, instead of on every retry.
 *
 * Upstash's free plan answers every command with "ERR max requests limit
 * exceeded" once its allowance is spent, and BullMQ logs each retry: on the
 * live deployment that was about seven error lines a second from two workers,
 * burying everything else in the logs.
 *
 * ── Why this only REPORTS, and does not close the worker ───────────────────
 *
 * The first version called `worker.close()`. In production that killed the
 * process one second after boot: closing removes the worker's listener from
 * its Redis connection, the connection then emitted one more refusal with no
 * listener, and Node treats an unhandled 'error' event as fatal. The deploy
 * failed and the old build kept serving. The worker's own retry loop is
 * harmless by comparison — the old build ran for hours with it — so the guard
 * keeps the listener attached and only stops the log flood. Ending the retries
 * properly means removing REDIS_URL or upgrading the plan, which this states.
 */
const QUOTA = /max requests limit exceeded|max daily request limit|max monthly request limit/i;

export function isRedisQuotaError(err: unknown): boolean {
  return QUOTA.test(String((err as any)?.message ?? err ?? ''));
}

export function reportRedisQuotaOnce(
  name: string,
  report: (message: string) => void,
): (err: unknown) => boolean {
  let reported = false;
  return (err: unknown) => {
    if (!isRedisQuotaError(err)) return false;
    if (!reported) {
      reported = true;
      report(
        `${name}: the Redis provider is refusing every command on quota (${String((err as any)?.message ?? err).slice(0, 120)}). ` +
          'Further refusals are not logged. Queued work falls back to the inline path. ' +
          'Upgrade the Redis plan or unset REDIS_URL, then restart.',
      );
    }
    return true;
  };
}
