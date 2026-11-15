import { YeelightProtocolError } from './errors';
import type { FrameDecodeResult, YeelightInboundMessage } from './types';

export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const CRLF = Buffer.from('\r\n');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseResponse(
  value: Record<string, unknown>
): YeelightInboundMessage | undefined {
  if (!Number.isInteger(value.id) || (value.id as number) < 1) {
    return undefined;
  }

  const id = value.id as number;
  if (Array.isArray(value.result)) {
    return {
      kind: 'result',
      id,
      result: value.result
    };
  }

  if (
    isRecord(value.error) &&
    Number.isInteger(value.error.code) &&
    typeof value.error.message === 'string'
  ) {
    return {
      kind: 'error',
      id,
      error: {
        code: value.error.code as number,
        message: value.error.message
      }
    };
  }

  return undefined;
}

function parseNotification(
  value: Record<string, unknown>
): YeelightInboundMessage | undefined {
  if (typeof value.method !== 'string' || value.method.length === 0) {
    return undefined;
  }

  if (value.method !== 'props') {
    return {
      kind: 'notification',
      method: value.method,
      params: value.params
    };
  }

  if (!isRecord(value.params)) {
    throw new YeelightProtocolError(
      'INVALID_MESSAGE',
      'Yeelight props notification params must be a JSON object'
    );
  }

  const params: Record<string, string> = {};
  for (const [name, propertyValue] of Object.entries(value.params)) {
    if (typeof propertyValue === 'string') {
      params[name] = propertyValue;
      continue;
    }
    if (
      typeof propertyValue === 'number' &&
      Number.isFinite(propertyValue)
    ) {
      params[name] = String(propertyValue);
      continue;
    }
    throw new YeelightProtocolError(
      'INVALID_MESSAGE',
      `Yeelight props property ${name} has unsupported type ${typeof propertyValue}`
    );
  }

  return {
    kind: 'props',
    method: 'props',
    params
  };
}

export function parseInboundMessage(
  frame: Buffer | string
): YeelightInboundMessage {
  const text = Buffer.isBuffer(frame) ? frame.toString('utf8') : frame;
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new YeelightProtocolError(
      'INVALID_JSON',
      'Yeelight frame is not valid JSON'
    );
  }

  if (!isRecord(parsed)) {
    throw new YeelightProtocolError(
      'INVALID_MESSAGE',
      'Yeelight frame must contain a JSON object'
    );
  }

  const message = parseResponse(parsed) ?? parseNotification(parsed);
  if (!message) {
    throw new YeelightProtocolError(
      'INVALID_MESSAGE',
      'Yeelight frame has an unsupported message shape'
    );
  }

  return message;
}

export class YeelightFrameDecoder {
  private buffer = Buffer.alloc(0);
  private discardingOversizedFrame = false;

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new RangeError('maxFrameBytes must be a positive integer');
    }
  }

  feed(chunk: Buffer | Uint8Array | string): FrameDecodeResult[] {
    const incoming =
      typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    const results: FrameDecodeResult[] = [];

    if (incoming.length === 0) {
      return results;
    }

    this.buffer = Buffer.concat([this.buffer, incoming]);

    while (this.buffer.length > 0) {
      if (this.discardingOversizedFrame) {
        const delimiterIndex = this.buffer.indexOf(CRLF);
        if (delimiterIndex < 0) {
          this.buffer = this.buffer.subarray(
            Math.max(0, this.buffer.length - 1)
          );
          return results;
        }

        this.buffer = this.buffer.subarray(delimiterIndex + CRLF.length);
        this.discardingOversizedFrame = false;
        continue;
      }

      const delimiterIndex = this.buffer.indexOf(CRLF);
      if (delimiterIndex < 0) {
        if (this.buffer.length > this.maxFrameBytes) {
          results.push({
            kind: 'error',
            error: new YeelightProtocolError(
              'FRAME_TOO_LARGE',
              `Yeelight frame exceeds ${this.maxFrameBytes} bytes`
            )
          });
          this.discardingOversizedFrame = true;
          this.buffer = this.buffer.subarray(
            Math.max(0, this.buffer.length - 1)
          );
        }
        return results;
      }

      const frame = this.buffer.subarray(0, delimiterIndex);
      this.buffer = this.buffer.subarray(delimiterIndex + CRLF.length);

      if (frame.length === 0) {
        continue;
      }

      if (frame.length > this.maxFrameBytes) {
        results.push({
          kind: 'error',
          error: new YeelightProtocolError(
            'FRAME_TOO_LARGE',
            `Yeelight frame exceeds ${this.maxFrameBytes} bytes`
          )
        });
        continue;
      }

      try {
        results.push({
          kind: 'message',
          message: parseInboundMessage(frame)
        });
      } catch (error) {
        results.push({
          kind: 'error',
          error: error instanceof Error ? error : new Error(String(error))
        });
      }
    }

    return results;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.discardingOversizedFrame = false;
  }

  get bufferedBytes(): number {
    return this.buffer.length;
  }
}
