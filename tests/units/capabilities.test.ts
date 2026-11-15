import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  YeelightControlCapability,
  YeelightLogicalTarget
} from '../../src/backend/catalog/device-catalog';
import {
  BRIGHTNESS_UNIT_ID,
  COLOR_TEMPERATURE_UNIT_ID,
  COLOR_UNIT_ID,
  POWER_UNIT_ID,
  SATURATION_UNIT_ID,
  filterCompatibleTargets,
  isTargetCompatible,
  requiredCapabilityForUnit
} from '../../src/backend/units';

function target(
  targetId: string,
  capabilities: YeelightControlCapability[],
  online = true
): YeelightLogicalTarget {
  return {
    targetId,
    deviceId: targetId.split(':')[0],
    domain: targetId.endsWith(':background') ? 'background' : 'main',
    name: targetId,
    host: '192.168.1.20',
    port: 55443,
    capabilities,
    properties: {},
    online,
    lastSeenAt: 1
  };
}

test('maps every Unit to its required Yeelight capability', () => {
  assert.equal(requiredCapabilityForUnit(POWER_UNIT_ID), 'power');
  assert.equal(requiredCapabilityForUnit(BRIGHTNESS_UNIT_ID), 'brightness');
  assert.equal(
    requiredCapabilityForUnit(COLOR_TEMPERATURE_UNIT_ID),
    'colorTemperature'
  );
  assert.equal(requiredCapabilityForUnit(COLOR_UNIT_ID), 'color');
  assert.equal(requiredCapabilityForUnit(SATURATION_UNIT_ID), 'saturation');
  assert.equal(requiredCapabilityForUnit('unknown'), undefined);
});

test('filters device selectors by the selected Unit function', () => {
  const targets = [
    target('0x1:main', ['power', 'brightness', 'colorTemperature']),
    target('0x2:main', ['power', 'color', 'saturation']),
    target('0x2:background', ['power', 'color', 'saturation'], false)
  ];

  assert.deepEqual(
    filterCompatibleTargets(COLOR_TEMPERATURE_UNIT_ID, targets).map(
      (entry) => entry.targetId
    ),
    ['0x1:main']
  );
  assert.deepEqual(
    filterCompatibleTargets(SATURATION_UNIT_ID, targets).map(
      (entry) => entry.targetId
    ),
    ['0x2:main', '0x2:background']
  );
  assert.equal(isTargetCompatible(BRIGHTNESS_UNIT_ID, targets[0]), true);
  assert.equal(isTargetCompatible(BRIGHTNESS_UNIT_ID, targets[1]), false);
});
