import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  YeelightCatalogSnapshot,
  YeelightLogicalTarget,
  YeelightPhysicalDevice
} from '../../src/backend/catalog/device-catalog';
import type { YeelightRuntimeSnapshot } from '../../src/backend/state/device-state-store';
import {
  mergeCatalogRuntime,
  normalizeV1UiRequest,
  unwrapV1ConfigPayload
} from '../../src/v1/catalog-runtime';

const physicalDevice: YeelightPhysicalDevice = {
  deviceId: '0x0000000000000001',
  host: '192.168.1.42',
  port: 55443,
  model: 'colorb',
  support: ['get_prop', 'set_power', 'bg_set_power'],
  properties: {},
  source: 'active',
  lastSeenAt: 1,
  online: false
};

function target(
  domain: 'main' | 'background'
): YeelightLogicalTarget {
  return {
    targetId: `${physicalDevice.deviceId}:${domain}`,
    deviceId: physicalDevice.deviceId,
    domain,
    name: 'Desk lamp',
    host: physicalDevice.host,
    port: physicalDevice.port,
    model: physicalDevice.model,
    capabilities: ['power'],
    properties: {},
    online: false,
    lastSeenAt: 1
  };
}

test('normalizes the real FlexDesigner v1 UI message envelope', () => {
  assert.deepEqual(
    normalizeV1UiRequest({
      data: {
        action: 'yeelight.manual.add',
        address: '192.168.1.42'
      }
    }),
    {
      action: 'yeelight.manual.add',
      address: '192.168.1.42',
      deviceId: undefined
    }
  );
  assert.throws(
    () => normalizeV1UiRequest({ data: {} }),
    /include an action/
  );
});

test('unwraps direct and host-wrapped v1 plugin config payloads', () => {
  const config = {
    schemaVersion: 1,
    manualAddresses: [],
    catalog: []
  };
  assert.equal(unwrapV1ConfigPayload(config), config);
  assert.equal(unwrapV1ConfigPayload({ config }), config);
  assert.equal(unwrapV1ConfigPayload({ result: config }), config);
});

test('projects confirmed runtime state into main and background targets', () => {
  const catalog: YeelightCatalogSnapshot = {
    revision: 1,
    devices: [structuredClone(physicalDevice)],
    targets: [target('main'), target('background')]
  };
  const runtime: YeelightRuntimeSnapshot = {
    revision: 4,
    devices: [
      {
        deviceId: physicalDevice.deviceId,
        generation: 2,
        revision: 3,
        phase: 'connected',
        stale: false,
        staleProperties: [],
        activeTransport: 'tcp-session',
        pendingCommands: [],
        properties: {
          power: 'on',
          bright: '75',
          bg_power: 'off',
          bg_bright: '20',
          bg_lmode: '3'
        },
        updatedAt: 2
      }
    ]
  };

  const merged = mergeCatalogRuntime(catalog, runtime);

  assert.equal(merged.devices[0].online, true);
  assert.equal(merged.devices[0].properties.bg_bright, '20');
  assert.equal(
    merged.devices[0].connection?.activeTransport,
    'tcp-session'
  );
  assert.equal(
    merged.devices[0].connection?.pendingCommandCount,
    0
  );
  assert.deepEqual(merged.targets[0].properties, {
    power: 'on',
    bright: '75'
  });
  assert.deepEqual(merged.targets[1].properties, {
    power: 'off',
    bright: '20',
    lmode: '3',
    color_mode: '3'
  });
  assert.equal(merged.targets[0].connection?.generation, 2);
  assert.equal(catalog.devices[0].online, false);
});

test('keeps a connected target online while one property is stale', () => {
  const catalog: YeelightCatalogSnapshot = {
    revision: 1,
    devices: [structuredClone(physicalDevice)],
    targets: [target('main')]
  };
  const runtime: YeelightRuntimeSnapshot = {
    revision: 2,
    devices: [
      {
        deviceId: physicalDevice.deviceId,
        generation: 1,
        revision: 2,
        phase: 'connected',
        stale: true,
        staleProperties: ['ct'],
        activeTransport: 'station-daemon',
        pendingCommands: [],
        properties: { power: 'on', ct: '2700' },
        updatedAt: 2,
        lastError: 'command was not confirmed'
      }
    ]
  };

  const merged = mergeCatalogRuntime(catalog, runtime);

  assert.equal(merged.devices[0].online, true);
  assert.equal(merged.targets[0].online, true);
  assert.equal(merged.targets[0].connection?.stale, true);
});
