import type { PersistedYeelightDevice } from '../catalog/device-catalog';
import {
  assertCommandSupported,
  YeelightConnectionClosedError,
  type YeelightCommand
} from '../protocol';
import { DeviceStateStore } from '../state/device-state-store';
import {
  getCommandConfirmation,
  YEELIGHT_HYDRATE_PROPERTIES,
  YeelightConnection,
  type YeelightConnectionLogger,
  type YeelightConnectionOptions
} from './yeelight-connection';
import { YeelightTcpQueryTransport } from './tcp-query-transport';
import type {
  TcpQueryTransport,
  TcpSessionTransport,
  UdpR2CommandTransport,
  YeelightControlTransportKind
} from './transport-types';
import {
  UdpR2Transport,
  type UdpR2TransportOptions
} from './udp-r2-transport';
import type {
  StationDaemonBridge,
  StationDaemonEvent
} from './station-daemon-client';

const UDP_SESSION_METHODS = [
  'udp_sess_new',
  'udp_sess_keep_alive'
] as const;

export interface TransportCoordinatorSnapshot {
  kind?: YeelightControlTransportKind;
  generation: number;
  fallbackReason?: string;
}

export interface UdpTransportHooks {
  onSessionUnavailable(error: Error): void;
  onSessionReady(sessionGeneration: number): void;
}

export interface TransportCoordinatorOptions {
  stateStore: DeviceStateStore;
  logger: YeelightConnectionLogger;
  nextGeneration: () => number;
  tcpSessionOptions?: Omit<
    YeelightConnectionOptions,
    'stateStore' | 'logger' | 'nextGeneration'
  >;
  udpTransportOptions?: Omit<
    UdpR2TransportOptions,
    | 'host'
    | 'onWarning'
    | 'onSessionUnavailable'
    | 'onSessionReady'
  >;
  createUdpTransport?: (
    device: PersistedYeelightDevice,
    hooks: UdpTransportHooks
  ) => UdpR2CommandTransport;
  createTcpQueryTransport?: (
    device: PersistedYeelightDevice
  ) => TcpQueryTransport;
  createTcpSessionTransport?: (
    device: PersistedYeelightDevice,
    nextGeneration: () => number
  ) => TcpSessionTransport;
  stationClient?: StationDaemonBridge;
}

export class TransportCoordinator {
  private udp?: UdpR2CommandTransport;
  private tcpQuery?: TcpQueryTransport;
  private tcpSession?: TcpSessionTransport;
  private kind?: YeelightControlTransportKind;
  private generation = 0;
  private fallbackReason?: string;
  private transitionId = 0;
  private stopped = false;
  private stationProbeInProgress = false;
  private readonly unsubscribeStation?: () => void;

  constructor(
    private device: PersistedYeelightDevice,
    private readonly options: TransportCoordinatorOptions
  ) {
    this.unsubscribeStation = options.stationClient?.subscribe((event) => {
      this.onStationEvent(event);
    });
  }

