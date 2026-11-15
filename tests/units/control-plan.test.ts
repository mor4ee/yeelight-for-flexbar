import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  YeelightLogicalTarget,
  YeelightTargetDomain
} from '../../src/backend/catalog/device-catalog';
import {
  createPowerControlPlan,
  createSliderControlPlan,
  UnitControlError,
  type ConfirmedTargetContext
} from '../../src/backend/units/control-plan';
import {
  BRIGHTNESS_UNIT_ID,
  COLOR_TEMPERATURE_UNIT_ID,
  COLOR_UNIT_ID,
  SATURATION_UNIT_ID
} from '../../src/backend/units/contracts';

function target(
  domain: YeelightTargetDomain = 'main'
): YeelightLogicalTarget {
  return {
    targetId: `0x10:${domain}`,
    deviceId: '0x10',
    domain,
    name: 'Test lamp',
    host: '192.168.1.50',
    port: 55443,
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

function context(
  properties: Record<string, string>,
  domain: YeelightTargetDomain = 'main',
  support = [
    'set_power',
    'toggle',
    'set_bright',
    'set_ct_abx',
    'set_hsv'
  ]
): ConfirmedTargetContext {
  return {
    target: target(domain),
    properties,
    supportedMethods: new Set(
      domain === 'background'
        ? support.map((method) => `bg_${method}`)
        : support
    )
  };
}

test('maps the complete Brightness slider width to its configured range', () => {
  const data = {
    schemaVersion: 1,
    targetId: '0x10:main',
    minimum: 20,
    maximum: 80
  };

  const left = createSliderControlPlan(
    BRIGHTNESS_UNIT_ID,
    data,
    0,
    context({ power: 'on', bright: '50' })
  );
  const right = createSliderControlPlan(
    BRIGHTNESS_UNIT_ID,
    data,
    1,
    context({ power: 'on', bright: '50' })
  );

  assert.deepEqual(left.commands[0].params, [20, 'smooth', 500]);
  assert.deepEqual(right.commands[0].params, [80, 'smooth', 500]);
  assert.equal(left.preview?.position, 0);
  assert.equal(right.preview?.position, 1);
});

test('uses power off instead of the invalid set_bright zero command', () => {
  const data = {
    schemaVersion: 1,
    targetId: '0x10:main',
    minimum: 0,
    maximum: 100
  };
  const plan = createSliderControlPlan(
    BRIGHTNESS_UNIT_ID,
    data,
    0,
    context({ power: 'on', bright: '25' })
  );

  assert.equal(plan.preview?.off, true);
  assert.equal(plan.preview?.displayText, 'OFF');
  assert.deepEqual(
    plan.commands.map((command) => command.method),
    ['set_power']
  );
  assert.equal(
    plan.commands.some(
      (command) =>
        command.method === 'set_bright' && command.params[0] === 0
    ),
    false
  );
});

test('turns an off lamp on before setting a positive brightness', () => {
  const plan = createSliderControlPlan(
    BRIGHTNESS_UNIT_ID,
    {
      schemaVersion: 1,
      targetId: '0x10:main',
      minimum: 0,
      maximum: 100
    },
    0.5,
    context({ power: 'off', bright: '25' })
  );

  assert.deepEqual(
    plan.commands.map((command) => command.method),
    ['set_power', 'set_bright']
  );
  assert.equal(plan.commands[1].params[0], 50);
});

test('uses the full protocol range when no device temperature range is advertised', () => {
  const data = {
    schemaVersion: 1,
    targetId: '0x10:main'
  };
  const left = createSliderControlPlan(
    COLOR_TEMPERATURE_UNIT_ID,
    data,
    0,
    context({ power: 'on', ct: '4000' })
  );
  const right = createSliderControlPlan(
    COLOR_TEMPERATURE_UNIT_ID,
    data,
    1,
    context({ power: 'on', ct: '4000' })
  );

  assert.equal(left.commands[0].params[0], 1700);
  assert.equal(right.commands[0].params[0], 6500);
});

test('maps Color Temperature across the device-advertised range', () => {
  const data = {
    schemaVersion: 1,
    targetId: '0x10:main'
  };
  const properties = {
    power: 'on',
    ct: '4000',
    min_ct: '2700',
    max_ct: '6500'
  };

  const left = createSliderControlPlan(
    COLOR_TEMPERATURE_UNIT_ID,
    data,
    0,
    context(properties)
  );
  const right = createSliderControlPlan(
    COLOR_TEMPERATURE_UNIT_ID,
    data,
    1,
    context(properties)
  );

  assert.equal(left.commands[0].params[0], 2700);
  assert.equal(right.commands[0].params[0], 6500);
});

test('preserves confirmed saturation when Hue changes', () => {
  const plan = createSliderControlPlan(
    COLOR_UNIT_ID,
    {
      schemaVersion: 1,
      targetId: '0x10:main'
    },
    0.5,
    context({ power: 'on', hue: '10', sat: '37' })
  );

  assert.equal(plan.commands[0].method, 'set_hsv');
  assert.deepEqual(plan.commands[0].params, [
    180,
    37,
    'smooth',
    500
  ]);
});

test('preserves confirmed Hue when Saturation changes', () => {
  const plan = createSliderControlPlan(
    SATURATION_UNIT_ID,
    {
      schemaVersion: 1,
      targetId: '0x10:main'
    },
    0.64,
    context({ power: 'on', hue: '214', sat: '10' })
  );

  assert.deepEqual(plan.commands[0].params, [
    214,
    64,
    'smooth',
    500
  ]);
});

test('does not invent a missing paired HSV property', () => {
  assert.throws(
    () =>
      createSliderControlPlan(
        COLOR_UNIT_ID,
        {
          schemaVersion: 1,
          targetId: '0x10:main'
        },
        0.5,
        context({ power: 'on', hue: '10' })
      ),
    (error) =>
      error instanceof UnitControlError &&
      error.code === 'MISSING_CONFIRMED_STATE'
  );
});

test('uses advertised background toggle when set_power is unavailable', () => {
  const plan = createPowerControlPlan(
    {
      schemaVersion: 1,
      targetId: '0x10:background'
    },
    context({ power: 'off' }, 'background', ['toggle'])
  );

  assert.equal(plan.commands[0].method, 'bg_toggle');
});

test('uses the confirmed scene to power on a lamp15 background target', () => {
  const targetContext = context(
    {
      power: 'off',
      bright: '48',
      color_mode: '3',
      hue: '210',
      sat: '65'
    },
    'background',
    ['set_power', 'set_scene']
  );
  targetContext.target.model = 'lamp15';

  const plan = createPowerControlPlan(
    {
      schemaVersion: 1,
      targetId: '0x10:background'
    },
    targetContext
  );

  assert.deepEqual(plan.commands, [
    {
      method: 'bg_set_scene',
      params: ['hsv', 210, 65, 48]
    }
  ]);
});

test('rejects coordinates outside the normalized custom Unit contract', () => {
  assert.throws(
    () =>
      createSliderControlPlan(
        SATURATION_UNIT_ID,
        {
          schemaVersion: 1,
          targetId: '0x10:main'
        },
        42,
        context({ hue: '10', sat: '10' })
      ),
    (error) =>
      error instanceof UnitControlError &&
      error.code === 'INVALID_POSITION'
  );
});
