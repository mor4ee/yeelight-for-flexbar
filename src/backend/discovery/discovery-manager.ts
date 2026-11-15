import { createSocket, type RemoteInfo } from 'node:dgram';
import {
  parseDiscoveryPacket,
  YEELIGHT_DISCOVERY_ADDRESS,
  YEELIGHT_DISCOVERY_PORT,
  YEELIGHT_DISCOVERY_REQUEST,
  type YeelightDiscoveryPacket
} from '../protocol';
import {
  isAddressOnTrustedNetwork,
  listActiveIPv4Interfaces,
  type IPv4NetworkInterface
} from './network';

export type DiscoveryPacketSource = 'active' | 'passive' | 'manual';

export interface DiscoveryPacketEvent {
  packet: YeelightDiscoveryPacket;
  source: DiscoveryPacketSource;
  senderAddress: string;
  interfaceName?: string;
}

export interface DiscoveryScanResult {
  cancelled: boolean;
  interfaceCount: number;
  discoveredDeviceIds: string[];
}

export interface DiscoveryManagerStatus {
  scanning: boolean;
  passiveListening: boolean;
  lastScanStartedAt?: number;
  lastScanCompletedAt?: number;
  lastError?: string;
}

interface UdpSocketLike {
  bind(port: number, address: string, callback: () => void): void;
  on(event: 'message', handler: (message: Buffer, info: RemoteInfo) => void): this;
  on(event: 'error', handler: (error: Error) => void): this;
  send(
    message: Buffer,
    port: number,
    address: string,
    callback?: (error: Error | null) => void
  ): void;
  setMulticastInterface(address: string): void;
  setMulticastTTL(ttl: number): void;
  addMembership(multicastAddress: string, multicastInterface?: string): void;
  close(): void;
}

interface ScanToken {
  cancelled: boolean;
  sockets: Set<UdpSocketLike>;
  timers: Set<ReturnType<typeof setTimeout>>;
  finishers: Set<() => void>;
}

export interface DiscoveryManagerOptions {
  onPacket: (event: DiscoveryPacketEvent) => void;
  onWarning?: (message: string, error?: Error) => void;
  listInterfaces?: () => IPv4NetworkInterface[];
  createUdpSocket?: () => UdpSocketLike;
  now?: () => number;
  scanDurationMs?: number;
  scanRounds?: number;
  scanIntervalMs?: number;
}

const DEFAULT_SCAN_DURATION_MS = 1_600;
const DEFAULT_SCAN_ROUNDS = 3;
const DEFAULT_SCAN_INTERVAL_MS = 250;

export class DiscoveryManager {
  private readonly listInterfaces: () => IPv4NetworkInterface[];
  private readonly createUdpSocket: () => UdpSocketLike;
  private readonly now: () => number;
  private readonly scanDurationMs: number;
  private readonly scanRounds: number;
  private readonly scanIntervalMs: number;
  private readonly manualAddresses = new Set<string>();
  private passiveSocket?: UdpSocketLike;
  private activeScan?: {
    token: ScanToken;
    promise: Promise<DiscoveryScanResult>;
  };
  private stopped = false;
  private readonly status: DiscoveryManagerStatus = {
    scanning: false,
    passiveListening: false
  };

  constructor(private readonly options: DiscoveryManagerOptions) {
    this.listInterfaces = options.listInterfaces ?? listActiveIPv4Interfaces;
    this.createUdpSocket =
      options.createUdpSocket ??
      (() => createSocket({ type: 'udp4', reuseAddr: true }) as UdpSocketLike);
    this.now = options.now ?? Date.now;
    this.scanDurationMs =
      options.scanDurationMs ?? DEFAULT_SCAN_DURATION_MS;
    this.scanRounds = options.scanRounds ?? DEFAULT_SCAN_ROUNDS;
    this.scanIntervalMs =
      options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;

    if (
      !Number.isInteger(this.scanDurationMs) ||
      this.scanDurationMs < 1 ||
      !Number.isInteger(this.scanRounds) ||
      this.scanRounds < 1 ||
      !Number.isInteger(this.scanIntervalMs) ||
      this.scanIntervalMs < 0
    ) {
      throw new RangeError('Invalid Yeelight discovery timing options');
    }
  }

