import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PersistedYeelightDevice,
  YeelightLogicalTarget
} from '../../src/backend/catalog/device-catalog';
import { YeelightConnection } from '../../src/backend/connection/yeelight-connection';
import { DeviceStateStore } from '../../src/backend/state/device-state-store';
import {
  createSliderControlPlan,
  type ConfirmedTargetContext
} from '../../src/backend/units/control-plan';
import {
  BRIGHTNESS_UNIT_ID,
  COLOR_UNIT_ID
} from '../../src/backend/units/contracts';
import { MockYeelightServer } from './mock-yeelight-server';

const support = [
  'get_prop',
  'set_power',
  'toggle',
  'set_bright',
  'set_ct_abx',
  'set_rgb',
  'set_hsv'
];

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function target(host: string, port: number): YeelightLogicalTarget {
  return {
    targetId: '0x10:main',
    deviceId: '0x10',
    domain: 'main',
    name: 'Mock Yeelight',
    host,
    port,
    capabilities: [
      'power',
      'brightness',
      'colorTemperature',
      'color',
      'saturation'
    ],
    properties: {},
    online: true,
    lastSeenAt: 1
  };
}

test('controls and rehydrates a Yeelight over a real loopback TCP socket', async () => {
  const server = new MockYeelightServer();
  const endpoint = await server.start();
  const stateStore = new DeviceStateStore();
  const device: PersistedYeelightDevice = {
    deviceId: '0x10',
    host: endpoint.host,
    port: endpoint.port,
    model: 'color',
    support,
    properties: {},
    source: 'manual',
    lastSeenAt: 1
  };
  const connection = new YeelightConnection(device, {
    stateStore,
    logger: {
      debug() {},
      warn() {}
    },
    connectTimeoutMs: 200,
    requestTimeoutMs: 200,
    confirmationTimeoutMs: 50,
    reconnectBaseMs: 5,
    reconnectMaximumMs: 10,
    random: () => 0.5
  });

  try {
    connection.start();
    await waitFor(
      () => stateStore.get('0x10')?.phase === 'connected',
      'initial hydrate'
    );
    assert.equal(stateStore.get('0x10')?.stale, false);
    assert.equal(stateStore.get('0x10')?.properties.power, 'off');

    const initialContext: ConfirmedTargetContext = {
      target: target(endpoint.host, endpoint.port),
      properties: {
        power: 'off',
        bright: '25',
        hue: '0',
        sat: '70'
      },
      supportedMethods: new Set(support)
    };
    const brightness = createSliderControlPlan(
      BRIGHTNESS_UNIT_ID,
      {
        schemaVersion: 1,
        targetId: '0x10:main',
        minimum: 0,
        maximum: 100
      },
      0.6,
      initialContext
    );
    for (const command of brightness.commands) {
      await connection.send(command);
    }

    assert.equal(stateStore.get('0x10')?.properties.power, 'on');
    assert.equal(stateStore.get('0x10')?.properties.bright, '60');
    assert.deepEqual(
      server.receivedMethods.slice(0, 3),
      ['get_prop', 'set_power', 'set_bright']
    );

    server.notify({
      hue: '210',
      sat: '44'
    });
    await waitFor(
      () => stateStore.get('0x10')?.properties.hue === '210',
      'external props notification'
    );

    const previousGeneration =
      stateStore.get('0x10')?.generation ?? 0;
    server.dropConnections();
    await waitFor(
      () =>
        (stateStore.get('0x10')?.generation ?? 0) >
          previousGeneration &&
        stateStore.get('0x10')?.phase === 'connected' &&
        stateStore.get('0x10')?.stale === false,
      'reconnect hydrate'
    );

    const rehydrated = stateStore.get('0x10')!;
    const color = createSliderControlPlan(
      COLOR_UNIT_ID,
      {
        schemaVersion: 1,
        targetId: '0x10:main'
      },
      0.25,
      {
        target: target(endpoint.host, endpoint.port),
        properties: {
          power: rehydrated.properties.power,
          hue: rehydrated.properties.hue,
          sat: rehydrated.properties.sat
        },
        supportedMethods: new Set(support)
      }
    );
    await connection.send(color.commands[0]);

    assert.equal(stateStore.get('0x10')?.properties.hue, '90');
    assert.equal(stateStore.get('0x10')?.properties.sat, '44');
    assert.ok(
      server.receivedMethods.filter((method) => method === 'get_prop')
        .length >= 2
    );
  } finally {
    connection.stop();
    await server.stop();
  }
});
