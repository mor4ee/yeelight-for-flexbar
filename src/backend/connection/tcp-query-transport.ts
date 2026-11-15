import { createConnection } from 'node:net';
import {
  encodeCommand,
  getProperties,
  YeelightConnectionClosedError,
  YeelightFrameDecoder,
  type YeelightInboundMessage
} from '../protocol';
import type { TcpQueryTransport } from './transport-types';

interface TcpQuerySocketLike {
  on(event: string, handler: (...args: any[]) => void): this;
  write(
    data: Buffer,
    callback?: (error?: Error | null) => void
  ): boolean;
  setNoDelay?(noDelay?: boolean): this;
  setTimeout?(timeout: number): this;
  destroy(error?: Error): this;
}

export interface YeelightTcpQueryTransportOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  createSocket?: (host: string, port: number) => TcpQuerySocketLike;
}

export class YeelightTcpQueryTransport implements TcpQueryTransport {
  private readonly timeoutMs: number;
  private readonly createSocket: (
    host: string,
    port: number
  ) => TcpQuerySocketLike;
  private readonly sockets = new Set<TcpQuerySocketLike>();
  private stopped = false;
  private requestId = 0;

  constructor(private readonly options: YeelightTcpQueryTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.createSocket =
      options.createSocket ??
      ((host, port) =>
        createConnection({ host, port }) as TcpQuerySocketLike);

    if (
      !Number.isInteger(options.port) ||
      options.port < 1 ||
      options.port > 65_535 ||
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1
    ) {
      throw new RangeError('Invalid Yeelight TCP query options');
    }
  }

  query(properties: readonly string[]): Promise<Record<string, string>> {
    if (this.stopped) {
      return Promise.reject(
        new YeelightConnectionClosedError(
          'Yeelight TCP query transport is stopped'
        )
      );
    }
    if (properties.length === 0) {
      return Promise.resolve({});
    }

    const requestId = this.nextRequestId();
    const decoder = new YeelightFrameDecoder();
    let socket: TcpQuerySocketLike;
    try {
      socket = this.createSocket(this.options.host, this.options.port);
    } catch (error) {
      return Promise.reject(this.normalizeError(error));
    }
    this.sockets.add(socket);
    socket.setNoDelay?.(true);
    socket.setTimeout?.(this.timeoutMs);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (
        error?: Error,
        result?: Record<string, string>
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.sockets.delete(socket);
        try {
          socket.destroy();
        } catch {
          // The peer may already have closed the short-lived socket.
        }
        if (error) {
          reject(error);
        } else {
          resolve(result ?? {});
        }
      };

      socket.on('connect', () => {
        if (this.stopped) {
          finish(
            new YeelightConnectionClosedError(
              'Yeelight TCP query transport is stopped'
            )
          );
          return;
        }
        socket.setTimeout?.(this.timeoutMs);
        socket.write(
          encodeCommand(requestId, getProperties(properties)),
          (error) => {
            if (error) {
              finish(this.normalizeError(error));
            }
          }
        );
      });
      socket.on(
        'data',
        (chunk: Buffer | Uint8Array | string) => {
          for (const decoded of decoder.feed(chunk)) {
            if (decoded.kind === 'error') {
              finish(decoded.error);
              return;
            }
            const message = decoded.message;
            if (
              (message.kind === 'result' || message.kind === 'error') &&
              message.id === requestId
            ) {
              this.finishResponse(message, properties, finish);
              return;
            }
          }
        }
      );
      socket.on('timeout', () => {
        finish(new Error('Yeelight TCP query timed out'));
      });
      socket.on('error', (error: Error) => {
        finish(this.normalizeError(error));
      });
      socket.on('close', () => {
        finish(
          new YeelightConnectionClosedError(
            'Yeelight TCP query connection closed'
          )
        );
      });
    });
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const socket of this.sockets) {
      try {
        socket.destroy(
          new YeelightConnectionClosedError(
            'Yeelight TCP query transport stopped'
          )
        );
      } catch {
        // Best-effort shutdown.
      }
    }
    this.sockets.clear();
  }

  private finishResponse(
    message: YeelightInboundMessage,
    properties: readonly string[],
    finish: (error?: Error, result?: Record<string, string>) => void
  ): void {
    if (message.kind === 'error') {
      finish(
        new Error(
          `Yeelight TCP query failed (${message.error.code}): ` +
            message.error.message
        )
      );
      return;
    }
    if (message.kind !== 'result') {
      return;
    }

    const result: Record<string, string> = {};
    for (let index = 0; index < properties.length; index += 1) {
      const value = message.result[index];
      if (typeof value === 'string' && value.length > 0) {
        result[properties[index]] = value;
      }
    }
    finish(undefined, result);
  }

  private nextRequestId(): number {
    this.requestId = (this.requestId % 0x7f_ff_ff_ff) + 1;
    return this.requestId;
  }

  private normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
