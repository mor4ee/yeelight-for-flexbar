import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DeviceCatalog,
  type PersistedYeelightDevice
} from '../../src/backend/catalog/device-catalog';
import type { YeelightDiscoveryPacket } from '../../src/backend/protocol';

function discoveryPacket(
  overrides: Partial<YeelightDiscoveryPacket> = {}
): YeelightDiscoveryPacket {
  return {
    kind: 'response',
    location: {
      host: '192.168.1.50',
      port: 55443
    },
    deviceId: '0x0000000000000010',
    model: 'ceiling',
    firmwareVersion: '42',
    support: new Set([
      'set_power',
      'set_bright',
      'set_ct_abx',
      'set_hsv',
      'bg_set_power',
      'bg_set_bright',
      'bg_set_rgb',
      'bg_set_hsv'
    ]),
    properties: {
      name: 'Living room',
      power: 'on',
      bright: '70',
      bg_power: 'off',
      bg_bright: '25',
      bg_lmode: '3',
      bg_hue: '180',
      bg_sat: '40'
    },
    headers: {},
    ...overrides
  };
}

test('projects background light as a separate stable logical target', () => {
  const catalog = new DeviceCatalog([], () => 1000);
  catalog.upsert(discoveryPacket(), 'active');
  const snapshot = catalog.snapshot();

  assert.equal(snapshot.devices.length, 1);
  assert.equal(snapshot.targets.length, 2);
  assert.deepEqual(
    snapshot.targets.map((target) => target.targetId),
    [
      '0x0000000000000010:main',
      '0x0000000000000010:background'
    ]
  );
  assert.deepEqual(snapshot.targets[0].capabilities, [
    'power',
    'brightness',
    'colorTemperature',
    'color',
    'saturation'
  ]);
  assert.deepEqual(snapshot.targets[1].capabilities, [
    'power',
    'brightness',
    'color',
    'saturation'
  ]);
  assert.deepEqual(snapshot.targets[1].properties, {
    power: 'off',
    bright: '25',
    lmode: '3',
    color_mode: '3',
    hue: '180',
    sat: '40'
  });
});

test('deduplicates by device id and updates DHCP location', () => {
  let now = 1000;
  const catalog = new DeviceCatalog([], () => now);
  catalog.upsert(discoveryPacket(), 'active');
  now = 2000;
  catalog.upsert(
    discoveryPacket({
      location: {
        host: '192.168.1.77',
        port: 55443
      },
      properties: {
        bright: '90'
      }
    }),
    'passive'
  );

  const snapshot = catalog.snapshot();
  assert.equal(snapshot.devices.length, 1);
  assert.equal(snapshot.devices[0].host, '192.168.1.77');
  assert.equal(snapshot.devices[0].lastSeenAt, 2000);
  assert.equal(snapshot.devices[0].properties.power, 'on');
  assert.equal(snapshot.devices[0].properties.bright, '90');
});

test('restores valid persisted devices and ignores malformed entries', () => {
  const valid: PersistedYeelightDevice = {
    deviceId: '0x20',
    host: '10.0.0.20',
    port: 55443,
    support: ['set_power'],
    properties: {
      power: 'off'
    },
    source: 'manual',
    lastSeenAt: 100
  };
  const catalog = new DeviceCatalog([
    valid,
    {
      ...valid,
      deviceId: 'invalid',
      host: '999.1.1.1'
    },
    {
      ...valid,
      deviceId: '0x21',
      host: '8.8.8.8'
    },
    {
      ...valid,
      deviceId: '0x22',
      host: '127.0.0.1'
    }
  ]);

  assert.equal(catalog.size, 1);
  assert.equal(catalog.snapshot().targets[0].targetId, '0x20:main');
});

test('rejects non-LAN discovery and Station topology endpoints', () => {
  const catalog = new DeviceCatalog([], () => 1000);

  assert.throws(
    () =>
      catalog.upsert(
        discoveryPacket({
          location: {
            host: '8.8.8.8',
            port: 55443
          }
        }),
        'active'
      ),
    /local network/
  );

  assert.throws(
    () =>
      catalog.upsertStation({
        deviceId: '0x20',
        host: '203.0.113.20',
        model: 'color',
        support: ['set_power'],
        properties: { power: 'off' }
      }),
    /Invalid Yeelight Station catalog device/
  );
  assert.equal(catalog.size, 0);
});

test('does not expose the Hue Unit for an rgb-only target', () => {
  const catalog = new DeviceCatalog([], () => 1000);
  catalog.upsert(
    discoveryPacket({
      support: new Set(['set_power', 'set_rgb'])
    }),
    'active'
  );

  assert.deepEqual(catalog.snapshot().targets[0].capabilities, [
    'power'
  ]);
});

test('uses validated Station topology as a first-run catalog source', () => {
  const catalog = new DeviceCatalog([], () => 123);
  const device = catalog.upsertStation({
    deviceId: '0x20',
    host: '192.168.1.20',
    model: 'color',
    support: ['set_power', 'set_bright'],
    properties: { power: 'off', bright: '40' }
  });

  assert.equal(device.source, 'station');
  assert.equal(device.port, 55_443);
  assert.equal(device.lastSeenAt, 123);
  assert.deepEqual(
    catalog.snapshot().targets[0].capabilities,
    ['power', 'brightness']
  );
  assert.equal(
    new DeviceCatalog(catalog.serialize()).serialize()[0].source,
    'station'
  );
});
