import { isRedisQuotaError, reportRedisQuotaOnce } from '../src/common/redis-quota';

// Live: two BullMQ workers logged Upstash's quota refusal ~7 times a second.
// The first fix CLOSED the worker, and the next refusal on its now-unlistened
// Redis connection crashed the process at boot. So the guard only reports.
describe('a spent Redis quota is reported once, and the worker is left alone', () => {
  const upstash = new Error('ERR max requests limit exceeded. Limit: 500000, Usage: 500002.');

  it('recognises the provider refusal and nothing else', () => {
    expect(isRedisQuotaError(upstash)).toBe(true);
    expect(isRedisQuotaError(new Error('connect ECONNREFUSED'))).toBe(false);
  });

  it('reports once however many refusals follow, and suppresses the rest', () => {
    const report = jest.fn();
    const onError = reportRedisQuotaOnce('W', report);
    for (let i = 0; i < 50; i++) expect(onError(upstash)).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('leaves a transient error to the normal handler', () => {
    expect(reportRedisQuotaOnce('W', jest.fn())(new Error('ECONNRESET'))).toBe(false);
  });

  it('takes no worker at all, so it cannot close one', () => {
    // Closing is what crashed production; the signature makes it impossible.
    expect(reportRedisQuotaOnce.length).toBe(2);
  });
});
