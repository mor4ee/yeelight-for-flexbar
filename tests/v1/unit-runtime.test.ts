import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  KeyData,
  PluginDataPayload
} from '@eniac/flexdesigner/dist/types.js';
import type { YeelightCommand } from '../../src/backend/protocol';
import {
  BRIGHTNESS_UNIT_ID,
  COLOR_TEMPERATURE_UNIT_ID,
  COLOR_UNIT_ID,
  POWER_UNIT_ID,
  SATURATION_UNIT_ID,
  type YeelightUnitId
} from '../../src/backend/units/contracts';
import type { ConfirmedTargetContext } from '../../src/backend/units/control-plan';
import {
  V1_CONTROL_CIDS,
  YeelightV1UnitRuntime,
  confirmedSliderPosition,
  isAmbiguousStationConfirmationFailure,
  nativeSliderPosition,
  nativeSliderWidth,
  type V1UnitRuntimeHost,
  type V1UnitRuntimeSource
} from '../../src/v1/unit-runtime';

const targetId = '0x0000000000000001:main';

function context(
  properties: Record<string, string> = {
    power: 'on',
    bright: '70',
    ct: '4000',
    hue: '180',
    sat: '40'
  }
): ConfirmedTargetContext {
  return {
    target: {
      targetId,
      deviceId: '0x0000000000000001',
      domain: 'main',
      name: 'Test light',
      host: '192.168.1.42',
      port: 55443,
      model: 'color',
      capabilities: [
        'power',
        'brightness',
        'colorTemperature',
        'color',
        'saturation'
      ],
      properties,
      online: true,
      lastSeenAt: 1
    },
    properties,
    supportedMethods: new Set([
      'set_power',
      'set_bright',
      'set_ct_abx',
      'set_hsv'
    ])
  };
}

function key(
  unitId: YeelightUnitId,
  uid: number,
  data: Record<string, unknown>
): KeyData {
  return {
    pluginID: 'com.mor4ee.yeelight',
    cid: V1_CONTROL_CIDS[unitId],
    uid,
    width: 300,
    data,
    title: '',
    cfg: unitId === POWER_UNIT_ID
      ? {
          keyType: 'multiState',
          multiState: { defaultState: 0 }
        }
      : { keyType: 'slider' }
  };
}

function baseData(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    targetId
  };
}

function brightnessData(
  minimum = 0,
  maximum = 100
): Record<string, unknown> {
  return {
    ...baseData(),
    minimum,
    maximum
  };
}

class FakeSource implements V1UnitRuntimeSource {
  readonly commands: YeelightCommand[] = [];
  currentContext = context();
  commandError?: Error;
  private listener?: () => void;

  getControlContext(): ConfirmedTargetContext | undefined {
    return this.currentContext;
  }

  async sendCommand(
    _deviceId: string,
    command: YeelightCommand
  ): Promise<unknown[]> {
    this.commands.push(command);
    if (this.commandError) {
      throw this.commandError;
    }
    return ['ok'];
  }

  subscribeState(listener: () => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
}

class FakeHost implements V1UnitRuntimeHost {
  readonly multiStates: Array<{ uid: number; state: number }> = [];
  readonly sliders: Array<{ uid: number; value: number }> = [];
  readonly sliderStyles: Array<{
    uid: number;
    color?: string;
    min?: number;
    max?: number;
    width?: number;
  }> = [];
  readonly errors: string[] = [];

  async setMultiState(
    _serialNumber: string,
    keyData: KeyData,
    state: number
  ): Promise<void> {
    this.multiStates.push({ uid: keyData.uid, state });
  }

  async setSlider(
    _serialNumber: string,
    keyData: KeyData,
    value: number
  ): Promise<void> {
    this.sliders.push({ uid: keyData.uid, value });
    const slider = (
      keyData.style as
        | {
            slider?: {
              color?: string;
              min?: number;
              max?: number;
              width?: number;
            };
          }
        | undefined
    )?.slider;
    this.sliderStyles.push({
      uid: keyData.uid,
      color: slider?.color,
      min: slider?.min,
      max: slider?.max,
      width: slider?.width
    });
  }

