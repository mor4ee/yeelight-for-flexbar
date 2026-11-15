import {
  DeviceCatalog,
  type CatalogDiscoverySource,
  type YeelightCatalogSnapshot,
  type YeelightConnectionSummary,
  type YeelightTargetDomain
} from '../backend/catalog/device-catalog';
import {
  DEFAULT_YEELIGHT_CONFIG,
  normalizePluginConfig,
  type YeelightPluginConfig
} from '../backend/catalog/plugin-config';
import { ConnectionManager } from '../backend/connection/connection-manager';
import {
  DiscoveryManager,
  type DiscoveryScanResult
} from '../backend/discovery/discovery-manager';
import { normalizeManualAddress } from '../backend/discovery/network';
import type { YeelightCommand } from '../backend/protocol';
import type {
  YeelightDeviceRuntimeState,
  YeelightRuntimeSnapshot
} from '../backend/state/device-state-store';
import {
  targetIdFromUnitData,
  type ConfirmedTargetContext
} from '../backend/units/control-plan';
import {
  YEELIGHT_UNIT_CONTRACTS,
  type YeelightUnitId
} from '../backend/units/contracts';

export interface V1ConfigStore {
  getConfig(): Promise<unknown>;
  setConfig(config: YeelightPluginConfig): Promise<unknown>;
}

export interface V1RuntimeLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface V1CatalogPayload {
  catalog: YeelightCatalogSnapshot;
  runtime: YeelightRuntimeSnapshot;
  manualAddresses: string[];
  discovery: {
    runId: number;
    scanning: boolean;
    passiveListening: boolean;
    lastScanStartedAt?: number;
    lastScanCompletedAt?: number;
    lastError?: string;
  };
}

export interface V1UiRequest {
  action: string;
  address?: unknown;
  deviceId?: unknown;
}

interface CatalogRuntimeOptions {
  configStore: V1ConfigStore;
  logger: V1RuntimeLogger;
  createDiscovery?: (
    options: ConstructorParameters<typeof DiscoveryManager>[0]
  ) => DiscoveryManager;
  createConnections?: (
    logger: V1RuntimeLogger
  ) => ConnectionManager;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function unwrapV1ConfigPayload(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (isRecord(value.config)) {
    return value.config;
  }
  if (isRecord(value.result)) {
    return value.result;
  }
  return value;
}

export function normalizeV1UiRequest(value: unknown): V1UiRequest {
  const request = isRecord(value) && isRecord(value.data)
    ? value.data
    : value;
  if (!isRecord(request) || typeof request.action !== 'string') {
    throw new TypeError('Yeelight UI request must include an action');
  }
  return {
    action: request.action,
    address: request.address,
    deviceId: request.deviceId
  };
}

function connectionSummary(
  state: YeelightDeviceRuntimeState
): YeelightConnectionSummary {
  return {
    phase: state.phase,
    stale: state.stale,
    staleProperties: [...state.staleProperties],
    activeTransport: state.activeTransport,
    pendingCommandCount: state.pendingCommands.length,
    generation: state.generation,
    revision: state.revision,
    lastError: state.lastError
  };
}

function projectProperties(
  properties: Readonly<Record<string, string>>,
  domain: YeelightTargetDomain
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (domain === 'main' && !name.startsWith('bg_')) {
      result[name] = value;
    } else if (domain === 'background' && name.startsWith('bg_')) {
      result[name.slice(3)] = value;
      if (name === 'bg_lmode') {
        result.color_mode = value;
      }
    }
  }
  return result;
}

