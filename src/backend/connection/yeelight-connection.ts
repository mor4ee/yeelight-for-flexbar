import { createConnection } from 'node:net';
import type { PersistedYeelightDevice } from '../catalog/device-catalog';
import {
  assertCommandSupported,
  encodeCommand,
  getProperties,
  YeelightConnectionClosedError,
  YeelightFrameDecoder,
  YeelightRequestCorrelator,
  type YeelightCommand
} from '../protocol';
import { DeviceStateStore } from '../state/device-state-store';
import { SlidingWindowRateLimiter } from './rate-limiter';

export const YEELIGHT_HYDRATE_PROPERTIES = [
  'power',
  'bright',
  'color_mode',
  'ct',
  'rgb',
  'hue',
  'sat',
  'flowing',
  'delayoff',
  'music_on',
  'name',
  'bg_power',
  'bg_bright',
  'bg_lmode',
  'bg_color_mode',
  'bg_ct',
  'bg_rgb',
  'bg_hue',
  'bg_sat',
  'active_mode',
  'nl_br'
] as const;

interface TcpSocketLike {
  on(event: string, handler: (...args: any[]) => void): this;
  write(
    data: Buffer,
    callback?: (error?: Error | null) => void
  ): boolean;
  setNoDelay?(noDelay?: boolean): this;
  setKeepAlive?(enable?: boolean, initialDelay?: number): this;
  setTimeout?(timeout: number): this;
  destroy(error?: Error): this;
}

export interface YeelightConnectionLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface YeelightConnectionOptions {
  stateStore: DeviceStateStore;
  logger: YeelightConnectionLogger;
  createSocket?: (host: string, port: number) => TcpSocketLike;
  random?: () => number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  confirmationTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaximumMs?: number;
  rateLimiter?: SlidingWindowRateLimiter;
  nextGeneration?: () => number;
}

export interface YeelightCommandConfirmation {
  properties: string[];
  expected?: Record<string, string>;
}

export function getCommandConfirmation(
  command: YeelightCommand
): YeelightCommandConfirmation | undefined {
  const background = command.method.startsWith('bg_');
  const prefix = background ? 'bg_' : '';
  const method = background ? command.method.slice(3) : command.method;

  switch (method) {
    case 'set_power':
      return {
        properties: [`${prefix}power`],
        expected: {
          [`${prefix}power`]: String(command.params[0])
        }
      };
    case 'toggle':
      return {
        properties: [`${prefix}power`]
      };
    case 'set_bright':
      return {
        properties: [`${prefix}bright`],
        expected: {
          [`${prefix}bright`]: String(command.params[0])
        }
      };
    case 'set_ct_abx':
      return {
        properties: [`${prefix}ct`],
        expected: {
          [`${prefix}ct`]: String(command.params[0])
        }
      };
    case 'set_rgb':
      return {
        properties: [`${prefix}rgb`],
        expected: {
          [`${prefix}rgb`]: String(command.params[0])
        }
      };
    case 'set_hsv':
      return {
        properties: [`${prefix}hue`, `${prefix}sat`],
        expected: {
          [`${prefix}hue`]: String(command.params[0]),
          [`${prefix}sat`]: String(command.params[1])
        }
      };
    case 'set_scene':
      return {
        properties: [`${prefix}power`],
        expected: {
          [`${prefix}power`]: 'on'
        }
      };
    default:
      return undefined;
  }
}

export class YeelightConnection {
  private host: string;
  private port: number;
  private supportedMethods: Set<string>;
  private socket?: TcpSocketLike;
  private correlator?: YeelightRequestCorrelator;
  private generation = 0;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private immediateReconnect = false;
  private lastSocketError?: string;
  private commandTail: Promise<unknown> = Promise.resolve();
  private readonly createSocket: (host: string, port: number) => TcpSocketLike;
  private readonly random: () => number;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly confirmationTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaximumMs: number;
  private readonly rateLimiter: SlidingWindowRateLimiter;
  private readonly nextGeneration?: () => number;

