import { createSocket, type RemoteInfo } from 'node:dgram';
import {
  decodeUdpR2Packet,
  encodeUdpCommand,
  encodeUdpHeartbeat,
  encodeUdpSessionNew,
  YEELIGHT_UDP_R2_HEARTBEAT_SECONDS,
  YEELIGHT_UDP_R2_PORT,
  type YeelightCommand
} from '../protocol';

const MAX_REQUEST_ID = 0x7f_ff_ff_ff;

interface UdpR2SocketLike {
  bind(port: number, address: string, callback: () => void): void;
  on(
    event: 'message',
    handler: (message: Buffer, info: RemoteInfo) => void
  ): this;
  on(event: 'error', handler: (error: Error) => void): this;
  send(
    message: Buffer,
    port: number,
    address: string,
    callback?: (error: Error | null, bytes?: number) => void
  ): void;
  close(): void;
}

export type UdpR2TransportPhase =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'stopped';

export interface UdpR2TransportSnapshot {
  phase: UdpR2TransportPhase;
  sessionGeneration: number;
  missedHeartbeats: number;
}

export interface UdpR2TransportOptions {
  host: string;
  port?: number;
  heartbeatIntervalMs?: number;
  heartbeatIntervalSeconds?: number;
  missedHeartbeatLimit?: number;
  handshakeTimeoutMs?: number;
  createSocket?: () => UdpR2SocketLike;
  onWarning?: (message: string, error?: Error) => void;
  onSessionUnavailable?: (error: Error) => void;
  onSessionReady?: (sessionGeneration: number) => void;
}

export class YeelightUdpR2SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YeelightUdpR2SessionError';
  }
}

interface PendingHandshake {
  id: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class UdpR2Transport {
  private readonly host: string;
  private readonly port: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatIntervalSeconds: number;
  private readonly missedHeartbeatLimit: number;
  private readonly handshakeTimeoutMs: number;
  private readonly createSocket: () => UdpR2SocketLike;
  private socket?: UdpR2SocketLike;
  private phase: UdpR2TransportPhase = 'idle';
  private requestId = 0;
  private token?: string;
  private sessionGeneration = 0;
  private missedHeartbeats = 0;
  private pendingHeartbeatIds = new Set<number>();
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private handshake?: PendingHandshake;
  private startTask?: Promise<void>;
  private bindReject?: (error: Error) => void;

  constructor(private readonly options: UdpR2TransportOptions) {
    this.host = options.host;
    this.port = options.port ?? YEELIGHT_UDP_R2_PORT;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.heartbeatIntervalSeconds =
      options.heartbeatIntervalSeconds ??
      YEELIGHT_UDP_R2_HEARTBEAT_SECONDS;
    this.missedHeartbeatLimit = options.missedHeartbeatLimit ?? 4;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 3_000;
    this.createSocket =
      options.createSocket ??
      (() => createSocket('udp4') as UdpR2SocketLike);

    if (
      !Number.isInteger(this.port) ||
      this.port < 1 ||
      this.port > 65_535 ||
      !Number.isInteger(this.heartbeatIntervalMs) ||
      this.heartbeatIntervalMs < 1 ||
      !Number.isInteger(this.heartbeatIntervalSeconds) ||
      this.heartbeatIntervalSeconds < 1 ||
      !Number.isInteger(this.missedHeartbeatLimit) ||
      this.missedHeartbeatLimit < 1 ||
      !Number.isInteger(this.handshakeTimeoutMs) ||
      this.handshakeTimeoutMs < 1
    ) {
      throw new RangeError('Invalid Yeelight UDP R2 transport options');
    }
  }

  start(): Promise<void> {
    if (this.phase === 'stopped') {
      return Promise.reject(
        new YeelightUdpR2SessionError('Yeelight UDP transport is stopped')
      );
    }
    if (this.phase === 'ready') {
      return Promise.resolve();
    }
    if (this.startTask) {
      return this.startTask;
    }

    const task = this.startCore();
    this.startTask = task;
    void task.finally(() => {
      if (this.startTask === task) {
        this.startTask = undefined;
      }
    }).catch(() => undefined);
    return task;
  }

  async send(command: YeelightCommand): Promise<void> {
    const socket = this.socket;
    const token = this.token;
    if (this.phase !== 'ready' || !socket || !token) {
      throw new YeelightUdpR2SessionError(
        'Yeelight UDP session is not ready'
      );
    }

    const packet = encodeUdpCommand(this.nextRequestId(), command, token);
    await this.sendPacket(socket, packet);
  }

  stop(): void {
    if (this.phase === 'stopped') {
      return;
    }
    this.phase = 'stopped';
    this.clearHeartbeat();
    this.token = undefined;
    this.missedHeartbeats = 0;
    this.pendingHeartbeatIds.clear();
    this.rejectHandshake(
      new YeelightUdpR2SessionError('Yeelight UDP transport stopped')
    );
    this.bindReject?.(
      new YeelightUdpR2SessionError('Yeelight UDP transport stopped')
    );
    this.bindReject = undefined;

    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      try {
        socket.close();
      } catch {
        // A socket error may already have closed it.
      }
    }
  }

  snapshot(): UdpR2TransportSnapshot {
    return {
      phase: this.phase,
      sessionGeneration: this.sessionGeneration,
      missedHeartbeats: this.missedHeartbeats
    };
  }

  private async startCore(): Promise<void> {
    await this.ensureSocket();
    await this.openSession();
  }

