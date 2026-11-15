import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readIntegerProperty,
  readPowerProperty,
  reduceProps,
  YeelightProtocolError
} from '../../src/backend/protocol';

test('applies props as a partial patch without clearing absent fields', () => {
  const previous = {
    power: 'off',
    bright: '20',
    ct: '3000'
  };
  const next = reduceProps(previous, {
    power: 'on',
    bright: '75'
  });

  assert.deepEqual(next, {
    power: 'on',
    bright: '75',
    ct: '3000'
  });
  assert.deepEqual(previous, {
    power: 'off',
    bright: '20',
    ct: '3000'
  });
  assert.equal(Object.isFrozen(next), true);
});

test('preserves unknown properties for forward compatibility', () => {
  assert.deepEqual(reduceProps({}, { future_property: 'value' }), {
    future_property: 'value'
  });
});

test('reads typed properties only inside their expected ranges', () => {
  const properties = {
    power: 'on',
    bright: '75',
    bad: '75.5',
    high: '101'
  };

  assert.equal(readPowerProperty(properties), true);
  assert.equal(readIntegerProperty(properties, 'bright', 1, 100), 75);
  assert.equal(readIntegerProperty(properties, 'bad', 1, 100), undefined);
  assert.equal(readIntegerProperty(properties, 'high', 1, 100), undefined);
});

test('rejects invalid patch entries', () => {
  assert.throws(
    () =>
      reduceProps({}, {
        'not valid': 'value'
      }),
    YeelightProtocolError
  );
});