  async showError(
    _serialNumber: string,
    message: string
  ): Promise<void> {
    this.errors.push(message);
  }
}

const silentLogger = {
  debug(): void {},
  warn(): void {}
};

test('maps native slider values to normalized Yeelight positions', () => {
  assert.equal(
    nativeSliderPosition(
      BRIGHTNESS_UNIT_ID,
      brightnessData(20, 80),
      20
    ),
    0
  );
  assert.equal(
    nativeSliderPosition(
      BRIGHTNESS_UNIT_ID,
      brightnessData(20, 80),
      80
    ),
    1
  );
  assert.equal(
    nativeSliderPosition(
      COLOR_TEMPERATURE_UNIT_ID,
      baseData(),
      4100
    ),
    0.5
  );
  assert.equal(
    nativeSliderPosition(COLOR_UNIT_ID, baseData(), 359),
    1
  );
  assert.equal(
    nativeSliderPosition(SATURATION_UNIT_ID, baseData(), 40),
    0.4
  );
});

test('uses the selected device Color Temperature range', () => {
  const constrained = context({
    power: 'on',
    ct: '4600',
    min_ct: '2700',
    max_ct: '6500'
  });

  assert.equal(
    nativeSliderPosition(
      COLOR_TEMPERATURE_UNIT_ID,
      baseData(),
      2700,
      constrained
    ),
    0
  );
  assert.equal(
    nativeSliderPosition(
      COLOR_TEMPERATURE_UNIT_ID,
      baseData(),
      6500,
      constrained
    ),
    1
  );
  assert.equal(
    confirmedSliderPosition(
      COLOR_TEMPERATURE_UNIT_ID,
      baseData(),
      constrained
    ),
    4600
  );
});

test('expands native slider width with the key while preserving controls', () => {
  assert.equal(nativeSliderWidth(360), 260);
  assert.equal(nativeSliderWidth(600), 500);
  assert.equal(nativeSliderWidth(60), 28);
  assert.equal(nativeSliderWidth(Number.NaN), undefined);
});

test('projects confirmed state back to native Flexbar values', () => {
  const confirmed = context();
  assert.equal(
    confirmedSliderPosition(
      BRIGHTNESS_UNIT_ID,
      brightnessData(20, 80),
      confirmed
    ),
    70
  );
  assert.equal(
    confirmedSliderPosition(
      COLOR_TEMPERATURE_UNIT_ID,
      baseData(),
      confirmed
    ),
    4000
  );
  assert.equal(
    confirmedSliderPosition(COLOR_UNIT_ID, baseData(), confirmed),
    180
  );
  assert.equal(
    confirmedSliderPosition(
      SATURATION_UNIT_ID,
      baseData(),
      confirmed
    ),
    40
  );
  assert.equal(
    confirmedSliderPosition(
      BRIGHTNESS_UNIT_ID,
      brightnessData(),
      context({ ...confirmed.properties, power: 'off' })
    ),
    0
  );
});

test('synchronizes all five live key types from confirmed state', async () => {
  const source = new FakeSource();
  const host = new FakeHost();
  const runtime = new YeelightV1UnitRuntime({
    source,
    host,
    logger: silentLogger,
    sliderIntervalMs: 10
  });
  await runtime.handleAlive('FLEXBAR', [
    key(POWER_UNIT_ID, 1, baseData()),
    key(BRIGHTNESS_UNIT_ID, 2, brightnessData()),
    key(COLOR_TEMPERATURE_UNIT_ID, 3, baseData()),
    key(COLOR_UNIT_ID, 4, baseData()),
    key(SATURATION_UNIT_ID, 5, baseData())
  ]);

  assert.deepEqual(host.multiStates, [{ uid: 1, state: 1 }]);
  assert.deepEqual(host.sliders, [
    { uid: 2, value: 70 },
    { uid: 3, value: 4000 },
    { uid: 4, value: 180 },
    { uid: 5, value: 40 }
  ]);
  runtime.stop();
});

test('sends native range, compact Hue format, and width from the placed key', async () => {
  const source = new FakeSource();
  source.currentContext = context({
    power: 'on',
    ct: '2700',
    min_ct: '2700',
    max_ct: '6500',
    hue: '120',
    sat: '40'
  });
  const host = new FakeHost();
  const runtime = new YeelightV1UnitRuntime({
    source,
    host,
    logger: silentLogger,
    sliderIntervalMs: 10
  });
  const temperature = key(
    COLOR_TEMPERATURE_UNIT_ID,
    3,
    baseData()
  );
  const hue = key(COLOR_UNIT_ID, 4, baseData());
  temperature.style = {
    width: 200,
    slider: { color: '#ffffff', min: 1700, max: 6500 }
  } as unknown as KeyData['style'];
  temperature.width = 360;
  hue.style = {
    width: 200,
    slider: { color: '#ffffff', min: 0, max: 359 }
  } as unknown as KeyData['style'];
  hue.width = 600;

  await runtime.handleAlive('FLEXBAR', [temperature, hue]);

  assert.deepEqual(host.sliderStyles, [
    {
      uid: 3,
      color: '#ffffff',
      min: 2700,
      max: 6500,
      width: 260
    },
    {
      uid: 4,
      color: '#ffffff',
      min: 0,
      max: 359,
      width: 500
    }
  ]);
  assert.equal(
    (hue.style as unknown as { slider: { format: string } })
      .slider.format,
    '%0.0f'
  );
  runtime.stop();
});

test('executes Power and preserves confirmed HSV partner values', async () => {
  const source = new FakeSource();
  const host = new FakeHost();
  const runtime = new YeelightV1UnitRuntime({
    source,
    host,
    logger: silentLogger,
    sliderIntervalMs: 10
  });
  const power = key(POWER_UNIT_ID, 1, baseData());
  const hue = key(COLOR_UNIT_ID, 2, baseData());

  runtime.handleData({
    serialNumber: 'FLEXBAR',
    data: { state: 1, key: power }
  } as PluginDataPayload);
  runtime.handleData({
    serialNumber: 'FLEXBAR',
    data: { value: 359, key: hue }
  } as PluginDataPayload);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(
    source.commands.map(({ method, params }) => ({ method, params })),
    [
      {
        method: 'set_power',
        params: ['off', 'smooth', 500]
      },
      {
        method: 'set_hsv',
        params: [359, 40, 'smooth', 500]
      }
    ]
  );
  runtime.stop();
});

test('does not show an error banner for ambiguous Station confirmation', async () => {
  const source = new FakeSource();
  source.commandError = new Error(
    'Yeelight Station command was not confirmed by topology'
  );
  const host = new FakeHost();
  const runtime = new YeelightV1UnitRuntime({
    source,
    host,
    logger: silentLogger,
    sliderIntervalMs: 10
  });

  assert.equal(
    isAmbiguousStationConfirmationFailure(source.commandError),
    true
  );
  runtime.handleData({
    serialNumber: 'FLEXBAR',
    data: { state: 0, key: key(POWER_UNIT_ID, 1, baseData()) }
  } as PluginDataPayload);

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(host.errors, []);
  runtime.stop();
});

test('coalesces rapid slider events to immediate and trailing commands', async () => {
  const source = new FakeSource();
  const host = new FakeHost();
  const runtime = new YeelightV1UnitRuntime({
    source,
    host,
    logger: silentLogger,
    sliderIntervalMs: 25
  });
  const brightness = key(
    BRIGHTNESS_UNIT_ID,
    1,
    brightnessData()
  );

  for (const value of [10, 20, 30]) {
    runtime.handleData({
      serialNumber: 'FLEXBAR',
      data: { value, key: brightness }
    } as PluginDataPayload);
  }

  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.deepEqual(
    source.commands
      .filter(({ method }) => method === 'set_bright')
      .map(({ params }) => params[0]),
    [10, 30]
  );
  runtime.stop();
});
