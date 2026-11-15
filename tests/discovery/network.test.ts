import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAddressInNetwork,
  isAddressOnTrustedNetwork,
  isPrivateOrLocalIPv4,
  normalizeManualAddress
} from '../../src/backend/discovery/network';

test('matches IPv4 addresses against interface networks', () => {
  assert.equal(
    isAddressInNetwork('192.168.5.200', '192.168.5.10', '255.255.255.0'),
    true
  );
  assert.equal(
    isAddressInNetwork('192.168.6.1', '192.168.5.10', '255.255.255.0'),
    false
  );
  assert.equal(
    isAddressOnTrustedNetwork('10.42.1.9', [
      {
        name: 'Ethernet',
        address: '10.42.1.5',
        netmask: '255.255.255.0'
      }
    ]),
    true
  );
});

test('manual addresses are constrained to non-Internet IPv4 ranges', () => {
  for (const address of [
    '10.0.0.2',
    '172.16.4.5',
    '192.168.1.9',
    '169.254.2.3',
    '100.64.1.2'
  ]) {
    assert.equal(isPrivateOrLocalIPv4(address), true);
    assert.equal(normalizeManualAddress(` ${address} `), address);
  }

  for (const address of ['8.8.8.8', '127.0.0.1', '239.255.255.250', 'invalid']) {
    assert.equal(isPrivateOrLocalIPv4(address), false);
    assert.throws(() => normalizeManualAddress(address));
  }
});
