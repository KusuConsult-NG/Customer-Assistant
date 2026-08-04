import http from 'http';

interface LoadTestStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  avgLatencyMs: number;
  requestsPerSec: number;
}

export async function runLoadTest(
  url: string,
  totalRequests = 100,
  concurrency = 10
): Promise<LoadTestStats> {
  const latencies: number[] = [];
  let successful = 0;
  let failed = 0;
  const startTime = Date.now();

  const parsedUrl = new URL(url);

  const makeRequest = (): Promise<void> => {
    return new Promise((resolve) => {
      const reqStart = Date.now();
      const req = http.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 80,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          timeout: 5000,
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            const elapsed = Date.now() - reqStart;
            latencies.push(elapsed);
            if (res.statusCode && res.statusCode < 400) {
              successful++;
            } else {
              failed++;
            }
            resolve();
          });
        }
      );

      req.on('error', () => {
        const elapsed = Date.now() - reqStart;
        latencies.push(elapsed);
        failed++;
        resolve();
      });

      req.end();
    });
  };

  const batches = Math.ceil(totalRequests / concurrency);
  for (let b = 0; b < batches; b++) {
    const promises: Promise<void>[] = [];
    const count = Math.min(concurrency, totalRequests - b * concurrency);
    for (let i = 0; i < count; i++) {
      promises.push(makeRequest());
    }
    await Promise.all(promises);
  }

  const totalTimeSec = (Date.now() - startTime) / 1000;
  const sumLatency = latencies.reduce((a, b) => a + b, 0);

  return {
    totalRequests,
    successfulRequests: successful,
    failedRequests: failed,
    minLatencyMs: Math.min(...latencies),
    maxLatencyMs: Math.max(...latencies),
    avgLatencyMs: Math.round(sumLatency / latencies.length),
    requestsPerSec: Math.round(totalRequests / totalTimeSec),
  };
}

if (require.main === module) {
  runLoadTest('http://localhost:4000/api/health', 100, 10).then((stats) => {
    console.log('=== LOAD TEST RESULTS ===');
    console.log(JSON.stringify(stats, null, 2));
  });
}
