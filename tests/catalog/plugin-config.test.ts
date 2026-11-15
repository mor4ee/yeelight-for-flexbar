import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_YEELIGHT_CONFIG,
  normalizePluginConfig
} from '../../src/backend/catalog/plugin-config';

test('normalizes, deduplicates and sorts manual addresses', () => {
  const config = normalizePluginConfig({
    schemaVersion: 99,
    manualAddresses: [
      ' 192.168.1.20 ',
      '10.0.0.3',
      '192.168.1.20',
      '8.8.8.8',
      42
    ],
    catalog: []
  });

  assert.deepEqual(config.manualAddresses, ['10.0.0.3', '192.168.1.20']);
  assert.equal(config.schemaVersion, 1);
});

test('returns independent defaults for malformed config', () => {
  const config = normalizePluginConfig(null);
  config.manualAddresses.push('10.0.0.2');

  assert.deepEqual(DEFAULT_YEELIGHT_CONFIG.manualAddresses, []);
});
