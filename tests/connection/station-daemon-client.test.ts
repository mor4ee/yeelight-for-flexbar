import assert from 'node:assert/strict';
import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket
} from 'node:net';
import test from 'node:test';
import type { PersistedYeelightDevice } from '../../src/backend/catalog/device-catalog';
import { StationDaemonClient } from '../../src/backend/connection/station-daemon-client';
import { setBrightness, setHsv } from '../../src/backend/protocol';

interface TestDaemon {
  server: Server;
  port: number;
  sockets: Set<Socket>;
  requests: Record<string, unknown>[];
  setBrightness(value: number): void;
  push(): void;
}

const persistedDevice: PersistedYeelightDevice = {
  deviceId: '0x20',
  host: '192.168.1.20',
  port: 55_443,
  model: 'color',
  support: ['get_prop', 'set_bright'],
  properties: {},
  source: 'active',
  lastSeenAt: 1
};

function topologyNode(
  brightness: number,
  rgb: number,
  colorMode: number
): Record<string, unknown> {
  return {
    id: 1,
    did: '0x20',
    ip: '192.168.1.20',
    model: 'color',
    connected: true,
    registered: true,
    support: 'get_prop set_bright',
    power: 'on',
    bright: brightness,
    color_mode: colorMode,
    ct: 4000,
    hue: 10,
    rgb,
    sat: 10,
    allowctrl: 1
  };
}

async function startDaemon(): Promise<TestDaemon> {
  let brightness = 20;
  let rgb = 0xff_00_00;
  let colorMode = 1;
  const sockets = new Set<Socket>();
  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const boundary = buffer.indexOf('\r\n');
        if (boundary < 0) {
          break;
        }
        const request = JSON.parse(
          buffer.slice(0, boundary)
        ) as Record<string, unknown>;
        buffer = buffer.slice(boundary + 2);
        requests.push(request);
        const id = request.id;
        if (request.method === 'get.topology') {
          socket.write(
            `${JSON.stringify({
              id,
              method: 'get.topology',
              nodes: [topologyNode(brightness, rgb, colorMode)]
            })}\r\n`
          );
        } else {
          const nodes = request.nodes as Array<{
            params: [number, ...unknown[]];
          }>;
          if (request.method === 'set_bright') {
            brightness = Number(nodes[0].params[0]);
          } else if (request.method === 'set_rgb') {
            rgb = Number(nodes[0].params[0]);
            colorMode = 1;
          }
          socket.write(
            `${JSON.stringify({
              id,
              method: request.method,
              result: 'ok'
            })}\r\n`
          );
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    sockets,
    requests,
    setBrightness(value): void {
      brightness = value;
    },
    push(): void {
      const frame = `${JSON.stringify({
        method: 'set.toplogy',
        nodes: [topologyNode(brightness, rgb, colorMode)]
      })}\r\n`;
      for (const socket of sockets) {
        socket.write(frame);
      }
    }
  };
}

async function stopDaemon(daemon: TestDaemon): Promise<void> {
  for (const socket of daemon.sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => daemon.server.close(() => resolve()));
}

test('validates topology and sends the Station command envelope', async () => {
  const daemon = await startDaemon();
  const client = new StationDaemonClient({
    port: daemon.port,
    pollIntervalMs: 0
  });
  try {
    assert.equal(await client.start(), true);
    assert.deepEqual(client.findDevice(persistedDevice)?.properties, {
      allowctrl: '1',
      bright: '20',
      color_mode: '1',
      ct: '4000',
      hue: '0',
      power: 'on',
      rgb: '16711680',
      sat: '100'
    });

    const confirmed = await client.send(
      persistedDevice,
      setBrightness(73)
    );
    assert.equal(confirmed.properties.bright, '73');
    assert.deepEqual(daemon.requests[1], {
      id: 2,
      method: 'set_bright',
      nodes: [{ did: '0x20', params: [73, 'smooth', 500] }]
    });
    assert.equal(daemon.requests[2].method, 'get.topology');
  } finally {
    client.stop();
    await stopDaemon(daemon);
  }
});

test('accepts set.toplogy as retained confirmed state', async () => {
  const daemon = await startDaemon();
  const client = new StationDaemonClient({
    port: daemon.port,
    pollIntervalMs: 0
  });
  try {
    assert.equal(await client.start(), true);
    const updated = new Promise<void>((resolve) => {
      const unsubscribe = client.subscribe((event) => {
        if (
          event.kind === 'topology' &&
          event.devices[0]?.properties.bright === '61'
        ) {
          unsubscribe();
          resolve();
        }
      });
    });
    daemon.setBrightness(61);
    daemon.push();
    await updated;
    assert.equal(
      client.findDevice(persistedDevice)?.properties.bright,
      '61'
    );
  } finally {
    client.stop();
    await stopDaemon(daemon);
  }
});

test('maps Station HSV control through confirmed RGB topology', async () => {
  const daemon = await startDaemon();
  const client = new StationDaemonClient({
    port: daemon.port,
    pollIntervalMs: 0
  });
  try {
    assert.equal(await client.start(), true);
    const confirmed = await client.send(
      persistedDevice,
      setHsv(349, 94)
    );
    assert.equal(daemon.requests[1].method, 'set_rgb');
    assert.equal(confirmed.properties.hue, '349');
    assert.equal(confirmed.properties.sat, '94');
  } finally {
    client.stop();
    await stopDaemon(daemon);
  }
});

test('reconciles external changes with one shared topology poll', async () => {
  const daemon = await startDaemon();
  const client = new StationDaemonClient({
    port: daemon.port,
    pollIntervalMs: 10
  });
  try {
    assert.equal(await client.start(), true);
    let topologyEvents = 0;
    const updated = new Promise<void>((resolve) => {
      const unsubscribe = client.subscribe((event) => {
        if (event.kind === 'topology') {
          topologyEvents += 1;
        }
        if (
          event.kind === 'topology' &&
          event.devices[0]?.properties.bright === '64'
        ) {
          unsubscribe();
          resolve();
        }
      });
    });
    daemon.setBrightness(64);
    await updated;
    assert.equal(
      client.findDevice(persistedDevice)?.properties.bright,
      '64'
    );
    assert.equal(topologyEvents, 1);
  } finally {
    client.stop();
    await stopDaemon(daemon);
  }
});

test('rejects an incompatible service without sending a command', async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (data) => {
      const request = JSON.parse(
        data.toString('utf8').trim()
      ) as { id: number };
      socket.write(
        `${JSON.stringify({
          id: request.id,
          result: 'not-station'
        })}\r\n`
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve)
  );
  const client = new StationDaemonClient({
    port: (server.address() as AddressInfo).port,
    pollIntervalMs: 0
  });
  try {
    assert.equal(await client.start(), false);
    await assert.rejects(
      client.send(persistedDevice, setBrightness(73)),
      /unavailable/
    );
  } finally {
    client.stop();
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
