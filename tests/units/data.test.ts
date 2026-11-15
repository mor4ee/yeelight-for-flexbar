import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BRIGHTNESS_UNIT_ID,
  COLOR_TEMPERATURE_UNIT_ID,
  POWER_UNIT_ID,
  UnitDataValidationError,
  createDefaultUnitData,
  parseUnitData
} from '../../src/backend/units';

test('creates closed versioned defaults for every control kind', () => {
  assert.deepEqual(createDefaultUnitData(POWER_UNIT_ID), {
    schemaVersion: 1,
    targetId: ''
  });
  assert.deepEqual(createDefaultUnitData(BRIGHTNESS_UNIT_ID), {
    schemaVersion: 1,
    targetId: '',
    minimum: 0,
    maximum: 100
  });
  assert.deepEqual(createDefaultUnitData(COLOR_TEMPERATURE_UNIT_ID), {
    schemaVersion: 1,
    targetId: ''
  });
});

test('normalizes a valid stable target id', () => {
  assert.deepEqual(
    parseUnitData(POWER_UNIT_ID, {
      schemaVersion: 1,
      targetId: '0xABCD:MAIN'
    }),
    {
      schemaVersion: 1,
      targetId: '0xabcd:main'
    }
  );
});

test('rejects unsupported fields in the closed schema', () => {
  assert.throws(
    () =>
      parseUnitData(POWER_UNIT_ID, {
        schemaVersion: 1,
        targetId: '',
        deviceName: 'Desk'
      }),
    UnitDataValidationError
  );
});

test('enforces the configurable brightness range', () => {
  assert.deepEqual(
    parseUnitData(BRIGHTNESS_UNIT_ID, {
      schemaVersion: 1,
      targetId: '0x1:background',
      minimum: 15,
      maximum: 85
    }),
    {
      schemaVersion: 1,
      targetId: '0x1:background',
      minimum: 15,
      maximum: 85
    }
  );

  for (const [minimum, maximum] of [
    [0, 0],
    [100, 100],
    [80, 20],
    [-1, 100],
    [0, 101],
    [0.5, 100]
  ]) {
    assert.throws(
      () =>
        parseUnitData(BRIGHTNESS_UNIT_ID, {
          schemaVersion: 1,
          targetId: '',
          minimum,
          maximum
        }),
      UnitDataValidationError
    );
  }
});
