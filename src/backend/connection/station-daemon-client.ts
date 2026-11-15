import {
  isIP,
  type Socket,
  createConnection
} from 'node:net';
import type { PersistedYeelightDevice } from '../catalog/device-catalog';
import type { YeelightCommand } from '../protocol';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 33_333;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const DEVICE_ID_PATTERN = /^0x[0-9a-f]{1,16}$/i;
const PROPERTY_NAME_PATTERN = /^[a-z][a-z0-9_]*$/i;
const ALLOWED_METHODS = new Set([
  'set_power',
  'toggle',
  'set_bright',
  'set_ct_abx',
  'set_hsv',
  'set_rgb',
  'set_scene',
  'bg_set_power',
  'bg_toggle',
  'bg_set_bright',
  'bg_set_ct_abx',
  'bg_set_hsv',
  'bg_set_rgb',
  'bg_set_scene'
]);
const METADATA_FIELDS = new Set([
  'connected',
  'device_type',
  'did',
  'id',
  'ip',
  'light_type',
  'model',
  'registered',
  'support'
]);

type JsonRecord = Record<string, unknown>;

export interface StationDaemonDevice {
  deviceId: string;
  host: string;
  model?: string;
  connected: boolean;
  support: string[];
  properties: Record<string, string>;
}

export type StationDaemonEvent =
  | {
      kind: 'topology';
      devices: readonly StationDaemonDevice[];
    }
  | {
      kind: 'disconnected';
      error?: Error;
    };

export type StationDaemonListener = (
  event: StationDaemonEvent
) => void;

export interface StationDaemonBridge {
  start(): Promise<boolean>;
  refresh(): Promise<readonly StationDaemonDevice[]>;
  findDevice(
    device: PersistedYeelightDevice
  ): StationDaemonDevice | undefined;
  send(
    device: PersistedYeelightDevice,
    command: YeelightCommand
  ): Promise<StationDaemonDevice>;
  subscribe(listener: StationDaemonListener): () => void;
  stop(): void;
}

export interface StationDaemonClientOptions {
  host?: '127.0.0.1';
  port?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  createSocket?: (
    options: Readonly<{ host: string; port: number }>
  ) => Socket;
}

