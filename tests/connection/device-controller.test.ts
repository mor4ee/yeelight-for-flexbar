import assert from 'node:assert/strict';
import test from 'node:test';
import type { PersistedYeelightDevice } from '../../src/backend/catalog/device-catalog';
import { DeviceController } from '../../src/backend/connection/device-controller';
import type {
  TcpQueryTransport,
  TcpSessionTransport,
  UdpR2CommandTransport
} from '../../src/backend/connection/transport-types';
import type { UdpTransportHooks } from '../../src/backend/connection/transport-coordinator';
import type {
  StationDaemonBridge,
  StationDaemonDevice,
  StationDaemonEvent,
  StationDaemonListener
} from '../../src/backend/connection/station-daemon-client';
import {
  setBrightness,
  setPower,
  type YeelightCommand
} from '../../src/backend/protocol';
import { DeviceStateStore } from '../../src/backend/state/device-state-store';

function device(
  overrides: Partial<PersistedYeelightDevice> = {}
): PersistedYeelightDevice {
  return {
    deviceId: '0x20',
    host: '192.168.1.20',
    port: 55_443,
    model: 'color',
    support: [
      'get_prop',
      'set_power',
      'set_bright',
      'udp_sess_new',
      'udp_sess_keep_alive'
    ],
    properties: {
      power: 'off',
      bright: '20'
    },
    source: 'active',
    lastSeenAt: 1,
    ...overrides
  };
}

class FakeUdpTransport implements UdpR2CommandTransport {
  readonly commands: YeelightCommand[] = [];
  stopped = false;

  constructor(
    private readonly startError?: Error,
    readonly hooks?: UdpTransportHooks,
    private readonly onSend?: (command: YeelightCommand) => void
  ) {}

  start(): Promise<void> {
    return this.startError
      ? Promise.reject(this.startError)
      : Promise.resolve();
  }

  send(command: YeelightCommand): Promise<void> {
    this.commands.push(command);
    this.onSend?.(command);
    return Promise.resolve();
  }

  stop(): void {
    this.stopped = true;
  }
}

class FakeQueryTransport implements TcpQueryTransport {
  stopped = false;
  readonly requested: string[][] = [];

  constructor(
    private readonly responder: (
      properties: readonly string[]
    ) => Promise<Record<string, string>>
  ) {}

  query(properties: readonly string[]): Promise<Record<string, string>> {
    this.requested.push([...properties]);
    return this.responder(properties);
  }

  stop(): void {
    this.stopped = true;
  }
}

class FakeTcpSession implements TcpSessionTransport {
  started = false;
  stopped = false;
  commands: YeelightCommand[] = [];

  constructor(
    private readonly device: PersistedYeelightDevice,
    private readonly stateStore: DeviceStateStore,
    private readonly nextGeneration: () => number
  ) {}

  start(): void {
    this.started = true;
    const generation = this.nextGeneration();
    this.stateStore.beginConnection(
      this.device.deviceId,
      generation,
      'tcp-session'
    );
    this.stateStore.markHydrating(this.device.deviceId, generation);
    this.stateStore.completeHydrate(
      this.device.deviceId,
      generation,
      this.device.properties
    );
  }

  updateDevice(): void {}

  reconnectNow(): void {}

  send(command: YeelightCommand): Promise<unknown[]> {
    this.commands.push(command);
    return Promise.resolve(['ok']);
  }

  stop(): void {
    this.stopped = true;
  }
}

class FakeStationClient implements StationDaemonBridge {
  private readonly listeners = new Set<StationDaemonListener>();
  available = true;
  stationDevice: StationDaemonDevice | undefined = {
    deviceId: '0x20',
    host: '192.168.1.20',
    model: 'color',
    connected: true,
    support: ['get_prop', 'set_power', 'set_bright'],
    properties: { power: 'on', bright: '20' }
  };
  readonly commands: YeelightCommand[] = [];
  applyCommands = true;

