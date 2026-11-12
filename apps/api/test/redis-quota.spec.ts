import { isRedisQuotaError, stopOnRedisQuota } from '../src/common/redis-quota';

// Live: two BullMQ workers logged Upstash's quota refusal ~7 times a second,
// each retry spending more of the quota that was already gone.
describe('a spent Redis quota stops the worker instead of retrying into it', () => {
  const upstash = new Error('ERR max requests limit exceeded. Limit: 500000, Usage: 500002.');

  it('recognises the provider refusal and nothing else', () => {
    expect(isRedisQuotaError(upstash)).toBe(true);
    expect(isRedisQuotaError(new Error('connect ECONNREFUSED'))).toBe(false);
  });

  it('closes the worker once and reports once, however many errors follow', () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const report = jest.fn();
    const onError = stopOnRedisQuota({ close }, 'W', report);
    for (let i = 0; i < 50; i++) expect(onError(upstash)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatch(/stopped instead of retrying/);
  });

  it('leaves a transient error to the normal handler', () => {
    const close = jest.fn();
    expect(stopOnRedisQuota({ close }, 'W', jest.fn())(new Error('ECONNRESET'))).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });
});