interface PendingRequest {
  resolve(message: JsonRecord): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function parseSupport(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  return [...new Set(value.trim().split(/\s+/).filter(Boolean))].sort();
}

function hsvToRgb(hue: number, saturation: number): number {
  const chroma = saturation / 100;
  const sector = hue / 60;
  const intermediate = chroma * (1 - Math.abs((sector % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;
  if (sector < 1) {
    red = chroma;
    green = intermediate;
  } else if (sector < 2) {
    red = intermediate;
    green = chroma;
  } else if (sector < 3) {
    green = chroma;
    blue = intermediate;
  } else if (sector < 4) {
    green = intermediate;
    blue = chroma;
  } else if (sector < 5) {
    red = intermediate;
    blue = chroma;
  } else {
    red = chroma;
    blue = intermediate;
  }
  const match = 1 - chroma;
  return (
    (Math.round((red + match) * 255) << 16) |
    (Math.round((green + match) * 255) << 8) |
    Math.round((blue + match) * 255)
  );
}

function projectRgbAsHsv(
  properties: Record<string, string>,
  prefix: '' | 'bg_'
): void {
  if (properties[`${prefix}color_mode`] !== '1') {
    return;
  }
  const rgb = Number(properties[`${prefix}rgb`]);
  if (!Number.isInteger(rgb) || rgb < 0 || rgb > 0xff_ff_ff) {
    return;
  }
  const red = ((rgb >> 16) & 0xff) / 255;
  const green = ((rgb >> 8) & 0xff) / 255;
  const blue = (rgb & 0xff) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0 && maximum === red) {
    hue = 60 * (((green - blue) / delta) % 6);
  } else if (delta > 0 && maximum === green) {
    hue = 60 * ((blue - red) / delta + 2);
  } else if (delta > 0) {
    hue = 60 * ((red - green) / delta + 4);
  }
  properties[`${prefix}hue`] = String(
    Math.round((hue + 360) % 360) % 360
  );
  properties[`${prefix}sat`] = String(
    maximum === 0 ? 0 : Math.round((delta / maximum) * 100)
  );
}

function parseTopologyNode(value: unknown): StationDaemonDevice {
  if (!isRecord(value)) {
    throw new Error('Invalid Yeelight Station topology node');
  }
  const { did, ip, model, connected, support } = value;
  if (
    typeof did !== 'string' ||
    !DEVICE_ID_PATTERN.test(did) ||
    typeof ip !== 'string' ||
    isIP(ip) !== 4 ||
    typeof connected !== 'boolean' ||
    (model !== undefined && typeof model !== 'string')
  ) {
    throw new Error('Invalid Yeelight Station topology identity');
  }

  const properties: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (
      METADATA_FIELDS.has(name) ||
      !PROPERTY_NAME_PATTERN.test(name) ||
      !['string', 'number', 'boolean'].includes(typeof entry)
    ) {
      continue;
    }
    properties[name] = String(entry);
  }
  projectRgbAsHsv(properties, '');
  projectRgbAsHsv(properties, 'bg_');

  return {
    deviceId: did.toLowerCase(),
    host: ip,
    model,
    connected,
    support: parseSupport(support),
    properties
  };
}

function parseTopology(message: JsonRecord): StationDaemonDevice[] {
  const result = isRecord(message.result) ? message.result : undefined;
  const rawNodes = message.nodes ?? result?.nodes;
  if (!Array.isArray(rawNodes)) {
    throw new Error('Invalid Yeelight Station topology response');
  }
  const devices = rawNodes.map(parseTopologyNode);
  if (
    new Set(devices.map(({ deviceId }) => deviceId)).size !==
    devices.length
  ) {
    throw new Error('Duplicate Yeelight Station topology device');
  }
  return devices;
}

export class StationDaemonClient implements StationDaemonBridge {
  private readonly host: '127.0.0.1';
  private readonly port: number;
  private readonly requestTimeoutMs: number;
  private readonly createSocket: NonNullable<
    StationDaemonClientOptions['createSocket']
  >;
  private readonly pollIntervalMs: number;
  private readonly listeners = new Set<StationDaemonListener>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly devices = new Map<string, StationDaemonDevice>();
  private socket?: Socket;
  private startPromise?: Promise<boolean>;
  private refreshPromise?: Promise<readonly StationDaemonDevice[]>;
  private buffer = '';
  private nextRequestId = 0;
  private stopped = false;
  private compatible = false;
  private topologySignature = '';
  private pollTimer?: ReturnType<typeof setTimeout>;
  private pollInProgress = false;

  constructor(options: StationDaemonClientOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.createSocket =
      options.createSocket ??
      ((endpoint) => createConnection(endpoint));
    if (
      this.host !== DEFAULT_HOST ||
      !Number.isInteger(this.port) ||
      this.port < 1 ||
      this.port > 65_535 ||
      !Number.isInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1 ||
      !Number.isInteger(this.pollIntervalMs) ||
      this.pollIntervalMs < 0
    ) {
      throw new RangeError('Invalid Yeelight Station daemon endpoint');
    }
  }

  start(): Promise<boolean> {
    if (this.stopped) {
      return Promise.resolve(false);
    }
    if (this.socket && this.compatible && !this.socket.destroyed) {
      return Promise.resolve(true);
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.connectAndValidate()
      .catch((error: unknown) => {
        this.closeSocket(normalizeError(error), false);
        return false;
      })
      .finally(() => {
        this.startPromise = undefined;
      });
    return this.startPromise;
  }

  refresh(): Promise<readonly StationDaemonDevice[]> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    const task = this.refreshTopology();
    this.refreshPromise = task;
    return task.finally(() => {
      if (this.refreshPromise === task) {
        this.refreshPromise = undefined;
      }
    });
  }

  findDevice(
    device: PersistedYeelightDevice
  ): StationDaemonDevice | undefined {
    const stationDevice = this.devices.get(device.deviceId.toLowerCase());
    if (
      !stationDevice ||
      !stationDevice.connected ||
      stationDevice.host !== device.host ||
      (device.model !== undefined &&
        stationDevice.model !== undefined &&
        stationDevice.model !== device.model)
    ) {
      return undefined;
    }
    return structuredClone(stationDevice);
  }

  async send(
    device: PersistedYeelightDevice,
    command: YeelightCommand
  ): Promise<StationDaemonDevice> {
    if (!ALLOWED_METHODS.has(command.method)) {
      throw new Error(
        `Unsupported Yeelight Station command: ${command.method}`
      );
    }
    if (!(await this.start())) {
      throw new Error('Yeelight Station daemon is unavailable');
    }
    const stationDevice = this.findDevice(device);
    if (!stationDevice) {
      throw new Error('Device is not owned by Yeelight Station daemon');
    }

    const wireCommand = this.toStationCommand(command);
    const response = await this.request(wireCommand.method, {
      nodes: [
        {
          did: stationDevice.deviceId,
          params: [...wireCommand.params]
        }
      ]
    });
    if (response.result !== 'ok') {
      throw new Error('Yeelight Station rejected the command');
    }
    await this.refresh();
    const confirmed = this.findDevice(device);
    if (!confirmed) {
      throw new Error(
        'Device disappeared from Yeelight Station topology'
      );
    }
    return confirmed;
  }

  subscribe(listener: StationDaemonListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.closeSocket(
      new Error('Yeelight Station daemon client is stopped'),
      false
    );
    this.listeners.clear();
  }

  private async connectAndValidate(): Promise<boolean> {
    this.closeSocket(undefined, false);
    this.stopped = false;
    const socket = this.createSocket({
      host: this.host,
      port: this.port
    });
    this.socket = socket;
    this.buffer = '';
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.onData(socket, chunk));
    socket.on('error', (error) => {
      if (this.socket === socket) {
        this.closeSocket(error, true);
      }
    });
    socket.on('close', () => {
      if (this.socket === socket) {
        this.closeSocket(
          new Error('Yeelight Station daemon connection closed'),
          true
        );
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => {
        socket.off('error', onInitialError);
        resolve();
      };
      const onInitialError = (error: Error): void => {
        socket.off('connect', onConnect);
        reject(error);
      };
      socket.once('connect', onConnect);
      socket.once('error', onInitialError);
    });
    if (this.socket !== socket) {
      return false;
    }
    const response = await this.request('get.topology', { params: [] });
    this.compatible = true;
    this.acceptTopology(response);
    this.schedulePoll();
    return true;
  }

  private request(
    method: string,
    extra: JsonRecord
  ): Promise<JsonRecord> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(
        new Error('Yeelight Station daemon is not connected')
      );
    }
    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`Yeelight Station request timed out: ${method}`)
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ id, method, ...extra })}\r\n`);
    });
  }

  private toStationCommand(command: YeelightCommand): YeelightCommand {
    if (
      command.method !== 'set_hsv' &&
      command.method !== 'bg_set_hsv'
    ) {
      return command;
    }
    const hue = Number(command.params[0]);
    const saturation = Number(command.params[1]);
    return {
      method:
        command.method === 'bg_set_hsv' ? 'bg_set_rgb' : 'set_rgb',
      params: [
        hsvToRgb(hue, saturation),
        ...command.params.slice(2)
      ]
    };
  }

  private onData(socket: Socket, chunk: Buffer): void {
    if (socket !== this.socket) {
      return;
    }
    this.buffer += chunk.toString('utf8');
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES) {
      this.closeSocket(
        new Error('Yeelight Station frame exceeds size limit'),
        true
      );
      return;
    }

    for (;;) {
      const boundary = this.buffer.indexOf('\r\n');
      if (boundary < 0) {
        return;
      }
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      if (!frame) {
        continue;
      }
      let message: unknown;
      try {
        message = JSON.parse(frame);
      } catch {
        this.closeSocket(
          new Error('Invalid JSON from Yeelight Station daemon'),
          true
        );
        return;
      }
      if (!isRecord(message)) {
        this.closeSocket(
          new Error('Invalid message from Yeelight Station daemon'),
          true
        );
        return;
      }

      const id = message.id;
      if (typeof id === 'number' && Number.isInteger(id)) {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.resolve(message);
          continue;
        }
      }
      if (message.method === 'set.toplogy') {
        try {
          this.acceptTopology(message);
        } catch (error) {
          this.closeSocket(normalizeError(error), true);
          return;
        }
      }
    }
  }

  private acceptTopology(
    message: JsonRecord
  ): readonly StationDaemonDevice[] {
    const devices = parseTopology(message);
    devices.sort((left, right) =>
      left.deviceId.localeCompare(right.deviceId)
    );
    this.devices.clear();
    for (const device of devices) {
      this.devices.set(device.deviceId, device);
    }
    const snapshot = devices.map((device) => structuredClone(device));
    const signature = JSON.stringify(snapshot);
    if (signature !== this.topologySignature) {
      this.topologySignature = signature;
      this.emit({ kind: 'topology', devices: snapshot });
    }
    return snapshot;
  }

  private schedulePoll(): void {
    if (
      this.pollIntervalMs === 0 ||
      this.stopped ||
      !this.compatible ||
      this.pollTimer ||
      this.pollInProgress
    ) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      if (this.stopped || !this.compatible) {
        return;
      }
      this.pollInProgress = true;
      void this.refresh()
        .catch((error: unknown) => {
          this.closeSocket(normalizeError(error), true);
        })
        .finally(() => {
          this.pollInProgress = false;
          this.schedulePoll();
        });
    }, this.pollIntervalMs);
  }

  private closeSocket(error?: Error, emit = true): void {
    const socket = this.socket;
    this.socket = undefined;
    this.compatible = false;
    this.topologySignature = '';
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.buffer = '';
    this.devices.clear();
    socket?.removeAllListeners();
    socket?.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        error ?? new Error('Yeelight Station daemon disconnected')
      );
    }
    this.pending.clear();
    if (emit && socket) {
      this.emit({ kind: 'disconnected', error });
    }
  }

  private async refreshTopology(): Promise<
    readonly StationDaemonDevice[]
  > {
    if (!(await this.start())) {
      throw new Error('Yeelight Station daemon is unavailable');
    }
    const response = await this.request('get.topology', { params: [] });
    return this.acceptTopology(response);
  }

  private emit(event: StationDaemonEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
