import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BRIGHTNESS_UNIT_ID,
  POWER_UNIT_ID,
  migrateUnitData,
  migrateYeelightUnit
} from '../../src/backend/units';

test('leaves canonical current data unchanged', () => {
  assert.equal(
    migrateUnitData(BRIGHTNESS_UNIT_ID, {
      schemaVersion: 1,
      targetId: '0x1:main',
      minimum: 0,
      maximum: 100
    }),
    undefined
  );
});

test('migrates a physical device id to the stable main target', () => {
  assert.deepEqual(
    migrateUnitData(POWER_UNIT_ID, {
      schemaVersion: 0,
      deviceId: '0xABC'
    }),
    {
      schemaVersion: 1,
      targetId: '0xabc:main'
    }
  );
});

test('migrates legacy brightness aliases into the closed schema', () => {
  assert.deepEqual(
    migrateUnitData(BRIGHTNESS_UNIT_ID, {
      target: '0x2:BACKGROUND',
      minBrightness: 15.4,
      maxBrightness: 85.2,
      obsolete: true
    }),
    {
      schemaVersion: 1,
      targetId: '0x2:background',
      minimum: 15,
      maximum: 85
    }
  );
});

test('falls back to the full brightness range for an invalid legacy range', () => {
  assert.deepEqual(
    migrateUnitData(BRIGHTNESS_UNIT_ID, {
      targetId: '0x3:main',
      min: 90,
      max: 20
    }),
    {
      schemaVersion: 1,
      targetId: '0x3:main',
      minimum: 0,
      maximum: 100
    }
  );
});

test('canonicalizes casing and returns a data-only host migration', () => {
  assert.deepEqual(
    migrateYeelightUnit({
      unitId: POWER_UNIT_ID,
      originalUnit: {
        data: {
          schemaVersion: 1,
          targetId: '0xABC:MAIN'
        }
      }
    }),
    {
      data: {
        schemaVersion: 1,
        targetId: '0xabc:main'
      }
    }
  );
});

test('ignores units owned by another definition', () => {
  assert.equal(
    migrateYeelightUnit({
      unitId: '@other/plugin/unit',
      originalUnit: {
        data: {}
      }
    }),
    undefined
  );
});