export function mergeCatalogRuntime(
  catalog: YeelightCatalogSnapshot,
  runtime: YeelightRuntimeSnapshot
): YeelightCatalogSnapshot {
  const result = structuredClone(catalog);
  const runtimeByDevice = new Map(
    runtime.devices.map((state) => [state.deviceId, state])
  );

  for (const device of result.devices) {
    const state = runtimeByDevice.get(device.deviceId);
    if (!state) {
      continue;
    }
    device.online = state.phase === 'connected';
    device.connection = connectionSummary(state);
    device.properties = {
      ...state.properties
    };
  }

  for (const target of result.targets) {
    const state = runtimeByDevice.get(target.deviceId);
    if (!state) {
      continue;
    }
    target.online = state.phase === 'connected';
    target.connection = connectionSummary(state);
    target.properties = projectProperties(
      state.properties,
      target.domain
    );
  }

  return result;
}

export class YeelightV1CatalogRuntime {
  private config: YeelightPluginConfig = structuredClone(
    DEFAULT_YEELIGHT_CONFIG
  );
  private catalog = new DeviceCatalog();
  private connections?: ConnectionManager;
  private unsubscribeRuntimeState?: () => void;
  private runtimePhaseSignature = '';
  private discovery?: DiscoveryManager;
  private initialization?: Promise<void>;
  private initialized = false;
  private stopped = false;
  private scanTask?: Promise<DiscoveryScanResult>;
  private scanRunId = 0;
  private initialScanTimer?: ReturnType<typeof setTimeout>;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private readonly stateListeners = new Set<() => void>();

  constructor(private readonly options: CatalogRuntimeOptions) {}

  initialize(): Promise<void> {
    if (this.initialized) {
      return Promise.resolve();
    }
    if (this.initialization) {
      return this.initialization;
    }

    const task = this.initializeCore();
    this.initialization = task;
    return task.catch((error) => {
      if (this.initialization === task) {
        this.initialization = undefined;
      }
      throw error;
    });
  }

  async handleUiRequest(request: V1UiRequest): Promise<unknown> {
    await this.initialize();

    switch (request.action) {
      case 'yeelight.catalog.get':
        return this.getPayload();
      case 'yeelight.discovery.scan':
        return this.scanAndWait('user');
      case 'yeelight.discovery.cancel':
        this.discovery?.cancelScan();
        return this.getPayload();
      case 'yeelight.manual.add':
        return this.addManualAddress(request.address);
      case 'yeelight.manual.remove':
        return this.removeManualAddress(request.address);
      case 'yeelight.connection.reconnect':
        return this.reconnectDevice(request.deviceId);
      default:
        throw new Error(`Unknown Yeelight UI action: ${request.action}`);
    }
  }

  getPayload(): V1CatalogPayload {
    const runtime = this.connections?.stateStore.snapshot() ?? {
      revision: 0,
      devices: []
    };
    return {
      catalog: mergeCatalogRuntime(this.catalog.snapshot(), runtime),
      runtime,
      manualAddresses: [...this.config.manualAddresses],
      discovery: {
        runId: this.scanRunId,
        ...(this.discovery?.getStatus() ?? {
          scanning: false,
          passiveListening: false
        })
      }
    };
  }

