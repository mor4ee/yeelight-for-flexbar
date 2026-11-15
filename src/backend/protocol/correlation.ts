import {
  YeelightCommandError,
  YeelightConnectionClosedError,
  YeelightProtocolError,
  YeelightRequestTimeoutError
} from './errors';
import type {
  YeelightErrorResponse,
  YeelightResultResponse
} from './types';

type ResponseMessage = YeelightResultResponse | YeelightErrorResponse;

interface PendingRequest {
  method: string;
  resolve: (result: unknown[]) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface CorrelatedRequest {
  id: number;
  response: Promise<unknown[]>;
}

export class YeelightRequestCorrelator {
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;

  constructor(private readonly maxPendingRequests = 32) {
    if (!Number.isInteger(maxPendingRequests) || maxPendingRequests < 1) {
      throw new RangeError('maxPendingRequests must be a positive integer');
    }
  }

  create(method: string, timeoutMs: number): CorrelatedRequest {
    if (this.closed) {
      throw new YeelightConnectionClosedError();
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError('timeoutMs must be a positive integer');
    }
    if (this.pending.size >= this.maxPendingRequests) {
      throw new YeelightProtocolError(
        'PENDING_LIMIT_REACHED',
        `At most ${this.maxPendingRequests} Yeelight requests may be pending`
      );
    }

    const id = this.allocateRequestId();
    let resolveResponse!: (result: unknown[]) => void;
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<unknown[]>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const timeout = setTimeout(() => {
      const request = this.pending.get(id);
      if (!request) {
        return;
      }
      this.pending.delete(id);
      request.reject(new YeelightRequestTimeoutError(id, method));
    }, timeoutMs);

    this.pending.set(id, {
      method,
      resolve: resolveResponse,
      reject: rejectResponse,
      timeout
    });

    return {
      id,
      response
    };
  }

  handle(message: ResponseMessage): boolean {
    const request = this.pending.get(message.id);
    if (!request) {
      return false;
    }

    clearTimeout(request.timeout);
    this.pending.delete(message.id);

    if (message.kind === 'result') {
      request.resolve(message.result);
    } else {
      request.reject(
        new YeelightCommandError(
          message.error.code,
          message.error.message,
          message.id
        )
      );
    }

    return true;
  }

  close(error: Error = new YeelightConnectionClosedError()): void {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }

  private allocateRequestId(): number {
    const maximumRequestId = 0x7f_ff_ff_ff;
    for (let attempts = 0; attempts < maximumRequestId; attempts += 1) {
      const id = this.nextRequestId;
      this.nextRequestId =
        this.nextRequestId >= maximumRequestId ? 1 : this.nextRequestId + 1;
      if (!this.pending.has(id)) {
        return id;
      }
    }

    throw new YeelightProtocolError(
      'PENDING_LIMIT_REACHED',
      'No Yeelight request id is available'
    );
  }
}
