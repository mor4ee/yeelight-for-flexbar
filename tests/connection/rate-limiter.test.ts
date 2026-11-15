import assert from 'node:assert/strict';
import test from 'node:test';
import { SlidingWindowRateLimiter } from '../../src/backend/connection/rate-limiter';
import { YeelightConnectionClosedError } from '../../src/backend/protocol';

test('delays commands that exceed the rolling window', async () => {
  const limiter = new SlidingWindowRateLimiter(2, 20);
  await limiter.acquire();
  await limiter.acquire();

  const startedAt = Date.now();
  await limiter.acquire();
  assert.ok(Date.now() - startedAt >= 10);
  limiter.close();
});

test('rejects queued rate-limit waits when connection shuts down', async () => {
  const limiter = new SlidingWindowRateLimiter(1, 10_000);
  await limiter.acquire();
  const waiting = limiter.acquire();
  limiter.close();

  await assert.rejects(waiting, YeelightConnectionClosedError);
});
