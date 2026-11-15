import { YeelightConnectionClosedError } from '../protocol';

export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = [];
  private queueTail: Promise<void> = Promise.resolve();
  private closedError?: Error;
  private readonly waiters = new Set<{
    timer: ReturnType<typeof setTimeout>;
    reject: (error: Error) => void;
  }>();

  constructor(
    private readonly maximumCommands = 60,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now
  ) {
    if (
      !Number.isInteger(maximumCommands) ||
      maximumCommands < 1 ||
      !Number.isInteger(windowMs) ||
      windowMs < 1
    ) {
      throw new RangeError('Invalid Yeelight rate limiter options');
    }
  }

  acquire(): Promise<void> {
    const task = this.queueTail.then(() => this.acquireSlot());
    this.queueTail = task.catch(() => {});
    return task;
  }

  close(error: Error = new YeelightConnectionClosedError()): void {
    if (this.closedError) {
      return;
    }
    this.closedError = error;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private async acquireSlot(): Promise<void> {
    while (true) {
      if (this.closedError) {
        throw this.closedError;
      }

      const now = this.now();
      const cutoff = now - this.windowMs;
      while (
        this.timestamps.length > 0 &&
        this.timestamps[0] <= cutoff
      ) {
        this.timestamps.shift();
      }

      if (this.timestamps.length < this.maximumCommands) {
        this.timestamps.push(now);
        return;
      }

      const waitMs = Math.max(
        1,
        this.timestamps[0] + this.windowMs - now
      );
      await this.wait(waitMs);
    }
  }

  private wait(delayMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter = {
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        reject
      };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve();
      }, delayMs);
      this.waiters.add(waiter);
    });
  }
}
