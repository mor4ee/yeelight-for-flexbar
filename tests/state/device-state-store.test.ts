import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceStateStore } from '../../src/backend/state/device-state-store';

test('keeps restored state stale until current generation hydrate completes', () => {
  let now = 100;
  const store = new DeviceStateStore(() => now);
  store.ensureDevice('0x10', {
    power: 'off',
    bright: '20'
  });
  now = 200;
  assert.equal(store.beginConnection('0x10', 1), true);
  assert.equal(store.markHydrating('0x10', 1), true);
  assert.equal(store.get('0x10')?.stale, true);

  now = 300;
  assert.equal(
    store.completeHydrate('0x10', 1, {
      power: 'on',
      bright: '75'
    }),
    true
  );

  assert.deepEqual(store.get('0x10'), {
    deviceId: '0x10',
    generation: 1,
    revision: 3,
    phase: 'connected',
    stale: false,
    staleProperties: [],
    activeTransport: 'unavailable',
    pendingCommands: [],
    properties: {
      power: 'on',
      bright: '75'
    },
    lastError: undefined,
    updatedAt: 300
  });
});

test('ignores props and disconnect events from old generations', () => {
  const store = new DeviceStateStore();
  store.ensureDevice('0x10');
  store.beginConnection('0x10', 1);
  store.markDisconnected('0x10', 1, 'closed');
  store.beginConnection('0x10', 2);
  store.markHydrating('0x10', 2);

  assert.equal(store.applyProps('0x10', 1, { power: 'off' }), false);
  assert.equal(store.markDisconnected('0x10', 1, 'old close'), false);
  assert.equal(store.get('0x10')?.generation, 2);
  assert.equal(store.get('0x10')?.phase, 'hydrating');
  assert.equal(store.get('0x10')?.properties.power, undefined);
});

test('marks disconnected confirmed state as stale without clearing properties', () => {
  const store = new DeviceStateStore();
  store.ensureDevice('0x10');
  store.beginConnection('0x10', 1);
  store.markHydrating('0x10', 1);
  store.completeHydrate('0x10', 1, { power: 'on' });
  store.markDisconnected('0x10', 1, 'socket closed');

  const state = store.get('0x10');
  assert.equal(state?.phase, 'disconnected');
  assert.equal(state?.stale, true);
  assert.deepEqual(state?.staleProperties, []);
  assert.equal(state?.properties.power, 'on');
  assert.equal(state?.lastError, 'socket closed');
});

test('publishes monotonically increasing aggregate revisions', () => {
  const revisions: number[] = [];
  const store = new DeviceStateStore();
  store.subscribe((snapshot) => revisions.push(snapshot.revision));

  store.ensureDevice('0x10');
  store.beginConnection('0x10', 1);
  store.markHydrating('0x10', 1);
  store.applyProps('0x10', 1, { bright: '50' });

  assert.deepEqual(revisions, [0, 1, 2, 3]);
});

test('does not let an older hydrate overwrite newer confirmed fields', () => {
  const store = new DeviceStateStore();
  store.ensureDevice('0x10', {
    power: 'off',
    bright: '20'
  });
  store.beginConnection('0x10', 1, 'tcp-session');
  store.markHydrating('0x10', 1);
  store.applyProps('0x10', 1, {
    power: 'on'
  });
  store.completeHydrate('0x10', 1, {
    power: 'off',
    bright: '75'
  });

  const state = store.get('0x10');
  assert.equal(state?.properties.power, 'on');
  assert.equal(state?.properties.bright, '75');
  assert.equal(state?.activeTransport, 'tcp-session');
  assert.equal(state?.stale, false);
});

test('one authoritative event consumes at most one matching command', () => {
  const store = new DeviceStateStore();
  store.ensureDevice('0x10');
  store.beginConnection('0x10', 1, 'udp-r2');
  store.completeHydrate('0x10', 1, {
    bright: '20'
  });
  const first = store.beginCommand(
    '0x10',
    1,
    ['bright'],
    { bright: '50' }
  );
  const second = store.beginCommand(
    '0x10',
    1,
    ['bright'],
    { bright: '50' }
  );

  assert.equal(first !== undefined, true);
  assert.equal(second !== undefined, true);
  store.applyProps('0x10', 1, {
    bright: '50'
  });

  const pending = store.get('0x10')?.pendingCommands ?? [];
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, second);
});

test('an unresolved accepted command keeps properties and marks state stale', () => {
  const store = new DeviceStateStore();
  store.ensureDevice('0x10');
  store.beginConnection('0x10', 1, 'udp-r2');
  store.completeHydrate('0x10', 1, {
    power: 'on',
    bright: '20'
  });
  const commandId = store.beginCommand(
    '0x10',
    1,
    ['bright'],
    { bright: '80' }
  );
  assert.notEqual(commandId, undefined);
  store.failCommand(
    '0x10',
    1,
    commandId!,
    'confirmation timed out',
    true
  );

  const state = store.get('0x10');
  assert.equal(state?.properties.bright, '20');
  assert.equal(state?.stale, true);
  assert.deepEqual(state?.staleProperties, ['bright']);
  assert.equal(state?.phase, 'connected');
  assert.equal(state?.activeTransport, 'udp-r2');
  assert.equal(state?.pendingCommands.length, 0);
});

test('a bounded query result cannot overwrite a newer external event', () => {
  const store = new DeviceStateStore();
  store.ensureDevice('0x10');
  store.beginConnection('0x10', 1, 'udp-r2');
  store.completeHydrate('0x10', 1, {
    bright: '20'
  });
  const queryRevision = store.get('0x10')!.revision;
  store.applyProps('0x10', 1, {
    bright: '70'
  });
  store.applyProps(
    '0x10',
    1,
    {
      bright: '30'
    },
    queryRevision
  );

  assert.equal(store.get('0x10')?.properties.bright, '70');
});

test('a later trusted patch reconciles command-scoped stale state', () => {
  const store = new DeviceStateStore();
  store.ensureDevice('0x10');
  store.beginConnection('0x10', 1, 'udp-r2');
  store.completeHydrate('0x10', 1, {
    bright: '20'
  });
  const commandId = store.beginCommand(
    '0x10',
    1,
    ['bright'],
    { bright: '80' }
  )!;
  store.failCommand(
    '0x10',
    1,
    commandId,
    'confirmation unavailable',
    true
  );
  store.applyProps('0x10', 1, {
    bright: '80'
  });

  const state = store.get('0x10');
  assert.equal(state?.properties.bright, '80');
  assert.equal(state?.stale, false);
  assert.deepEqual(state?.staleProperties, []);
  assert.equal(state?.lastError, undefined);
});
