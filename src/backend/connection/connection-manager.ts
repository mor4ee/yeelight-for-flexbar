import type { PersistedYeelightDevice } from '../catalog/device-catalog';
import type { YeelightCommand } from '../protocol';
import { DeviceStateStore } from '../state/device-state-store';
import {
  DeviceController,
  type DeviceControllerOptions
} from './device-controller';
import type { TransportCoordinatorSnapshot } from './transport-coordinator';
import {
  type YeelightConnectionLogger,
  type YeelightConnectionOptions
} from './yeelight-connection';
import {
  StationDaemonClient,
  type StationDaemonBridge,
  type StationDaemonDevice
} from './station-daemon-client';

export interface ConnectionManagerOptions {
  logger: YeelightConnectionLogger;
  stateStore?: DeviceStateStore;
  connectionOptions?: Omit<
    YeelightConnectionOptions,
    'logger' | 'stateStore'
  >;
  controllerOptions?: Omit<
    DeviceControllerOptions,
    'logger' | 'stateStore'
  >;
  stationClient?: StationDaemonBridge | false;
  onStationTopology?: (
    devices: readonly StationDaemonDevice[]
  ) => void;
}

export class ConnectionManager {
  readonly stateStore: DeviceStateStore;
  private readonly controllers = new Map<string, DeviceController>();
  private readonly stationClient?: StationDaemonBridge;
  private readonly unsubscribeStation?: () => void;

  constructor(private readonly options: ConnectionManagerOptions) {
    this.stateStore = options.stateStore ?? new DeviceStateStore();
    this.stationClient =
      options.stationClient === false
        ? undefined
        : options.stationClient ?? new StationDaemonClient();
    this.unsubscribeStation = this.stationClient?.subscribe((event) => {
      if (event.kind === 'topology') {
        this.options.onStationTopology?.(event.devices);
      }
    });
    void this.stationClient?.start();
  }

  upsertDevice(device: PersistedYeelightDevice): void {
    const existing = this.controllers.get(device.deviceId);
    if (existing) {
      void existing.updateDevice(device).catch((error: unknown) => {
        this.options.logger.warn('Yeelight device update failed', {
          deviceId: device.deviceId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      return;
    }

    const controller = new DeviceController(device, {
      stateStore: this.stateStore,
      logger: this.options.logger,
      tcpSessionOptions: this.options.connectionOptions,
      stationClient: this.stationClient,
      ...this.options.controllerOptions
    });
    this.controllers.set(device.deviceId, controller);
    void controller.start().catch((error: unknown) => {
      this.options.logger.warn('Yeelight device controller start failed', {
        deviceId: device.deviceId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  reconnect(deviceId: string): boolean {
    const controller = this.controllers.get(deviceId);
    if (!controller) {
      return false;
    }
    void controller.reconnect().catch((error: unknown) => {
      this.options.logger.warn('Yeelight device reconnect failed', {
        deviceId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return true;
  }

  send(deviceId: string, command: YeelightCommand): Promise<unknown[]> {
    const controller = this.controllers.get(deviceId);
    if (!controller) {
      return Promise.reject(
        new Error(`Yeelight device is not registered: ${deviceId}`)
      );
    }
    return controller.send(command);
  }

  transportSnapshot(
    deviceId: string
  ): TransportCoordinatorSnapshot | undefined {
    return this.controllers.get(deviceId)?.snapshot();
  }

  stop(): void {
    for (const controller of this.controllers.values()) {
      controller.stop();
    }
    this.controllers.clear();
    this.unsubscribeStation?.();
    this.stationClient?.stop();
  }

  get size(): number {
    return this.controllers.size;
  }
}