  startPassiveListener(): void {
    if (this.stopped || this.passiveSocket) {
      return;
    }

    const interfaces = this.listInterfaces();
    const socket = this.createUdpSocket();
    this.passiveSocket = socket;

    socket.on('message', (message, info) => {
      this.handlePacket(
        message,
        info,
        interfaces,
        this.manualAddresses,
        'passive'
      );
    });
    socket.on('error', (error) => {
      this.status.lastError = error.message;
      this.status.passiveListening = false;
      this.options.onWarning?.(
        'Yeelight passive discovery listener failed',
        error
      );
    });
    socket.bind(YEELIGHT_DISCOVERY_PORT, '0.0.0.0', () => {
      let joined = 0;
      for (const networkInterface of interfaces) {
        try {
          socket.addMembership(
            YEELIGHT_DISCOVERY_ADDRESS,
            networkInterface.address
          );
          joined += 1;
        } catch (error) {
          this.options.onWarning?.(
            `Cannot join Yeelight multicast on ${networkInterface.name}`,
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
      this.status.passiveListening = joined > 0;
    });
  }

  scan(manualAddresses: readonly string[] = []): Promise<DiscoveryScanResult> {
    if (this.stopped) {
      return Promise.reject(new Error('Yeelight discovery manager is stopped'));
    }
    if (this.activeScan) {
      return this.activeScan.promise;
    }

    const interfaces = this.listInterfaces();
    this.setManualAddresses(manualAddresses);
    const manualSet = new Set(manualAddresses);
    const token: ScanToken = {
      cancelled: false,
      sockets: new Set(),
      timers: new Set(),
      finishers: new Set()
    };
    const discoveredDeviceIds = new Set<string>();

    this.status.scanning = true;
    this.status.lastScanStartedAt = this.now();
    this.status.lastError = undefined;

    const scanTargets: Array<IPv4NetworkInterface | undefined> =
      interfaces.length > 0
        ? interfaces
        : manualSet.size > 0
          ? [undefined]
          : [];

    const promise = Promise.all(
      scanTargets.map((networkInterface) =>
        this.scanFromInterface(
          networkInterface,
          interfaces,
          manualSet,
          discoveredDeviceIds,
          token
        )
      )
    )
      .then(() => ({
        cancelled: token.cancelled,
        interfaceCount: interfaces.length,
        discoveredDeviceIds: [...discoveredDeviceIds].sort()
      }))
      .catch((error: unknown) => {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        this.status.lastError = normalizedError.message;
        throw normalizedError;
      })
      .finally(() => {
        for (const timer of token.timers) {
          clearTimeout(timer);
        }
        for (const socket of token.sockets) {
          this.closeSocket(socket);
        }
        this.status.scanning = false;
        this.status.lastScanCompletedAt = this.now();
        this.activeScan = undefined;
      });

    this.activeScan = {
      token,
      promise
    };
    return promise;
  }

  cancelScan(): void {
    const activeScan = this.activeScan;
    if (!activeScan) {
      return;
    }

    activeScan.token.cancelled = true;
    for (const timer of activeScan.token.timers) {
      clearTimeout(timer);
    }
    for (const finish of [...activeScan.token.finishers]) {
      finish();
    }
  }

  setManualAddresses(addresses: readonly string[]): void {
    this.manualAddresses.clear();
    for (const address of addresses) {
      this.manualAddresses.add(address);
    }
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.cancelScan();

    if (this.passiveSocket) {
      this.closeSocket(this.passiveSocket);
      this.passiveSocket = undefined;
    }
    this.status.passiveListening = false;
  }

  getStatus(): DiscoveryManagerStatus {
    return {
      ...this.status
    };
  }

  private scanFromInterface(
    networkInterface: IPv4NetworkInterface | undefined,
    trustedInterfaces: readonly IPv4NetworkInterface[],
    manualAddresses: ReadonlySet<string>,
    discoveredDeviceIds: Set<string>,
    token: ScanToken
  ): Promise<void> {
    return new Promise((resolve) => {
      const socket = this.createUdpSocket();
      token.sockets.add(socket);
      let settled = false;

      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        token.finishers.delete(finish);
        token.sockets.delete(socket);
        this.closeSocket(socket);
        resolve();
      };
      token.finishers.add(finish);

      socket.on('message', (message, info) => {
        const event = this.handlePacket(
          message,
          info,
          trustedInterfaces,
          manualAddresses,
          'active',
          networkInterface?.name
        );
        if (event) {
          discoveredDeviceIds.add(event.packet.deviceId);
        }
      });
      socket.on('error', (error) => {
        this.options.onWarning?.(
          `Yeelight discovery failed on ${networkInterface?.name ?? 'default route'}`,
          error
        );
        finish();
      });
      socket.bind(0, networkInterface?.address ?? '0.0.0.0', () => {
        if (token.cancelled) {
          finish();
          return;
        }

        if (networkInterface) {
          try {
            socket.setMulticastInterface(networkInterface.address);
            socket.setMulticastTTL(1);
          } catch (error) {
            this.options.onWarning?.(
              `Cannot configure Yeelight multicast on ${networkInterface.name}`,
              error instanceof Error ? error : new Error(String(error))
            );
          }
        }

        for (let round = 0; round < this.scanRounds; round += 1) {
          const timer = setTimeout(() => {
            token.timers.delete(timer);
            if (token.cancelled || settled) {
              return;
            }
            this.sendSearchRound(socket, Boolean(networkInterface), manualAddresses);
          }, round * this.scanIntervalMs);
          token.timers.add(timer);
        }

        const completionTimer = setTimeout(() => {
          token.timers.delete(completionTimer);
          finish();
        }, this.scanDurationMs);
        token.timers.add(completionTimer);
      });
    });
  }

  private sendSearchRound(
    socket: UdpSocketLike,
    includeMulticast: boolean,
    manualAddresses: ReadonlySet<string>
  ): void {
    const request = Buffer.from(YEELIGHT_DISCOVERY_REQUEST, 'utf8');
    if (includeMulticast) {
      socket.send(
        request,
        YEELIGHT_DISCOVERY_PORT,
        YEELIGHT_DISCOVERY_ADDRESS,
        (error) => {
          if (error) {
            this.options.onWarning?.(
              'Cannot send Yeelight multicast discovery request',
              error
            );
          }
        }
      );
    }

    for (const address of manualAddresses) {
      socket.send(request, YEELIGHT_DISCOVERY_PORT, address, (error) => {
        if (error) {
          this.options.onWarning?.(
            `Cannot probe manual Yeelight address ${address}`,
            error
          );
        }
      });
    }
  }

  private handlePacket(
    message: Buffer,
    info: RemoteInfo,
    interfaces: readonly IPv4NetworkInterface[],
    manualAddresses: ReadonlySet<string>,
    defaultSource: DiscoveryPacketSource,
    interfaceName?: string
  ): DiscoveryPacketEvent | undefined {
    try {
      const packet = parseDiscoveryPacket(message);
      const senderAddress = info.address;
      const isManual = manualAddresses.has(senderAddress);
      const trusted =
        isManual || isAddressOnTrustedNetwork(senderAddress, interfaces);

      if (!trusted || packet.location.host !== senderAddress) {
        this.options.onWarning?.(
          `Ignored untrusted Yeelight discovery packet from ${senderAddress}`
        );
        return undefined;
      }

      const event: DiscoveryPacketEvent = {
        packet,
        source: isManual ? 'manual' : defaultSource,
        senderAddress,
        interfaceName
      };
      this.options.onPacket(event);
      return event;
    } catch (error) {
      this.options.onWarning?.(
        `Ignored invalid Yeelight discovery packet from ${info.address}`,
        error instanceof Error ? error : new Error(String(error))
      );
      return undefined;
    }
  }

  private closeSocket(socket: UdpSocketLike): void {
    try {
      socket.close();
    } catch {
      // Socket may already be closed by an error event.
    }
  }
}