  constructor(
    private device: PersistedYeelightDevice,
    private readonly options: YeelightConnectionOptions
  ) {
    this.host = device.host;
    this.port = device.port;
    this.supportedMethods = new Set(device.support);
    this.createSocket =
      options.createSocket ??
      ((host, port) => createConnection({ host, port }) as TcpSocketLike);
    this.random = options.random ?? Math.random;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 3_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
    this.confirmationTimeoutMs = options.confirmationTimeoutMs ?? 500;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 500;
    this.reconnectMaximumMs = options.reconnectMaximumMs ?? 30_000;
    this.rateLimiter = options.rateLimiter ?? new SlidingWindowRateLimiter();
    this.nextGeneration = options.nextGeneration;
    options.stateStore.ensureDevice(device.deviceId, device.properties);
  }

  start(): void {
    if (this.stopped || this.socket || this.reconnectTimer) {
      return;
    }
    this.connectNow();
  }

  updateDevice(device: PersistedYeelightDevice): void {
    const endpointChanged =
      device.host !== this.host || device.port !== this.port;
    this.device = device;
    this.host = device.host;
    this.port = device.port;
    this.supportedMethods = new Set(device.support);
    this.options.stateStore.ensureDevice(device.deviceId, device.properties);

    if (!endpointChanged || this.stopped) {
      return;
    }

    this.reconnectAttempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.connectNow();
    } else if (this.socket) {
      this.immediateReconnect = true;
      this.socket.destroy(
        new YeelightConnectionClosedError('Yeelight endpoint changed')
      );
    } else {
      this.connectNow();
    }
  }

  reconnectNow(): void {
    if (this.stopped) {
      return;
    }
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket) {
      this.immediateReconnect = true;
      this.socket.destroy(
        new YeelightConnectionClosedError('Manual reconnect requested')
      );
    } else {
      this.connectNow();
    }
  }

  send(command: YeelightCommand): Promise<unknown[]> {
    const task = this.commandTail.then(async () => {
      const state = this.options.stateStore.get(this.device.deviceId);
      if (
        !state ||
        state.phase !== 'connected' ||
        state.stale ||
        !this.socket ||
        !this.correlator
      ) {
        throw new YeelightConnectionClosedError(
          'Yeelight state is not confirmed'
        );
      }
      assertCommandSupported(command, this.supportedMethods);
      const baseline = this.options.stateStore.get(this.device.deviceId)!;
      const confirmation = getCommandConfirmation(command);
      const pendingCommandId = confirmation
        ? this.options.stateStore.beginCommand(
            this.device.deviceId,
            state.generation,
            confirmation.properties,
            confirmation.expected
          )
        : undefined;
      let accepted = false;
      try {
        const result = await this.performCommand(
          command,
          state.generation,
          this.socket,
          this.correlator
        );
        accepted = true;
        await this.confirmCommand(
          command,
          baseline.properties,
          pendingCommandId,
          state.generation,
          this.socket,
          this.correlator
        );
        if (pendingCommandId !== undefined) {
          this.options.stateStore.resolveCommand(
            this.device.deviceId,
            state.generation,
            pendingCommandId
          );
        }
        return result;
      } catch (error) {
        if (pendingCommandId !== undefined) {
          this.options.stateStore.failCommand(
            this.device.deviceId,
            state.generation,
            pendingCommandId,
            error instanceof Error ? error.message : String(error),
            accepted
          );
        }
        throw error;
      }
    });
    this.commandTail = task.catch(() => {});
    return task;
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.rateLimiter.close();
    this.correlator?.close();
    this.socket?.destroy();
    this.socket = undefined;
    this.options.stateStore.markDisconnected(
      this.device.deviceId,
      this.generation
    );
  }

  get currentGeneration(): number {
    return this.generation;
  }

  private connectNow(): void {
    if (this.stopped || this.socket) {
      return;
    }

    const generation = this.nextGeneration?.() ?? this.generation + 1;
    this.generation = generation;
    this.options.stateStore.beginConnection(
      this.device.deviceId,
      generation,
      'tcp-session'
    );
    const decoder = new YeelightFrameDecoder();
    const correlator = new YeelightRequestCorrelator();
    this.correlator = correlator;
    this.lastSocketError = undefined;

    let socket: TcpSocketLike;
    try {
      socket = this.createSocket(this.host, this.port);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      correlator.close(new YeelightConnectionClosedError(message));
      this.options.stateStore.markDisconnected(
        this.device.deviceId,
        generation,
        message
      );
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.setNoDelay?.(true);
    socket.setKeepAlive?.(true, 15_000);
    socket.setTimeout?.(this.connectTimeoutMs);

    socket.on('connect', () => {
      if (!this.isCurrent(generation, socket)) {
        return;
      }
      socket.setTimeout?.(0);
      this.options.stateStore.markHydrating(
        this.device.deviceId,
        generation
      );
      void this.hydrate(generation, socket, correlator);
    });
    socket.on('data', (chunk: Buffer | Uint8Array | string) => {
      if (!this.isCurrent(generation, socket)) {
        return;
      }
      for (const result of decoder.feed(chunk)) {
        if (result.kind === 'error') {
          this.options.logger.warn('Invalid Yeelight TCP frame ignored', {
            deviceId: this.device.deviceId,
            error: result.error.message
          });
          continue;
        }

        const message = result.message;
        if (message.kind === 'result' || message.kind === 'error') {
          correlator.handle(message);
        } else if (message.kind === 'props') {
          this.options.stateStore.applyProps(
            this.device.deviceId,
            generation,
            message.params
          );
        }
      }
    });
    socket.on('timeout', () => {
      if (this.isCurrent(generation, socket)) {
        socket.destroy(new Error('Yeelight TCP connection timed out'));
      }
    });
    socket.on('error', (error: Error) => {
      if (this.isCurrent(generation, socket)) {
        this.lastSocketError = error.message;
      }
    });
    socket.on('close', () => {
      this.handleClose(generation, socket, correlator);
    });
  }

  private async hydrate(
    generation: number,
    socket: TcpSocketLike,
    correlator: YeelightRequestCorrelator
  ): Promise<void> {
    if (!this.supportedMethods.has('get_prop')) {
      this.options.stateStore.markHydrateUnavailable(
        this.device.deviceId,
        generation,
        'Device does not advertise get_prop'
      );
      return;
    }

    try {
      const result = await this.performCommand(
        getProperties(YEELIGHT_HYDRATE_PROPERTIES),
        generation,
        socket,
        correlator
      );
      if (!this.isCurrent(generation, socket)) {
        return;
      }

      const properties: Record<string, string> = {};
      for (
        let index = 0;
        index < YEELIGHT_HYDRATE_PROPERTIES.length;
        index += 1
      ) {
        const value = result[index];
        if (typeof value === 'string' && value.length > 0) {
          properties[YEELIGHT_HYDRATE_PROPERTIES[index]] = value;
        }
      }
      this.options.stateStore.completeHydrate(
        this.device.deviceId,
        generation,
        properties
      );
      this.reconnectAttempt = 0;
    } catch (error) {
      if (!this.isCurrent(generation, socket)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.warn('Yeelight state hydrate failed', {
        deviceId: this.device.deviceId,
        generation,
        error: message
      });
      socket.destroy(new Error(message));
    }
  }

  private async performCommand(
    command: YeelightCommand,
    generation: number,
    socket: TcpSocketLike,
    correlator: YeelightRequestCorrelator
  ): Promise<unknown[]> {
    await this.rateLimiter.acquire();
    if (!this.isCurrent(generation, socket)) {
      throw new YeelightConnectionClosedError();
    }

    const request = correlator.create(command.method, this.requestTimeoutMs);
    socket.write(encodeCommand(request.id, command), (error) => {
      if (error && this.isCurrent(generation, socket)) {
        socket.destroy(error);
      }
    });
    const result = await request.response;
    if (!this.isCurrent(generation, socket)) {
      throw new YeelightConnectionClosedError();
    }
    return result;
  }

  private async confirmCommand(
    command: YeelightCommand,
    baseline: Readonly<Record<string, string>>,
    pendingCommandId: number | undefined,
    generation: number,
    socket: TcpSocketLike,
    correlator: YeelightRequestCorrelator
  ): Promise<void> {
    const confirmation = getCommandConfirmation(command);
    if (!confirmation || !this.isCurrent(generation, socket)) {
      return;
    }

    const confirmed = await this.waitForConfirmation(
      generation,
      baseline,
      confirmation.properties,
      confirmation.expected,
      pendingCommandId
    );
    if (confirmed) {
      return;
    }

    const queryRevision =
      this.options.stateStore.get(this.device.deviceId)?.revision ?? 0;
    const result = await this.performCommand(
      getProperties(confirmation.properties),
      generation,
      socket,
      correlator
    );
    const patch: Record<string, string> = {};
    for (let index = 0; index < confirmation.properties.length; index += 1) {
      const value = result[index];
      if (typeof value === 'string') {
        patch[confirmation.properties[index]] = value;
      }
    }
    this.options.stateStore.applyProps(
      this.device.deviceId,
      generation,
      patch,
      queryRevision
    );
    const current =
      this.options.stateStore.get(this.device.deviceId)?.properties ?? {};
    const queryConfirmed = confirmation.expected
      ? Object.entries(confirmation.expected).every(
          ([name, value]) => current[name] === value
        )
      : confirmation.properties.some(
          (name) => current[name] !== baseline[name]
        );
    if (!queryConfirmed) {
      throw new Error(
        'Yeelight TCP command was not confirmed by the device'
      );
    }
  }

  private waitForConfirmation(
    generation: number,
    baseline: Readonly<Record<string, string>>,
    properties: readonly string[],
    expected?: Readonly<Record<string, string>>,
    pendingCommandId?: number
  ): Promise<boolean> {
    const isConfirmed = (): boolean => {
      const state = this.options.stateStore.get(this.device.deviceId);
      if (
        !state ||
        state.generation !== generation ||
        state.phase === 'disconnected'
      ) {
        return false;
      }
      if (pendingCommandId !== undefined) {
        return !this.options.stateStore.hasPendingCommand(
          this.device.deviceId,
          generation,
          pendingCommandId
        );
      }
      if (expected) {
        return Object.entries(expected).every(
          ([name, value]) => state.properties[name] === value
        );
      }
      return properties.some(
        (name) => state.properties[name] !== baseline[name]
      );
    };

    if (isConfirmed()) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe = (): void => {};
      const finish = (confirmed: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(confirmed);
      };
      const timer = setTimeout(
        () => finish(false),
        this.confirmationTimeoutMs
      );
      unsubscribe = this.options.stateStore.subscribe(() => {
        if (isConfirmed()) {
          finish(true);
        }
      });
      if (isConfirmed()) {
        finish(true);
      }
    });
  }

  private handleClose(
    generation: number,
    socket: TcpSocketLike,
    correlator: YeelightRequestCorrelator
  ): void {
    if (!this.isCurrent(generation, socket)) {
      return;
    }

    this.socket = undefined;
    this.correlator = undefined;
    correlator.close(
      new YeelightConnectionClosedError(
        this.lastSocketError ?? 'Yeelight TCP connection closed'
      )
    );
    this.options.stateStore.markDisconnected(
      this.device.deviceId,
      generation,
      this.lastSocketError
    );

    if (!this.stopped) {
      const immediate = this.immediateReconnect;
      this.immediateReconnect = false;
      this.scheduleReconnect(immediate);
    }
  }

  private scheduleReconnect(immediate = false): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    const delay = immediate
      ? 0
      : calculateReconnectDelay(
          this.reconnectAttempt,
          this.reconnectBaseMs,
          this.reconnectMaximumMs,
          this.random()
        );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectNow();
    }, delay);
  }

  private isCurrent(
    generation: number,
    socket: TcpSocketLike
  ): boolean {
    return (
      !this.stopped &&
      this.generation === generation &&
      this.socket === socket
    );
  }
}

export function calculateReconnectDelay(
  attempt: number,
  baseMs: number,
  maximumMs: number,
  randomValue: number
): number {
  if (
    !Number.isInteger(attempt) ||
    attempt < 0 ||
    !Number.isInteger(baseMs) ||
    baseMs < 1 ||
    !Number.isInteger(maximumMs) ||
    maximumMs < baseMs ||
    !Number.isFinite(randomValue) ||
    randomValue < 0 ||
    randomValue > 1
  ) {
    throw new RangeError('Invalid Yeelight reconnect delay options');
  }

  const jitter = 0.8 + randomValue * 0.4;
  return Math.min(
    maximumMs,
    Math.round(baseMs * 2 ** attempt * jitter)
  );
}