  private ensureSocket(): Promise<void> {
    if (this.socket) {
      return Promise.resolve();
    }

    let socket: UdpR2SocketLike;
    try {
      socket = this.createSocket();
    } catch (error) {
      return Promise.reject(this.normalizeError(error));
    }
    this.socket = socket;

    socket.on('message', (message, info) => {
      this.handleMessage(message, info);
    });
    socket.on('error', (error) => {
      this.handleSocketError(error);
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      this.bindReject = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };
      socket.bind(0, '0.0.0.0', () => {
        if (settled) {
          return;
        }
        settled = true;
        this.bindReject = undefined;
        resolve();
      });
    });
  }

  private openSession(): Promise<void> {
    if (!this.socket || this.phase === 'stopped') {
      return Promise.reject(
        new YeelightUdpR2SessionError(
          'Yeelight UDP socket is unavailable'
        )
      );
    }
    if (this.handshake) {
      return Promise.reject(
        new YeelightUdpR2SessionError(
          'Yeelight UDP session handshake is already running'
        )
      );
    }

    this.clearHeartbeat();
    this.phase = 'starting';
    this.token = undefined;
    this.missedHeartbeats = 0;
    this.pendingHeartbeatIds.clear();
    const requestId = this.nextRequestId();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.handshake?.id !== requestId) {
          return;
        }
        const error = new YeelightUdpR2SessionError(
          'Yeelight UDP session handshake timed out'
        );
        this.handshake = undefined;
        this.phase = 'idle';
        reject(error);
      }, this.handshakeTimeoutMs);

      this.handshake = {
        id: requestId,
        timeout,
        resolve,
        reject
      };

      void this.sendPacket(
        this.socket!,
        encodeUdpSessionNew(requestId)
      ).catch((error: unknown) => {
        if (this.handshake?.id !== requestId) {
          return;
        }
        this.rejectHandshake(this.normalizeError(error));
        this.phase = 'idle';
      });
    });
  }

  private handleMessage(message: Buffer, info: RemoteInfo): void {
    if (
      this.phase === 'stopped' ||
      info.address !== this.host ||
      info.port !== this.port
    ) {
      return;
    }

    let packet;
    try {
      packet = decodeUdpR2Packet(message);
    } catch (error) {
      this.options.onWarning?.(
        'Ignored invalid Yeelight UDP R2 packet',
        this.normalizeError(error)
      );
      return;
    }

    if (packet.kind === 'session-token') {
      const handshake = this.handshake;
      if (!handshake || packet.id !== handshake.id) {
        return;
      }
      clearTimeout(handshake.timeout);
      this.handshake = undefined;
      this.token = packet.token;
      this.phase = 'ready';
      this.sessionGeneration += 1;
      this.missedHeartbeats = 0;
      this.pendingHeartbeatIds.clear();
      handshake.resolve();
      this.options.onSessionReady?.(this.sessionGeneration);
      this.scheduleHeartbeat();
      return;
    }

    if (
      this.phase === 'ready' &&
      packet.token === this.token &&
      packet.result.length === 1 &&
      packet.result[0] === 'ok' &&
      this.pendingHeartbeatIds.delete(packet.id)
    ) {
      this.missedHeartbeats = 0;
    }
  }

  private scheduleHeartbeat(): void {
    this.clearHeartbeat();
    if (this.phase !== 'ready') {
      return;
    }
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      this.runHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private runHeartbeat(): void {
    const socket = this.socket;
    const token = this.token;
    if (this.phase !== 'ready' || !socket || !token) {
      return;
    }

    if (this.missedHeartbeats >= this.missedHeartbeatLimit) {
      void this.recreateSession();
      return;
    }

    const requestId = this.nextRequestId();
    this.pendingHeartbeatIds.add(requestId);
    this.missedHeartbeats += 1;
    const packet = encodeUdpHeartbeat(
      requestId,
      token,
      this.heartbeatIntervalSeconds
    );
    void this.sendPacket(socket, packet)
      .catch((error: unknown) => {
        this.pendingHeartbeatIds.delete(requestId);
        void this.recreateSession(this.normalizeError(error));
      })
      .finally(() => {
        if (this.phase === 'ready') {
          this.scheduleHeartbeat();
        }
      });
  }

  private async recreateSession(cause?: Error): Promise<void> {
    if (this.phase === 'stopped' || this.phase === 'starting') {
      return;
    }
    if (cause) {
      this.options.onWarning?.(
        'Yeelight UDP R2 session transport failed',
        cause
      );
    }
    try {
      await this.openSession();
    } catch (error) {
      const normalized = this.normalizeError(error);
      this.phase = 'idle';
      this.options.onSessionUnavailable?.(normalized);
    }
  }

  private handleSocketError(error: Error): void {
    const normalized = this.normalizeError(error);
    if (this.bindReject) {
      this.bindReject(normalized);
      this.bindReject = undefined;
    }
    this.rejectHandshake(normalized);

    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      try {
        socket.close();
      } catch {
        // The runtime may already have closed the socket.
      }
    }

    if (this.phase !== 'stopped') {
      this.phase = 'idle';
      this.token = undefined;
      this.clearHeartbeat();
      this.pendingHeartbeatIds.clear();
      this.options.onSessionUnavailable?.(normalized);
    }
  }

  private rejectHandshake(error: Error): void {
    const handshake = this.handshake;
    if (!handshake) {
      return;
    }
    this.handshake = undefined;
    clearTimeout(handshake.timeout);
    handshake.reject(error);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private sendPacket(
    socket: UdpR2SocketLike,
    packet: Buffer
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        socket.send(packet, this.port, this.host, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(this.normalizeError(error));
      }
    });
  }

  private nextRequestId(): number {
    this.requestId =
      this.requestId >= MAX_REQUEST_ID ? 1 : this.requestId + 1;
    return this.requestId;
  }

  private normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
