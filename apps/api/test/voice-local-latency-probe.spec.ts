import { median, timeBody } from '../src/voice-local/latency-probe';

describe('latency probe', () => {
  it('times a streamed body to its first byte, its first 4 KB and its end', async () => {
    let t = 1_000;
    const chunks = [Buffer.alloc(44), Buffer.alloc(5_000), Buffer.alloc(5_000)];
    const stamps = [1_100, 1_400, 1_900, 1_900];
    let i = 0;
    const res = { body: { getReader: () => ({ read: async () => { t = stamps[i]; const c = chunks[i++]; return c ? { done: false, value: c } : { done: true }; } }) } } as any;
    expect(await timeBody(1_000, res, () => t)).toEqual({ firstByteMs: 100, first4kMs: 400, lastByteMs: 900, bytes: 10_044 });
  });

  it('reports the end when the body never reaches 4 KB', async () => {
    let t = 0;
    const stamps = [50, 80];
    let i = 0;
    const res = { body: { getReader: () => ({ read: async () => { t = stamps[i]; return i++ === 0 ? { done: false, value: Buffer.alloc(10) } : { done: true }; } }) } } as any;
    expect(await timeBody(0, res, () => t)).toEqual({ firstByteMs: 50, first4kMs: 80, lastByteMs: 80, bytes: 10 });
  });

  it('takes the middle run', () => {
    expect(median([900, 100, 400])).toBe(400);
    expect(median([300, 100])).toBe(100);
  });
});
