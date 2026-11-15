import assert from 'node:assert/strict';
import test from 'node:test';
import type { PersistedYeelightDevice } from '../../src/backend/catalog/device-catalog';
import { ConnectionManager } from '../../src/backend/connection/connection-manager';
import {
  calculateReconnectDelay,
  YeelightConnection
} from '../../src/backend/connection/yeelight-connection';
import {
  setPower,
  setRgb,
  type YeelightWireCommand
} from '../../src/backend/protocol';
import { DeviceStateStore } from '../../src/backend/state/device-state-store';

type Handler = (...args: any[]) => void;

class FakeTcpSocket {
  readonly writes: Buffer[] = [];
  destroyed = false;
  private readonly handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  write(
    data: Buffer,
    callback?: (error?: Error | null) => void
  ): boolean {
    this.writes.push(Buffer.from(data));
    callback?.(null);
    return true;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  setTimeout(): this {
    return this;
  }

  destroy(error?: Error): this {
    if (this.destroyed) {
      return this;
    }
    this.destroyed = true;
    if (error) {
      this.emit('error', error);
    }
    this.emit('close', Boolean(error));
    return this;
  }

  connect(): void {
    this.emit('connect');
  }

  receive(message: object): void {
    this.emit('data', Buffer.from(`${JSON.stringify(message)}\r\n`, 'utf8'));
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

function device(
  overrides: Partial<PersistedYeelightDevice> = {}
): PersistedYeelightDevice {
  return {
    deviceId: '0x10',
    host: '192.168.1.50',
    port: 55443,
    model: 'color',
    firmwareVersion: '42',
    support: [
      'get_prop',
      'set_power',
      'set_bright',
      'set_ct_abx',
      'set_rgb',
      'set_hsv'
    ],
    properties: {
      power: 'off',
      bright: '20'
    },
    source: 'active',
    lastSeenAt: 100,
    ...overrides
  };
}

function wireCommand(socket: FakeTcpSocket, index: number): YeelightWireCommand {
  return JSON.parse(socket.writes[index].toString('utf8').trim());
}

async function waitFor(
  predicate: () => boolean,
  message = 'condition'
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function hydrateResult(
  power: string,
  brightness: string
): string[] {
  return [
    power,
    brightness,
    '2',
    '4000',
    '',
    '',
    '',
    '0',
    '0',
    '0',
    'Test lamp',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    ''
  ];
}

async function hydrate(
  socket: FakeTcpSocket,
  power = 'on',
  brightness = '75'
): Promise<void> {
  socket.connect();
  await waitFor(() => socket.writes.length >= 1, 'hydrate request');
  const command = wireCommand(socket, 0);
  assert.equal(command.method, 'get_prop');
  socket.receive({
    id: command.id,
    result: hydrateResult(power, brightness)
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const logger = {
  debug() {},
  warn() {}
};

test('hydrates state, applies props and does not treat result as state', async () => {
  const stateStore = new DeviceStateStore();
  const socket = new FakeTcpSocket();
  const connection = new YeelightConnection(device(), {
    stateStore,
    logger,
    createSocket: () => socket
  });

  connection.start();
  await hydrate(socket);

  assert.equal(stateStore.get('0x10')?.phase, 'connected');
  assert.equal(stateStore.get('0x10')?.stale, false);
  assert.equal(stateStore.get('0x10')?.properties.power, 'on');
  assert.equal(stateStore.get('0x10')?.properties.bright, '75');

  const commandResult = connection.send(setPower(false));
  await waitFor(() => socket.writes.length >= 2, 'power command');
  const command = wireCommand(socket, 1);
  socket.receive({
    id: command.id,
    result: ['ok']
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stateStore.get('0x10')?.properties.power, 'on');

  socket.receive({
    method: 'props',
    params: {
      power: 'off'
    }
  });
  assert.deepEqual(await commandResult, ['ok']);
  assert.equal(stateStore.get('0x10')?.properties.power, 'off');

  connection.stop();
});

test('refuses unsupported commands even on a confirmed connection', async () => {
  const stateStore = new DeviceStateStore();
  const socket = new FakeTcpSocket();
  const connection = new YeelightConnection(
    device({
      support: ['get_prop', 'set_power']
    }),
    {
      stateStore,
      logger,
      createSocket: () => socket
    }
  );

  connection.start();
  await hydrate(socket);

  await assert.rejects(connection.send(setRgb(0xff0000)));
  connection.stop();
});

test('uses targeted get_prop when a command notification is missing', async () => {
  const stateStore = new DeviceStateStore();
  const socket = new FakeTcpSocket();
  const connection = new YeelightConnection(device(), {
    stateStore,
    logger,
    createSocket: () => socket,
    confirmationTimeoutMs: 5
  });
  connection.start();
  await hydrate(socket, 'on', '50');

  const result = connection.send(setPower(false));
  await waitFor(() => socket.writes.length >= 2, 'power command');
  const command = wireCommand(socket, 1);
  socket.receive({
    id: command.id,
    result: ['ok']
  });
  await waitFor(() => socket.writes.length >= 3, 'confirmation get_prop');
  const confirmation = wireCommand(socket, 2);
  assert.equal(confirmation.method, 'get_prop');
  assert.deepEqual(confirmation.params, ['power']);
  socket.receive({
    id: confirmation.id,
    result: ['off']
  });

  assert.deepEqual(await result, ['ok']);
  assert.equal(stateStore.get('0x10')?.properties.power, 'off');
  connection.stop();
});

test('marks accepted TCP commands stale when targeted state is unchanged', async () => {
  const stateStore = new DeviceStateStore();
  const socket = new FakeTcpSocket();
  const connection = new YeelightConnection(device(), {
    stateStore,
    logger,
    createSocket: () => socket,
    confirmationTimeoutMs: 5
  });
  connection.start();
  await hydrate(socket, 'on', '50');

  const result = connection.send(setPower(false));
  await waitFor(() => socket.writes.length >= 2, 'power command');
  const command = wireCommand(socket, 1);
  socket.receive({
    id: command.id,
    result: ['ok']
  });
  await waitFor(() => socket.writes.length >= 3, 'confirmation get_prop');
  const confirmation = wireCommand(socket, 2);
  socket.receive({
    id: confirmation.id,
    result: ['on']
  });

  await assert.rejects(result, /not confirmed/);
  const state = stateStore.get('0x10');
  assert.equal(state?.properties.power, 'on');
  assert.equal(state?.stale, true);
  assert.deepEqual(state?.staleProperties, ['power']);
  connection.stop();
});

test('reconnects with a new generation and ignores the old socket', async () => {
  const stateStore = new DeviceStateStore();
  const sockets: FakeTcpSocket[] = [];
  const endpoints: string[] = [];
  const connection = new YeelightConnection(device(), {
    stateStore,
    logger,
    createSocket: (host, port) => {
      endpoints.push(`${host}:${port}`);
      const socket = new FakeTcpSocket();
      sockets.push(socket);
      return socket;
    },
    reconnectBaseMs: 1,
    reconnectMaximumMs: 1,
    random: () => 0.5
  });

  connection.start();
  await hydrate(sockets[0], 'on', '50');
  const firstRevision = stateStore.get('0x10')!.revision;

  connection.updateDevice(
    device({
      host: '192.168.1.77',
      properties: {
        power: 'on',
        bright: '50'
      }
    })
  );
  await waitFor(() => sockets.length === 2, 'replacement connection');
  assert.deepEqual(endpoints, [
    '192.168.1.50:55443',
    '192.168.1.77:55443'
  ]);
  assert.equal(stateStore.get('0x10')?.generation, 2);
  assert.equal(stateStore.get('0x10')?.stale, true);

  sockets[0].receive({
    method: 'props',
    params: {
      bright: '1'
    }
  });
  assert.equal(stateStore.get('0x10')?.properties.bright, '50');
  assert.ok(stateStore.get('0x10')!.revision > firstRevision);

  await hydrate(sockets[1], 'on', '80');
  assert.equal(stateStore.get('0x10')?.generation, 2);
  assert.equal(stateStore.get('0x10')?.stale, false);
  assert.equal(stateStore.get('0x10')?.properties.bright, '80');
  connection.stop();
});

test('connection manager keeps one TCP client per device id', () => {
  const sockets: FakeTcpSocket[] = [];
  const manager = new ConnectionManager({
    logger,
    stationClient: false,
    connectionOptions: {
      createSocket: () => {
        const socket = new FakeTcpSocket();
        sockets.push(socket);
        return socket;
      }
    }
  });

  manager.upsertDevice(device());
  manager.upsertDevice(
    device({
      properties: {
        bright: '40'
      }
    })
  );

  assert.equal(manager.size, 1);
  assert.equal(sockets.length, 1);
  manager.stop();
});

test('reconnect delay applies exponential backoff, jitter and hard maximum', () => {
  assert.equal(calculateReconnectDelay(0, 500, 30_000, 0), 400);
  assert.equal(calculateReconnectDelay(1, 500, 30_000, 0.5), 1000);
  assert.equal(calculateReconnectDelay(20, 500, 30_000, 1), 30_000);
});