  start(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  refresh(): Promise<readonly StationDaemonDevice[]> {
    return Promise.resolve(
      this.stationDevice ? [structuredClone(this.stationDevice)] : []
    );
  }

  findDevice(
    current: PersistedYeelightDevice
  ): StationDaemonDevice | undefined {
    return this.stationDevice?.deviceId === current.deviceId
      ? structuredClone(this.stationDevice)
      : undefined;
  }

  send(
    _current: PersistedYeelightDevice,
    command: YeelightCommand
  ): Promise<StationDaemonDevice> {
    this.commands.push(command);
    if (!this.stationDevice) {
      return Promise.reject(new Error('missing Station device'));
    }
    if (this.applyCommands && command.method === 'set_bright') {
      this.stationDevice.properties.bright = String(command.params[0]);
    }
    if (this.applyCommands && command.method === 'set_power') {
      this.stationDevice.properties.power = String(command.params[0]);
    }
    this.emit({
      kind: 'topology',
      devices: [structuredClone(this.stationDevice)]
    });
    return Promise.resolve(structuredClone(this.stationDevice));
  }

  subscribe(listener: StationDaemonListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {}

  emit(event: StationDaemonEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

const logger = {
  debug() {},
  warn() {}
};

test('prefers one Station daemon transport and confirms topology state', async () => {
  const stateStore = new DeviceStateStore();
  const station = new FakeStationClient();
  const controller = new DeviceController(device(), {
    stateStore,
    logger,
    stationClient: station
  });

  try {
    await controller.start();
    assert.deepEqual(controller.snapshot(), {
      kind: 'station-daemon',
      generation: 1,
      fallbackReason: undefined
    });
    assert.equal(stateStore.get('0x20')?.properties.bright, '20');
    assert.deepEqual(await controller.send(setBrightness(73)), ['ok']);
    assert.deepEqual(station.commands, [setBrightness(73)]);
    assert.equal(stateStore.get('0x20')?.properties.bright, '73');
  } finally {
    controller.stop();
  }
});

test('does not mark a Station-connected device offline after an unconfirmed command', async () => {
  const stateStore = new DeviceStateStore();
  const station = new FakeStationClient();
  station.applyCommands = false;
  const controller = new DeviceController(device(), {
    stateStore,
    logger,
    stationClient: station
  });

  try {
    await controller.start();
    await assert.rejects(
      controller.send(setBrightness(73)),
      /not confirmed by topology/
    );
    const state = stateStore.get('0x20');
    assert.equal(state?.phase, 'connected');
    assert.equal(state?.stale, false);
    assert.deepEqual(state?.staleProperties, []);

    station.applyCommands = true;
    assert.deepEqual(await controller.send(setBrightness(74)), ['ok']);
    assert.equal(stateStore.get('0x20')?.properties.bright, '74');
  } finally {
    controller.stop();
  }
});

test('starts a direct LAN generation when Station disconnects', async () => {
  const stateStore = new DeviceStateStore();
  const station = new FakeStationClient();
  let udp: FakeUdpTransport | undefined;
  const controller = new DeviceController(device(), {
    stateStore,
    logger,
    stationClient: station,
    createUdpTransport: (_current, hooks) => {
      udp = new FakeUdpTransport(undefined, hooks);
      return udp;
    },
    createTcpQueryTransport: () =>
      new FakeQueryTransport(async () => ({
        power: 'on',
        bright: '40'
      }))
  });

  try {
    await controller.start();
    station.available = false;
    station.stationDevice = undefined;
    station.emit({
      kind: 'disconnected',
      error: new Error('Station closed')
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(udp?.stopped, false);
    assert.deepEqual(controller.snapshot(), {
      kind: 'udp-r2',
      generation: 2,
      fallbackReason: undefined
    });
    assert.equal(stateStore.get('0x20')?.properties.bright, '40');
  } finally {
    controller.stop();
  }
});

test('selects UDP R2 and confirms commands through short TCP queries', async () => {
  const stateStore = new DeviceStateStore();
  const udp = new FakeUdpTransport();
  let queryCount = 0;
  const query = new FakeQueryTransport(async () => {
    queryCount += 1;
    const result: Record<string, string> = queryCount === 1
      ? { power: 'on', bright: '20' }
      : { bright: '73' };
    return result;
  });
  const controller = new DeviceController(device(), {
    stateStore,
    logger,
    createUdpTransport: () => udp,
    createTcpQueryTransport: () => query
  });

  try {
    await controller.start();
    assert.deepEqual(controller.snapshot(), {
      kind: 'udp-r2',
      generation: 1,
      fallbackReason: undefined
    });
    assert.equal(stateStore.get('0x20')?.stale, false);

    assert.deepEqual(await controller.send(setBrightness(73)), ['ok']);
    assert.deepEqual(udp.commands, [setBrightness(73)]);
    assert.deepEqual(query.requested[1], ['bright']);
    assert.equal(stateStore.get('0x20')?.properties.bright, '73');
  } finally {
    controller.stop();
  }
});

test('falls back atomically to managed TCP when UDP handshake fails', async () => {
  const stateStore = new DeviceStateStore();
  const udp = new FakeUdpTransport(new Error('no UDP slots'));
  let tcp: FakeTcpSession | undefined;
  const controller = new DeviceController(device(), {
    stateStore,
    logger,
    createUdpTransport: () => udp,
    createTcpQueryTransport: () =>
      new FakeQueryTransport(async () => ({})),
    createTcpSessionTransport: (current, nextGeneration) => {
      tcp = new FakeTcpSession(
        current,
        stateStore,
        nextGeneration
      );
      return tcp;
    }
  });

  try {
    await controller.start();
    assert.equal(udp.stopped, true);
    assert.equal(tcp?.started, true);
    assert.deepEqual(controller.snapshot(), {
      kind: 'tcp-session',
      generation: 2,
      fallbackReason: 'no UDP slots'
    });
    assert.equal(stateStore.get('0x20')?.generation, 2);
    assert.equal(stateStore.get('0x20')?.stale, false);
    assert.deepEqual(await controller.send(setPower(false)), ['ok']);
    assert.deepEqual(tcp?.commands, [setPower(false)]);
  } finally {
    controller.stop();
  }
});

test('does not accept an unchanged TCP query as UDP command confirmation', async () => {
  const stateStore = new DeviceStateStore();
  const controller = new DeviceController(device(), {
    stateStore,
    logger,
    createUdpTransport: () => new FakeUdpTransport(),
    createTcpQueryTransport: () =>
      new FakeQueryTransport(async () => ({
        power: 'off',
        bright: '20'
      }))
  });

  try {
    await controller.start();
    await assert.rejects(
      controller.send(setBrightness(73)),
      /not confirmed/
    );
    assert.equal(stateStore.get('0x20')?.properties.bright, '20');
  } finally {
    controller.stop();
  }
});

test('prefers new discovery state and ignores an old hydrate after an endpoint change', async () => {
  const stateStore = new DeviceStateStore();
  let resolveOld:
    | ((value: Record<string, string>) => void)
    | undefined;
  const oldHydrate = new Promise<Record<string, string>>((resolve) => {
    resolveOld = resolve;
  });
  const udpTransports: FakeUdpTransport[] = [];
  const controller = new DeviceController(device(), {
    stateStore,
    logger,
    createUdpTransport: () => {
      const udp = new FakeUdpTransport();
      udpTransports.push(udp);
      return udp;
    },
    createTcpQueryTransport: (current) =>
      new FakeQueryTransport(async () =>
        current.host === '192.168.1.20'
          ? oldHydrate
          : { power: 'on', bright: '80' }
      )
  });

  const firstStart = controller.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await controller.updateDevice(
    device({
      host: '192.168.1.21',
      properties: {
        power: 'on',
        bright: '50'
      }
    })
  );
  resolveOld?.({ power: 'off', bright: '1' });
  await firstStart;

  assert.equal(udpTransports.length, 2);
  assert.equal(udpTransports[0].stopped, true);
  assert.equal(stateStore.get('0x20')?.generation, 2);
  assert.equal(stateStore.get('0x20')?.properties.bright, '50');
  controller.stop();
});

test('a lost UDP session switches one physical controller to TCP', async () => {
  const stateStore = new DeviceStateStore();
  let udp: FakeUdpTransport | undefined;
  let tcp: FakeTcpSession | undefined;
  const controller = new DeviceController(device(), {
    stateStore,
    logger,
    createUdpTransport: (_current, hooks) => {
      udp = new FakeUdpTransport(undefined, hooks);
      return udp;
    },
    createTcpQueryTransport: () =>
      new FakeQueryTransport(async () => ({
        power: 'on',
        bright: '20'
      })),
    createTcpSessionTransport: (current, nextGeneration) => {
      tcp = new FakeTcpSession(
        current,
        stateStore,
        nextGeneration
      );
      return tcp;
    }
  });

  try {
    await controller.start();
    udp?.hooks?.onSessionUnavailable(new Error('heartbeat lost'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(udp?.stopped, true);
    assert.equal(tcp?.started, true);
    assert.deepEqual(controller.snapshot(), {
      kind: 'tcp-session',
      generation: 2,
      fallbackReason: 'heartbeat lost'
    });
  } finally {
    controller.stop();
  }
});

test('reconciles confirmed state after a UDP session is recreated', async () => {
  const stateStore = new DeviceStateStore();
  let brightness = '20';
  let udp: FakeUdpTransport | undefined;
  const controller = new DeviceController(device(), {
    stateStore,
    logger,
    createUdpTransport: (_current, hooks) => {
      udp = new FakeUdpTransport(undefined, hooks);
      return udp;
    },
    createTcpQueryTransport: () =>
      new FakeQueryTransport(async () => ({
        power: 'on',
        bright: brightness
      }))
  });

  try {
    await controller.start();
    brightness = '90';
    udp?.hooks?.onSessionReady(2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = stateStore.get('0x20');
    assert.equal(state?.phase, 'connected');
    assert.equal(state?.stale, false);
    assert.equal(state?.properties.bright, '90');
  } finally {
    controller.stop();
  }
});

test('uses an authoritative event without launching a duplicate command query', async () => {
  const stateStore = new DeviceStateStore();
  let queryCount = 0;
  const udp = new FakeUdpTransport(
    undefined,
    undefined,
    (command) => {
      stateStore.applyProps('0x20', 1, {
        bright: String(command.params[0])
      });
    }
  );
  const controller = new DeviceController(device(), {
    stateStore,
    logger,
    createUdpTransport: () => udp,
    createTcpQueryTransport: () =>
      new FakeQueryTransport(async () => {
        queryCount += 1;
        return { power: 'on', bright: '20' };
      })
  });

  try {
    await controller.start();
    await controller.send(setBrightness(73));
    assert.equal(queryCount, 1);
    assert.equal(stateStore.get('0x20')?.properties.bright, '73');
  } finally {
    controller.stop();
  }
});

test('coalesces replaceable commands across Units at device level', async () => {
  const stateStore = new DeviceStateStore();
  let resolveFirstCommand:
    | ((value: Record<string, string>) => void)
    | undefined;
  const firstCommandResult = new Promise<Record<string, string>>(
    (resolve) => {
      resolveFirstCommand = resolve;
    }
  );
  let queryCount = 0;
  const udp = new FakeUdpTransport();
  const controller = new DeviceController(device(), {
    stateStore,
    logger,
    sliderCommandIntervalMs: 0,
    createUdpTransport: () => udp,
    createTcpQueryTransport: () =>
      new FakeQueryTransport(async () => {
        queryCount += 1;
        if (queryCount === 1) {
          return { power: 'on', bright: '20' };
        }
        if (queryCount === 2) {
          return firstCommandResult;
        }
        return { bright: '30' };
      })
  });

  try {
    await controller.start();
    const first = controller.send(setBrightness(10));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = controller.send(setBrightness(20));
    const third = controller.send(setBrightness(30));
    resolveFirstCommand?.({ bright: '10' });
    await Promise.all([first, second, third]);

    assert.deepEqual(
      udp.commands.map((command) => command.params[0]),
      [10, 30]
    );
    assert.equal(stateStore.get('0x20')?.properties.bright, '30');
  } finally {
    controller.stop();
  }
});
