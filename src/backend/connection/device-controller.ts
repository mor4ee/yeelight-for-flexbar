import type { PersistedYeelightDevice } from '../catalog/device-catalog';
import type { YeelightCommand } from '../protocol';
import { DeviceStateStore } from '../state/device-state-store';
import {
  TransportCoordinator,
  type TransportCoordinatorOptions,
  type TransportCoordinatorSnapshot
} from './transport-coordinator';

export interface DeviceControllerOptions
  extends Omit<TransportCoordinatorOptions, 'stateStore' | 'nextGeneration'> {
  stateStore: DeviceStateStore;
  sliderCommandIntervalMs?: number;
}

export class DeviceController {
  private generation = 0;
  private stopped = false;
  private readonly coordinator: TransportCoordinator;
  private readonly scheduler: DeviceCommandScheduler;

  constructor(
    private device: PersistedYeelightDevice,
    private readonly options: DeviceControllerOptions
  ) {
    options.stateStore.ensureDevice(device.deviceId, device.properties);
    const {
      sliderCommandIntervalMs = 100,
      ...coordinatorOptions
    } = options;
    this.coordinator = new TransportCoordinator(device, {
      ...coordinatorOptions,
      nextGeneration: () => {
        this.generation += 1;
        return this.generation;
      }
    });
    this.scheduler = new DeviceCommandScheduler({
      intervalMs: sliderCommandIntervalMs,
      execute: (command) => this.coordinator.send(command)
    });
  }

  start(): Promise<void> {
    return this.coordinator.start();
  }

  updateDevice(device: PersistedYeelightDevice): Promise<void> {
    if (device.deviceId !== this.device.deviceId) {
      return Promise.reject(
        new Error('Cannot change DeviceController identity')
      );
    }
    this.device = device;
    if (!this.options.stateStore.get(device.deviceId)) {
      this.options.stateStore.ensureDevice(
        device.deviceId,
        device.properties
      );
    }
    const update = this.coordinator.updateDevice(device);
    const state = this.options.stateStore.get(device.deviceId);
    if (
      state &&
      state.generation > 0 &&
      Object.keys(device.properties).length > 0
    ) {
      this.options.stateStore.applyProps(
        device.deviceId,
        state.generation,
        device.properties
      );
    }
    return update;
  }

  reconnect(): Promise<void> {
    return this.coordinator.reconnect();
  }

  send(command: YeelightCommand): Promise<unknown[]> {
    if (this.stopped) {
      return Promise.reject(
        new Error('Yeelight DeviceController is stopped')
      );
    }
    return this.scheduler.schedule(command);
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.scheduler.stop();
    this.coordinator.stop();
  }

  snapshot(): TransportCoordinatorSnapshot {
    return this.coordinator.snapshot();
  }
}

interface CommandWaiter {
  resolve(result: unknown[]): void;
  reject(error: unknown): void;
}

interface CommandLane {
  running: boolean;
  lastStartedAt?: number;
  pendingCommand?: YeelightCommand;
  pendingWaiters: CommandWaiter[];
  timer?: ReturnType<typeof setTimeout>;
}

interface DeviceCommandSchedulerOptions {
  intervalMs: number;
  execute(command: YeelightCommand): Promise<unknown[]>;
  now?: () => number;
}

class DeviceCommandScheduler {
  private readonly lanes = new Map<string, CommandLane>();
  private readonly now: () => number;
  private globalTail: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: DeviceCommandSchedulerOptions) {
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 0) {
      throw new RangeError('Invalid Yeelight command interval');
    }
  }

  schedule(command: YeelightCommand): Promise<unknown[]> {
    if (this.stopped) {
      return Promise.reject(
        new Error('Yeelight DeviceController is stopped')
      );
    }
    const laneKey = this.replaceableLane(command);
    if (!laneKey) {
      return this.enqueue(command);
    }

    const lane = this.lanes.get(laneKey) ?? {
      running: false,
      pendingWaiters: []
    };
    this.lanes.set(laneKey, lane);
    lane.pendingCommand = command;
    const result = new Promise<unknown[]>((resolve, reject) => {
      lane.pendingWaiters.push({ resolve, reject });
    });
    this.pump(laneKey, lane);
    return result;
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    const error = new Error('Yeelight DeviceController is stopped');
    for (const lane of this.lanes.values()) {
      if (lane.timer) {
        clearTimeout(lane.timer);
      }
      for (const waiter of lane.pendingWaiters) {
        waiter.reject(error);
      }
      lane.pendingWaiters = [];
      lane.pendingCommand = undefined;
    }
    this.lanes.clear();
  }

  private pump(laneKey: string, lane: CommandLane): void {
    if (
      this.stopped ||
      lane.running ||
      lane.timer ||
      !lane.pendingCommand
    ) {
      return;
    }
    const elapsed =
      lane.lastStartedAt === undefined
        ? Number.POSITIVE_INFINITY
        : this.now() - lane.lastStartedAt;
    const delay = Math.max(0, this.options.intervalMs - elapsed);
    if (delay > 0) {
      lane.timer = setTimeout(() => {
        lane.timer = undefined;
        this.pump(laneKey, lane);
      }, delay);
      return;
    }

    const command = lane.pendingCommand;
    const waiters = lane.pendingWaiters;
    lane.pendingCommand = undefined;
    lane.pendingWaiters = [];
    lane.running = true;
    lane.lastStartedAt = this.now();
    void this.enqueue(command)
      .then((result) => {
        for (const waiter of waiters) {
          waiter.resolve(result);
        }
      })
      .catch((error: unknown) => {
        for (const waiter of waiters) {
          waiter.reject(error);
        }
      })
      .finally(() => {
        lane.running = false;
        if (lane.pendingCommand) {
          this.pump(laneKey, lane);
        }
      });
  }

  private enqueue(command: YeelightCommand): Promise<unknown[]> {
    const task = this.globalTail.then(() => {
      if (this.stopped) {
        throw new Error('Yeelight DeviceController is stopped');
      }
      return this.options.execute(command);
    });
    this.globalTail = task.catch(() => undefined);
    return task;
  }

  private replaceableLane(command: YeelightCommand): string | undefined {
    const background = command.method.startsWith('bg_');
    const method = background
      ? command.method.slice(3)
      : command.method;
    if (
      !['set_bright', 'set_ct_abx', 'set_hsv', 'set_rgb'].includes(
        method
      )
    ) {
      return undefined;
    }
    return `${background ? 'background' : 'main'}:${method}`;
  }
}