  subscribeState(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  getControlContext(
    unitId: YeelightUnitId,
    data: unknown
  ): ConfirmedTargetContext | undefined {
    let targetId: string;
    try {
      targetId = targetIdFromUnitData(unitId, data);
    } catch {
      return undefined;
    }
    if (!targetId) {
      return undefined;
    }

    const snapshot = this.getPayload().catalog;
    const target = snapshot.targets.find(
      (entry) => entry.targetId === targetId
    );
    if (
      !target ||
      !target.online ||
      !target.capabilities.includes(
        YEELIGHT_UNIT_CONTRACTS[unitId].capability
      )
    ) {
      return undefined;
    }
    const device = snapshot.devices.find(
      (entry) => entry.deviceId === target.deviceId
    );
    if (!device) {
      return undefined;
    }

    return {
      target,
      properties: target.properties,
      supportedMethods: new Set(device.support)
    };
  }

  sendCommand(
    deviceId: string,
    command: YeelightCommand
  ): Promise<unknown[]> {
    if (!this.connections) {
      return Promise.reject(
        new Error('Yeelight connection runtime is not initialized')
      );
    }
    return this.connections.send(deviceId, command);
  }

  async shutdown(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.initialScanTimer) {
      clearTimeout(this.initialScanTimer);
      this.initialScanTimer = undefined;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.discovery?.stop();
    this.unsubscribeRuntimeState?.();
    this.unsubscribeRuntimeState = undefined;
    this.runtimePhaseSignature = '';
    this.connections?.stop();
    this.stateListeners.clear();
    try {
      await this.scanTask;
    } catch {
      // The discovery error was already logged.
    }
    if (this.initialized) {
      await this.persistConfig();
    }
  }

  private async initializeCore(): Promise<void> {
    const stored = await this.options.configStore.getConfig();
    const normalized = normalizePluginConfig(unwrapV1ConfigPayload(stored));
    this.config = this.canonicalConfig(normalized);
    this.catalog = new DeviceCatalog(this.config.catalog);
    this.createConnections();

    const createDiscovery =
      this.options.createDiscovery ??
      ((options) => new DiscoveryManager(options));
    this.discovery = createDiscovery({
      onPacket: (event) => {
        const device = this.catalog.upsert(
          event.packet,
          event.source as CatalogDiscoverySource
        );
        this.connections?.upsertDevice(device);
        this.notifyStateListeners();
        this.schedulePersist();
        this.options.logger.info('Yeelight discovered on LAN', {
          deviceId: device.deviceId,
          host: device.host,
          source: event.source,
          model: device.model
        });
      },
      onWarning: (message, error) => {
        this.options.logger.warn(
          message,
          error ? { error: error.message } : undefined
        );
      }
    });
    this.discovery.setManualAddresses(this.config.manualAddresses);
    this.discovery.startPassiveListener();
    this.initialized = true;

    this.initialScanTimer = setTimeout(() => {
      this.initialScanTimer = undefined;
      void this.startDiscoveryScan('startup');
    }, 0);

    this.options.logger.info('Yeelight LAN catalog runtime initialized', {
      catalogDevices: this.catalog.size,
      manualAddresses: this.config.manualAddresses.length
    });
  }

  private createConnections(): void {
    const createConnections =
      this.options.createConnections ??
      ((runtimeLogger) =>
        new ConnectionManager({
          logger: {
            debug: (message, data) =>
              runtimeLogger.debug(message, data),
            warn: (message, data) =>
              runtimeLogger.warn(message, data)
          },
          onStationTopology: (devices) => {
            for (const stationDevice of devices) {
              if (!stationDevice.connected) {
                continue;
              }
              const device = this.catalog.upsertStation(stationDevice);
              this.connections?.upsertDevice(device);
            }
            this.notifyStateListeners();
            this.schedulePersist();
          }
        }));
    this.connections = createConnections(this.options.logger);
    this.unsubscribeRuntimeState =
      this.connections.stateStore.subscribe((snapshot) => {
        this.notifyStateListeners();
        const phases = snapshot.devices.map((state) => ({
          deviceId: state.deviceId,
          phase: state.phase,
          stale: state.stale,
          generation: state.generation,
          error: state.lastError
        }));
        const signature = JSON.stringify(phases);
        if (signature === this.runtimePhaseSignature) {
          return;
        }
        this.runtimePhaseSignature = signature;
        this.options.logger.info('Yeelight runtime state changed', {
          devices: phases
        });
      });
    for (const device of this.catalog.serialize()) {
      this.connections.upsertDevice(device);
    }
    this.notifyStateListeners();
  }

  private notifyStateListeners(): void {
    for (const listener of this.stateListeners) {
      try {
        listener();
      } catch (error) {
        this.options.logger.warn('Yeelight state listener failed', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private async scanAndWait(
    trigger: 'startup' | 'user' | 'manual'
  ): Promise<V1CatalogPayload> {
    const task = this.startDiscoveryScan(trigger);
    await task;
    await this.persistConfig();
    return this.getPayload();
  }

  private startDiscoveryScan(
    trigger: 'startup' | 'user' | 'manual'
  ): Promise<DiscoveryScanResult> {
    if (!this.discovery || this.stopped) {
      return Promise.reject(
        new Error('Yeelight discovery is not available')
      );
    }
    if (this.scanTask) {
      return this.scanTask;
    }

    this.scanRunId += 1;
    const runId = this.scanRunId;
    this.options.logger.info('Yeelight discovery scan started', {
      runId,
      trigger
    });
    const task = this.discovery.scan(this.config.manualAddresses);
    this.scanTask = task;

    void task
      .then((result) => {
        this.options.logger.info('Yeelight discovery scan completed', {
          runId,
          cancelled: result.cancelled,
          interfaceCount: result.interfaceCount,
          discoveredDevices: result.discoveredDeviceIds.length
        });
      })
      .catch((error: unknown) => {
        this.options.logger.warn('Yeelight discovery scan failed', {
          runId,
          error: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        if (this.scanTask === task) {
          this.scanTask = undefined;
        }
      });

    return task;
  }

  private async addManualAddress(
    address: unknown
  ): Promise<V1CatalogPayload> {
    if (typeof address !== 'string') {
      throw new TypeError('Manual Yeelight address must be a string');
    }
    const normalized = normalizeManualAddress(address);
    if (!this.config.manualAddresses.includes(normalized)) {
      this.config.manualAddresses = [
        ...this.config.manualAddresses,
        normalized
      ].sort();
      this.discovery?.setManualAddresses(this.config.manualAddresses);
      await this.persistConfig();
    }

    const previousTask = this.scanTask;
    if (previousTask) {
      this.discovery?.cancelScan();
      try {
        await previousTask;
      } catch {
        // The replacement scan reports its own result.
      }
      if (this.scanTask === previousTask) {
        this.scanTask = undefined;
      }
    }
    return this.scanAndWait('manual');
  }

  private async removeManualAddress(
    address: unknown
  ): Promise<V1CatalogPayload> {
    if (typeof address !== 'string') {
      throw new TypeError('Manual Yeelight address must be a string');
    }
    const normalized = normalizeManualAddress(address);
    this.config.manualAddresses = this.config.manualAddresses.filter(
      (entry) => entry !== normalized
    );
    this.discovery?.setManualAddresses(this.config.manualAddresses);
    await this.persistConfig();
    return this.getPayload();
  }

  private reconnectDevice(deviceId: unknown): V1CatalogPayload {
    if (
      typeof deviceId !== 'string' ||
      !/^0x[0-9a-f]{1,16}$/i.test(deviceId)
    ) {
      throw new TypeError('Invalid Yeelight device id');
    }
    const accepted =
      this.connections?.reconnect(deviceId.toLowerCase()) ?? false;
    if (!accepted) {
      throw new Error('Yeelight device is not registered');
    }
    return this.getPayload();
  }

  private schedulePersist(): void {
    if (this.persistTimer || this.stopped) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistConfig().catch((error: unknown) => {
        this.options.logger.warn('Cannot persist Yeelight catalog', {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, 250);
  }

  private async persistConfig(): Promise<void> {
    this.config = this.canonicalConfig({
      schemaVersion: 1,
      manualAddresses: [...this.config.manualAddresses],
      catalog: this.catalog.serialize()
    });
    await this.options.configStore.setConfig(this.config);
  }

  private canonicalConfig(
    config: YeelightPluginConfig
  ): YeelightPluginConfig {
    const catalog = new DeviceCatalog(config.catalog);
    return {
      schemaVersion: 1,
      manualAddresses: [...config.manualAddresses].sort(),
      catalog: catalog.serialize()
    };
  }
}