  start(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(
        new YeelightConnectionClosedError(
          'Yeelight transport coordinator is stopped'
        )
      );
    }
    if (this.kind || this.udp || this.tcpSession) {
      return Promise.resolve();
    }
    return this.activate(++this.transitionId);
  }

  updateDevice(device: PersistedYeelightDevice): Promise<void> {
    if (device.deviceId !== this.device.deviceId) {
      return Promise.reject(
        new Error('Cannot change TransportCoordinator device identity')
      );
    }
    if (this.stopped) {
      return Promise.resolve();
    }

    const restart =
      device.host !== this.device.host ||
      device.port !== this.device.port ||
      this.transportSignature(device) !==
        this.transportSignature(this.device);
    this.device = device;
    if (!restart) {
      this.tcpSession?.updateDevice(device);
      if (this.kind === 'station-daemon') {
        this.applyStationDevice();
        return Promise.resolve();
      }
      return this.promoteToStationIfAvailable();
    }

    const transitionId = ++this.transitionId;
    this.disposeTransports();
    return this.activate(transitionId);
  }

  reconnect(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    const transitionId = ++this.transitionId;
    this.disposeTransports();
    return this.activate(transitionId);
  }

  async send(command: YeelightCommand): Promise<unknown[]> {
    assertCommandSupported(command, new Set(this.device.support));
    if (this.stopped) {
      throw new YeelightConnectionClosedError(
        'Yeelight transport coordinator is stopped'
      );
    }

    if (this.kind === 'tcp-session' && this.tcpSession) {
      return this.tcpSession.send(command);
    }
    if (this.kind === 'station-daemon') {
      return this.sendThroughStation(command);
    }
    if (this.kind !== 'udp-r2' || !this.udp) {
      throw new YeelightConnectionClosedError(
        'Yeelight control transport is not ready'
      );
    }

    const udp = this.udp;
    const generation = this.generation;
    const confirmation = getCommandConfirmation(command);
    const baselineState = this.options.stateStore.get(
      this.device.deviceId
    );
    const baseline = baselineState?.properties ?? {};
    const pendingCommandId = confirmation
      ? this.options.stateStore.beginCommand(
          this.device.deviceId,
          generation,
          confirmation.properties,
          confirmation.expected
        )
      : undefined;
    try {
      await udp.send(command);
    } catch (error) {
      const normalized = this.normalizeError(error);
      if (pendingCommandId !== undefined) {
        this.options.stateStore.failCommand(
          this.device.deviceId,
          generation,
          pendingCommandId,
          normalized.message,
          true
        );
      }
      void this.fallbackFromUdp(generation, normalized);
      throw normalized;
    }

    if (
      pendingCommandId !== undefined &&
      !this.options.stateStore.hasPendingCommand(
        this.device.deviceId,
        generation,
        pendingCommandId
      )
    ) {
      return ['ok'];
    }

    if (
      !confirmation ||
      !this.device.support.includes('get_prop') ||
      !this.tcpQuery
    ) {
      const error = new Error(
        'Yeelight UDP command has no authoritative confirmation channel'
      );
      if (pendingCommandId !== undefined) {
        this.options.stateStore.failCommand(
          this.device.deviceId,
          generation,
          pendingCommandId,
          error.message,
          true
        );
      }
      throw error;
    }

    const queryRevision =
      this.options.stateStore.get(this.device.deviceId)?.revision ??
      baselineState?.revision ??
      0;
    let patch: Record<string, string>;
    try {
      patch = await this.tcpQuery.query(confirmation.properties);
    } catch (error) {
      const normalized = this.normalizeError(error);
      if (pendingCommandId !== undefined) {
        this.options.stateStore.failCommand(
          this.device.deviceId,
          generation,
          pendingCommandId,
          normalized.message,
          true
        );
      }
      throw normalized;
    }
    if (!this.isCurrentUdp(generation, udp)) {
      throw new YeelightConnectionClosedError(
        'Yeelight transport changed during command confirmation'
      );
    }
    this.options.stateStore.applyProps(
      this.device.deviceId,
      generation,
      patch,
      queryRevision
    );
    const confirmedProperties =
      this.options.stateStore.get(this.device.deviceId)?.properties ?? {};
    const confirmed = confirmation.expected
      ? Object.entries(confirmation.expected).every(
          ([name, value]) => confirmedProperties[name] === value
        )
      : confirmation.properties.some(
          (name) => confirmedProperties[name] !== baseline[name]
        );
    if (!confirmed) {
      const error = new Error(
        'Yeelight UDP command was not confirmed by the device'
      );
      if (pendingCommandId !== undefined) {
        this.options.stateStore.failCommand(
          this.device.deviceId,
          generation,
          pendingCommandId,
          error.message,
          true
        );
      }
      throw error;
    }
    if (pendingCommandId !== undefined) {
      this.options.stateStore.resolveCommand(
        this.device.deviceId,
        generation,
        pendingCommandId
      );
    }
    return ['ok'];
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.transitionId += 1;
    this.disposeTransports();
    this.unsubscribeStation?.();
    const state = this.options.stateStore.get(this.device.deviceId);
    if (state) {
      this.options.stateStore.markDisconnected(
        this.device.deviceId,
        state.generation
      );
    }
  }

  snapshot(): TransportCoordinatorSnapshot {
    return {
      kind: this.kind,
      generation: this.generation,
      fallbackReason: this.fallbackReason
    };
  }

  private async activate(transitionId: number): Promise<void> {
    if (
      this.options.stationClient &&
      (await this.activateStation(transitionId))
    ) {
      return;
    }
    if (!this.isCurrentTransitionId(transitionId)) {
      return;
    }
    if (this.supportsUdpR2(this.device)) {
      await this.activateUdp(transitionId);
    } else {
      this.activateTcp(transitionId);
    }
  }

  private async activateStation(
    transitionId: number
  ): Promise<boolean> {
    const station = this.options.stationClient;
    if (!station) {
      return false;
    }
    this.stationProbeInProgress = true;
    try {
      if (!(await station.start())) {
        return false;
      }
    } catch (error) {
      this.options.logger.debug('Yeelight Station IPC unavailable', {
        deviceId: this.device.deviceId,
        error: this.normalizeError(error).message
      });
      return false;
    } finally {
      this.stationProbeInProgress = false;
    }
    if (!this.isCurrentTransitionId(transitionId)) {
      return true;
    }
    const stationDevice = station.findDevice(this.device);
    if (!stationDevice) {
      return false;
    }

    this.disposeTransports();
    const generation = this.options.nextGeneration();
    this.generation = generation;
    this.options.stateStore.beginConnection(
      this.device.deviceId,
      generation,
      'station-daemon'
    );
    this.options.stateStore.markHydrating(
      this.device.deviceId,
      generation
    );
    this.options.stateStore.completeHydrate(
      this.device.deviceId,
      generation,
      stationDevice.properties
    );
    this.kind = 'station-daemon';
    this.fallbackReason = undefined;
    return true;
  }

  private async activateUdp(transitionId: number): Promise<void> {
    const generation = this.options.nextGeneration();
    this.generation = generation;
    this.options.stateStore.beginConnection(
      this.device.deviceId,
      generation,
      'udp-r2'
    );
    this.options.stateStore.markHydrating(
      this.device.deviceId,
      generation
    );

    const tcpQuery = this.createTcpQueryTransport(this.device);
    let activeUdp: UdpR2CommandTransport | undefined;
    const udp = this.createUdpTransport(this.device, {
      onSessionUnavailable: (error) => {
        void this.fallbackFromUdp(generation, error);
      },
      onSessionReady: () => {
        if (
          activeUdp &&
          this.isCurrentUdp(generation, activeUdp)
        ) {
          void this.reconcileUdp(generation, activeUdp, tcpQuery);
        }
      }
    });
    activeUdp = udp;
    this.udp = udp;
    this.tcpQuery = tcpQuery;
    this.kind = undefined;
    this.fallbackReason = undefined;

    try {
      await udp.start();
      if (!this.isCurrentTransition(transitionId, udp)) {
        return;
      }

      if (this.device.support.includes('get_prop')) {
        const properties = await tcpQuery.query(
          YEELIGHT_HYDRATE_PROPERTIES
        );
        if (!this.isCurrentTransition(transitionId, udp)) {
          return;
        }
        this.options.stateStore.completeHydrate(
          this.device.deviceId,
          generation,
          properties
        );
      } else {
        this.options.stateStore.markHydrateUnavailable(
          this.device.deviceId,
          generation,
          'UDP R2 device does not advertise get_prop'
        );
      }
      this.kind = 'udp-r2';
    } catch (error) {
      if (!this.isCurrentTransition(transitionId, udp)) {
        return;
      }
      await this.fallbackFromUdp(
        generation,
        this.normalizeError(error)
      );
    }
  }

  private activateTcp(transitionId: number, reason?: Error): void {
    if (this.stopped || transitionId !== this.transitionId) {
      return;
    }
    this.fallbackReason = reason?.message;
    const session = this.createTcpSessionTransport(
      this.device,
      () => {
        const generation = this.options.nextGeneration();
        this.generation = generation;
        return generation;
      }
    );
    this.tcpSession = session;
    this.kind = 'tcp-session';
    session.start();
  }

  private async fallbackFromUdp(
    generation: number,
    reason: Error
  ): Promise<void> {
    if (
      this.stopped ||
      this.kind === 'tcp-session' ||
      this.generation !== generation
    ) {
      return;
    }
    const transitionId = ++this.transitionId;
    this.options.logger.warn('Yeelight UDP R2 unavailable; using TCP', {
      deviceId: this.device.deviceId,
      error: reason.message
    });
    this.disposeTransports();
    this.activateTcp(transitionId, reason);
  }

  private async fallbackFromStation(reason: Error): Promise<void> {
    if (this.stopped || this.kind !== 'station-daemon') {
      return;
    }
    const transitionId = ++this.transitionId;
    this.options.logger.warn(
      'Yeelight Station IPC unavailable; using direct LAN',
      {
        deviceId: this.device.deviceId,
        error: reason.message
      }
    );
    this.disposeTransports();
    this.fallbackReason = reason.message;
    if (this.supportsUdpR2(this.device)) {
      await this.activateUdp(transitionId);
    } else {
      this.activateTcp(transitionId, reason);
    }
  }

  private disposeTransports(): void {
    this.kind = undefined;
    this.udp?.stop();
    this.tcpQuery?.stop();
    this.tcpSession?.stop();
    this.udp = undefined;
    this.tcpQuery = undefined;
    this.tcpSession = undefined;
  }

  private async promoteToStationIfAvailable(): Promise<void> {
    if (this.stopped || this.kind === 'station-daemon') {
      return;
    }
    const transitionId = ++this.transitionId;
    if (!(await this.activateStation(transitionId))) {
      this.transitionId -=
        this.transitionId === transitionId ? 1 : 0;
    }
  }

  private onStationEvent(event: StationDaemonEvent): void {
    if (this.stopped) {
      return;
    }
    if (event.kind === 'disconnected') {
      void this.fallbackFromStation(
        event.error ??
          new Error('Yeelight Station daemon disconnected')
      );
      return;
    }
    if (this.kind === 'station-daemon') {
      if (!this.applyStationDevice()) {
        void this.fallbackFromStation(
          new Error(
            'Device disappeared from Yeelight Station topology'
          )
        );
      }
      return;
    }
    if (
      !this.stationProbeInProgress &&
      this.options.stationClient?.findDevice(this.device)
    ) {
      void this.promoteToStationIfAvailable();
    }
  }

  private applyStationDevice(): boolean {
    const stationDevice =
      this.options.stationClient?.findDevice(this.device);
    if (!stationDevice || this.kind !== 'station-daemon') {
      return false;
    }
    this.options.stateStore.applyProps(
      this.device.deviceId,
      this.generation,
      stationDevice.properties
    );
    return true;
  }

  private async sendThroughStation(
    command: YeelightCommand
  ): Promise<unknown[]> {
    const station = this.options.stationClient;
    if (!station) {
      throw new YeelightConnectionClosedError(
        'Yeelight Station transport is not ready'
      );
    }
    const generation = this.generation;
    const confirmation = getCommandConfirmation(command);
    const baseline =
      this.options.stateStore.get(this.device.deviceId)?.properties ?? {};
    const pendingCommandId = confirmation
      ? this.options.stateStore.beginCommand(
          this.device.deviceId,
          generation,
          confirmation.properties,
          confirmation.expected
        )
      : undefined;
    try {
      const confirmed = await station.send(this.device, command);
      if (
        this.stopped ||
        this.kind !== 'station-daemon' ||
        this.generation !== generation
      ) {
        throw new YeelightConnectionClosedError(
          'Yeelight transport changed during Station confirmation'
        );
      }
      this.options.stateStore.applyProps(
        this.device.deviceId,
        generation,
        confirmed.properties
      );
      let valid = this.isStationConfirmationValid(
        confirmation,
        baseline
      );
      for (let attempt = 0; !valid && attempt < 5; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await station.refresh();
        const refreshed = station.findDevice(this.device);
        if (!refreshed) {
          throw new Error(
            'Device disappeared from Yeelight Station topology'
          );
        }
        this.options.stateStore.applyProps(
          this.device.deviceId,
          generation,
          refreshed.properties
        );
        valid = this.isStationConfirmationValid(
          confirmation,
          baseline
        );
      }
      if (!valid) {
        throw new Error(
          'Yeelight Station command was not confirmed by topology'
        );
      }
      if (
        pendingCommandId !== undefined &&
        this.options.stateStore.hasPendingCommand(
          this.device.deviceId,
          generation,
          pendingCommandId
        )
      ) {
        this.options.stateStore.resolveCommand(
          this.device.deviceId,
          generation,
          pendingCommandId
        );
      }
      return ['ok'];
    } catch (error) {
      const normalized = this.normalizeError(error);
      if (
        pendingCommandId !== undefined &&
        this.options.stateStore.hasPendingCommand(
          this.device.deviceId,
          generation,
          pendingCommandId
        )
      ) {
        this.options.stateStore.failCommand(
          this.device.deviceId,
          generation,
          pendingCommandId,
          normalized.message,
          false
        );
      }
      throw normalized;
    }
  }

  private isStationConfirmationValid(
    confirmation:
      | ReturnType<typeof getCommandConfirmation>
      | undefined,
    baseline: Readonly<Record<string, string>>
  ): boolean {
    if (!confirmation) {
      return true;
    }
    const properties =
      this.options.stateStore.get(this.device.deviceId)?.properties ??
      {};
    return confirmation.expected
      ? Object.entries(confirmation.expected).every(
          ([name, value]) => properties[name] === value
        )
      : confirmation.properties.some(
          (name) => properties[name] !== baseline[name]
        );
  }

  private createUdpTransport(
    device: PersistedYeelightDevice,
    hooks: UdpTransportHooks
  ): UdpR2CommandTransport {
    if (this.options.createUdpTransport) {
      return this.options.createUdpTransport(device, hooks);
    }
    return new UdpR2Transport({
      host: device.host,
      ...this.options.udpTransportOptions,
      onWarning: (message, error) => {
        this.options.logger.warn(message, {
          deviceId: device.deviceId,
          error: error?.message
        });
      },
      onSessionUnavailable: hooks.onSessionUnavailable,
      onSessionReady: hooks.onSessionReady
    });
  }

  private createTcpQueryTransport(
    device: PersistedYeelightDevice
  ): TcpQueryTransport {
    return (
      this.options.createTcpQueryTransport?.(device) ??
      new YeelightTcpQueryTransport({
        host: device.host,
        port: device.port
      })
    );
  }

  private createTcpSessionTransport(
    device: PersistedYeelightDevice,
    nextGeneration: () => number
  ): TcpSessionTransport {
    return (
      this.options.createTcpSessionTransport?.(
        device,
        nextGeneration
      ) ??
      new YeelightConnection(device, {
        stateStore: this.options.stateStore,
        logger: this.options.logger,
        ...this.options.tcpSessionOptions,
        nextGeneration
      })
    );
  }

  private supportsUdpR2(device: PersistedYeelightDevice): boolean {
    const support = new Set(device.support);
    return UDP_SESSION_METHODS.every((method) => support.has(method));
  }

  private transportSignature(device: PersistedYeelightDevice): string {
    const support = new Set(device.support);
    return [...UDP_SESSION_METHODS, 'get_prop']
      .map((method) => `${method}:${support.has(method) ? 1 : 0}`)
      .join('|');
  }

  private isCurrentTransition(
    transitionId: number,
    udp: UdpR2CommandTransport
  ): boolean {
    return (
      !this.stopped &&
      transitionId === this.transitionId &&
      this.udp === udp
    );
  }

  private isCurrentTransitionId(transitionId: number): boolean {
    return !this.stopped && transitionId === this.transitionId;
  }

  private isCurrentUdp(
    generation: number,
    udp: UdpR2CommandTransport
  ): boolean {
    return (
      !this.stopped &&
      this.kind === 'udp-r2' &&
      this.generation === generation &&
      this.udp === udp
    );
  }

  private async reconcileUdp(
    generation: number,
    udp: UdpR2CommandTransport,
    tcpQuery: TcpQueryTransport
  ): Promise<void> {
    if (
      !this.isCurrentUdp(generation, udp) ||
      !this.device.support.includes('get_prop')
    ) {
      return;
    }
    this.options.stateStore.markHydrating(
      this.device.deviceId,
      generation
    );
    try {
      const properties = await tcpQuery.query(
        YEELIGHT_HYDRATE_PROPERTIES
      );
      if (!this.isCurrentUdp(generation, udp)) {
        return;
      }
      this.options.stateStore.completeHydrate(
        this.device.deviceId,
        generation,
        properties
      );
    } catch (error) {
      if (!this.isCurrentUdp(generation, udp)) {
        return;
      }
      this.options.stateStore.markHydrateUnavailable(
        this.device.deviceId,
        generation,
        this.normalizeError(error).message
      );
    }
  }

  private normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
