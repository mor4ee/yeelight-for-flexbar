import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCommandSupported,
  encodeCommand,
  getProperties,
  setBrightness,
  setColorTemperature,
  setColorTemperatureScene,
  setHsv,
  setHsvScene,
  setPower,
  setRgb,
  setRgbScene,
  YeelightProtocolError
} from '../../src/backend/protocol';

test('builds and encodes a closed set_power command', () => {
  const command = setPower(true);
  assert.equal(
    encodeCommand(7, command).toString('utf8'),
    '{"id":7,"method":"set_power","params":["on","smooth",500]}\r\n'
  );
});

test('maps background commands to bg methods', () => {
  assert.equal(setPower(false, 'background').method, 'bg_set_power');
  assert.equal(setBrightness(50, 'background').method, 'bg_set_bright');
  assert.equal(
    setColorTemperature(4000, 'background').method,
    'bg_set_ct_abx'
  );
  assert.equal(setRgb(0xff00aa, 'background').method, 'bg_set_rgb');
  assert.equal(setHsv(120, 80, 'background').method, 'bg_set_hsv');
  assert.deepEqual(setHsvScene(120, 80, 50, 'background'), {
    method: 'bg_set_scene',
    params: ['hsv', 120, 80, 50]
  });
  assert.deepEqual(setRgbScene(0xff00aa, 50, 'background').params, [
    'color',
    0xff00aa,
    50
  ]);
  assert.deepEqual(
    setColorTemperatureScene(4_000, 50, 'background').params,
    ['ct', 4_000, 50]
  );
});

test('enforces protocol ranges', () => {
  for (const invalid of [0, 101, 1.5]) {
    assert.throws(() => setBrightness(invalid), YeelightProtocolError);
  }
  for (const invalid of [1699, 6501]) {
    assert.throws(() => setColorTemperature(invalid), YeelightProtocolError);
  }
  assert.throws(() => setRgb(-1), YeelightProtocolError);
  assert.throws(() => setRgb(0x1000000), YeelightProtocolError);
  assert.throws(() => setHsv(360, 50), YeelightProtocolError);
  assert.throws(() => setHsv(180, 101), YeelightProtocolError);
  assert.throws(() => setHsvScene(180, 50, 0), YeelightProtocolError);
  assert.throws(() => setRgbScene(-1, 50), YeelightProtocolError);
  assert.throws(
    () => setColorTemperatureScene(1_699, 50),
    YeelightProtocolError
  );
});

test('validates get_prop and capability support', () => {
  assert.deepEqual(getProperties(['power', 'bright']), {
    method: 'get_prop',
    params: ['power', 'bright']
  });
  assert.throws(() => getProperties([]), YeelightProtocolError);
  assert.doesNotThrow(() =>
    assertCommandSupported(setBrightness(50), new Set(['set_bright']))
  );
  assert.throws(
    () => assertCommandSupported(setBrightness(50), new Set(['set_power'])),
    (error: unknown) =>
      error instanceof YeelightProtocolError &&
      error.code === 'UNSUPPORTED_CAPABILITY'
  );
});

test('refuses arbitrary outbound methods', () => {
  assert.throws(
    () =>
      encodeCommand(1, {
        method: 'set_music',
        params: [1, '192.168.1.2', 55443]
      }),
    (error: unknown) =>
      error instanceof YeelightProtocolError &&
      error.code === 'INVALID_COMMAND'
  );
});
